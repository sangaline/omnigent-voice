import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import * as z from "zod/v4";
import type { JsonObject } from "./omnigent.js";
import { OmnigentGrantClient } from "./remote-omnigent.js";
import { RemoteStore, remoteReadScope } from "./remote-store.js";

const textResult = (value: JsonObject) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const stringField = (value: JsonObject, ...names: string[]): string | undefined => {
  for (const name of names) {
    if (typeof value[name] === "string" && value[name]) return value[name] as string;
  }
  return undefined;
};

const numberField = (value: JsonObject, ...names: string[]): number | undefined => {
  for (const name of names) {
    if (typeof value[name] === "number") return value[name] as number;
  }
  return undefined;
};

const projectSession = (session: JsonObject): JsonObject => ({
  id: stringField(session, "id") ?? "",
  name: stringField(session, "title", "name") ?? "Untitled session",
  status: stringField(session, "status") ?? "unknown",
  ...(stringField(session, "updated_at") ? { updated_at: stringField(session, "updated_at") } : {}),
  ...(stringField(session, "agent_name") ? { agent: stringField(session, "agent_name") } : {}),
  ...(stringField(session, "project_name") ? { project: stringField(session, "project_name") } : {}),
  ...(numberField(session, "pending_elicitation_count", "pending_count") !== undefined
    ? { pending_prompts: numberField(session, "pending_elicitation_count", "pending_count") }
    : {}),
});

interface CachedAccess {
  token: string;
  expiresAt: number;
}

export class RemoteToolService {
  private readonly access = new Map<string, CachedAccess>();
  private readonly locks = new Map<string, Promise<CachedAccess>>();

  public constructor(
    private readonly store: RemoteStore,
    private readonly omnigent: OmnigentGrantClient,
  ) {}

  public createServer(auth: AuthInfo): McpServer {
    const identity = this.identity(auth);
    const server = new McpServer({ name: "omnigent", version: "0.1.0" });

    server.registerTool(
      "whoami",
      {
        description:
          "Return the authenticated Omnigent account and granted read-only MCP capabilities.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () => this.audit(identity, "whoami", async () => {
        await this.accessToken(identity.grantId);
        return textResult({
          account_id: identity.accountId,
          scopes: identity.scopes,
          read_only: true,
        });
      }),
    );

    server.registerTool(
      "list_sessions",
      {
        description:
          "List the authenticated Omnigent account's recent accessible sessions. The upstream Omnigent ACL filters every result.",
        inputSchema: {
          limit: z.number().int().min(1).max(20).optional().describe("Maximum sessions; defaults to 10."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ limit }) => this.audit(identity, "list_sessions", async () => {
        const accessToken = await this.accessToken(identity.grantId);
        const sessions = await this.omnigent.listSessions(accessToken, limit ?? 10);
        return textResult({
          account_id: identity.accountId,
          order: "most_recent_first",
          sessions: sessions.map(projectSession),
        });
      }),
    );

    return server;
  }

  private identity(auth: AuthInfo) {
    if (!auth.scopes.includes(remoteReadScope)) throw new Error("Read scope is required");
    const grantId = auth.extra?.grant_id;
    const accountId = auth.extra?.account_id;
    if (typeof grantId !== "string" || typeof accountId !== "string") {
      throw new Error("Authenticated grant identity is missing");
    }
    return {
      grantId,
      accountId,
      clientId: auth.clientId,
      scopes: auth.scopes,
    };
  }

  private async accessToken(grantId: string): Promise<string> {
    const current = this.access.get(grantId);
    if (current && current.expiresAt - Date.now() > 60_000) return current.token;
    const existing = this.locks.get(grantId);
    if (existing) return (await existing).token;
    const pending = (async (): Promise<CachedAccess> => {
      const refreshToken = this.store.upstreamRefreshToken(grantId);
      const refreshed = await this.omnigent.accessToken(refreshToken);
      if (refreshed.refreshToken !== refreshToken) {
        this.store.updateUpstreamRefreshToken(grantId, refreshed.refreshToken);
      }
      const cached = {
        token: refreshed.token,
        expiresAt: Date.now() + refreshed.expiresIn * 1_000,
      };
      this.access.set(grantId, cached);
      return cached;
    })();
    this.locks.set(grantId, pending);
    try {
      return (await pending).token;
    } finally {
      this.locks.delete(grantId);
    }
  }

  private async audit<T>(
    identity: { grantId: string; accountId: string; clientId: string },
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const correlationId = randomUUID();
    try {
      const result = await action();
      this.store.recordAudit({ ...identity, correlationId, operation, outcome: "allowed" });
      return result;
    } catch (error) {
      this.store.recordAudit({ ...identity, correlationId, operation, outcome: "failed" });
      throw error;
    }
  }
}
