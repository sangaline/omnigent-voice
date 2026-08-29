import { describe, expect, it } from "vitest";
import {
  FrozenCoordinatorExecutor,
  observationFromTrace,
  scoreVoiceEval,
  VoiceEvalCase,
  VoiceEvalObservation,
} from "./evaluation.js";

const testCase: VoiceEvalCase = {
  id: "send_retry",
  description: "Retry a missed send without changing focus.",
  history: [],
  input: "no it didn't send it again",
  coordinatorState: {},
  expected: {
    toolSequence: ["send_message"],
    forbiddenTools: ["focus_session"],
    messageTerms: ["try", "again"],
    delivery: "not_queued",
    speechTerms: ["primary work"],
    speechForbiddenTerms: ["later"],
    maxRounds: 2,
  },
};

const observation: VoiceEvalObservation = {
  toolCalls: [
    {
      name: "send_message",
      arguments: { message: "Try that again" },
      result: { accepted: true },
    },
  ],
  speech: "I sent that to Primary Work.",
  rounds: 2,
  durationMs: 500,
  promptTokens: 100,
  completionTokens: 20,
  modelError: undefined,
};

describe("voice harness evaluation", () => {
  it("scores tool choice, arguments, speech, and latency rounds", () => {
    expect(scoreVoiceEval(testCase, observation)).toEqual({
      passed: true,
      checks: 8,
      failures: [],
    });
    expect(
      scoreVoiceEval(testCase, {
        ...observation,
        toolCalls: [
          {
            name: "focus_session",
            arguments: { message: "unrelated" },
            result: {},
          },
        ],
        speech: "I'll do that later.",
        rounds: 3,
      }),
    ).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        expect.stringContaining("tool sequence"),
        expect.stringContaining("forbidden tool"),
        expect.stringContaining("message omitted"),
        expect.stringContaining("speech included forbidden"),
        expect.stringContaining("maximum"),
      ]),
    });
  });

  it("returns frozen state and adds the authoritative envelope to tool fixtures", async () => {
    const executor = new FrozenCoordinatorExecutor(
      {
        focused_session: { id: "session-primary", name: "Primary Work" },
        recent_actions: [{ type: "message_sent" }],
        output_delta: { changed: false, output: "" },
        updates: [],
        update_cursor: 9,
      },
      {
        send_message: { accepted: true },
      },
    );

    await expect(executor.execute("check_updates", {}, 0)).resolves.toMatchObject({
      focused_session: { id: "session-primary" },
      output_delta: { changed: false },
      update_cursor: 9,
    });
    await expect(executor.execute("send_message", { message: "Hello" }, 9)).resolves.toMatchObject({
      accepted: true,
      focused_session: { id: "session-primary" },
      recent_actions: [{ type: "message_sent" }],
      update_cursor: 9,
    });
    executor.replaceState({
      focused_session: { id: "session-side", name: "Side Work" },
      recent_actions: [],
      updates: [],
      update_cursor: 10,
    });
    executor.replaceToolResults({
      get_output: { items: [{ text: "New output" }] },
    });
    await expect(executor.execute("check_updates", {}, 9)).resolves.toMatchObject({
      focused_session: { id: "session-side" },
      update_cursor: 10,
    });
    await expect(executor.execute("get_output", {}, 10)).resolves.toMatchObject({
      items: [{ text: "New output" }],
      focused_session: { id: "session-side" },
    });
  });

  it("replays only coordinator updates newer than the MCP consumer cursor", async () => {
    const executor = new FrozenCoordinatorExecutor({
      focused_session: { id: "session-primary", name: "Primary Work" },
      updates: [
        { event_id: 4, type: "session_completed", session_id: "session-old" },
        { event_id: 7, type: "decision_needed", session_id: "session-new" },
      ],
      update_cursor: 7,
    }, {
      answer_prompt: { resolved: true },
    });

    await expect(executor.execute("check_updates", {}, 4)).resolves.toMatchObject({
      updates: [{ event_id: 7 }],
      update_cursor: 7,
    });
    await expect(executor.execute("answer_prompt", {}, 7)).resolves.toMatchObject({
      resolved: true,
      updates: [],
      update_cursor: 7,
    });
  });

  it("marks model-service errors separately from scored harness behavior", () => {
    expect(
      observationFromTrace(
        [
          {
            type: "error",
            phase: "turn",
            message: "Celeris returned HTTP 429",
          },
        ],
        "I couldn't reach the coordination layer just now.",
        100,
      ),
    ).toMatchObject({
      rounds: 0,
      modelError: "Celeris returned HTTP 429",
    });
  });

  it("accepts a safe optional read while still checking its target", () => {
    const optionalRead: VoiceEvalCase = {
      ...testCase,
      expected: {
        toolSequence: [],
        alternativeToolSequences: [["get_output"]],
        sessionIdIfTool: "session-side",
      },
    };
    expect(
      scoreVoiceEval(optionalRead, {
        ...observation,
        toolCalls: [
          {
            name: "get_output",
            arguments: { session_id: "session-side" },
            result: {},
          },
        ],
      }).passed,
    ).toBe(true);
    expect(
      scoreVoiceEval(optionalRead, {
        ...observation,
        toolCalls: [
          {
            name: "get_output",
            arguments: { session_id: "session-primary" },
            result: {},
          },
        ],
      }).failures,
    ).toContain("session_id session-primary != session-side");
  });

  it("scores each call in a grounded cross-session transaction", () => {
    const transaction: VoiceEvalCase = {
      ...testCase,
      expected: {
        toolSequence: ["get_output", "send_message"],
        callExpectations: [
          { index: 0, name: "get_output", sessionId: "session-source" },
          {
            index: 1,
            name: "send_message",
            sessionId: "session-target",
            messageTerms: ["stale cache"],
            delivery: "not_queued",
          },
        ],
      },
    };
    const grounded: VoiceEvalObservation = {
      ...observation,
      toolCalls: [
        {
          name: "get_output",
          arguments: { session_id: "session-source" },
          result: { latest_message: { text: "The worker used a stale cache key." } },
        },
        {
          name: "send_message",
          arguments: {
            session_id: "session-target",
            message: "The source found a stale cache key.",
          },
          result: { accepted: true },
        },
      ],
    };
    expect(scoreVoiceEval(transaction, grounded).passed).toBe(true);
    expect(
      scoreVoiceEval(transaction, {
        ...grounded,
        toolCalls: [
          grounded.toolCalls[0]!,
          {
            ...grounded.toolCalls[1]!,
            arguments: {
              session_id: "session-source",
              message: "Please inspect the other session.",
            },
          },
        ],
      }).failures,
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("session_id session-source != session-target"),
        expect.stringContaining("message omitted"),
      ]),
    );
  });

  it("checks independent compound actions without imposing call order", () => {
    const compound: VoiceEvalCase = {
      ...testCase,
      expected: {
        toolSequence: ["send_message", "focus_session"],
        alternativeToolSequences: [["focus_session", "send_message"]],
        unorderedCallExpectations: [
          {
            name: "send_message",
            sessionId: "session-side",
            messageTerms: ["rerun", "worker"],
          },
          { name: "focus_session", sessionId: "session-side" },
        ],
      },
    };
    const reversed: VoiceEvalObservation = {
      ...observation,
      toolCalls: [
        {
          name: "focus_session",
          arguments: { session_id: "session-side" },
          result: { focus_changed: true },
        },
        {
          name: "send_message",
          arguments: {
            session_id: "session-side",
            message: "Rerun the voice worker",
          },
          result: { accepted: true },
        },
      ],
    };
    expect(scoreVoiceEval(compound, reversed).passed).toBe(true);
    expect(
      scoreVoiceEval(compound, {
        ...reversed,
        toolCalls: [
          reversed.toolCalls[0]!,
          {
            ...reversed.toolCalls[1]!,
            arguments: { session_id: "session-side", message: "Do something" },
          },
        ],
      }).failures,
    ).toEqual(expect.arrayContaining([expect.stringContaining("message omitted")]));
  });

  it("rejects invented spoken numbers while allowing configured thresholds", () => {
    const numericCase: VoiceEvalCase = {
      ...testCase,
      expected: {
        toolSequence: [],
        allowedSpeechNumbers: [80, 48_000],
      },
    };
    expect(
      scoreVoiceEval(numericCase, {
        ...observation,
        toolCalls: [],
        speech: "The contract retains 80 messages or 48,000 characters.",
      }).passed,
    ).toBe(true);
    expect(
      scoreVoiceEval(numericCase, {
        ...observation,
        toolCalls: [],
        speech: "The contract retains 80 messages or 44,000 characters.",
      }).failures,
    ).toContain("speech included unapproved number 44000");
  });
});
