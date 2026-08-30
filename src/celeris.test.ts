import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowsArchive,
  allowsFocusChange,
  allowsRename,
  CelerisConversation,
  CelerisTraceEvent,
  CelerisMemoryPolicy,
  compactCoordinatorUpdatesForModel,
  CoordinatorToolClient,
  directCoordinatorUpdateSpeech,
  directFocusedOutputSpeech,
  directGetOutputResultSpeech,
  directHumanSuppliedCorrectionSpeech,
  directInterruptedSendVerificationSpeech,
  directNoIncomingUpdateSpeech,
  directOutputVisibilityCapabilitySpeech,
  directRepetitionCorrectionSpeech,
  directPendingDecisionSpeech,
  directSessionOrganizationSpeech,
  directPollOutputResultSpeech,
  directSessionOutputSpeech,
  immediateNotificationTargets,
  isDeclarativeMissedSend,
  missingMultiSourceCauseTerms,
  missingMultiSourceNames,
  missingMultiSourceNumbers,
  requestsPositiveFocusAction,
  requestedRenameTitle,
  requiresNotificationOutputRead,
  serializeToolResult,
  StreamingSpeechSegmenter,
  successfulActionSpeech,
  targetsFocusedSession,
  verifiedActionFollowupSpeech,
  verifiedAttributionClarificationSpeech,
  verifiedDeliveryVisibilitySpeech,
  verifiedExactMessageSpeech,
  verifiedQueuedDeliverySpeech,
  verifiedToolWorkflowOutcome,
  withoutUnsupportedMonitoringOffers,
  voiceFocusRouting,
  voiceAttributionRelayMessage,
  voiceMessageInstruction,
  voiceMultipleMessageInstructions,
  voiceNotificationMessageInstructions,
  voiceMessageRouting,
  voiceSelfReportRelayMessage,
  voiceReadRouting,
  voiceRetryReadRouting,
  voiceStartInstruction,
  voiceStartTitle,
} from "./celeris.js";
import { Logger } from "./log.js";
import { CoordinatorExecutor, CoordinatorMcpClient } from "./mcp.js";

const response = (message: object): Response =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const streamingResponse = (...payloads: Array<object | "[DONE]">): Response =>
  new Response(
    payloads
      .map((payload) =>
        `data: ${payload === "[DONE]" ? payload : JSON.stringify(payload)}\n\n`
      )
      .join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

const toolClient = (): CoordinatorToolClient => ({
  listTools: vi.fn().mockResolvedValue([
    {
      name: "send_message",
      description: "Send a message.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          session_id: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      name: "focus_session",
      description: "Switch sessions.",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
    },
    {
      name: "get_output",
      description: "Read session output.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          page: { type: "number" },
        },
      },
    },
    {
      name: "poll_output",
      description: "Read stable output after an opaque cursor.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          cursor: { type: "string" },
        },
      },
    },
    {
      name: "archive_session",
      description: "Archive the focused session and restore the previous focus.",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
      },
    },
    {
      name: "rename_session",
      description: "Rename the focused session without changing focus.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          session_id: { type: "string" },
        },
        required: ["title"],
      },
    },
    {
      name: "answer_prompt",
      description: "Resolve a pending prompt.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: { type: "string" },
          action: { type: "string", enum: ["accept", "decline", "cancel"] },
          session_id: { type: "string" },
        },
        required: ["prompt_id", "action"],
      },
    },
    {
      name: "check_updates",
      description: "Check updates.",
      inputSchema: { type: "object", properties: {} },
    },
  ]),
  callTool: vi.fn().mockImplementation((name: string) =>
    Promise.resolve(name === "check_updates" ? { updates: [] } : { sent: true, updates: [] }),
  ),
});

const conversation = (
  apiKey: string | undefined,
  tools: CoordinatorToolClient = toolClient(),
  memoryPolicy?: Partial<CelerisMemoryPolicy>,
): CelerisConversation =>
  new CelerisConversation({
    apiKey,
    baseUrl: "https://example.test/v1",
    model: "test-model",
    logger: new Logger("error"),
    tools,
    memoryPolicy,
  });

afterEach(() => vi.unstubAllGlobals());

describe("Celeris coordinator conversation", () => {
  it("describes terminal visibility without claiming arbitrary raw scrollback", () => {
    expect(
      directOutputVisibilityCapabilitySpeech(
        "are you seeing raw terminal output like diffs or just the chat summary",
      ),
    ).toContain("persisted conversation");
    expect(
      directOutputVisibilityCapabilitySpeech("what is the latest session output"),
    ).toBeUndefined();
  });

  it("stops a failed explanation instead of repeating its premise", () => {
    expect(
      directRepetitionCorrectionSpeech(
        "stop just repeating yourself that explanation doesn't make any sense",
      ),
    ).toContain("doesn't make sense");
    expect(directRepetitionCorrectionSpeech("please explain that again")).toBeUndefined();
  });

  it("removes unsupported future-monitoring offers without losing current evidence", () => {
    expect(
      withoutUnsupportedMonitoringOffers(
        "No, it didn't give a time estimate. It is building the image now. I'll keep an eye on it and let you know.",
      ),
    ).toBe("No, it didn't give a time estimate. It is building the image now.");
    expect(
      withoutUnsupportedMonitoringOffers(
        "It reported the build is running, but it did not provide a timing estimate.",
      ),
    ).toBe("It reported the build is running, but it did not provide a timing estimate.");
    expect(
      withoutUnsupportedMonitoringOffers(
        "The runtime will monitor coordinator events. I can't monitor them by myself.",
      ),
    ).toBe("The runtime will monitor coordinator events. I can't monitor them by myself.");
  });

  it("does not reuse an older send receipt for an interrupted content-free request", () => {
    expect(
      directInterruptedSendVerificationSpeech(
        "did you send the message I just asked you to",
        [
          { role: "user", content: "send the release question" },
          { role: "assistant", content: "I sent that to Release Work." },
          { role: "user", content: "okay can you send a message for me" },
          {
            role: "system",
            content: "The preceding human turn was interrupted before a spoken result.",
          },
        ],
      ),
    ).toBe("No. You hadn't told me what message to send yet. What should I send?");
    expect(
      directInterruptedSendVerificationSpeech(
        "did you send the message I just asked you to",
        [
          { role: "user", content: "send the release question" },
          { role: "assistant", content: "I sent that to Release Work." },
        ],
      ),
    ).toBeUndefined();
  });

  it("attributes a merged voice-interface correction to the coordinator", () => {
    expect(
      voiceSelfReportRelayMessage(
        "okay can you send a message for me it says the voice agent claims it never got the estimate but the coding agent already said thirty to forty minutes if the image build and routing behave normally",
      ),
    ).toBe(
      "The human reports that the voice coordinator claims it never got the estimate but the coding agent already said thirty to forty minutes if the image build and routing behave normally.",
    );
    expect(
      voiceSelfReportRelayMessage("send a message for me saying the deployment is ready"),
    ).toBeUndefined();
  });

  it("preserves a human-supplied numeric correction and its condition without a model", () => {
    expect(
      directHumanSuppliedCorrectionSpeech(
        "no the coding agent already said about thirty to forty minutes if the image build and routing behave normally",
      ),
    ).toBe(
      "You're right. The estimate you reported was about thirty to forty minutes if the image build and routing behave normally.",
    );
    expect(
      directHumanSuppliedCorrectionSpeech("no I meant the other deployment"),
    ).toBeUndefined();
  });

  it("segments generated text at natural boundaries with a hard speech limit", () => {
    const segmenter = new StreamingSpeechSegmenter(54);
    expect(segmenter.push("The first sentence arrives. The second")).toEqual([
      "The first sentence arrives.",
    ]);
    expect(segmenter.push(" one is long enough, and keeps moving")).toEqual([]);
    expect(segmenter.finish()).toEqual([]);
    expect(() => segmenter.push("late")).toThrow("already finalized");
  });

  it("remembers exactly the complete sentences emitted within the speech budget", async () => {
    const first =
      "The local coordinator uses runtime credentials and private reachability for its stdio server.";
    const second =
      "A remote transport would need authenticated identity and authorization before external clients could safely connect to it across every deployment without exposing coordinator authority, and that work has not been implemented yet.";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamingResponse(
          {
            choices: [{ delta: { content: `${first} ` }, finish_reason: null }],
          },
          {
            choices: [{ delta: { content: second }, finish_reason: "stop" }],
          },
          "[DONE]",
        ),
      ),
    );
    const subject = conversation("test-key");
    const segments: string[] = [];

    await expect(
      subject.respond("How does remote authentication work?", (segment) => {
        segments.push(segment);
      }),
    ).resolves.toBe(first);
    expect(segments).toEqual([first]);
    await expect(subject.respond("repeat that")).resolves.toBe(first);
  });

  it("streams content deltas into speech segments while retaining the full reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamingResponse(
        {
          choices: [{ delta: { content: "The first sentence. " }, finish_reason: null }],
          usage: { prompt_tokens: 100, completion_tokens: 4 },
        },
        {
          choices: [{ delta: { content: "The second sentence." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 8 },
        },
        "[DONE]",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const segments: string[] = [];

    await expect(
      conversation("test-key").respond("Explain it briefly.", (segment) => {
        segments.push(segment);
      }),
    ).resolves.toBe("The first sentence. The second sentence.");
    expect(segments).toEqual(["The first sentence.", "The second sentence."]);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    expect(request).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("assembles streamed tool-call fragments without speaking tool arguments", async () => {
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string, args) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: { id: "session-primary", name: "Primary Work" },
              known_sessions: [{ id: "session-primary", name: "Primary Work" }],
              updates: [],
            }
          : {
              accepted: true,
              delivery: "immediate",
              target_session: { id: String(args.session_id), name: "Primary Work" },
              updates: [],
            },
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamingResponse(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-streamed",
                      type: "function",
                      function: { name: "send_message", arguments: '{"message":"run' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: ' it now"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          "[DONE]",
        ),
      ),
    );
    const segments: string[] = [];

    await expect(
      conversation("test-key", tools).respond("Tell it to run it now.", (segment) => {
        segments.push(segment);
      }),
    ).resolves.toBe("I sent that to Primary Work.");
    expect(segments).toEqual([]);
    expect(tools.callTool).toHaveBeenCalledWith("send_message", {
      message: "run it now",
    });
  });

  it("keeps oversized tool results as valid structured JSON", () => {
    const serialized = serializeToolResult({
      focused_session: { id: "session-1", name: "Voice MVP" },
      latest_message: { kind: "message", text: `latest ${"x".repeat(10_000)}` },
      items: Array.from({ length: 40 }, (_, index) => ({
        position: index + 1,
        kind: index === 0 ? "message" : "tool_result",
        text: `${index} ${"y".repeat(10_000)}`,
      })),
    });
    expect(serialized.length).toBeLessThanOrEqual(32_000);
    const parsed = JSON.parse(serialized) as {
      tool_result_compacted?: boolean;
      latest_message?: { text?: string };
      items?: Array<{ text?: string } | { omitted_items?: number }>;
    };
    expect(parsed.tool_result_compacted).toBe(true);
    expect(parsed.latest_message?.text).toContain("latest ");
    expect(parsed.items?.[0]).toMatchObject({ position: 1, kind: "message" });
    expect(parsed.items?.at(-1)).toHaveProperty("omitted_items");
  });

  it("keeps only the latest assistant conclusion from noisy native stream output", () => {
    const original = [
      {
        event_id: 7,
        type: "session_output" as const,
        session_id: "session-voice",
        name: "Voice Work",
        output_delta: {
          changed: true,
          output:
            "assistant: tool call shell: inspect the deployment\n\ntool result: raw command output\n\ntool call apply_patch: edit source\n\nassistant: The live bridge passed 138 tests in 2.2 seconds.\n[older output omitted]",
        },
      },
    ];
    expect(directCoordinatorUpdateSpeech(original)).toBeUndefined();
    const [compacted] = compactCoordinatorUpdatesForModel(original);
    expect(compacted).toMatchObject({
      event_id: 7,
      name: "Voice Work",
      output_delta: {
        changed: true,
        output: "assistant: The live bridge passed 138 tests in 2.2 seconds.",
        voice_selection: "latest_assistant_conclusion_after_native_activity",
      },
    });
  });

  it("compacts native activity in coordinator fields before serializing tool results", () => {
    const nativeOutput =
      "tool call shell: inspect a private rollout\n\ntool result: irrelevant command text\n\nassistant: The current rollout is healthy.";
    const serialized = serializeToolResult({
      output_delta: { changed: true, output: nativeOutput },
      updates: [
        {
          event_id: 10,
          type: "session_output",
          session_id: "session-voice",
          name: "Voice Work",
          output_delta: { changed: true, output: nativeOutput },
        },
      ],
    });
    expect(serialized).not.toContain("irrelevant command text");
    const parsed = JSON.parse(serialized) as {
      output_delta: { output: string; voice_selection: string };
      updates: Array<{ output_delta: { output: string; voice_selection: string } }>;
    };
    expect(parsed.output_delta).toEqual({
      changed: true,
      output: "assistant: The current rollout is healthy.",
      voice_selection: "latest_assistant_conclusion_after_native_activity",
    });
    expect(parsed.updates[0]?.output_delta).toEqual(parsed.output_delta);
  });

  it("leaves ordinary coordinator output unchanged", () => {
    const updates = [
      {
        event_id: 8,
        type: "session_output" as const,
        session_id: "session-voice",
        name: "Voice Work",
        output_delta: {
          changed: true,
          output: "assistant: The deployment is healthy.",
        },
      },
    ];
    expect(compactCoordinatorUpdatesForModel(updates)).toEqual(updates);
  });

  it("bounds noisy native output that has no final assistant conclusion", () => {
    const noise = `tool call shell: inspect\n\ntool result: ${"x".repeat(4_000)}`;
    const [compacted] = compactCoordinatorUpdatesForModel([
      {
        event_id: 9,
        type: "session_output",
        session_id: "session-voice",
        name: "Voice Work",
        output_delta: { changed: true, output: noise },
      },
    ]);
    expect(compacted).toBeDefined();
    if (!compacted) throw new Error("missing compacted update");
    const output = (compacted.output_delta as { output: string }).output;
    expect(output.length).toBeLessThanOrEqual(2_000);
    expect(output).toContain("tool call shell");
    expect(output).toContain("tool result");
    expect(compacted.output_delta).toMatchObject({
      voice_selection: "bounded_native_activity_without_new_assistant_conclusion",
    });
  });

  it("does not promote an older assistant message followed by newer tool activity", () => {
    const [compacted] = compactCoordinatorUpdatesForModel([
      {
        event_id: 11,
        type: "session_output",
        session_id: "session-voice",
        name: "Voice Work",
        output_delta: {
          changed: true,
          output:
            "tool call shell: start the check\n\nassistant: The prior build was healthy.\n\ntool call shell: run the new test\n\ntool result: still running",
        },
      },
    ]);
    expect(compacted?.output_delta).toMatchObject({
      voice_selection: "bounded_native_activity_without_new_assistant_conclusion",
    });
    expect((compacted?.output_delta as { output: string }).output).toContain(
      "tool result: still running",
    );
  });

  it("prefers typed streaming assistant output over an older noisy prefix", () => {
    const [compacted] = compactCoordinatorUpdatesForModel([
      {
        event_id: 12,
        type: "session_output",
        session_id: "session-voice",
        name: "Voice Work",
        output_delta: {
          changed: true,
          output:
            "assistant: The prior build was healthy.\n\ntool call shell: run the new test\n\ntool result: still running\n\nassistant (still streaming): The candidate has passed 20 of",
          voice_assistant_output: "assistant (still streaming): The candidate has passed 20 of",
          voice_assistant_output_state: "streaming",
          voice_assistant_output_scope: "streaming_suffix",
        },
      },
    ]);
    expect(compacted?.output_delta).toEqual({
      changed: true,
      output: "assistant (still streaming): The candidate has passed 20 of",
      voice_selection: "latest_streaming_assistant_suffix_after_native_activity",
    });
  });

  it("answers a plain latest-output question only from a safe fresh delta", () => {
    const state = {
      focused_session: { id: "session-primary", name: "Primary Work" },
      pending_decisions: [],
      updates: [],
      output_delta: {
        changed: true,
        output: "assistant: The shared harness passed the held out checks.",
      },
    };
    expect(directFocusedOutputSpeech("okay what's the latest on it right now", state)).toBe(
      "Primary Work update: The shared harness passed the held out checks.",
    );
    expect(
      directFocusedOutputSpeech("tell it to rerun the latest check", state),
    ).toBeUndefined();
    expect(
      directFocusedOutputSpeech("what's the latest", {
        ...state,
        updates: [{ event_id: 9, type: "decision_needed" }],
      }),
    ).toBeUndefined();
    expect(
      directGetOutputResultSpeech("do you see a message from me more recently", {
        target_session: { id: "session-primary", name: "Primary Work" },
        latest_message: {
          role: "user",
          text: "There is a newer follow-up message.",
        },
        updates: [],
      }),
    ).toBe("Primary Work latest user message: There is a newer follow-up message.");
    expect(
      directGetOutputResultSpeech("what did the agent say", {
        target_session: { id: "session-primary", name: "Primary Work" },
        latest_message: { role: "user", text: "Do not attribute this to the agent." },
        updates: [],
      }),
    ).toBeUndefined();
  });

  it("answers current status from a typed streaming suffix without claiming completion", () => {
    const state = {
      focused_session: { id: "session-primary", name: "Primary Work" },
      known_sessions: [
        { id: "session-primary", name: "Primary Work", focused: true },
        { id: "session-side", name: "Side Work", focused: false },
      ],
      pending_decisions: [],
      updates: [],
      output_delta: {
        changed: true,
        output:
          "assistant: Old result.\n\ntool call shell: run checks\n\nassistant (still streaming): The candidate passed 20 of",
        voice_assistant_output: "assistant (still streaming): The candidate passed 20 of",
        voice_assistant_output_state: "streaming",
        voice_assistant_output_scope: "streaming_suffix",
      },
    };
    expect(
      directFocusedOutputSpeech("what has primary work said so far", state),
    ).toBe("Primary Work is still responding. So far: The candidate passed 20 of");
    expect(
      directFocusedOutputSpeech("what has side work said so far", state),
    ).toBeUndefined();
    expect(
      directFocusedOutputSpeech("what have primary work and side work said so far", state),
    ).toBeUndefined();
  });

  it("labels a typed finalized continuation as the final part of a response", () => {
    expect(
      directFocusedOutputSpeech("what's the latest now", {
        focused_session: { id: "session-primary", name: "Primary Work" },
        known_sessions: [
          { id: "session-primary", name: "Primary Work", focused: true },
        ],
        pending_decisions: [],
        updates: [],
        output_delta: {
          changed: true,
          output: "assistant (continued): 45 to 60 minutes.",
          voice_assistant_output: "assistant (continued): 45 to 60 minutes.",
          voice_assistant_output_state: "final",
          voice_assistant_output_scope: "continued",
        },
      }),
    ).toBe(
      "Primary Work finished that response. The final part says: 45 to 60 minutes.",
    );
  });

  it("speaks only short safe incremental poll results directly", () => {
    expect(
      directPollOutputResultSpeech({
        target_session: { id: "session-side", name: "Side Audit" },
        changed: true,
        output: "assistant: The retry passed all 20 checks.",
        cursor: "item-20",
        cursor_expired: false,
        updates: [],
      }),
    ).toBe("Side Audit update: The retry passed all 20 checks.");
    expect(
      directPollOutputResultSpeech({
        target_session: { id: "session-side", name: "Side Audit" },
        changed: false,
        output: "",
        cursor: "item-20",
        cursor_expired: false,
        updates: [],
      }),
    ).toBe("Side Audit has no new stable output since the last update.");
    expect(
      directPollOutputResultSpeech({
        target_session: { id: "session-side", name: "Side Audit" },
        changed: true,
        output: "assistant: This cursor can no longer prove continuity.",
        cursor: "item-20",
        cursor_expired: true,
        updates: [],
      }),
    ).toBeUndefined();
  });

  it("renders verified action receipts directly unless an update also needs speech", () => {
    expect(
      successfulActionSpeech("send_message", {
        accepted: true,
        delivery: "queued",
        target_session: { id: "session-1", name: "Primary Work" },
        updates: [],
      }),
    ).toBe("I queued that for Primary Work.");
    expect(
      successfulActionSpeech("rename_session", {
        renamed: true,
        previous_name: "Voice MVP",
        new_name: "Receipt Lab",
        updates: [],
      }),
    ).toBe("I renamed Voice MVP to Receipt Lab.");
    expect(
      successfulActionSpeech("archive_session", {
        archived: true,
        archived_session: { id: "session-side", name: "Receipt Lab" },
        focused_session: { id: "session-primary", name: "Primary Work" },
        updates: [],
      }),
    ).toBe("I archived Receipt Lab; you're back in Primary Work.");
    expect(
      successfulActionSpeech("answer_prompt", {
        resolved: true,
        action: "accept",
        target_session: { id: "session-cache", name: "Cache Worker" },
        updates: [],
      }),
    ).toBe("I approved the prompt for Cache Worker.");
    expect(
      successfulActionSpeech("answer_prompt", {
        resolved: true,
        action: "decline",
        target_session: { id: "session-release", name: "Release Deploy" },
        updates: [],
      }),
    ).toBe("I declined the prompt for Release Deploy.");
    expect(
      successfulActionSpeech("focus_session", {
        focus_changed: true,
        previous_focused_session: { id: "session-primary", name: "Primary Work" },
        focused_session: { id: "session-build", name: "Build Worker" },
        updates: [],
      }),
    ).toBe("I switched from Primary Work to Build Worker.");
    expect(
      successfulActionSpeech("send_message", {
        accepted: true,
        target_session: { id: "session-1", name: "Primary Work" },
        updates: [{ type: "session_completed" }],
      }),
    ).toBeUndefined();
    expect(
      verifiedActionFollowupSpeech(
        "wait so what part actually happened and where am i",
        "I sent that to Side Beta. I couldn't switch sessions.",
        { id: "session-primary", name: "Primary Work" },
      ),
    ).toBe(
      "I sent that to Side Beta. I couldn't switch sessions. You're in Primary Work.",
    );
    expect(
      verifiedActionFollowupSpeech(
        "can you check the output to verify what happened",
        "I sent that to Side Beta.",
        { id: "session-primary", name: "Primary Work" },
      ),
    ).toBeUndefined();
    expect(
      verifiedActionFollowupSpeech(
        "wait did both of those actually happen or are you just saying that",
        "I approved the prompt for Cache Worker. I declined the prompt for Release Deploy.",
        { id: "session-primary", name: "Primary Work" },
      ),
    ).toBe(
      "I approved the prompt for Cache Worker. I declined the prompt for Release Deploy. Those outcomes are recorded.",
    );
    expect(
      verifiedActionFollowupSpeech(
        "wait did both of those really happen and where am i now",
        "I approved the prompt for Release Setup. I sent that to Primary Work.",
        { id: "session-primary", name: "Primary Work" },
        2,
      ),
    ).toBe(
      "I approved the prompt for Release Setup. I sent that to Primary Work. Those outcomes are recorded. You're in Primary Work.",
    );
    expect(
      verifiedActionFollowupSpeech(
        "wait did both of those actually happen",
        "I approved the prompt for Release Deploy.",
        { id: "session-primary", name: "Primary Work" },
        1,
      ),
    ).toBeUndefined();
    expect(
      verifiedActionFollowupSpeech(
        "and did that approval actually go through",
        "I approved the prompt for Side Beta.",
        { id: "session-primary", name: "Primary Work" },
      ),
    ).toBe("I approved the prompt for Side Beta. That outcome is recorded.");
    expect(
      verifiedDeliveryVisibilitySpeech("is that message showing now", {
        target_session: { id: "session-primary", name: "Primary Work" },
        recent_delivery_visibility: {
          delivery: "immediate",
          status: "visible_on_page",
        },
        updates: [],
      }),
    ).toBe("It was sent, and the message is visible in Primary Work's output.");
    expect(
      verifiedDeliveryVisibilitySpeech("can you see it yet", {
        recent_delivery_visibility: {
          delivery: "immediate",
          status: "not_visible_on_page",
        },
        updates: [],
      }),
    ).toBe("It was sent, but the message isn't visible on the returned output page yet.");
    expect(
      verifiedQueuedDeliverySpeech(
        "wait did that queued message actually get sent and am i still in primary",
        [
          {
            type: "message_sent",
            delivery: "queued_after_turn",
            name: "Side Worker",
          },
        ],
        { id: "session-primary", name: "Primary Work" },
      ),
    ).toBe("The queued message was sent to Side Worker. You're in Primary Work.");
    expect(
      verifiedExactMessageSpeech(
        "wait read back what you actually sent and where am i still",
        [
          {
            type: "message_sent",
            name: "Release Work",
            message: "Memory Sweep failed 7 of 60 calls after a 9 gigabyte spike.",
          },
        ],
        { id: "session-release", name: "Release Work" },
      ),
    ).toBe(
      "I sent to Release Work: Memory Sweep failed 7 of 60 calls after a 9 gigabyte spike. " +
      "You're in Release Work.",
    );
    expect(
      verifiedExactMessageSpeech(
        "can you see whether that message is visible",
        [
          {
            type: "message_sent",
            name: "Release Work",
            message: "Run the checks.",
          },
        ],
        { id: "session-release", name: "Release Work" },
      ),
    ).toBeUndefined();
    expect(
      verifiedExactMessageSpeech(
        "what did the last message say",
        [
          {
            type: "message_sent",
            name: "Release Work",
            message: "Run the checks.",
          },
        ],
        { id: "session-release", name: "Release Work" },
      ),
    ).toBeUndefined();
    expect(
      verifiedToolWorkflowOutcome([
        {
          name: "get_output",
          result: {
            target_session: { id: "session-a", name: "Socket Probe" },
            updates: [],
          },
        },
        {
          name: "get_output",
          result: {
            target_session: { id: "session-b", name: "Poll Probe" },
            updates: [],
          },
        },
        {
          name: "send_message",
          result: {
            accepted: true,
            delivery: "immediate",
            target_session: { id: "session-primary", name: "Primary Work" },
            updates: [],
          },
        },
      ]),
    ).toEqual({
      ordered_steps: [
        { operation: "read", tool: "get_output", session: "Socket Probe" },
        { operation: "read", tool: "get_output", session: "Poll Probe" },
        {
          operation: "action",
          tool: "send_message",
          receipt: "I sent that to Primary Work.",
        },
      ],
    });
    const readExecutions = [
      {
        name: "get_output",
        result: { target_session: { id: "session-a", name: "Socket Probe" } },
      },
      {
        name: "get_output",
        result: { target_session: { id: "session-b", name: "Poll Probe" } },
      },
    ];
    expect(
      missingMultiSourceNames(
        "compare socket probe and poll probe",
        "Socket Probe passed, but the other result failed.",
        readExecutions,
      ),
    ).toEqual(["Poll Probe"]);
    expect(
      missingMultiSourceNames(
        "which one held up better",
        "Socket Probe passed while Poll Probe failed.",
        readExecutions,
      ),
    ).toEqual([]);
    expect(
      missingMultiSourceNames(
        "read both but only tell primary what socket probe said",
        "Socket Probe passed.",
        readExecutions,
      ),
    ).toEqual([]);
    expect(
      missingMultiSourceNumbers(
        "compare all three with all exact numbers",
        "Audio Sweep passed 60 while Network Sweep passed 58 of 60.",
        [
          {
            name: "get_output",
            result: {
              latest_message: { text: "Audio Sweep passed all 60 at 74 milliseconds." },
              target_session: { name: "Audio Sweep" },
            },
          },
          {
            name: "get_output",
            result: {
              latest_message: { text: "Network Sweep passed 58 of 60." },
              target_session: { name: "Network Sweep" },
            },
          },
        ],
      ),
    ).toEqual(["74"]);
    expect(
      missingMultiSourceNumbers(
        "compare all three with all exact numbers",
        "Audio Sweep passed 60 at 74 milliseconds; Network Sweep passed 58 of 60.",
        [
          {
            name: "get_output",
            result: { latest_message: { text: "Audio passed 60 at 74." } },
          },
          {
            name: "get_output",
            result: { latest_message: { text: "Network passed 58 of 60." } },
          },
        ],
      ),
    ).toEqual([]);
    const causeExecutions = [
      {
        name: "get_output",
        result: {
          latest_message: {
            text: "Network Sweep passed 58 of 60 calls; two reconnects timed out.",
          },
        },
      },
      {
        name: "get_output",
        result: {
          latest_message: {
            text:
              "Memory Sweep failed 7 of 60 calls when memory usage spiked by 9 gigabytes, making it the launch blocker.",
          },
        },
      },
    ];
    expect(
      missingMultiSourceCauseTerms(
        "compare them with all exact numbers and causes",
        "Network Sweep passed 58 of 60; two interconnects timed out. Memory Sweep failed 7 of 60 when memory spiked by 9 gigabytes and is blocking launch.",
        causeExecutions,
      ),
    ).toEqual(["reconnects"]);
    expect(
      missingMultiSourceCauseTerms(
        "compare them with all exact numbers and causes",
        "Network Sweep passed 58 of 60; two reconnects timed out. Memory Sweep failed 7 of 60 when memory spiked by 9 gigabytes and is blocking launch.",
        causeExecutions,
      ),
    ).toEqual([]);
  });

  it("only allows focus mutation for an explicit session switch", () => {
    expect(allowsFocusChange("Use the second one you mentioned.")).toBe(true);
    expect(allowsFocusChange("Switch to the voice agent session.")).toBe(true);
    expect(allowsFocusChange("What's the most recent output?")).toBe(false);
    expect(allowsFocusChange("Check the session we were already in.")).toBe(false);
    expect(allowsArchive("Archive this temporary session.")).toBe(true);
    expect(allowsArchive("What is this session doing?")).toBe(false);
    expect(allowsRename("Rename this session to Voice Research.")).toBe(true);
    expect(allowsRename("Call this session Voice Research.")).toBe(true);
    expect(allowsRename("What is this session called?")).toBe(false);
    expect(requestedRenameTitle("Rename this session to Voice Research.")).toBe(
      "Voice Research",
    );
    expect(requestedRenameTitle("rename this session audio packet research")).toBe(
      "audio packet research",
    );
    expect(
      requestedRenameTitle(
        "rename this session latency lab and then tell it rerun the endpoint probe",
      ),
    ).toBe("latency lab");
    expect(
      requestedRenameTitle(
        "rename this session latency lab and then switch me back to primary work",
      ),
    ).toBe("latency lab");
    expect(
      requestedRenameTitle(
        "rename this temporary session reconnect scratch and then archive it",
      ),
    ).toBe("reconnect scratch");
    expect(requestedRenameTitle("Call this session Voice Research.")).toBe(
      "Voice Research",
    );
    expect(requestedRenameTitle("can you rename the temporary session")).toBeUndefined();
    expect(
      requestsPositiveFocusAction("tell side beta to rerun it and switch me there"),
    ).toBe(true);
    expect(
      requestsPositiveFocusAction("tell side beta to rerun it but don't switch me"),
    ).toBe(false);
    expect(
      requestsPositiveFocusAction("tell it no wait focus on the discord cutoff first"),
    ).toBe(false);
    expect(requestsPositiveFocusAction("tell side beta open the log file")).toBe(
      false,
    );
    expect(requestsPositiveFocusAction("tell it to switch branches first")).toBe(false);
    expect(
      voiceMessageInstruction(
        "when side worker finishes queue it a message to rerun the reconnect test with packet logs and don't switch me",
        "Side Worker",
      ),
    ).toBe("rerun the reconnect test with packet logs");
    expect(
      voiceMessageInstruction(
        "tell side worker to rerun all 48 probes but don't switch me there",
        "Side Worker",
      ),
    ).toBe("rerun all 48 probes");
    expect(
      voiceMessageInstruction(
        "tell side beta rerun the voice worker then uh switch me to that one",
        "Side Beta",
      ),
    ).toBe("rerun the voice worker");
    expect(
      voiceMessageInstruction(
        "tell side beta to rerun the cutoff checks and uh if anything came in while i was saying that tell me too",
        "Side Beta",
      ),
    ).toBe("rerun the cutoff checks");
    expect(
      voiceMessageInstruction(
        "tell it to rerun the endpoint checks and uh if anything came in while i was talking tell me too",
      ),
    ).toBe("rerun the endpoint checks");
    expect(
      voiceMessageInstruction(
        "rename this session latency lab and then tell it rerun the endpoint probe with three warm samples",
      ),
    ).toBe("rerun the endpoint probe with three warm samples");
    expect(
      voiceMessageInstruction(
        "okay tell that one rerun the flaky reconnect test with debug logs",
        "Side Beta",
      ),
    ).toBe("rerun the flaky reconnect test with debug logs");
    expect(
      voiceMessageInstruction(
        "ask the other one to compare the packet timestamps",
        "Side Beta",
      ),
    ).toBe("compare the packet timestamps");
    expect(
      voiceMessageInstruction(
        "tell primary work what side worker found",
        "Primary Work",
      ),
    ).toBeUndefined();
    expect(
      Object.fromEntries(
        voiceMultipleMessageInstructions(
          "okay tell build worker to rerun the barge in test with phone audio and tell docs worker to write down the latency numbers but don't switch me",
          [
            { id: "session-build", name: "Build Worker" },
            { id: "session-docs", name: "Docs Worker" },
          ],
        ),
      ),
    ).toEqual({
      "session-build": "rerun the barge in test with phone audio",
      "session-docs": "write down the latency numbers",
    });
    expect(
      Object.fromEntries(
        voiceMultipleMessageInstructions(
          "tell build worker rerun the packet cutoff and tell docs worker write down first audio latency don't switch me",
          [
            { id: "session-build", name: "Build Worker" },
            { id: "session-docs", name: "Docs Worker" },
          ],
        ),
      ),
    ).toEqual({
      "session-build": "rerun the packet cutoff",
      "session-docs": "write down first audio latency",
    });
    expect(
      Object.fromEntries(
        voiceMultipleMessageInstructions(
          "send build worker a message to rerun the phone cutoff and let docs worker know the first audio was 180 milliseconds don't move me",
          [
            { id: "session-build", name: "Build Worker" },
            { id: "session-docs", name: "Docs Worker" },
          ],
        ),
      ),
    ).toEqual({
      "session-build": "rerun the phone cutoff",
      "session-docs": "the first audio was 180 milliseconds",
    });
    expect(
      Object.fromEntries(
        voiceNotificationMessageInstructions(
          "tell the first one rerun all 12 cutoff probes and tell the second one write down the 180 millisecond first audio number don't switch me",
          [
            { id: "session-alpha", name: "Side Alpha" },
            { id: "session-beta", name: "Side Beta" },
          ],
        ),
      ),
    ).toEqual({
      "session-alpha": "rerun all 12 cutoff probes",
      "session-beta": "write down the 180 millisecond first audio number",
    });
    expect(
      Object.fromEntries(
        voiceMultipleMessageInstructions(
          "uh tell docs worker to record the first audio timing and queue build worker a message to rerun the long reply after this turn don't move me",
          [
            { id: "session-docs", name: "Docs Worker" },
            { id: "session-build", name: "Build Worker" },
          ],
        ),
      ),
    ).toEqual({
      "session-docs": "record the first audio timing",
      "session-build": "rerun the long reply",
    });
    expect(targetsFocusedSession("Switch back to Primary Work.", "Primary Work")).toBe(true);
    expect(
      targetsFocusedSession(
        "Switch back to the Omnigent Voice Agent.",
        "Prepare Omnigent Voice Agent",
      ),
    ).toBe(true);
    expect(
      targetsFocusedSession("Switch from Primary Work to Side Research.", "Primary Work"),
    ).toBe(false);
    expect(
      voiceMessageRouting("tell side beta to rerun it", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      voiceMessageRouting(
        "when side beta wraps this one queue it to rerun the packet test",
        [
          { id: "session-primary", name: "Primary Work" },
          { id: "session-beta", name: "Side Beta" },
        ],
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    const notificationTargets = immediateNotificationTargets(
      [
        {
          role: "system",
          content:
            'Omnigent background update: [{"event_id":4,"session_id":"session-beta","name":"Old Side Beta"}]',
        },
        { role: "assistant", content: "Side Beta finished the reconnect check." },
      ],
      [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ],
    );
    expect(notificationTargets).toEqual([
      { id: "session-beta", name: "Side Beta" },
    ]);
    expect(
      voiceMessageRouting(
        "okay tell that one rerun the flaky reconnect test",
        [
          { id: "session-primary", name: "Primary Work" },
          { id: "session-beta", name: "Side Beta" },
        ],
        notificationTargets,
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      immediateNotificationTargets(
        [
          {
            role: "system",
            content:
              'Omnigent background update: [{"session_id":"session-beta","name":"Side Beta"}]',
          },
          { role: "assistant", content: "Side Beta finished." },
          { role: "user", content: "what is primary doing" },
          { role: "assistant", content: "Primary is still running." },
        ],
        [{ id: "session-beta", name: "Side Beta" }],
      ),
    ).toEqual([]);
    const notificationBurst = immediateNotificationTargets(
      [
        {
          role: "system",
          content:
            'Omnigent background update: [{"session_id":"session-alpha","name":"Side Alpha"}]',
        },
        { role: "assistant", content: "Side Alpha finished." },
        {
          role: "system",
          content:
            'Omnigent background update: [{"session_id":"session-beta","name":"Side Beta"}]',
        },
        { role: "assistant", content: "Side Beta finished." },
      ],
      [
        { id: "session-alpha", name: "Side Alpha" },
        { id: "session-beta", name: "Side Beta" },
      ],
    );
    expect(notificationBurst).toEqual([
      { id: "session-alpha", name: "Side Alpha" },
      { id: "session-beta", name: "Side Beta" },
    ]);
    expect(
      voiceMessageRouting(
        "tell the first one rerun the packet test",
        [],
        notificationBurst,
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-alpha", name: "Side Alpha" },
    });
    expect(
      voiceMessageRouting("tell that one rerun the test", [], notificationBurst),
    ).toEqual({ mode: "ambiguous", candidates: ["Side Alpha", "Side Beta"] });
    expect(
      voiceMessageRouting(
        "tell the first one rerun all 12 cutoff probes and tell the second one write down the 180 millisecond first audio number",
        [],
        notificationBurst,
      ),
    ).toEqual({
      mode: "multiple",
      candidates: ["Side Alpha", "Side Beta"],
      targets: [
        { id: "session-alpha", name: "Side Alpha" },
        { id: "session-beta", name: "Side Beta" },
      ],
    });
    expect(
      voiceMessageRouting(
        "tell the first one and tell the second one rerun it",
        [],
        notificationBurst,
      ),
    ).toEqual({ mode: "ambiguous", candidates: ["Side Alpha", "Side Beta"] });
    expect(voiceMessageRouting("tell it to rerun the test", [])).toEqual({
      mode: "focused",
    });
    expect(
      voiceMessageRouting("tell primary work what side beta found", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({
      mode: "named",
      target: { id: "session-primary", name: "Primary Work" },
    });
    expect(
      voiceMessageRouting("tell primary work and ask side beta to compare", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({ mode: "ambiguous", candidates: ["Primary Work", "Side Beta"] });
    expect(
      voiceMessageRouting(
        "switch me to build worker and tell me if anything else came in while i was saying that",
        [
          { id: "session-primary", name: "Primary Work" },
          { id: "session-build", name: "Build Worker" },
        ],
      ),
    ).toEqual({ mode: "focused" });
    expect(
      voiceMessageRouting("can you tell me what message came from side beta", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({ mode: "focused" });
    expect(
      voiceMessageRouting(
        "tell build worker to rerun phone audio and tell docs worker to record first audio",
        [
          { id: "session-build", name: "Build Worker" },
          { id: "session-docs", name: "Docs Worker" },
        ],
      ),
    ).toEqual({
      mode: "multiple",
      candidates: ["Build Worker", "Docs Worker"],
      targets: [
        { id: "session-build", name: "Build Worker" },
        { id: "session-docs", name: "Docs Worker" },
      ],
    });
    expect(
      voiceMessageRouting(
        "send build worker and let docs worker know the timing changed",
        [
          { id: "session-build", name: "Build Worker" },
          { id: "session-docs", name: "Docs Worker" },
        ],
      ),
    ).toEqual({ mode: "ambiguous", candidates: ["Build Worker", "Docs Worker"] });
    expect(
      voiceMessageRouting(
        "tell build worker rerun phone audio and tell docs worker record first audio",
        [
          { id: "session-build", name: "Build Worker" },
          { id: "session-docs", name: "Docs Worker" },
        ],
      ),
    ).toEqual({
      mode: "multiple",
      candidates: ["Build Worker", "Docs Worker"],
      targets: [
        { id: "session-build", name: "Build Worker" },
        { id: "session-docs", name: "Docs Worker" },
      ],
    });
    expect(
      voiceMessageRouting(
        "send build worker a message to rerun phone audio and let docs worker know the first audio was 180 milliseconds",
        [
          { id: "session-build", name: "Build Worker" },
          { id: "session-docs", name: "Docs Worker" },
        ],
      ),
    ).toEqual({
      mode: "multiple",
      candidates: ["Build Worker", "Docs Worker"],
      targets: [
        { id: "session-build", name: "Build Worker" },
        { id: "session-docs", name: "Docs Worker" },
      ],
    });
    expect(
      voiceFocusRouting("switch me over to side beta", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      voiceFocusRouting("switch from primary work to side beta", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      voiceFocusRouting("compare primary work and side beta", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({ mode: "model" });
    expect(
      voiceReadRouting("okay what's side beta doing with that now", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      voiceReadRouting("compare primary work and side beta", [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-beta", name: "Side Beta" },
      ]),
    ).toEqual({ mode: "model" });
    expect(
      voiceReadRouting(
        "tell primary work what side beta found",
        [
          { id: "session-primary", name: "Primary Work" },
          { id: "session-beta", name: "Side Beta" },
        ],
        { id: "session-primary", name: "Primary Work" },
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      voiceReadRouting(
        "yeah okay what's the last thing that one actually said",
        [],
        undefined,
        notificationTargets,
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      voiceReadRouting(
        "what did the second one say",
        [],
        undefined,
        notificationBurst,
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-beta", name: "Side Beta" },
    });
    expect(
      voiceReadRouting(
        "what did that one say",
        [],
        undefined,
        notificationBurst,
      ),
    ).toEqual({ mode: "ambiguous", candidates: ["Side Alpha", "Side Beta"] });
    expect(
      voiceReadRouting(
        "what's latest on this session",
        [],
        undefined,
        notificationTargets,
      ),
    ).toEqual({ mode: "model" });
    const contentlessNotificationHistory = [
      {
        role: "system",
        content:
          'Omnigent background update: [{"event_id":7,"type":"session_completed","session_id":"session-beta","name":"Side Beta"}]',
      },
      { role: "assistant", content: "Side Beta completed." },
    ];
    expect(
      requiresNotificationOutputRead(
        "yeah just a quick summary where it left off",
        contentlessNotificationHistory,
        { mode: "named", target: { id: "session-beta", name: "Side Beta" } },
        notificationTargets,
      ),
    ).toBe(true);
    const summarizedNotificationHistory = [
      {
        role: "system",
        content:
          'Omnigent background update: [{"event_id":7,"type":"session_completed","session_id":"session-beta","name":"Side Beta","summary":"Side Beta passed all eighteen checks."}]',
      },
      { role: "assistant", content: "Side Beta passed all eighteen checks." },
    ];
    expect(
      requiresNotificationOutputRead(
        "what was the update from that one",
        summarizedNotificationHistory,
        { mode: "named", target: { id: "session-beta", name: "Side Beta" } },
        notificationTargets,
      ),
    ).toBe(false);
    expect(
      requiresNotificationOutputRead(
        "what was the last thing that one actually said",
        summarizedNotificationHistory,
        { mode: "named", target: { id: "session-beta", name: "Side Beta" } },
        notificationTargets,
      ),
    ).toBe(true);
    expect(
      voiceRetryReadRouting(
        "can you try again",
        [
          { role: "user", content: "send primary work the audio note" },
          { role: "assistant", content: "I sent that to Primary Work." },
          { role: "user", content: "can we check in on the release login" },
          { role: "assistant", content: "I couldn't reach the coordination layer." },
          { role: "user", content: "release login" },
          { role: "assistant", content: "I couldn't reach the coordination layer." },
        ],
        [
          { id: "session-primary", name: "Primary Work" },
          { id: "session-release", name: "Release Login Audit" },
        ],
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-release", name: "Release Login Audit" },
    });
    expect(
      voiceRetryReadRouting(
        "release login",
        [
          { role: "user", content: "can we check in on the release work" },
          { role: "assistant", content: "I couldn't read that session output." },
        ],
        [
          { id: "session-primary", name: "Primary Work" },
          { id: "session-release", name: "Release Login Audit" },
        ],
      ),
    ).toEqual({
      mode: "named",
      target: { id: "session-release", name: "Release Login Audit" },
    });
    expect(
      voiceRetryReadRouting(
        "try again",
        [
          { role: "user", content: "send primary work the audio note" },
          { role: "assistant", content: "I couldn't send that message." },
        ],
        [{ id: "session-primary", name: "Primary Work" }],
      ),
    ).toBeUndefined();
    expect(
      voiceRetryReadRouting(
        "try again",
        [
          { role: "user", content: "check in on the login work" },
          { role: "assistant", content: "I couldn't reach the coordination layer." },
        ],
        [
          { id: "session-release", name: "Release Login" },
          { id: "session-auth", name: "Login Authentication" },
        ],
      ),
    ).toEqual({
      mode: "ambiguous",
      candidates: ["Release Login", "Login Authentication"],
    });
    expect(
      voiceStartInstruction("make a temporary session to test that receipt wording"),
    ).toBe("test that receipt wording");
    expect(
      voiceStartInstruction(
        "make a new session to profile the phone endpointing cutoff and tell me what came in while i was talking",
      ),
    ).toBe("profile the phone endpointing cutoff");
    expect(
      voiceStartInstruction(
        "make a new session to profile the cutoff and tell me how to reproduce it",
      ),
    ).toBe("profile the cutoff and tell me how to reproduce it");
    expect(
      voiceStartInstruction(
        "start a new session to investigate reconnect jitter and tell primary work keep its current branch until the benchmark finishes",
        ["Primary Work"],
      ),
    ).toBe("investigate reconnect jitter");
    expect(
      voiceStartInstruction(
        "make a new session called Reconnect Lab to investigate websocket jitter and tell primary work keep the release branch unchanged",
        ["Primary Work"],
      ),
    ).toBe("investigate websocket jitter");
    expect(
      voiceStartTitle(
        "make a new session called Reconnect Lab to investigate websocket jitter",
      ),
    ).toBe("Reconnect Lab");
    expect(
      voiceStartTitle("make a temporary session to test receipt wording"),
    ).toBeUndefined();
    expect(
      voiceStartInstruction(
        "make a side chat for check the audio cutoff then ask docs worker write down the current result",
        ["Docs Worker"],
      ),
    ).toBe("check the audio cutoff");
    expect(
      voiceStartInstruction(
        "make a new session to investigate primary work and tell me how to reproduce it",
        ["Primary Work"],
      ),
    ).toBe("investigate primary work and tell me how to reproduce it");
    expect(voiceStartInstruction("what is this session doing")).toBeUndefined();
  });

  it("injects the authoritative ID for an explicitly named focus target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-focus",
            type: "function",
            function: {
              name: "focus_session",
              arguments: JSON.stringify({ session_id: "session-beta}" }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: { id: "session-primary", name: "Primary Work" },
              known_sessions: [
                { id: "session-primary", name: "Primary Work" },
                { id: "session-beta", name: "Side Beta" },
              ],
              updates: [],
            }
          : {
              focus_changed: true,
              focused_session: { id: "session-beta", name: "Side Beta" },
              updates: [],
            },
      ),
    );

    await expect(
      conversation("test-key", tools).respond("Switch me over to Side Beta"),
    ).resolves.toBe("I switched to Side Beta.");
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "focus_session", {
      session_id: "session-beta",
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{
        function?: {
          name?: string;
          description?: string;
          parameters?: { properties?: Record<string, unknown> };
        };
      }>;
    };
    const focus = request.tools?.find((tool) => tool.function?.name === "focus_session");
    expect(focus?.function?.description).toContain("Side Beta");
    expect(focus?.function?.parameters?.properties).not.toHaveProperty("session_id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an unsupported declarative send correction from inspection", () => {
    expect(
      isDeclarativeMissedSend(
        "i'm looking and i don't see that message",
        [],
        "I've sent that message to Primary Work.",
      ),
    ).toBe(true);
    expect(
      isDeclarativeMissedSend(
        "no that testing delivery message isn't there either",
        [],
        "I've sent the delivery test to Primary Work.",
      ),
    ).toBe(true);
    expect(
      isDeclarativeMissedSend(
        "did it send or not because i can't see it",
        [{ type: "message_sent" }],
        "I've sent that to Primary Work.",
      ),
    ).toBe(false);
    expect(
      isDeclarativeMissedSend(
        "can you check whether it is visible",
        [],
        "I've sent that to Primary Work.",
      ),
    ).toBe(false);
  });

  it("answers an ordinary conversational turn directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ content: "Hello there." }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(conversation("test-key").respond("Hello")).resolves.toBe("Hello there.");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
      tools?: Array<{
        function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
      }>;
    };
    expect(request.tools).toHaveLength(4);
    expect(request.tools?.map((tool) => tool.function?.name)).not.toContain("focus_session");
    expect(request.tools?.map((tool) => tool.function?.name)).toContain("answer_prompt");
    expect(request.tools?.map((tool) => tool.function?.name)).toContain("poll_output");
    const send = request.tools?.find((tool) => tool.function?.name === "send_message");
    expect(send?.function?.parameters?.properties).not.toHaveProperty("session_id");
    expect(
      request.messages?.some((message) =>
        message.content?.includes('"context_measurement":"No token or page-count introspection'),
      ),
    ).toBe(true);
    expect(
      request.messages?.some((message) =>
        message.content?.includes("retained verbatim until 80 messages or 48000 characters"),
      ),
    ).toBe(true);
    expect(
      request.messages?.some((message) => message.content?.includes('"recent_actions":[]')),
    ).toBe(true);
    expect(request.messages?.slice(-2)).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("No coordinator action has happened"),
      }),
      { role: "user", content: "Hello" },
    ]);
  });

  it("retries one empty completion before returning speech", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: null, tool_calls: [] }))
      .mockResolvedValueOnce(response({ content: "You are in Primary Work." }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(conversation("test-key").respond("Where am I right now?")).resolves.toBe(
      "You are in Primary Work.",
    );
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(secondRequest.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("previous completion was empty"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offers focus mutation only on an explicit switch turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ content: "Voice MVP selected." }));
    vi.stubGlobal("fetch", fetchMock);

    await conversation("test-key").respond("Switch to the Voice MVP session.");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(request.tools?.map((tool) => tool.function?.name)).toContain("focus_session");
  });

  it("offers archive only on an explicit archive turn and fixes its target to focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({ content: "Archived the side task; you're back in Primary work." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await conversation("test-key").respond(
      "yeah that's enough archive this temporary thing",
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{
        function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
      }>;
    };
    const archive = request.tools?.find((tool) => tool.function?.name === "archive_session");
    expect(archive).toBeDefined();
    expect(archive?.function?.parameters?.properties).not.toHaveProperty("session_id");
  });

  it("offers rename only on an explicit rename turn and fixes its target to focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({ content: "Renamed Voice MVP to Audio Packet Research." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await conversation("test-key").respond(
      "Rename this session to Audio Packet Research.",
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{
        function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
      }>;
    };
    const rename = request.tools?.find((tool) => tool.function?.name === "rename_session");
    expect(rename).toBeDefined();
    expect(rename?.function?.parameters?.properties).toHaveProperty("title");
    expect(rename?.function?.parameters?.properties).not.toHaveProperty("session_id");
  });

  it("withholds local mutation tools when rename or archive is nested in a relay", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(response({ content: "Okay." })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await conversation("test-key").respond(
      "Tell Build Worker rename this session to reconnect audit and don't switch me",
    );
    await conversation("test-key").respond(
      "Tell Build Worker archive this session's old benchmark logs and don't switch me",
    );

    const requests = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as {
        tools?: Array<{ function?: { name?: string } }>;
      }
    );
    expect(requests[0]?.tools?.map((tool) => tool.function?.name)).not.toContain(
      "rename_session",
    );
    expect(requests[1]?.tools?.map((tool) => tool.function?.name)).not.toContain(
      "archive_session",
    );
  });

  it("asks for a missing rename title without calling Celeris", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      conversation("test-key").respond("Can you rename the temporary session?"),
    ).resolves.toBe("What would you like me to call the current session?");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("executes an MCP coordinator tool and voices the immediate result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Inspect the deployment" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ content: "I sent that to the active session." }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();

    await expect(conversation("test-key", tools).respond("Check the deployment")).resolves.toBe(
      "I sent that to the active session.",
    );
    expect(tools.callTool).toHaveBeenNthCalledWith(1, "check_updates", {
      after_event_id: 0,
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "send_message", {
      message: "Inspect the deployment",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not execute a tool chosen by a superseded model turn", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      return response({
        content: null,
        tool_calls: [
          {
            id: "call-stale",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ message: "Only the first fragment" }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    const subject = conversation("test-key", tools);

    await expect(
      subject.respond(
        "Can you send a message for me",
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      subject.respond("did you send the message I just asked you to"),
    ).resolves.toBe("No. You hadn't told me what message to send yet. What should I send?");
    expect(tools.callTool).toHaveBeenCalledTimes(2);
    expect(tools.callTool).toHaveBeenNthCalledWith(1, "check_updates", {
      after_event_id: 0,
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "check_updates", {
      after_event_id: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes an explicitly named send without exposing its session id to the model", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Rer worker" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ content: "I sent that to Side Beta." }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: { id: "session-primary", name: "Primary Work" },
              known_sessions: [
                { id: "session-primary", name: "Primary Work" },
                { id: "session-beta", name: "Side Beta" },
              ],
              updates: [],
            }
          : { accepted: true, target_session: { id: "session-beta", name: "Side Beta" } },
      ),
    );

    await expect(
      conversation("test-key", tools).respond(
        "tell side beta to rerun the worker but don't switch me there",
      ),
    ).resolves.toBe("I sent that to Side Beta.");
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "send_message", {
      message: "rerun the worker",
      session_id: "session-beta",
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{
        function?: {
          name?: string;
          description?: string;
          parameters?: { properties?: Record<string, unknown> };
        };
      }>;
    };
    const send = request.tools?.find((tool) => tool.function?.name === "send_message");
    expect(send?.function?.description).toContain("Side Beta");
    expect(send?.function?.parameters?.properties).not.toHaveProperty("session_id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes distinct instructions to multiple explicit names without exposing ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-build",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({
                target: "Build Worker",
                message: "rerun phone audio",
                delivery: "queued",
              }),
            },
          },
          {
            id: "call-docs",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({
                target: "Docs Worker",
                message: "record first audio",
              }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string, args) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-build", name: "Build Worker" },
            { id: "session-docs", name: "Docs Worker" },
          ],
          updates: [],
        });
      }
      const target = args.session_id === "session-build" ? "Build Worker" : "Docs Worker";
      return Promise.resolve({
        accepted: true,
        delivery: args.delivery,
        target_session: { id: args.session_id, name: target },
        updates: [],
      });
    });

    await expect(
      conversation("test-key", tools).respond(
        "tell build worker to rerun phone audio now and tell docs worker to record first audio after this turn don't switch",
      ),
    ).resolves.toBe("I sent that to Build Worker. I queued that for Docs Worker.");
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "send_message", {
      message: "rerun phone audio",
      delivery: "immediate",
      session_id: "session-build",
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "send_message", {
      message: "record first audio",
      delivery: "queued",
      session_id: "session-docs",
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{
        function?: {
          name?: string;
          parameters?: {
            required?: string[];
            properties?: Record<string, { enum?: string[] }>;
          };
        };
      }>;
    };
    const send = request.tools?.find((tool) => tool.function?.name === "send_message");
    expect(send?.function?.parameters?.required).toContain("target");
    expect(send?.function?.parameters?.properties?.target?.enum).toEqual([
      "Build Worker",
      "Docs Worker",
    ]);
    expect(send?.function?.parameters?.properties).not.toHaveProperty("session_id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("injects the authoritative ID for an explicitly named output read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-read",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-side}" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ content: "Side Worker is collecting packet logs now." }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: { id: "session-primary", name: "Primary Work" },
              known_sessions: [
                { id: "session-primary", name: "Primary Work" },
                { id: "session-side", name: "Side Worker" },
              ],
              updates: [],
            }
          : {
              target_session: { id: "session-side", name: "Side Worker" },
              latest_message: { role: "assistant", text: "Collecting packet logs now." },
              updates: [],
            },
      ),
    );

    await expect(
      conversation("test-key", tools).respond("okay what's side worker doing now"),
    ).resolves.toBe("Side Worker update: Collecting packet logs now.");
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "get_output", {
      session_id: "session-side",
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{
        function?: {
          name?: string;
          description?: string;
          parameters?: { properties?: Record<string, unknown> };
        };
      }>;
    };
    const read = request.tools?.find((tool) => tool.function?.name === "get_output");
    expect(read?.function?.description).toContain("Side Worker");
    expect(read?.function?.parameters?.properties).not.toHaveProperty("session_id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("speaks an explicitly requested latest user message without another model round", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-latest-user",
            type: "function",
            function: { name: "get_output", arguments: "{}" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: { id: "session-primary", name: "Primary Work" },
              known_sessions: [{ id: "session-primary", name: "Primary Work" }],
              updates: [],
            }
          : {
              target_session: { id: "session-primary", name: "Primary Work" },
              latest_message: {
                role: "user",
                text: "There is a newer follow-up message.",
              },
              updates: [],
            },
      ),
    );

    await expect(
      conversation("test-key", tools).respond(
        "do you see a message from me more recently",
      ),
    ).resolves.toBe(
      "Primary Work latest user message: There is a newer follow-up message.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("injects the authoritative ID for a read following a spoken notification", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-read-notification",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-primary" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ content: "The route audit passed all checks." }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: { id: "session-primary", name: "Primary Work" },
              known_sessions: [{ id: "session-primary", name: "Primary Work" }],
              updates: [],
              update_cursor: 7,
            }
          : {
              target_session: { id: "session-side", name: "Side Audit" },
              latest_message: {
                role: "assistant",
                text: "The route audit passed all checks.",
              },
              updates: [],
            },
      ),
    );
    const subject = conversation("test-key", tools);
    subject.restoreHistory([
      {
        role: "system",
        content:
          'Omnigent background update: [{"event_id":7,"type":"session_completed","session_id":"session-side","name":"Side Audit","summary":"Side Audit completed."}]',
      },
      { role: "assistant", content: "Side Audit completed." },
    ]);

    await expect(
      subject.respond("yeah okay what's the last thing that one actually said"),
    ).resolves.toBe("Side Audit update: The route audit passed all checks.");
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "get_output", {
      session_id: "session-side",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tool_choice?: unknown;
      tools?: Array<{
        function?: {
          name?: string;
          description?: string;
          parameters?: { properties?: Record<string, unknown> };
        };
      }>;
    };
    expect(request.tool_choice).toEqual({
      type: "function",
      function: { name: "get_output" },
    });
    const read = request.tools?.find((tool) => tool.function?.name === "get_output");
    expect(read?.function?.description).toContain("Side Audit");
    expect(read?.function?.parameters?.properties).not.toHaveProperty("session_id");
  });

  it("retains and advances a spoken notification's output cursor across voice turns", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-poll-first",
              type: "function",
              function: { name: "poll_output", arguments: "{}" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-poll-second",
              type: "function",
              function: { name: "poll_output", arguments: "{}" },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    let pollCount = 0;
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-release", name: "Release Work" },
          known_sessions: [
            { id: "session-release", name: "Release Work" },
            { id: "session-side", name: "Side Audit" },
          ],
          updates: [],
          update_cursor: 610,
        });
      }
      pollCount += 1;
      return Promise.resolve(
        pollCount === 1
          ? {
              target_session: { id: "session-side", name: "Side Audit" },
              changed: true,
              output: "assistant: The retry passed all 20 checks.",
              cursor: "item-20",
              cursor_expired: false,
              updates: [],
            }
          : {
              target_session: { id: "session-side", name: "Side Audit" },
              changed: false,
              output: "",
              cursor: "item-20",
              cursor_expired: false,
              updates: [],
            },
      );
    });
    const subject = conversation("test-key", tools);
    subject.acknowledgeSpokenUpdates(
      [
        {
          event_id: 610,
          type: "session_output",
          session_id: "session-side",
          name: "Side Audit",
          status: "running",
          output_delta: {
            changed: true,
            output: "assistant: The initial batch passed all 18 checks.",
            cursor: "item-18",
          },
        },
      ],
      "Side Audit update: The initial batch passed all 18 checks.",
    );

    await expect(
      subject.respond("okay uh anything newer from that one since that update"),
    ).resolves.toBe("Side Audit update: The retry passed all 20 checks.");
    await expect(
      subject.respond("and anything newer from side audit after that now"),
    ).resolves.toBe("Side Audit has no new stable output since the last update.");

    expect(tools.callTool).toHaveBeenNthCalledWith(1, "check_updates", {
      after_event_id: 610,
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "poll_output", {
      session_id: "session-side",
      cursor: "item-18",
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "check_updates", {
      after_event_id: 610,
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(4, "poll_output", {
      session_id: "session-side",
      cursor: "item-20",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tool_choice?: { function?: { name?: string } };
      tools?: Array<{
        function?: {
          name?: string;
          parameters?: { properties?: Record<string, unknown> };
        };
      }>;
    };
    expect(firstRequest.tool_choice?.function?.name).toBe("poll_output");
    const poll = firstRequest.tools?.find(
      (tool) => tool.function?.name === "poll_output",
    );
    expect(poll?.function?.parameters?.properties).not.toHaveProperty("session_id");
    expect(poll?.function?.parameters?.properties).not.toHaveProperty("cursor");
  });

  it("treats a spoken backend notification as authoritative when asked whether the agent responded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-send-question",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Does the integration support notifications?" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: "Yes. Voice Work says it supports notifications with polling fallback.",
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: "Yes. Voice Work says it supports notifications with polling fallback.",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: { id: "session-voice", name: "Voice Work" },
              known_sessions: [{ id: "session-voice", name: "Voice Work" }],
              updates: [],
              update_cursor: 40,
            }
          : {
              accepted: true,
              delivery: "immediate",
              target_session: { id: "session-voice", name: "Voice Work" },
              updates: [],
            },
      ),
    );
    const subject = conversation("test-key", tools);

    await expect(
      subject.respond("ask it whether the integration supports notifications"),
    ).resolves.toBe("I sent that to Voice Work.");
    subject.acknowledgeSpokenUpdates(
      [
        {
          event_id: 41,
          type: "session_output",
          session_id: "session-voice",
          name: "Voice Work",
          status: "running",
          output_delta: {
            changed: true,
            output: "assistant: It supports notifications with polling fallback.",
            cursor: "item-41",
          },
        },
      ],
      "Voice Work says it supports notifications with polling fallback.",
    );

    await expect(subject.respond("did we get a response")).resolves.toBe(
      "Yes. Voice Work says it supports notifications with polling fallback.",
    );
    await expect(
      subject.respond("and it didn't get back to us with anything"),
    ).resolves.toBe(
      "Yes. Voice Work says it supports notifications with polling fallback.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retains an output event consumed alongside a human turn", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-poll-after-human-turn",
            type: "function",
            function: { name: "poll_output", arguments: "{}" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    let checkCount = 0;
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        checkCount += 1;
        return Promise.resolve(
          checkCount === 1
            ? {
                focused_session: { id: "session-release", name: "Release Work" },
                known_sessions: [
                  { id: "session-release", name: "Release Work" },
                  { id: "session-side", name: "Side Audit" },
                ],
                updates: [
                  {
                    event_id: 620,
                    type: "session_output",
                    session_id: "session-side",
                    name: "Side Audit",
                    output_delta: {
                      changed: true,
                      output: "assistant: The retry passed all 24 checks.",
                      cursor: "item-24",
                    },
                  },
                ],
                update_cursor: 620,
              }
            : {
                focused_session: { id: "session-release", name: "Release Work" },
                known_sessions: [
                  { id: "session-release", name: "Release Work" },
                  { id: "session-side", name: "Side Audit" },
                ],
                updates: [],
                update_cursor: 620,
              },
        );
      }
      return Promise.resolve({
        target_session: { id: "session-side", name: "Side Audit" },
        changed: true,
        output: "assistant: A final phone run passed all 25 checks.",
        cursor: "item-25",
        cursor_expired: false,
        updates: [],
      });
    });
    const subject = conversation("test-key", tools);

    await expect(
      subject.respond("uh while i was talking did anything new just come in"),
    ).resolves.toBe("Side Audit update: The retry passed all 24 checks.");
    await expect(
      subject.respond("okay uh anything newer from that one since then"),
    ).resolves.toBe("Side Audit update: A final phone run passed all 25 checks.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tools.callTool).toHaveBeenNthCalledWith(1, "check_updates", {
      after_event_id: 0,
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "check_updates", {
      after_event_id: 620,
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "poll_output", {
      session_id: "session-side",
      cursor: "item-24",
    });
  });

  it("retains a concurrent output event returned by an action tool", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-send-with-update",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "rerun the build" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-poll-after-action",
              type: "function",
              function: { name: "poll_output", arguments: "{}" },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    let checkCount = 0;
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        checkCount += 1;
        return Promise.resolve({
          focused_session: { id: "session-release", name: "Release Work" },
          known_sessions: [
            { id: "session-release", name: "Release Work" },
            { id: "session-side", name: "Side Audit" },
          ],
          updates: [],
          update_cursor: checkCount === 1 ? 0 : 630,
        });
      }
      if (name === "send_message") {
        return Promise.resolve({
          accepted: true,
          delivery: "immediate",
          target_session: { id: "session-release", name: "Release Work" },
          updates: [
            {
              event_id: 630,
              type: "session_output",
              session_id: "session-side",
              name: "Side Audit",
              output_delta: {
                changed: true,
                output: "assistant: The packet check passed.",
                cursor: "item-30",
              },
            },
          ],
          update_cursor: 630,
        });
      }
      return Promise.resolve({
        target_session: { id: "session-side", name: "Side Audit" },
        changed: false,
        output: "",
        cursor: "item-30",
        cursor_expired: false,
        updates: [],
      });
    });
    const subject = conversation("test-key", tools);

    await expect(subject.respond("tell it to rerun the build")).resolves.toBe(
      "I sent that to Release Work. Side Audit update: The packet check passed.",
    );
    await expect(
      subject.respond("anything newer from that one since then"),
    ).resolves.toBe("Side Audit has no new stable output since the last update.");

    expect(tools.callTool).toHaveBeenNthCalledWith(4, "poll_output", {
      session_id: "session-side",
      cursor: "item-30",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a named action before answering a redundant incoming-update question", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-send-before-update-reply",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ message: "rerun the cutoff checks" }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-side-beta", name: "Side Beta" },
            { id: "session-audit", name: "Audit Sweep" },
          ],
          updates: [],
          update_cursor: 0,
        });
      }
      return Promise.resolve({
        accepted: true,
        delivery: "immediate",
        target_session: { id: "session-side-beta", name: "Side Beta" },
        focused_session: { id: "session-primary", name: "Primary Work" },
        updates: [
          {
            event_id: 701,
            type: "session_output",
            session_id: "session-audit",
            name: "Audit Sweep",
            output_delta: {
              changed: true,
              output: "assistant: The queue soak passed 31 checks with zero dropped events.",
              cursor: "audit-31",
            },
          },
        ],
        update_cursor: 701,
      });
    });
    const subject = conversation("test-key", tools);

    await expect(
      subject.respond(
        "tell side beta to rerun the cutoff checks and uh if anything came in while i was saying that tell me too",
      ),
    ).resolves.toBe(
      "I sent that to Side Beta. Audit Sweep update: The queue soak passed 31 checks with zero dropped events.",
    );

    expect(tools.callTool).toHaveBeenCalledTimes(2);
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "send_message", {
      message: "rerun the cutoff checks",
      session_id: "session-side-beta",
    });
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tool_choice?: { function?: { name?: string } };
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(firstRequest.tool_choice?.function?.name).toBe("send_message");
    expect(firstRequest.tools?.map((tool) => tool.function?.name)).not.toContain(
      "get_output",
    );
    expect(firstRequest.tools?.map((tool) => tool.function?.name)).not.toContain(
      "poll_output",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes every named send before reporting an update present at speech finalization", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-build-before-update-reply",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  target: "Build Worker",
                  message: "shortened by model",
                }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-docs-before-update-reply",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  target: "Docs Worker",
                  message: "also shortened",
                }),
              },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string, args) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-build", name: "Build Worker" },
            { id: "session-docs", name: "Docs Worker" },
            { id: "session-audit", name: "Audit Sweep" },
          ],
          pending_decisions: [],
          output_delta: { changed: false, output: "" },
          updates: [
            {
              event_id: 1501,
              type: "session_output",
              session_id: "session-audit",
              name: "Audit Sweep",
              output_delta: {
                changed: true,
                output: "assistant: The queue soak passed 31 checks with zero dropped events.",
                cursor: "audit-31",
              },
            },
          ],
          update_cursor: 1501,
        });
      }
      const target = args.session_id === "session-build"
        ? { id: "session-build", name: "Build Worker" }
        : { id: "session-docs", name: "Docs Worker" };
      return Promise.resolve({
        accepted: true,
        delivery: "immediate",
        target_session: target,
        focused_session: { id: "session-primary", name: "Primary Work" },
        updates: [],
        update_cursor: 1501,
      });
    });
    const subject = conversation("test-key", tools);

    await expect(
      subject.respond(
        "tell build worker rerun the flaky reconnect probe with debug logs and tell docs worker write down the first audio latency and uh if anything came in while i was talking tell me too",
      ),
    ).resolves.toBe(
      "I sent that to Build Worker. I sent that to Docs Worker. Audit Sweep update: The queue soak passed 31 checks with zero dropped events.",
    );

    expect(tools.callTool).toHaveBeenCalledTimes(3);
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "send_message", {
      message: "rerun the flaky reconnect probe with debug logs",
      session_id: "session-build",
      delivery: "immediate",
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "send_message", {
      message: "write down the first audio latency",
      session_id: "session-docs",
      delivery: "immediate",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const request = JSON.parse(String(call[1]?.body)) as {
        tool_choice?: { function?: { name?: string } };
      };
      expect(request.tool_choice?.function?.name).toBe("send_message");
    }
  });

  it("clarifies an ambiguous notification read without invoking the model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockResolvedValue({
      focused_session: { id: "session-primary", name: "Primary Work" },
      known_sessions: [
        { id: "session-primary", name: "Primary Work" },
        { id: "session-alpha", name: "Side Alpha" },
        { id: "session-beta", name: "Side Beta" },
      ],
      updates: [],
      update_cursor: 82,
    });
    const subject = conversation("test-key", tools);
    subject.restoreHistory([
      {
        role: "system",
        content:
          'Omnigent background update: [{"event_id":81,"session_id":"session-alpha","name":"Side Alpha"}]',
      },
      { role: "assistant", content: "Side Alpha completed." },
      {
        role: "system",
        content:
          'Omnigent background update: [{"event_id":82,"session_id":"session-beta","name":"Side Beta"}]',
      },
      { role: "assistant", content: "Side Beta completed." },
    ]);

    await expect(
      subject.respond("wait what did that one actually say"),
    ).resolves.toBe("Which session do you mean, Side Alpha or Side Beta?");
    expect(tools.callTool).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("speaks a deterministic failure and skips another model call after a tool error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ message: "Please run the checks" }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) =>
      Promise.resolve(
        name === "check_updates"
          ? { updates: [] }
          : { error: "backend unavailable", updates: [] },
      ),
    );

    await expect(conversation("test-key", tools).respond("Send the checks now")).resolves.toBe(
      "I couldn't send that message.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves completed action receipts when another action in the turn fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-send",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ message: "Rerun the voice worker" }),
            },
          },
          {
            id: "call-focus",
            type: "function",
            function: {
              name: "focus_session",
              arguments: JSON.stringify({ session_id: "session-beta" }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-beta", name: "Side Beta" },
          ],
          updates: [],
        });
      }
      if (name === "send_message") {
        return Promise.resolve({
          accepted: true,
          delivery: "immediate",
          target_session: { id: "session-beta", name: "Side Beta" },
          updates: [],
        });
      }
      return Promise.resolve({ error: "target disappeared", updates: [] });
    });

    await expect(
      conversation("test-key", tools).respond(
        "Tell Side Beta to rerun the voice worker, then switch me over there",
      ),
    ).resolves.toBe("I sent that to Side Beta. I couldn't switch sessions.");
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "send_message", {
      message: "rerun the voice worker",
      session_id: "session-beta",
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "focus_session", {
      session_id: "session-beta",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("combines verified receipts for multiple successful actions without another model call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-send",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ message: "Rerun the voice worker" }),
            },
          },
          {
            id: "call-focus",
            type: "function",
            function: {
              name: "focus_session",
              arguments: JSON.stringify({ session_id: "session-beta" }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-beta", name: "Side Beta" },
          ],
          updates: [],
        });
      }
      if (name === "send_message") {
        return Promise.resolve({
          accepted: true,
          delivery: "immediate",
          target_session: { id: "session-beta", name: "Side Beta" },
          updates: [],
        });
      }
      return Promise.resolve({
        focus_changed: true,
        focused_session: { id: "session-beta", name: "Side Beta" },
        updates: [],
      });
    });

    await expect(
      conversation("test-key", tools).respond(
        "Tell Side Beta to rerun the voice worker, then switch me over there",
      ),
    ).resolves.toBe("I sent that to Side Beta. I switched to Side Beta.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("combines a verified action with safe named output and audits the current action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-approve",
            type: "function",
            function: {
              name: "answer_prompt",
              arguments: JSON.stringify({
                session_id: "session-release",
                prompt_id: "prompt-staging-migration",
                action: "accept",
              }),
            },
          },
          {
            id: "call-read",
            type: "function",
            function: {
              name: "get_output",
              arguments: JSON.stringify({ page: 1, session_id: "session-side" }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    let resolved = false;
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-side", name: "Side Worker" },
            { id: "session-release", name: "Release Deploy" },
          ],
          pending_decisions: resolved
            ? []
            : [{ session_id: "session-release", name: "Release Deploy" }],
          updates: [],
        });
      }
      if (name === "answer_prompt") {
        resolved = true;
        return Promise.resolve({
          resolved: true,
          action: "accept",
          target_session: { id: "session-release", name: "Release Deploy" },
          updates: [],
        });
      }
      return Promise.resolve({
        target_session: { id: "session-side", name: "Side Worker" },
        latest_message: {
          role: "assistant",
          text: "The websocket rerun reached stream three.",
        },
        updates: [],
      });
    });
    const subject = conversation("test-key", tools);
    const actionReceipt = "I approved the prompt for Release Deploy.";

    await expect(
      subject.respond(
        "yeah approve the release migration one and what's side worker doing now",
      ),
    ).resolves.toBe(
      `${actionReceipt} Side Worker update: The websocket rerun reached stream three.`,
    );
    await expect(
      subject.respond(
        "did that migration approval actually go through and where am i",
      ),
    ).resolves.toBe(`${actionReceipt} That outcome is recorded. You're in Primary Work.`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders multiple verified prompt resolutions and answers the immediate audit without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-accept",
            type: "function",
            function: {
              name: "answer_prompt",
              arguments: JSON.stringify({
                session_id: "session-cache",
                prompt_id: "prompt-cache-restart",
                action: "accept",
              }),
            },
          },
          {
            id: "call-decline",
            type: "function",
            function: {
              name: "answer_prompt",
              arguments: JSON.stringify({
                session_id: "session-release",
                prompt_id: "prompt-production-deploy",
                action: "decline",
              }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    let resolved = false;
    vi.mocked(tools.callTool).mockImplementation(
      (name: string, args: Record<string, unknown>) => {
        if (name === "check_updates") {
          return Promise.resolve({
            focused_session: { id: "session-primary", name: "Primary Work" },
            pending_decisions: resolved
              ? []
              : [
                  { session_id: "session-cache", name: "Cache Worker" },
                  { session_id: "session-release", name: "Release Deploy" },
                ],
            updates: [],
          });
        }
        if (args.prompt_id === "prompt-cache-restart") {
          return Promise.resolve({
            resolved: true,
            action: "accept",
            target_session: { id: "session-cache", name: "Cache Worker" },
            updates: [],
          });
        }
        resolved = true;
        return Promise.resolve({
          resolved: true,
          action: "decline",
          target_session: { id: "session-release", name: "Release Deploy" },
          updates: [],
        });
      },
    );
    const subject = conversation("test-key", tools);
    const receipt =
      "I approved the prompt for Cache Worker. I declined the prompt for Release Deploy.";

    await expect(
      subject.respond(
        "yeah okay let the cache restart one go ahead but uh no decline the production deploy",
      ),
    ).resolves.toBe(receipt);
    await expect(
      subject.respond("wait did both of those actually happen or are you just saying that"),
    ).resolves.toBe(`${receipt} Those outcomes are recorded.`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tools.callTool).toHaveBeenCalledTimes(4);
  });

  it("carries an ordered verified read-before-send workflow into the next model turn", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-socket",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-socket" }),
              },
            },
            {
              id: "call-poll",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-poll" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-send",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  message:
                    "Socket Probe passed all runs while Poll Probe reset its cursor.",
                }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content:
            "I checked both Socket Probe and Poll Probe before sending that to Primary Work. You're in Primary Work.",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    let sent = false;
    vi.mocked(tools.callTool).mockImplementation(
      (name: string, args: Record<string, unknown>) => {
        if (name === "check_updates") {
          return Promise.resolve({
            focused_session: { id: "session-primary", name: "Primary Work" },
            known_sessions: [
              { id: "session-primary", name: "Primary Work" },
              { id: "session-socket", name: "Socket Probe" },
              { id: "session-poll", name: "Poll Probe" },
            ],
            recent_actions: sent
              ? [
                  {
                    type: "message_sent",
                    name: "Primary Work",
                    message:
                      "Socket Probe passed all runs while Poll Probe reset its cursor.",
                  },
                ]
              : [],
            updates: [],
          });
        }
        if (name === "get_output") {
          const socket = args.session_id === "session-socket";
          return Promise.resolve({
            target_session: {
              id: String(args.session_id),
              name: socket ? "Socket Probe" : "Poll Probe",
            },
            latest_message: {
              role: "assistant",
              text: socket ? "Socket passed all runs." : "Poll reset its cursor.",
            },
            updates: [],
          });
        }
        sent = true;
        return Promise.resolve({
          accepted: true,
          delivery: "immediate",
          target_session: { id: "session-primary", name: "Primary Work" },
          updates: [],
        });
      },
    );
    const subject = conversation("test-key", tools);

    await expect(
      subject.respond(
        "check socket probe and poll probe then tell primary work which held up",
      ),
    ).resolves.toContain("I sent that to Primary Work.");
    await expect(
      subject.respond("did you really check both before telling it and where am i"),
    ).resolves.toContain("You're in Primary Work.");

    const auditRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const coordinatorState = auditRequest.messages?.find(
      (message) =>
        message.role === "system" &&
        message.content?.startsWith("Current coordinator state."),
    )?.content;
    expect(coordinatorState).toContain(
      '"last_verified_tool_workflow":{"ordered_steps":[{"operation":"read","tool":"get_output","session":"Socket Probe"},{"operation":"read","tool":"get_output","session":"Poll Probe"},{"operation":"action","tool":"send_message","receipt":"I sent that to Primary Work."}]}',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("defers a send composed in the same completion as its source read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-read",
              type: "function",
              function: { name: "get_output", arguments: "{}" },
            },
            {
              id: "call-early-send",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Use the result from Source Probe." }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-grounded-send",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  message: "Source Probe found that the cursor reset after reconnect.",
                }),
              },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-source", name: "Source Probe" },
          ],
          updates: [],
        });
      }
      if (name === "get_output") {
        return Promise.resolve({
          target_session: { id: "session-source", name: "Source Probe" },
          latest_message: {
            role: "assistant",
            text: "The cursor reset after reconnect.",
          },
          updates: [],
        });
      }
      return Promise.resolve({
        accepted: true,
        delivery: "immediate",
        target_session: { id: "session-primary", name: "Primary Work" },
        updates: [],
      });
    });

    await expect(
      conversation("test-key", tools).respond(
        "check source probe and tell primary work what it found",
      ),
    ).resolves.toBe(
      "Source Probe update: The cursor reset after reconnect. I sent that to Primary Work.",
    );
    expect(tools.callTool).toHaveBeenCalledTimes(3);
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "get_output", {
      session_id: "session-source",
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "send_message", {
      message: "Source Probe found that the cursor reset after reconnect.",
      session_id: "session-primary",
    });
    const groundedRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      tool_choice?: unknown;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(groundedRequest.tool_choice).toEqual({
      type: "function",
      function: { name: "send_message" },
    });
    expect(groundedRequest.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-early-send",
      content: expect.stringContaining("No message was sent"),
    });
    expect(groundedRequest.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("Do not repeat the reads"),
    });
  });

  it("does not send a multi-source comparison until every source is named", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-alpha",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-alpha" }),
              },
            },
            {
              id: "call-beta",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-beta" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-incomplete-send",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Alpha Probe passed all runs." }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-complete-send",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  message: "Alpha Probe passed all runs while Beta Probe reset its cursor.",
                }),
              },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation(
      (name: string, args: Record<string, unknown>) => {
        if (name === "check_updates") {
          return Promise.resolve({
            focused_session: { id: "session-primary", name: "Primary Work" },
            known_sessions: [
              { id: "session-primary", name: "Primary Work" },
              { id: "session-alpha", name: "Alpha Probe" },
              { id: "session-beta", name: "Beta Probe" },
            ],
            updates: [],
          });
        }
        if (name === "get_output") {
          const alpha = args.session_id === "session-alpha";
          return Promise.resolve({
            target_session: {
              id: String(args.session_id),
              name: alpha ? "Alpha Probe" : "Beta Probe",
            },
            latest_message: {
              role: "assistant",
              text: alpha ? "Passed all runs." : "Reset its cursor.",
            },
            updates: [],
          });
        }
        return Promise.resolve({
          accepted: true,
          delivery: "immediate",
          target_session: { id: "session-primary", name: "Primary Work" },
          updates: [],
        });
      },
    );

    await expect(
      conversation("test-key", tools).respond(
        "check alpha probe and beta probe and tell primary work which one passed",
      ),
    ).resolves.toContain("I sent that to Primary Work.");
    expect(tools.callTool).toHaveBeenCalledTimes(4);
    expect(tools.callTool).toHaveBeenLastCalledWith("send_message", {
      message: "Alpha Probe passed all runs while Beta Probe reset its cursor.",
      session_id: "session-primary",
    });
    const retriedRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      tool_choice?: unknown;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(retriedRequest.tool_choice).toEqual({
      type: "function",
      function: { name: "send_message" },
    });
    expect(retriedRequest.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-incomplete-send",
      content: expect.stringContaining("Beta Probe"),
    });
  });

  it("does not send an exact multi-source relay until every numeric fact is present", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-alpha-numbers",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-alpha" }),
              },
            },
            {
              id: "call-beta-numbers",
              type: "function",
              function: {
                name: "get_output",
                arguments: JSON.stringify({ session_id: "session-beta" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-incomplete-numbers",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  message:
                    "Alpha Probe passed all 60 calls while Beta Probe passed 58 of 60 after two interconnects timing out.",
                }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-complete-numbers",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  message:
                    "Alpha Probe passed all 60 calls at 74 milliseconds p95 while Beta Probe passed 58 of 60; two reconnects timed out.",
                }),
              },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation(
      (name: string, args: Record<string, unknown>) => {
        if (name === "check_updates") {
          return Promise.resolve({
            focused_session: { id: "session-primary", name: "Primary Work" },
            known_sessions: [
              { id: "session-primary", name: "Primary Work" },
              { id: "session-alpha", name: "Alpha Probe" },
              { id: "session-beta", name: "Beta Probe" },
            ],
            updates: [],
          });
        }
        if (name === "get_output") {
          const alpha = args.session_id === "session-alpha";
          return Promise.resolve({
            target_session: {
              id: String(args.session_id),
              name: alpha ? "Alpha Probe" : "Beta Probe",
            },
            latest_message: {
              role: "assistant",
              text: alpha
                ? "Passed all 60 calls at 74 milliseconds p95."
                : "Passed 58 of 60 calls; two reconnects timed out.",
            },
            updates: [],
          });
        }
        return Promise.resolve({
          accepted: true,
          delivery: "immediate",
          target_session: { id: "session-primary", name: "Primary Work" },
          updates: [],
        });
      },
    );

    await expect(
      conversation("test-key", tools).respond(
        "compare alpha probe and beta probe and tell primary work all the exact numbers and causes",
      ),
    ).resolves.toContain("I sent that to Primary Work.");
    expect(tools.callTool).toHaveBeenCalledTimes(4);
    expect(tools.callTool).toHaveBeenLastCalledWith("send_message", {
      message:
        "Alpha Probe passed all 60 calls at 74 milliseconds p95 while Beta Probe passed 58 of 60; two reconnects timed out.",
      session_id: "session-primary",
    });
    const retriedRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      tool_choice?: unknown;
      messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
    };
    expect(retriedRequest.tool_choice).toEqual({
      type: "function",
      function: { name: "send_message" },
    });
    expect(retriedRequest.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-incomplete-numbers",
      content: expect.stringContaining('"missing_numeric_facts":["74","95"]'),
    });
    expect(retriedRequest.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-incomplete-numbers",
      content: expect.stringContaining(
        '"missing_evidence_terms":["milliseconds","reconnects"]',
      ),
    });
    expect(retriedRequest.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("numeric facts 74, 95"),
    });
    expect(retriedRequest.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("Do not repeat the reads"),
    });
  });

  it("forces the missing half of an explicit compound action before speaking", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-focus",
              type: "function",
              function: { name: "focus_session", arguments: "{}" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-send",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Rerun the voice worker" }),
              },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-primary", name: "Primary Work" },
          known_sessions: [
            { id: "session-primary", name: "Primary Work" },
            { id: "session-beta", name: "Side Beta" },
          ],
          updates: [],
        });
      }
      if (name === "focus_session") {
        return Promise.resolve({
          focus_changed: true,
          focused_session: { id: "session-beta", name: "Side Beta" },
          updates: [],
        });
      }
      return Promise.resolve({
        accepted: true,
        delivery: "immediate",
        target_session: { id: "session-beta", name: "Side Beta" },
        updates: [],
      });
    });

    await expect(
      conversation("test-key", tools).respond(
        "Tell Side Beta to rerun the voice worker, then switch me over there",
      ),
    ).resolves.toBe("I switched to Side Beta. I sent that to Side Beta.");
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "focus_session", {
      session_id: "session-beta",
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "send_message", {
      message: "rerun the voice worker",
      session_id: "session-beta",
    });
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      tool_choice?: unknown;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(secondRequest.tool_choice).toEqual({
      type: "function",
      function: { name: "send_message" },
    });
    expect(secondRequest.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("explicitly requested multiple coordinator actions"),
    });
  });

  it("forces a focused send after an explicit rename and preserves both exact clauses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-rename",
              type: "function",
              function: {
                name: "rename_session",
                arguments: JSON.stringify({ title: "latency" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-send",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Rerun it" }),
              },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string) => {
      if (name === "check_updates") {
        return Promise.resolve({
          focused_session: { id: "session-lab", name: "Temporary Lab" },
          known_sessions: [
            { id: "session-lab", name: "Temporary Lab", focused: true },
            { id: "session-primary", name: "Primary Work", focused: false },
          ],
          updates: [],
        });
      }
      if (name === "rename_session") {
        return Promise.resolve({
          renamed: true,
          previous_name: "Temporary Lab",
          new_name: "Latency Lab",
          focused_session: { id: "session-lab", name: "Latency Lab" },
          updates: [],
        });
      }
      return Promise.resolve({
        accepted: true,
        delivery: "immediate",
        target_session: { id: "session-lab", name: "Latency Lab" },
        focused_session: { id: "session-lab", name: "Latency Lab" },
        updates: [],
      });
    });

    await expect(
      conversation("test-key", tools).respond(
        "rename this session latency lab and then tell it rerun the endpoint probe with three warm samples",
      ),
    ).resolves.toBe(
      "I renamed Temporary Lab to Latency Lab. I sent that to Latency Lab.",
    );
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "rename_session", {
      title: "latency lab",
    });
    expect(tools.callTool).toHaveBeenNthCalledWith(3, "send_message", {
      message: "rerun the endpoint probe with three warm samples",
    });
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      tool_choice?: unknown;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(secondRequest.tool_choice).toEqual({
      type: "function",
      function: { name: "send_message" },
    });
    expect(secondRequest.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("remaining send_message tool"),
    });
  });

  it("runs restored replay history through the production conversation and MCP path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ message: "Try that again" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ content: "I sent it again." }));
    vi.stubGlobal("fetch", fetchMock);
    const calls: Array<{ name: string; afterEventId: number | undefined }> = [];
    const executor: CoordinatorExecutor = {
      execute: vi.fn().mockImplementation(
        (name: string, _args: Record<string, unknown>, afterEventId?: number) => {
          calls.push({ name, afterEventId });
          return Promise.resolve(
            name === "check_updates"
              ? {
                  focused_session: { id: "session-1", name: "Voice work" },
                  recent_actions: [],
                  output_delta: { changed: false, output: "" },
                  updates: [],
                  update_cursor: 4,
                }
              : {
                  sent: true,
                  focused_session: { id: "session-1", name: "Voice work" },
                  updates: [],
                  update_cursor: 5,
                },
          );
        },
      ),
    };
    const mcp = await CoordinatorMcpClient.create(executor);
    const trace: CelerisTraceEvent[] = [];
    try {
      const subject = new CelerisConversation({
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "test-model",
        logger: new Logger("error"),
        tools: mcp,
        systemPromptOverride: "Candidate system prompt.",
        actionInvariantOverride: "",
        temperature: 0.2,
        seed: 11,
        trace: (event) => trace.push(event),
      });
      subject.restoreHistory([
        { role: "user", content: "send it to the voice work" },
        { role: "assistant", content: "I sent it." },
      ]);

      await expect(subject.respond("no it didn't send it again")).resolves.toBe(
        "I sent it again.",
      );
      expect(calls.map(({ name }) => name)).toEqual(["check_updates", "send_message"]);
      expect(calls[0]?.afterEventId).toBe(0);
      const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        temperature?: number;
        seed?: number;
        tool_choice?: unknown;
        messages?: Array<{ role?: string; content?: string }>;
      };
      expect(firstRequest.temperature).toBe(0.2);
      expect(firstRequest.seed).toBe(11);
      expect(firstRequest.tool_choice).toEqual({
        type: "function",
        function: { name: "send_message" },
      });
      expect(firstRequest.messages?.[0]).toEqual({
        role: "system",
        content: "Candidate system prompt.",
      });
      expect(firstRequest.messages).toContainEqual({
        role: "user",
        content: "send it to the voice work",
      });
      expect(firstRequest.messages).not.toContainEqual({
        role: "system",
        content: expect.stringContaining("CURRENT TURN EXECUTION RULES"),
      });
      expect(trace.filter((event) => event.type === "completion")).toHaveLength(2);
      expect(trace.find((event) => event.type === "tool")).toMatchObject({
        type: "tool",
        name: "send_message",
        arguments: { message: "Try that again" },
        result: { sent: true, update_cursor: 5 },
      });
      expect(() => subject.restoreHistory([])).toThrow(
        "history has already been initialized",
      );
    } finally {
      await mcp.close();
    }
  });

  it("reports the missing fast model without invoking Omnigent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();

    await expect(conversation(undefined, tools).respond("Inspect the cluster")).resolves.toBe(
      "Celeris isn't configured right now.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tools.callTool).not.toHaveBeenCalled();
  });

  it("repeats the last spoken response exactly without a model round", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const subject = conversation("test-key");
    subject.restoreHistory([
      { role: "user", content: "what finished" },
      {
        role: "assistant",
        content: "The cutoff is fixed and every decoder test passes.",
      },
    ]);

    await expect(subject.respond("wait can you repeat that last bit")).resolves.toBe(
      "The cutoff is fixed and every decoder test passes.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers an atomically empty incoming-update check without a model round", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockResolvedValue({
      focused_session: { id: "session-primary", name: "Primary Work", status: "running" },
      known_sessions: [{ id: "session-primary", name: "Primary Work", status: "running" }],
      pending_decisions: [],
      output_delta: { changed: false, output: "" },
      updates: [],
      update_cursor: 12,
    });

    await expect(
      conversation("test-key", tools).respond(
        "uh while i was saying all that did anything else new just come in",
      ),
    ).resolves.toBe("No new coordinator updates came in while you were talking.");
    expect(tools.callTool).toHaveBeenCalledTimes(1);
    expect(tools.callTool).toHaveBeenCalledWith("check_updates", { after_event_id: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not hide a pending approval behind an empty update snapshot", () => {
    const state = {
      pending_decisions: [
        {
          session_id: "session-temp",
          name: "Temporary Session",
          prompts: [
            {
              prompt_id: "prompt-top",
              message: "Allow the command that samples the top CPU processes?",
              mode: "confirmation",
            },
          ],
        },
      ],
      output_delta: { changed: false, output: "" },
      updates: [],
    };
    expect(directPendingDecisionSpeech("okay so nothing new", state)).toBe(
      "Temporary Session needs your approval: Allow the command that samples the top CPU processes?",
    );
    expect(
      directNoIncomingUpdateSpeech(
        "did anything new come in while i was talking",
        state,
      ),
    ).toBeUndefined();
  });

  it("keeps project filing distinct from an unavailable pin flag", () => {
    expect(
      directSessionOrganizationSpeech(
        "when you look at sessions can you tell if a session is pinned or not",
        {
          focused_session: {
            id: "session-primary",
            name: "Primary Work",
            project: { id: "project-base", name: "Base Project" },
          },
          pending_decisions: [],
          output_delta: { changed: false, output: "" },
          updates: [],
        },
      ),
    ).toBe(
      "Omnigent doesn't expose a separate pinned-session flag. Primary Work is filed in Base Project.",
    );
  });

  it("does not report an empty incoming-update check without complete evidence", () => {
    const input = "while i was talking did anything new just come in";
    expect(
      directNoIncomingUpdateSpeech(input, {
        updates: [],
        output_delta: { changed: true, output: "assistant: The check passed." },
      }),
    ).toBeUndefined();
    expect(
      directNoIncomingUpdateSpeech(input, {
        updates: [],
        output_delta: { changed: false, output: "" },
        update_cursor_expired: true,
      }),
    ).toBeUndefined();
    expect(directNoIncomingUpdateSpeech(input, { updates: [] })).toBeUndefined();
    expect(
      directNoIncomingUpdateSpeech(
        "tell it to rerun the checks and tell me if anything came in",
        { updates: [], output_delta: { changed: false, output: "" } },
      ),
    ).toBeUndefined();
  });

  it("composes an action receipt with an atomically empty incoming-update check", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [
          {
            id: "call-send",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ message: "Rerun the speech checks." }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    vi.mocked(tools.callTool).mockImplementation((name: string, args) =>
      Promise.resolve(
        name === "check_updates"
          ? {
              focused_session: {
                id: "session-primary",
                name: "Primary Work",
                status: "running",
              },
              known_sessions: [
                { id: "session-primary", name: "Primary Work", status: "running" },
              ],
              pending_decisions: [],
              output_delta: { changed: false, output: "" },
              updates: [],
              update_cursor: 0,
            }
          : {
              accepted: true,
              delivery: "immediate",
              target_session: {
                id: String(args.session_id ?? "session-primary"),
                name: "Primary Work",
                status: "running",
              },
              updates: [],
              update_cursor: 0,
            },
      )
    );

    await expect(
      conversation("test-key", tools).respond(
        "tell it to rerun the speech checks and uh if anything else new came in tell me too",
      ),
    ).resolves.toBe(
      "I sent that to Primary Work. No new coordinator updates came in while you were talking.",
    );
    expect(tools.callTool).toHaveBeenNthCalledWith(2, "send_message", {
      message: "rerun the speech checks",
    });
  });

  it("keeps a voice-owned correction distinct from the human across a relay", () => {
    const actions = [
      {
        action_id: 1,
        type: "message_sent",
        message: "I misunderstood the previous request.",
      },
    ];
    const clarification = verifiedAttributionClarificationSpeech(
      "it'll think those words came from me and not the voice thing do you get what i mean",
      actions,
    );
    expect(clarification).toBe(
      "Yes. That wording attributes the mistake to you, but the voice coordinator made the mistake.",
    );
    expect(
      voiceAttributionRelayMessage(
        "yeah now send it another note making that exact distinction clear",
        [{ role: "assistant", content: clarification ?? "" }],
        actions,
      ),
    ).toBe(
      "The voice coordinator misunderstood the previous request; the human did not.",
    );
  });

  it("voices the real coordinator completion shape without model paraphrasing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      conversation("test-key").announceUpdate(
        [
          {
            event_id: 1,
            type: "session_completed",
            session_id: "session-1",
            name: "Voice MVP",
            output_delta: { changed: true, output: "assistant: Ready." },
          },
        ],
        controller.signal,
      ),
    ).resolves.toBe("Voice MVP finished: Ready.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voices one short plain progress update without a model request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const update = {
      event_id: 2,
      type: "session_output" as const,
      session_id: "session-1",
      name: "Voice MVP",
      output_delta: {
        changed: true,
        output: "The decoder passes eight checks; the soak is still running.",
      },
    };

    expect(directSessionOutputSpeech([update])).toContain("soak is still running");
    await expect(
      conversation("test-key").announceUpdate([update], new AbortController().signal),
    ).resolves.toBe(
      "Voice MVP update: The decoder passes eight checks; the soak is still running.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voices one short plain completion without paraphrasing away its facts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const update = {
      event_id: 3,
      type: "session_completed" as const,
      session_id: "session-beta",
      name: "Side Beta",
      summary: "Side Beta finished the check. It found one flaky reconnect test.",
    };

    expect(directCoordinatorUpdateSpeech([update])).toContain("flaky reconnect");
    await expect(
      conversation("test-key").announceUpdate([update], new AbortController().signal),
    ).resolves.toBe(
      "Side Beta finished the check. It found one flaky reconnect test.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voices a bounded batch of safe completions without dropping either result", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updates = [
      {
        event_id: 30,
        type: "session_completed" as const,
        session_id: "session-alpha",
        name: "Side Alpha",
        summary: "Side Alpha finished twelve cutoff probes.",
      },
      {
        event_id: 31,
        type: "session_completed" as const,
        session_id: "session-beta",
        name: "Side Beta",
        summary: "Side Beta measured first audio at 180 milliseconds.",
      },
    ];
    const expected =
      "Side Alpha finished twelve cutoff probes. " +
      "Side Beta measured first audio at 180 milliseconds.";

    expect(directCoordinatorUpdateSpeech(updates)).toBe(expected);
    await expect(
      conversation("test-key").announceUpdate(updates, new AbortController().signal),
    ).resolves.toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts a bounded long completion without garbling its facts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const update = {
      event_id: 31,
      type: "session_completed" as const,
      session_id: "session-rollout",
      name: "Rollout Check",
      output_delta: {
        changed: true,
        output:
          "The candidate image is live in the private cluster. " +
          "Credential inspection passed, every regression test passed, and the image was imported directly without using an external registry. " +
          "The coordinator remains focused on Primary Work.",
      },
    };

    await expect(
      conversation("test-key").announceUpdate([update], new AbortController().signal),
    ).resolves.toBe(
      "Rollout Check: The candidate image is live in the private cluster; " +
      "Credential inspection passed; the image was imported directly without using an external registry.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voices a bounded batch of structured decisions without model paraphrasing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updates = [
      {
        event_id: 4,
        type: "decision_needed" as const,
        session_id: "session-cache",
        name: "Cache Worker",
        prompts: [{ message: "Restart the local test process?", mode: "confirmation" }],
      },
      {
        event_id: 5,
        type: "decision_needed" as const,
        session_id: "session-release",
        name: "Release Deploy",
        prompts: [{ message: "Deploy the candidate to production?", mode: "confirmation" }],
      },
    ];
    const expected =
      "Cache Worker needs your approval: Restart the local test process? " +
      "Release Deploy needs your approval: Deploy the candidate to production?";

    expect(directCoordinatorUpdateSpeech(updates)).toBe(expected);
    await expect(
      conversation("test-key").announceUpdate(updates, new AbortController().signal),
    ).resolves.toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voices one safe completion beside structured decisions without paraphrasing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updates = [
      {
        event_id: 6,
        type: "decision_needed" as const,
        session_id: "session-release",
        name: "Release Setup",
        prompts: [
          {
            message: "Choose the target environment and replica count.",
            mode: "form",
          },
        ],
      },
      {
        event_id: 7,
        type: "session_completed" as const,
        session_id: "session-research",
        name: "Research Worker",
        summary:
          "Research Worker finished. The reconnect failure came from a stale DNS cache.",
      },
    ];
    const expected =
      "Research Worker finished. The reconnect failure came from a stale DNS cache. " +
      "Release Setup needs your input: Choose the target environment and replica count.";

    expect(directCoordinatorUpdateSpeech(updates)).toBe(expected);
    await expect(
      conversation("test-key").announceUpdate(
        updates,
        new AbortController().signal,
      ),
    ).resolves.toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voices a queued dispatch together with the prior-turn outcome", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updates = [
      {
        event_id: 6,
        type: "message_delivered" as const,
        session_id: "session-side",
        name: "Side Worker",
        delivery: "queued_after_turn",
      },
      {
        event_id: 7,
        type: "session_completed" as const,
        session_id: "session-side",
        name: "Side Worker",
        summary: "Side Worker finished its prior turn. The reconnect checks passed.",
      },
    ];
    const expected =
      "Side Worker finished its prior turn. The reconnect checks passed. " +
      "I sent the queued message to Side Worker.";

    expect(directCoordinatorUpdateSpeech(updates)).toBe(expected);
    await expect(
      conversation("test-key").announceUpdate(updates, new AbortController().signal),
    ).resolves.toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voices a queued dispatch and an unrelated decision without model paraphrasing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updates = [
      {
        event_id: 8,
        type: "session_completed" as const,
        session_id: "session-side",
        name: "Side Worker",
        summary: "Side Worker finished its prior turn. The websocket replay passed.",
      },
      {
        event_id: 9,
        type: "message_delivered" as const,
        session_id: "session-side",
        name: "Side Worker",
        delivery: "queued_after_turn",
      },
      {
        event_id: 10,
        type: "decision_needed" as const,
        session_id: "session-release",
        name: "Release Deploy",
        prompts: [{ message: "Apply the database migration to staging?", mode: "confirmation" }],
      },
    ];
    const expected =
      "Side Worker finished its prior turn. The websocket replay passed. " +
      "I sent the queued message to Side Worker. " +
      "Release Deploy needs your approval: Apply the database migration to staging?";

    expect(directCoordinatorUpdateSpeech(updates)).toBe(expected);
    await expect(
      conversation("test-key").announceUpdate(updates, new AbortController().signal),
    ).resolves.toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("advances its update cursor only after a proactive update is spoken", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: "The Voice MVP session is ready." }))
      .mockResolvedValueOnce(response({ content: "Hello again." }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = toolClient();
    const subject = conversation("test-key", tools);
    const updates = [
      {
        event_id: 7,
        type: "session_completed" as const,
        session_id: "session-1",
        name: "Voice MVP",
      },
    ];
    const speech = await subject.announceUpdate(updates, new AbortController().signal);
    subject.acknowledgeSpokenUpdates(updates, speech ?? "");

    await subject.respond("Hello");
    expect(tools.callTool).toHaveBeenCalledWith("check_updates", { after_event_id: 7 });
  });

  it("compacts old dialogue after an idle delay and keeps a raw recent tail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: "Answer one." }))
      .mockResolvedValueOnce(response({ content: "Answer two." }))
      .mockResolvedValueOnce(response({ content: "Answer three." }))
      .mockResolvedValueOnce(response({ content: "Decisions: the user prefers durable memory." }))
      .mockResolvedValueOnce(response({ content: "Answer four." }));
    vi.stubGlobal("fetch", fetchMock);
    const subject = conversation("test-key", toolClient(), {
      compactAfterMessages: 4,
      compactAfterCharacters: 10_000,
      keepRecentMessages: 2,
      compactionIdleMs: 0,
    });

    await subject.respond("Question one.");
    await subject.respond("Question two.");
    await subject.respond("Question three.");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setImmediate(resolve));
    await subject.respond("Question four.");

    const request = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const content = request.messages?.map((message) => message.content ?? "") ?? [];
    expect(content.some((text) => text.includes("durable memory"))).toBe(true);
    expect(content).not.toContain("Question one.");
    expect(content).not.toContain("Question two.");
    expect(content).toContain("Question three.");
  });
});
