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
});
