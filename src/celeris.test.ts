import { afterEach, describe, expect, it, vi } from "vitest";
import { CelerisConversation, CoordinatorToolClient } from "./celeris.js";
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
        properties: { message: { type: "string" } },
        required: ["message"],
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
  it("answers an ordinary conversational turn directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ content: "Hello there." }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(conversation("test-key").respond("Hello")).resolves.toBe("Hello there.");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: unknown[];
    };
    expect(request.tools).toHaveLength(2);
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
    expect(tools.callTool).toHaveBeenNthCalledWith(1, "check_updates", {});
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
});
