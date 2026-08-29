import { Logger } from "./log.js";

export interface OmnigentOptions {
  baseUrl: string;
  refreshToken: string;
  agentName: string;
  hostId?: string | undefined;
  workspace: string;
  logger: Logger;
}

export interface JsonObject {
  [key: string]: unknown;
}

interface StreamResult {
  text: string;
  terminal: string | null;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const extractContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isObject(part)) return "";
      const type = part.type;
      if (type !== "output_text" && type !== "text") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
};

const extractAssistantItems = (items: unknown): string => {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      if (!isObject(item)) return "";
      const message = isObject(item.data) ? item.data : item;
      if (message.role !== "assistant") return "";
      return extractContentText(message.content);
    })
    .filter(Boolean)
    .join("\n");
};

const latestAssistantText = (
  snapshot: JsonObject,
  knownItemIds: ReadonlySet<string>,
): string => {
  if (!Array.isArray(snapshot.items)) return "";
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (!isObject(item)) continue;
    if (typeof item.id !== "string" || knownItemIds.has(item.id)) continue;
    const message = isObject(item.data) ? item.data : item;
    if (message.role !== "assistant") continue;
    const text = extractContentText(message.content);
    if (text) return text;
  }
  return "";
};

export class OmnigentClient {
  private accessToken?: string;
  private accessTokenExpiresAt = 0;
  private sessionId?: string;
  private activeTurn = false;

  public constructor(private readonly options: OmnigentOptions) {}

  public async listSessions(limit = 20): Promise<JsonObject[]> {
    const query = new URLSearchParams({
      limit: String(limit),
      sort_by: "updated_at",
      order: "desc",
      kind: "default",
    });
    const listing = await this.requestJson(`/v1/sessions?${query.toString()}`);
    return Array.isArray(listing.data) ? listing.data.filter(isObject) : [];
  }

  public async getSession(sessionId: string): Promise<JsonObject> {
    const query = new URLSearchParams({
      include_items: "false",
      include_liveness: "false",
    });
    return this.requestJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`,
    );
  }

  public async archiveSession(sessionId: string): Promise<JsonObject> {
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
  }

  public async listItems(
    sessionId: string,
    limit: number,
    after?: string,
  ): Promise<{ data: JsonObject[]; hasMore: boolean; lastId?: string }> {
    const query = new URLSearchParams({ limit: String(limit), order: "desc" });
    if (after) query.set("after", after);
    const listing = await this.requestJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/items?${query.toString()}`,
    );
    const lastId = typeof listing.last_id === "string" ? listing.last_id : undefined;
    return {
      data: Array.isArray(listing.data) ? listing.data.filter(isObject) : [],
      hasMore: listing.has_more === true,
      ...(lastId ? { lastId } : {}),
    };
  }

  public async sendMessage(sessionId: string, message: string): Promise<JsonObject> {
    return this.sendEvent(sessionId, {
      type: "message",
      data: {
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    });
  }

  public async resolveElicitation(
    sessionId: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<JsonObject> {
    return this.requestJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/elicitations/${encodeURIComponent(elicitationId)}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(content ? { content } : {}) }),
      },
    );
  }

  public async createSession(options: {
    agentName?: string | undefined;
    workspace?: string | undefined;
    instruction: string;
    title?: string | undefined;
  }): Promise<JsonObject> {
    const [agentId, hostId] = await Promise.all([
      this.resolveAgentId(options.agentName),
      this.resolveHostId(),
    ]);
    const snapshot = await this.requestJson("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        host_id: hostId,
        workspace: options.workspace ?? this.options.workspace,
        ...(options.title ? { title: options.title } : {}),
      }),
    });
    if (typeof snapshot.id !== "string" || !snapshot.id) {
      throw new Error("Omnigent session creation returned no session id");
    }
    await this.sendMessage(snapshot.id, options.instruction);
    return snapshot;
  }

  public async interruptSession(sessionId: string): Promise<void> {
    await this.sendEvent(sessionId, { type: "interrupt", data: {} });
    this.options.logger.info("omnigent.interrupt.sent");
  }

  public async start(): Promise<void> {
    await this.ensureAccessToken();
    const [agentId, hostId] = await Promise.all([
      this.resolveAgentId(),
      this.resolveHostId(),
    ]);
    const snapshot = await this.requestJson("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        host_id: hostId,
        workspace: this.options.workspace,
        title: "Voice conversation",
      }),
    });
    if (typeof snapshot.id !== "string" || !snapshot.id) {
      throw new Error("Omnigent session creation returned no session id");
    }
    this.sessionId = snapshot.id;
    this.options.logger.info("omnigent.session.ready");
  }

  public async query(input: string): Promise<string> {
    if (!this.sessionId) await this.start();
    const sessionId = this.sessionId!;
    const beforeTurn = await this.requestJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
    );
    const knownItemIds = new Set(
      (Array.isArray(beforeTurn.items) ? beforeTurn.items : [])
        .filter(isObject)
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string"),
    );
    const controller = new AbortController();
    let markStreamReady: (() => void) | undefined;
    const streamReady = new Promise<void>((resolve) => {
      markStreamReady = resolve;
    });
    const started = performance.now();
    this.options.logger.info("omnigent.request.started");
    this.activeTurn = true;
    const streamTask = this.collectTurn(sessionId, controller, () => markStreamReady?.());
    try {
      await Promise.race([streamReady, sleep(1_000)]);
      await this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "message",
          data: {
            role: "user",
            content: [{ type: "input_text", text: input }],
          },
        }),
      });
      const result = await streamTask;
      if (result.terminal === "response.failed") {
        throw new Error("Omnigent reported a failed turn");
      }
      let text = result.text.trim();
      if (!text) {
        for (let attempt = 0; attempt < 20 && !text; attempt += 1) {
          if (attempt > 0) await sleep(250);
          const snapshot = await this.requestJson(
            `/v1/sessions/${encodeURIComponent(sessionId)}`,
          );
          const items = Array.isArray(snapshot.items) ? snapshot.items : [];
          this.options.logger.debug("omnigent.snapshot.shape", {
            items: items.length,
            itemTypes: items
              .slice(-4)
              .map((item) => (isObject(item) && typeof item.type === "string" ? item.type : "unknown"))
              .join(","),
            itemRoles: items
              .slice(-4)
              .map((item) => (isObject(item) && typeof item.role === "string" ? item.role : "none"))
              .join(","),
          });
          text = latestAssistantText(snapshot, knownItemIds).trim();
        }
      }
      if (!text && result.terminal?.includes("incomplete")) {
        throw new Error("Omnigent turn was interrupted");
      }
      if (!text) throw new Error("Omnigent returned no response text");
      this.options.logger.info("omnigent.response.complete", {
        durationMs: Math.round(performance.now() - started),
      });
      return text;
    } finally {
      this.activeTurn = false;
      controller.abort();
    }
  }

  public async interrupt(): Promise<boolean> {
    if (!this.sessionId || !this.activeTurn) return false;
    await this.interruptSession(this.sessionId);
    return true;
  }

  private async resolveAgentId(agentName = this.options.agentName): Promise<string> {
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "1000" });
      if (after) query.set("after", after);
      const listing = await this.requestJson(`/v1/agents?${query.toString()}`);
      const agents = Array.isArray(listing.data) ? listing.data : [];
      for (const candidate of agents) {
        if (
          isObject(candidate) &&
          candidate.name === agentName &&
          typeof candidate.id === "string"
        ) {
          return candidate.id;
        }
      }
      after = listing.has_more && typeof listing.last_id === "string"
        ? listing.last_id
        : undefined;
    } while (after);
    throw new Error("Configured Omnigent agent was not found");
  }

  private async resolveHostId(): Promise<string> {
    const listing = await this.requestJson("/v1/hosts");
    const hosts = Array.isArray(listing.hosts)
      ? listing.hosts.filter(
          (host): host is JsonObject =>
            isObject(host) && host.status === "online" && host.sandbox_provider == null,
        )
      : [];
    if (this.options.hostId) {
      if (!hosts.some((host) => host.host_id === this.options.hostId)) {
        throw new Error("Configured Omnigent host is not online");
      }
      return this.options.hostId;
    }
    if (hosts.length !== 1 || typeof hosts[0]?.host_id !== "string") {
      throw new Error("OMNIGENT_HOST_ID is required unless exactly one external host is online");
    }
    return hosts[0].host_id;
  }

  private async collectTurn(
    sessionId: string,
    controller: AbortController,
    onReady: () => void,
  ): Promise<StreamResult> {
    const response = await this.authorizedFetch(
      `/v1/sessions/${encodeURIComponent(sessionId)}/stream`,
      { signal: controller.signal },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Omnigent stream returned HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let completedText = "";
    let terminal: string | null = null;
    try {
      while (!terminal) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data || data === "[DONE]") continue;
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          if (!isObject(event) || typeof event.type !== "string") continue;
          onReady();
          this.options.logger.debug("omnigent.stream.event", { type: event.type });
          if (
            event.type === "response.output_text.delta" &&
            typeof event.delta === "string"
          ) {
            text += event.delta;
          }
          if (
            event.type === "response.completed" ||
            event.type === "response.failed" ||
            event.type === "response.incomplete" ||
            event.type === "response.cancelled"
          ) {
            if (isObject(event.response)) {
              completedText = extractAssistantItems(event.response.output);
              const output = Array.isArray(event.response.output) ? event.response.output : [];
              this.options.logger.debug("omnigent.stream.completed_shape", {
                outputItems: output.length,
                outputTypes: output
                  .map((item) => (isObject(item) && typeof item.type === "string" ? item.type : "unknown"))
                  .join(","),
                outputRoles: output
                  .map((item) => (isObject(item) && typeof item.role === "string" ? item.role : "none"))
                  .join(","),
              });
            }
            terminal = event.type;
            break;
          }
          if (event.type === "session.status" && event.status === "failed") {
            terminal = "response.failed";
            break;
          }
        }
      }
      return { text: text || completedText, terminal };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async ensureAccessToken(force = false): Promise<string> {
    if (
      !force &&
      this.accessToken &&
      this.accessTokenExpiresAt - Date.now() > 60_000
    ) {
      return this.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.options.refreshToken,
    });
    const response = await fetch(`${this.options.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`Omnigent authentication returned HTTP ${response.status}`);
    const payload = (await response.json()) as JsonObject;
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error("Omnigent authentication returned no access token");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3_600;
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1_000;
    return this.accessToken;
  }

  private async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean): Promise<Response> => {
      const token = await this.ensureAccessToken(force);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(`${this.options.baseUrl}${path}`, { ...init, headers });
    };
    let response = await attempt(false);
    if (response.status === 401) response = await attempt(true);
    return response;
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<JsonObject> {
    const response = await this.authorizedFetch(path, init);
    if (!response.ok) throw new Error(`Omnigent API returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isObject(payload)) throw new Error("Omnigent API returned malformed JSON");
    return payload;
  }

  private async sendEvent(sessionId: string, event: JsonObject): Promise<JsonObject> {
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  }
}
