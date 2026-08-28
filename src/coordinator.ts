import { Logger } from "./log.js";
import { JsonObject, OmnigentClient } from "./omnigent.js";

export type SessionFilter =
  | "any"
  | "idle"
  | "running"
  | "waiting"
  | "failed"
  | "waiting_for_input";

export interface CoordinatorUpdate extends JsonObject {
  type: "session_completed" | "decision_needed" | "session_failed";
  session_id: string;
  name: string;
}

export interface CoordinatorOptions {
  omnigent: OmnigentClient;
  logger: Logger;
  pollIntervalMs?: number;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const sessionId = (session: JsonObject): string | undefined => stringValue(session.id);

const sessionName = (session: JsonObject): string =>
  stringValue(session.title) ?? stringValue(session.name) ?? "Untitled session";

const pendingCount = (session: JsonObject): number =>
  numberValue(session.pending_elicitations_count) ??
  (Array.isArray(session.pending_elicitations) ? session.pending_elicitations.length : 0);

const timestampMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const timeAgo = (value: unknown, now = Date.now()): string => {
  const timestamp = timestampMs(value);
  if (timestamp === undefined) return "unknown";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isObject(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
};

const stringifyCompact = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const formatConversationItem = (raw: JsonObject): string => {
  const item = isObject(raw.data) ? raw.data : raw;
  const type = stringValue(raw.type) ?? stringValue(item.type) ?? "item";
  const role = stringValue(item.role);
  if (role) {
    const text = contentText(item.content).trim();
    return text ? `${role}: ${text}` : "";
  }
  if (type === "terminal_command") {
    const input = stringifyCompact(item.input).trim();
    const stdout = stringifyCompact(item.stdout).trim();
    const stderr = stringifyCompact(item.stderr).trim();
    return [`terminal: ${input}`, stdout, stderr && `stderr: ${stderr}`]
      .filter(Boolean)
      .join("\n");
  }
  if (type === "function_call") {
    const name = stringValue(item.name) ?? "tool";
    const args = stringifyCompact(item.arguments).trim();
    return `tool call ${name}${args ? `: ${args}` : ""}`;
  }
  if (type === "function_call_output") {
    const output = stringifyCompact(item.output).trim();
    return output ? `tool result: ${output}` : "";
  }
  const text = contentText(item.content).trim();
  return text ? `${type}: ${text}` : "";
};

const summary = (session: JsonObject): JsonObject => ({
  id: sessionId(session) ?? "",
  name: sessionName(session),
  status: stringValue(session.status) ?? "unknown",
  last_activity: timeAgo(session.updated_at ?? session.last_activity_at),
  pending_prompts: pendingCount(session),
});

const findPrompt = (snapshot: JsonObject, promptId: string): JsonObject | undefined =>
  (Array.isArray(snapshot.pending_elicitations) ? snapshot.pending_elicitations : [])
    .filter(isObject)
    .find((prompt) => prompt.elicitation_id === promptId);

export class OmnigentCoordinator {
  private focusedSessionId: string | undefined;
  private readonly fingerprints = new Map<string, string>();
  private readonly updates: CoordinatorUpdate[] = [];
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  public constructor(private readonly options: CoordinatorOptions) {}

  public async start(): Promise<void> {
    const sessions = await this.options.omnigent.listSessions(30);
    this.seed(sessions);
    this.focusedSessionId = sessionId(sessions[0] ?? {});
    this.timer = setInterval(() => {
      void this.refreshUpdates().catch((error) =>
        this.options.logger.error("coordinator.poll.failed", error),
      );
    }, this.options.pollIntervalMs ?? 2_000);
    this.timer.unref();
    this.options.logger.info("coordinator.ready", {
      focused: Boolean(this.focusedSessionId),
      watchedSessions: sessions.length,
    });
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async interruptFocused(): Promise<boolean> {
    if (!this.focusedSessionId) return false;
    const snapshot = await this.options.omnigent.getSession(this.focusedSessionId);
    if (snapshot.status !== "running" && snapshot.status !== "waiting") return false;
    await this.options.omnigent.interruptSession(this.focusedSessionId);
    return true;
  }

  public async execute(name: string, args: Record<string, unknown>): Promise<JsonObject> {
    await this.refreshUpdates();
    let result: JsonObject;
    switch (name) {
      case "list_sessions":
        result = await this.listSessions(args);
        break;
      case "focus_session":
        result = await this.focusSession(args);
        break;
      case "get_output":
        result = await this.getOutput(args);
        break;
      case "send_message":
        result = await this.sendMessage(args);
        break;
      case "answer_prompt":
        result = await this.answerPrompt(args);
        break;
      case "start_session":
        result = await this.startSession(args);
        break;
      case "check_updates":
        result = { checked: true };
        break;
      default:
        throw new Error(`Unknown coordinator tool: ${name}`);
    }
    return { ...result, updates: this.drainUpdates() };
  }

  private async listSessions(args: Record<string, unknown>): Promise<JsonObject> {
    const limit = typeof args.limit === "number" ? args.limit : 8;
    const filter = typeof args.status === "string" ? args.status : "any";
    const sessions = await this.options.omnigent.listSessions(Math.max(limit, 30));
    const filtered = sessions.filter((session) =>
      filter === "any"
        ? true
        : filter === "waiting_for_input"
          ? pendingCount(session) > 0
          : session.status === filter,
    );
    return { sessions: filtered.slice(0, limit).map(summary) };
  }

  private async focusSession(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.requiredString(args, "session_id");
    const snapshot = await this.options.omnigent.getSession(id);
    this.focusedSessionId = id;
    const prompts = (Array.isArray(snapshot.pending_elicitations)
      ? snapshot.pending_elicitations
      : [])
      .filter(isObject)
      .map((prompt) => {
        const params = isObject(prompt.params) ? prompt.params : {};
        return {
          prompt_id: stringValue(prompt.elicitation_id) ?? "",
          message: stringValue(params.message) ?? "Input is needed.",
          mode: stringValue(params.mode) ?? "form",
          schema: params.requestedSchema ?? null,
        };
      });
    return { focused_session: summary(snapshot), prompts };
  }

  private async getOutput(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.sessionFrom(args);
    const page = typeof args.page === "number" ? args.page : 1;
    const pageSize = typeof args.page_size === "number" ? args.page_size : 12;
    let cursor: string | undefined;
    let listing: Awaited<ReturnType<OmnigentClient["listItems"]>> | undefined;
    for (let current = 1; current <= page; current += 1) {
      listing = await this.options.omnigent.listItems(id, pageSize, cursor);
      if (current < page && (!listing.hasMore || !listing.lastId)) break;
      cursor = listing.lastId;
    }
    const text = (listing?.data ?? [])
      .map(formatConversationItem)
      .filter(Boolean)
      .join("\n\n");
    return {
      session_id: id,
      page,
      output: text.length > 16_000 ? `${text.slice(0, 16_000)}\n[output shortened]` : text,
      has_more: listing?.hasMore ?? false,
    };
  }

  private async sendMessage(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.sessionFrom(args);
    const message = this.requiredString(args, "message");
    const response = await this.options.omnigent.sendMessage(id, message);
    return {
      sent: true,
      session_id: id,
      queued: response.queued === true,
    };
  }

  private async answerPrompt(args: Record<string, unknown>): Promise<JsonObject> {
    const focusedId = this.sessionFrom(args);
    const promptId = this.requiredString(args, "prompt_id");
    const action = this.requiredString(args, "action") as "accept" | "decline" | "cancel";
    const snapshot = await this.options.omnigent.getSession(focusedId);
    const prompt = findPrompt(snapshot, promptId);
    if (!prompt) throw new Error("That prompt is no longer pending in the session");
    const params = isObject(prompt.params) ? prompt.params : {};
    const targetId = stringValue(params.target_session_id) ?? focusedId;
    const answers = isObject(args.answers) ? args.answers : undefined;
    await this.options.omnigent.resolveElicitation(targetId, promptId, action, answers);
    return { resolved: true, session_id: targetId, prompt_id: promptId, action };
  }

  private async startSession(args: Record<string, unknown>): Promise<JsonObject> {
    const instruction = this.requiredString(args, "instruction");
    const agent = typeof args.agent === "string" ? args.agent : undefined;
    const workspace = typeof args.workspace === "string" ? args.workspace : undefined;
    const title = typeof args.title === "string" ? args.title : undefined;
    const created = await this.options.omnigent.createSession({
      instruction,
      ...(agent ? { agentName: agent } : {}),
      ...(workspace ? { workspace } : {}),
      ...(title ? { title } : {}),
    });
    const id = sessionId(created);
    if (!id) throw new Error("Omnigent returned no session id");
    this.focusedSessionId = id;
    this.fingerprints.set(id, this.fingerprint(created));
    return { started: true, focused_session: summary(created) };
  }

  private requiredString(args: Record<string, unknown>, name: string): string {
    const value = typeof args[name] === "string" ? args[name].trim() : "";
    if (!value) throw new Error(`${name} is required`);
    return value;
  }

  private sessionFrom(args: Record<string, unknown>): string {
    const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
    const id = explicit || this.focusedSessionId;
    if (!id) throw new Error("No session is focused; list and focus a session first");
    return id;
  }

  private drainUpdates(): CoordinatorUpdate[] {
    return this.updates.splice(0, this.updates.length);
  }

  private seed(sessions: JsonObject[]): void {
    for (const session of sessions) {
      const id = sessionId(session);
      if (id) this.fingerprints.set(id, this.fingerprint(session));
    }
  }

  private fingerprint(session: JsonObject): string {
    return JSON.stringify({ status: session.status, pending: pendingCount(session) });
  }

  private async refreshUpdates(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async poll(): Promise<void> {
    const sessions = await this.options.omnigent.listSessions(30);
    for (const session of sessions) {
      const id = sessionId(session);
      if (!id) continue;
      const before = this.fingerprints.get(id);
      const after = this.fingerprint(session);
      this.fingerprints.set(id, after);
      if (!before || before === after) continue;
      let previous: { status?: unknown; pending?: unknown } = {};
      try {
        previous = JSON.parse(before) as typeof previous;
      } catch {
        continue;
      }
      const status = stringValue(session.status) ?? "unknown";
      const name = sessionName(session);
      if (status === "failed" && previous.status !== "failed") {
        this.pushUpdate({ type: "session_failed", session_id: id, name, status });
      } else if (
        status === "idle" &&
        (previous.status === "running" || previous.status === "waiting")
      ) {
        this.pushUpdate({ type: "session_completed", session_id: id, name, status });
      }
      if (pendingCount(session) > Number(previous.pending ?? 0)) {
        this.pushUpdate({
          type: "decision_needed",
          session_id: id,
          name,
          pending_prompts: pendingCount(session),
        });
      }
    }
  }

  private pushUpdate(update: CoordinatorUpdate): void {
    this.updates.push(update);
    if (this.updates.length > 50) this.updates.splice(0, this.updates.length - 50);
  }
}
