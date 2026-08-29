import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { JsonObject } from "./omnigent.js";

export interface CoordinatorExecutor {
  execute(
    name: string,
    args: Record<string, unknown>,
    afterEventId?: number,
  ): Promise<JsonObject>;
}

interface ToolConsumerState {
  updateCursor: number;
}

const toolResult = async (
  coordinator: CoordinatorExecutor,
  name: string,
  args: Record<string, unknown>,
  state: ToolConsumerState,
) => {
  try {
    const explicitCursor =
      name === "check_updates" && typeof args.after_event_id === "number"
        ? args.after_event_id
        : undefined;
    const result = await coordinator.execute(
      name,
      args,
      explicitCursor ?? state.updateCursor,
    );
    if (typeof result.update_cursor === "number") {
      state.updateCursor = Math.max(state.updateCursor, result.update_cursor);
    }
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
  coordinator: CoordinatorExecutor,
): McpServer => {
  const server = new McpServer({ name: "omnigent-coordinator", version: "0.1.0" });
  const state: ToolConsumerState = { updateCursor: 0 };

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
    (args) => toolResult(coordinator, "list_sessions", args, state),
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
    (args) => toolResult(coordinator, "focus_session", args, state),
  );

  server.registerTool(
    "get_output",
    {
      description:
        "Read a page of recent typed conversation and internal activity when the human asks what output contains or whether a sent user message is visible there. recent_delivery_visibility compares the latest server-recorded delivery for this session with typed user messages on the returned page; visible_on_page and not_visible_on_page refer only to that page. Never use get_output to verify whether a coordinator action occurred; recent_actions is authoritative for that. Do not use it for a declarative correction that a message you claimed to send is missing; that requires send_message again. Page 1 is the most recent page; items inside every page are oldest_to_newest so later incremental updates continue the same chronology. Each item has a position and timestamp, messages remain distinct from tool and terminal activity, and page 1 identifies the latest conversation message.",
      inputSchema: {
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
        page: z.number().int().min(1).max(10).optional().describe("Page 1 is newest."),
        page_size: z.number().int().min(1).max(30).optional().describe("Items per page, default 12."),
      },
    },
    (args) => toolResult(coordinator, "get_output", args, state),
  );

  server.registerTool(
    "poll_output",
    {
      description:
        "Return stable output after an explicit cursor. Pass the returned cursor next time. It never changes focus and ignores transient terminal animations.",
      inputSchema: {
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe("Opaque cursor returned by the prior poll; omit for buffered output."),
      },
    },
    (args) => toolResult(coordinator, "poll_output", args, state),
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send the user's request to the focused session. Also repeat the intended message when the human declaratively corrects a prior send claim as missing, including 'I don't see that message' or 'that message isn't there.' Immediate delivery is the default and steers active work at its next safe boundary. Queued delivery waits until the current turn finishes.",
      inputSchema: {
        message: z.string().min(1).describe("The user's complete message in their own intent."),
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
        delivery: z
          .enum(["immediate", "queued"])
          .optional()
          .describe("Defaults to immediate. Use queued only when the user explicitly asks."),
      },
    },
    (args) => toolResult(coordinator, "send_message", args, state),
  );

  server.registerTool(
    "archive_session",
    {
      description:
        "Archive a session. If it is focused, restore the previous focused session, falling back to the most recently active session.",
      inputSchema: {
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
      },
    },
    (args) => toolResult(coordinator, "archive_session", args, state),
  );

  server.registerTool(
    "rename_session",
    {
      description:
        "Rename a session without changing focus. Returns both the previous and new names.",
      inputSchema: {
        title: z.string().trim().min(1).max(120).describe("New concise session title."),
        session_id: z.string().min(1).optional().describe("Defaults to the focused session."),
      },
    },
    (args) => toolResult(coordinator, "rename_session", args, state),
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
    (args) => toolResult(coordinator, "answer_prompt", args, state),
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
    (args) => toolResult(coordinator, "start_session", args, state),
  );

  server.registerTool(
    "check_updates",
    {
      description:
        "Return background completion, failure, and decision-needed updates after an explicit event cursor. Omit the cursor for this connection's unread updates.",
      inputSchema: {
        after_event_id: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Last update_cursor seen by the caller; use 0 on first poll."),
      },
    },
    (args) => toolResult(coordinator, "check_updates", args, state),
  );

  return server;
};

export class CoordinatorMcpClient {
  private constructor(
    private readonly client: Client,
    private readonly server: McpServer,
  ) {}

  public static async create(coordinator: CoordinatorExecutor): Promise<CoordinatorMcpClient> {
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
