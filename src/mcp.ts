import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { OmnigentCoordinator } from "./coordinator.js";
import { JsonObject } from "./omnigent.js";

const toolResult = async (
  coordinator: OmnigentCoordinator,
  name: string,
  args: Record<string, unknown>,
) => {
  try {
    const result = await coordinator.execute(name, args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    };
  }
};

export const createCoordinatorMcpServer = (
  coordinator: OmnigentCoordinator,
): McpServer => {
  const server = new McpServer({ name: "omnigent-coordinator", version: "0.1.0" });

  server.registerTool(
    "list_sessions",
    {
      description:
        "List recent Omnigent sessions. Use waiting_for_input to find work that needs the user.",
      inputSchema: {
        status: z
          .enum(["any", "idle", "running", "waiting", "failed", "waiting_for_input"])
          .optional()
          .describe("Optional session state filter."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum sessions, default 8."),
      },
    },
    (args) => toolResult(coordinator, "list_sessions", args),
  );

  server.registerTool(
    "focus_session",
    {
      description:
        "Explicitly switch the active session. Only use when the user asked to switch, focus, open, or use a different session; never use merely to read latest output.",
      inputSchema: {
        session_id: z.string().min(1).describe("Session id returned by list_sessions."),
      },
    },
    (args) => toolResult(coordinator, "focus_session", args),
  );

  server.registerTool(
    "get_output",
    {
      description:
        "Read recent conversation and captured terminal output from a session, newest page first.",
      inputSchema: {
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
        page: z.number().int().min(1).max(10).optional().describe("Page 1 is newest."),
        page_size: z.number().int().min(1).max(30).optional().describe("Items per page, default 12."),
      },
    },
    (args) => toolResult(coordinator, "get_output", args),
  );

  server.registerTool(
    "poll_output",
    {
      description:
        "Return only stable new output since the previous poll for a session. It never changes focus and ignores transient terminal animations.",
      inputSchema: {
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
      },
    },
    (args) => toolResult(coordinator, "poll_output", args),
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send the user's request to the focused session. Immediate delivery is the default and steers active work at its next safe boundary. Queued delivery waits until the current turn finishes.",
      inputSchema: {
        message: z.string().min(1).describe("The user's complete message in their own intent."),
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
        delivery: z
          .enum(["immediate", "queued"])
          .optional()
          .describe("Defaults to immediate. Use queued only when the user explicitly asks."),
      },
    },
    (args) => toolResult(coordinator, "send_message", args),
  );

  server.registerTool(
    "answer_prompt",
    {
      description:
        "Resolve a pending structured Omnigent prompt. Only accept when the user clearly approved it.",
      inputSchema: {
        prompt_id: z.string().min(1).describe("Prompt id returned by focus_session."),
        action: z.enum(["accept", "decline", "cancel"]),
        answers: z.record(z.string(), z.unknown()).optional().describe("Form field answers when requested."),
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
      },
    },
    (args) => toolResult(coordinator, "answer_prompt", args),
  );

  server.registerTool(
    "start_session",
    {
      description: "Start and focus a new Omnigent work session, then queue its initial instruction.",
      inputSchema: {
        instruction: z.string().min(1).describe("Initial work request."),
        agent: z.string().min(1).optional().describe("Agent name; omit for the configured default."),
        workspace: z.string().min(1).optional().describe("Workspace path; omit for the configured default."),
        title: z.string().min(1).optional().describe("Short session title."),
      },
    },
    (args) => toolResult(coordinator, "start_session", args),
  );

  server.registerTool(
    "check_updates",
    {
      description:
        "Drain background session completion, failure, and decision-needed updates since the last tool call.",
    },
    () => toolResult(coordinator, "check_updates", {}),
  );

  return server;
};

export class CoordinatorMcpClient {
  private constructor(
    private readonly client: Client,
    private readonly server: McpServer,
  ) {}

  public static async create(coordinator: OmnigentCoordinator): Promise<CoordinatorMcpClient> {
    const server = createCoordinatorMcpServer(coordinator);
    const client = new Client({ name: "omnigent-voice", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return new CoordinatorMcpClient(client, server);
  }

  public async listTools(): Promise<Tool[]> {
    return (await this.client.listTools()).tools;
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<JsonObject> {
    const response = await this.client.callTool({ name, arguments: args });
    if (response.structuredContent && typeof response.structuredContent === "object") {
      return response.structuredContent as JsonObject;
    }
    const content = Array.isArray(response.content) ? response.content : [];
    const textItem = content.find(
      (item): item is { type: "text"; text: string } =>
        Boolean(item) &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    );
    const text = textItem?.text;
    if (!text) throw new Error(`MCP tool ${name} returned no result`);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`MCP tool ${name} returned malformed JSON`);
    }
    if (response.isError) {
      const rawError = (parsed as JsonObject).error;
      const message = typeof rawError === "string"
        ? rawError
        : `MCP tool ${name} failed`;
      throw new Error(message);
    }
    return parsed as JsonObject;
  }

  public async close(): Promise<void> {
    await this.client.close();
    await this.server.close();
  }
}
