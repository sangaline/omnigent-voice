import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowsArchive,
  allowsFocusChange,
  CelerisConversation,
  CoordinatorToolClient,
} from "./celeris.js";
import { Logger } from "./log.js";

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
): CelerisConversation =>
  new CelerisConversation({
    apiKey,
    baseUrl: "https://example.test/v1",
    model: "test-model",
    logger: new Logger("error"),
    tools,
  });

afterEach(() => vi.unstubAllGlobals());

describe("Celeris coordinator conversation", () => {
  it("only allows focus mutation for an explicit session switch", () => {
    expect(allowsFocusChange("Use the second one you mentioned.")).toBe(true);
    expect(allowsFocusChange("Switch to the voice agent session.")).toBe(true);
    expect(allowsFocusChange("What's the most recent output?")).toBe(false);
    expect(allowsFocusChange("Check the session we were already in.")).toBe(false);
    expect(allowsArchive("Archive this temporary session.")).toBe(true);
    expect(allowsArchive("What is this session doing?")).toBe(false);
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
    expect(request.tools).toHaveLength(2);
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
        message.content?.includes("At most ten recent user/assistant exchanges and 8000 characters"),
      ),
    ).toBe(true);
    expect(
      request.messages?.some((message) => message.content?.includes('"recent_actions":[]')),
    ).toBe(true);
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
});
