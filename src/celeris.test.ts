import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowsArchive,
  allowsFocusChange,
  allowsRename,
  CelerisConversation,
  CelerisTraceEvent,
  CelerisMemoryPolicy,
  CoordinatorToolClient,
  directCoordinatorUpdateSpeech,
  directFocusedOutputSpeech,
  directSessionOutputSpeech,
  immediateNotificationTargets,
  isDeclarativeMissedSend,
  requestsPositiveFocusAction,
  serializeToolResult,
  successfulActionSpeech,
  targetsFocusedSession,
  verifiedActionFollowupSpeech,
  verifiedDeliveryVisibilitySpeech,
  verifiedQueuedDeliverySpeech,
  voiceFocusRouting,
  voiceMessageRouting,
  voiceReadRouting,
  voiceStartInstruction,
} from "./celeris.js";
import { Logger } from "./log.js";
import { CoordinatorExecutor, CoordinatorMcpClient } from "./mcp.js";

const response = (message: object): Response =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

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
    expect(
      voiceStartInstruction("make a temporary session to test that receipt wording"),
    ).toBe("test that receipt wording");
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
    expect(request.tools).toHaveLength(3);
    expect(request.tools?.map((tool) => tool.function?.name)).not.toContain("focus_session");
    expect(request.tools?.map((tool) => tool.function?.name)).toContain("answer_prompt");
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

    await conversation("test-key").respond("Archive this temporary session.");
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
                arguments: JSON.stringify({ message: "Rerun the worker" }),
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
      message: "Rerun the worker",
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
    ).resolves.toBe("Side Worker is collecting packet logs now.");
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
    ).resolves.toBe("The route audit passed all checks.");
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
    expect(read?.function?.description).toContain("Side Audit");
    expect(read?.function?.parameters?.properties).not.toHaveProperty("session_id");
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
      message: "Rerun the voice worker",
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
      message: "Rerun the voice worker",
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

  it("voices a real backend update without exposing coordinator tools", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ content: "The Voice MVP session is ready for you." }));
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
    ).resolves.toBe("The Voice MVP session is ready for you.");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: unknown;
      tool_choice?: unknown;
    };
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
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
