import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowsArchive,
  allowsFocusChange,
  allowsRename,
  CelerisConversation,
  CelerisTraceEvent,
  CelerisMemoryPolicy,
  CoordinatorToolClient,
  isDeclarativeMissedSend,
  serializeToolResult,
  successfulActionSpeech,
  targetsFocusedSession,
  voiceMessageRouting,
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
      successfulActionSpeech("send_message", {
        accepted: true,
        target_session: { id: "session-1", name: "Primary Work" },
        updates: [{ type: "session_completed" }],
      }),
    ).toBeUndefined();
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
    expect(request.tools).toHaveLength(1);
    expect(request.tools?.map((tool) => tool.function?.name)).not.toContain("focus_session");
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
