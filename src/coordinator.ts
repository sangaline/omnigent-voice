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
  event_id: number;
  type: "session_completed" | "session_output" | "decision_needed" | "session_failed";
  session_id: string;
  name: string;
}

interface CoordinatorUpdateInput extends JsonObject {
  type: "session_completed" | "session_output" | "decision_needed" | "session_failed";
  session_id: string;
  name: string;
}

interface CoordinatorAction extends JsonObject {
  action_id: number;
  type:
    | "focus_changed"
    | "message_queued"
    | "message_sent"
    | "prompt_answered"
    | "session_archived"
    | "session_renamed"
    | "session_started";
  occurred_at: string;
  summary: string;
}

interface CoordinatorActionInput extends JsonObject {
  type: CoordinatorAction["type"];
  summary: string;
}

interface OutputEntry {
  id: string;
  text: string;
}

interface ConversationOutputItemData extends JsonObject {
  occurred_at: string | null;
  time_ago: string;
  kind: string;
  text: string;
}

interface ConversationOutputItem extends ConversationOutputItemData {
  position: number;
}

interface OutputState {
  seenIds: Set<string>;
  seenOrder: string[];
  entries: OutputEntry[];
  contextIndex: number;
  notificationIndex: number;
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

const timestampIso = (value: unknown): string | null => {
  const timestamp = timestampMs(value);
  if (timestamp === undefined) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
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

const clipItemText = (
  text: string,
  maximum = 6_000,
): { text: string; text_truncated: boolean } => {
  if (text.length <= maximum) return { text, text_truncated: false };
  const marker = "\n[item text shortened]\n";
  const remaining = maximum - marker.length;
  const head = Math.ceil(remaining * 0.7);
  const tail = Math.max(0, remaining - head);
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(-tail)}`,
    text_truncated: true,
  };
};

const conversationOutputItem = (
  raw: JsonObject,
  now = Date.now(),
): ConversationOutputItemData | undefined => {
  const item = isObject(raw.data) ? raw.data : raw;
  const type = stringValue(raw.type) ?? stringValue(item.type) ?? "item";
  const role = stringValue(item.role);
  const occurred = raw.created_at ?? item.created_at ?? raw.updated_at ?? item.updated_at;
  let kind = type;
  let text = "";
  if (role) {
    kind = "message";
    text = contentText(item.content).trim();
  } else {
    kind =
      type === "terminal_command"
        ? "terminal_command"
        : type === "function_call"
          ? "tool_call"
          : type === "function_call_output"
            ? "tool_result"
            : type;
    text = formatConversationItem(raw).trim();
  }
  if (!text) return undefined;
  const clipped = clipItemText(text);
  return {
    occurred_at: timestampIso(occurred),
    time_ago: timeAgo(occurred, now),
    kind,
    ...(role ? { role } : {}),
    ...(kind === "tool_call" && stringValue(item.name)
      ? { tool_name: stringValue(item.name) }
      : {}),
    ...clipped,
  };
};

export const formatConversationItems = (
  rawItems: JsonObject[],
  now = Date.now(),
  maximumJsonCharacters = 18_000,
): { items: ConversationOutputItem[]; omitted: number } => {
  const formatted = rawItems
    .map((raw) => conversationOutputItem(raw, now))
    .filter((item): item is ConversationOutputItemData => item !== undefined)
    .map((item, index) => ({ ...item, position: index + 1 }));
  const items: ConversationOutputItem[] = [];
  for (const item of formatted) {
    const candidate = [...items, item];
    if (JSON.stringify(candidate).length > maximumJsonCharacters) break;
    items.push(item);
  }
  return { items, omitted: formatted.length - items.length };
};

const summary = (session: JsonObject): JsonObject => ({
  id: sessionId(session) ?? "",
  name: sessionName(session),
  status: stringValue(session.status) ?? "unknown",
  last_activity: timeAgo(session.updated_at ?? session.last_activity_at),
  pending_prompts: pendingCount(session),
});

const voicePrompts = (snapshot: JsonObject): JsonObject[] =>
  (Array.isArray(snapshot.pending_elicitations)
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
    })
    .filter((prompt) => Boolean(prompt.prompt_id));

const findPrompt = (snapshot: JsonObject, promptId: string): JsonObject | undefined =>
  (Array.isArray(snapshot.pending_elicitations) ? snapshot.pending_elicitations : [])
    .filter(isObject)
    .find((prompt) => prompt.elicitation_id === promptId);

const itemId = (raw: JsonObject): string | undefined =>
  stringValue(raw.id) ?? (isObject(raw.data) ? stringValue(raw.data.id) : undefined);

const meaningfulOutput = (raw: JsonObject): string => {
  const item = isObject(raw.data) ? raw.data : raw;
  const type = stringValue(raw.type) ?? stringValue(item.type) ?? "item";
  const role = stringValue(item.role);
  if (role === "user") return "";
  if (role === "assistant") return formatConversationItem(raw);
  if (
    type === "terminal_command" ||
    type === "function_call" ||
    type === "function_call_output"
  ) {
    return formatConversationItem(raw);
  }
  return "";
};

const comparableMessage = (value: string): string =>
  value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const isAssistantMessage = (raw: JsonObject): boolean => {
  const item = isObject(raw.data) ? raw.data : raw;
  return stringValue(item.role) === "assistant" && Boolean(contentText(item.content).trim());
};

export class OmnigentCoordinator {
  private focusedSessionId: string | undefined;
  private focusedSession: JsonObject | undefined;
  private readonly focusHistory: string[] = [];
  private readonly sessionSummaries = new Map<string, JsonObject>();
  private recentSessionIds: string[] = [];
  private readonly deferredMessages: Array<{
    sessionId: string;
    sessionName: string;
    message: string;
  }> = [];
  private readonly outputStates = new Map<string, OutputState>();
  private readonly outputInitializations = new Map<string, Promise<void>>();
  private readonly updateListeners = new Set<(update: CoordinatorUpdate) => void>();
  private updateSequence = 0;
  private readonly fingerprints = new Map<string, string>();
  private readonly updates: CoordinatorUpdate[] = [];
  private actionSequence = 0;
  private readonly recentActions: CoordinatorAction[] = [];
  private readonly pendingDecisions = new Map<string, JsonObject>();
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  public constructor(private readonly options: CoordinatorOptions) {}

  public async start(): Promise<void> {
    const sessions = await this.options.omnigent.listSessions(30);
    this.seed(sessions);
    await this.refreshPendingDecisions(sessions);
    this.focusedSessionId = sessionId(sessions[0] ?? {});
    this.focusedSession = this.focusedSessionId
      ? this.sessionSummaries.get(this.focusedSessionId)
      : undefined;
    if (this.focusedSessionId) await this.ensureOutputMonitor(this.focusedSessionId);
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

  public subscribeUpdates(listener: (update: CoordinatorUpdate) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  public async interruptFocused(): Promise<boolean> {
    if (!this.focusedSessionId) return false;
    const snapshot = await this.options.omnigent.getSession(this.focusedSessionId);
    if (snapshot.status !== "running" && snapshot.status !== "waiting") return false;
    await this.options.omnigent.interruptSession(this.focusedSessionId);
    return true;
  }

  public async execute(
    name: string,
    args: Record<string, unknown>,
    afterEventId = 0,
  ): Promise<JsonObject> {
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
      case "poll_output":
        result = await this.pollOutput(args);
        break;
      case "send_message":
        result = await this.sendMessage(args);
        break;
      case "archive_session":
        result = await this.archiveSession(args);
        break;
      case "rename_session":
        result = await this.renameSession(args);
        break;
      case "answer_prompt":
        result = await this.answerPrompt(args);
        break;
      case "start_session":
        result = await this.startSession(args);
        break;
      case "check_updates":
        result = {
          checked: true,
          output_delta: this.focusedSessionId
            ? this.readOutput(this.focusedSessionId, "contextIndex")
            : { changed: false, output: "" },
        };
        break;
      default:
        throw new Error(`Unknown coordinator tool: ${name}`);
    }
    return {
      ...result,
      focused_session: this.focusedSession ?? null,
      known_sessions: this.recentSessionIds.slice(0, 8).map((id) => ({
        ...(this.sessionSummaries.get(id) ?? { id, name: "Untitled session" }),
        focused: id === this.focusedSessionId,
      })),
      pending_decisions: [...this.pendingDecisions.values()],
      recent_actions: this.recentActions.slice(-5),
      ...this.updatesAfter(afterEventId),
    };
  }

  private async listSessions(args: Record<string, unknown>): Promise<JsonObject> {
    const limit = typeof args.limit === "number" ? args.limit : 8;
    const filter = typeof args.status === "string" ? args.status : "any";
    const sessions = await this.options.omnigent.listSessions(Math.max(limit, 30));
    this.rememberSessions(sessions);
    const filtered = sessions.filter((session) =>
      filter === "any"
        ? true
        : filter === "waiting_for_input"
          ? pendingCount(session) > 0
          : session.status === filter,
    );
    return {
      sessions: filtered.slice(0, limit).map((session) => ({
        ...summary(session),
        focused: sessionId(session) === this.focusedSessionId,
      })),
    };
  }

  private async focusSession(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.requiredString(args, "session_id");
    const snapshot = await this.options.omnigent.getSession(id);
    const previousName = stringValue(this.focusedSession?.name) ?? "none";
    const alreadyFocused = id === this.focusedSessionId;
    if (!alreadyFocused) this.rememberPreviousFocus(id);
    this.focusedSessionId = id;
    this.focusedSession = summary(snapshot);
    this.sessionSummaries.set(id, this.focusedSession);
    if (!alreadyFocused) {
      this.options.logger.info("coordinator.focus.changed", {
        from: previousName,
        to: sessionName(snapshot),
      });
      this.recordAction({
        type: "focus_changed",
        session_id: id,
        name: sessionName(snapshot),
        previous_session: previousName,
        summary: `Focused ${sessionName(snapshot)}; previous focus was ${previousName}.`,
      });
    }
    await this.ensureOutputMonitor(id);
    const prompts = voicePrompts(snapshot);
    return {
      focused_session: summary(snapshot),
      focus_changed: !alreadyFocused,
      already_focused: alreadyFocused,
      prompts,
    };
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
    const formatted = formatConversationItems(listing?.data ?? []);
    const items: ConversationOutputItem[] = [...formatted.items]
      .reverse()
      .map((item, index) => ({ ...item, position: index + 1 }));
    const latestMessage = [...items].reverse().find((item) => item.kind === "message") ?? null;
    const recentDelivery = [...this.recentActions]
      .reverse()
      .find(
        (action) =>
          (action.type === "message_sent" || action.type === "message_queued") &&
          action.session_id === id &&
          typeof action.message === "string",
      );
    const deliveredText =
      recentDelivery && typeof recentDelivery.message === "string"
        ? comparableMessage(recentDelivery.message)
        : "";
    const matchingItem = deliveredText
      ? items.find(
          (item) =>
            item.kind === "message" &&
            item.role === "user" &&
            comparableMessage(item.text) === deliveredText,
        )
      : undefined;
    return {
      session_id: id,
      target_session: this.sessionSummaries.get(id) ?? null,
      focus_changed: false,
      page,
      order: "oldest_to_newest",
      latest_message: page === 1 ? latestMessage : null,
      items,
      items_omitted: formatted.omitted,
      has_more: listing?.hasMore ?? false,
      recent_delivery_visibility: recentDelivery
        ? {
            action_id: recentDelivery.action_id,
            delivery: recentDelivery.delivery,
            status: matchingItem ? "visible_on_page" : "not_visible_on_page",
            matching_position: matchingItem?.position ?? null,
            page,
          }
        : null,
    };
  }

  private async pollOutput(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.sessionFrom(args);
    const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
    await this.ensureOutputMonitor(id);
    await this.captureOutput(id);
    return {
      target_session: this.sessionSummaries.get(id) ?? null,
      focus_changed: false,
      ...this.outputAfterCursor(id, cursor || undefined),
    };
  }

  private async sendMessage(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.sessionFrom(args);
    const message = this.requiredString(args, "message");
    const delivery = args.delivery === "queued" ? "queued" : "immediate";
    await this.ensureOutputMonitor(id);
    const snapshot = await this.options.omnigent.getSession(id);
    const target = summary(snapshot);
    this.sessionSummaries.set(id, target);
    if (id === this.focusedSessionId) this.focusedSession = target;
    if (
      delivery === "queued" &&
      (snapshot.status === "running" || snapshot.status === "waiting")
    ) {
      this.deferredMessages.push({ sessionId: id, sessionName: sessionName(snapshot), message });
      this.options.logger.info("coordinator.message.deferred", {
        target: sessionName(snapshot),
        characters: message.length,
      });
      this.recordAction({
        type: "message_queued",
        session_id: id,
        name: sessionName(snapshot),
        delivery: "queued",
        message: message.slice(0, 500),
        summary: `Queued for ${sessionName(snapshot)} after its current turn: ${message.slice(0, 300)}`,
      });
      return {
        accepted: true,
        delivery: "queued",
        target_session: target,
        queued_messages: this.deferredMessages.filter((item) => item.sessionId === id).length,
      };
    }
    const response = await this.options.omnigent.sendMessage(id, message);
    this.options.logger.info("coordinator.message.sent", {
      target: sessionName(snapshot),
      delivery: "immediate",
      characters: message.length,
    });
    this.recordAction({
      type: "message_sent",
      session_id: id,
      name: sessionName(snapshot),
      delivery: "immediate",
      message: message.slice(0, 500),
      summary: `Sent immediately to ${sessionName(snapshot)}: ${message.slice(0, 300)}`,
    });
    return {
      accepted: true,
      delivery: "immediate",
      target_session: target,
      backend_async_accepted: response.queued === true,
    };
  }

  private async archiveSession(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.sessionFrom(args);
    const snapshot = await this.options.omnigent.getSession(id);
    await this.options.omnigent.archiveSession(id);
    const archived = summary(snapshot);
    this.outputStates.delete(id);
    const wasFocused = id === this.focusedSessionId;
    let focusReason = "unchanged";
    if (wasFocused) {
      const sessions = await this.options.omnigent.listSessions(30);
      this.rememberSessions(sessions);
      const available = new Set(
        sessions.map(sessionId).filter((value): value is string => Boolean(value)),
      );
      let nextId: string | undefined;
      while (this.focusHistory.length > 0 && !nextId) {
        const candidate = this.focusHistory.pop();
        if (candidate && candidate !== id && available.has(candidate)) nextId = candidate;
      }
      if (nextId) {
        focusReason = "previous_focus";
      } else {
        nextId = sessionId(sessions[0] ?? {});
        focusReason = nextId ? "most_recent_active" : "no_active_session";
      }
      this.focusedSessionId = nextId;
      this.focusedSession = nextId ? this.sessionSummaries.get(nextId) : undefined;
      if (nextId) await this.ensureOutputMonitor(nextId);
    }
    this.options.logger.info("coordinator.session.archived", {
      archived: sessionName(snapshot),
      nextFocus: stringValue(this.focusedSession?.name) ?? "none",
      focusReason,
    });
    this.recordAction({
      type: "session_archived",
      session_id: id,
      name: sessionName(snapshot),
      next_focus: this.focusedSession ?? null,
      summary: this.focusedSession
        ? `Archived ${sessionName(snapshot)}; focus returned to ${stringValue(this.focusedSession.name) ?? "the previous session"}.`
        : `Archived ${sessionName(snapshot)}; no active session remains.`,
    });
    return {
      archived: true,
      archived_session: archived,
      focus_reason: focusReason,
    };
  }

  private async renameSession(args: Record<string, unknown>): Promise<JsonObject> {
    const id = this.sessionFrom(args);
    const title = this.requiredString(args, "title");
    if (title.length > 120) throw new Error("title must be 120 characters or fewer");
    const before = await this.options.omnigent.getSession(id);
    const previousName = sessionName(before);
    const response = await this.options.omnigent.renameSession(id, title);
    const renamed = summary({ ...before, ...response, id, title });
    this.sessionSummaries.set(id, renamed);
    if (id === this.focusedSessionId) this.focusedSession = renamed;
    const decision = this.pendingDecisions.get(id);
    if (decision) this.pendingDecisions.set(id, { ...decision, name: title });
    this.recordAction({
      type: "session_renamed",
      session_id: id,
      name: title,
      previous_name: previousName,
      new_name: title,
      summary: `Renamed ${previousName} to ${title}.`,
    });
    return {
      renamed: true,
      previous_name: previousName,
      new_name: title,
      renamed_session: renamed,
      focus_changed: false,
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
    const pending = this.pendingDecisions.get(focusedId);
    const targetName =
      stringValue(this.sessionSummaries.get(targetId)?.name) ??
      stringValue(pending?.name) ??
      stringValue(this.sessionSummaries.get(focusedId)?.name) ??
      sessionName(snapshot);
    const targetSession = this.sessionSummaries.get(targetId) ?? {
      id: targetId,
      name: targetName,
    };
    if (pending && Array.isArray(pending.prompts)) {
      const prompts = pending.prompts.filter(
        (entry) => !isObject(entry) || entry.prompt_id !== promptId,
      );
      if (prompts.length > 0) this.pendingDecisions.set(focusedId, { ...pending, prompts });
      else this.pendingDecisions.delete(focusedId);
    }
    this.recordAction({
      type: "prompt_answered",
      session_id: targetId,
      name: targetName,
      prompt_id: promptId,
      action,
      summary: `${action === "accept" ? "Accepted" : action === "decline" ? "Declined" : "Cancelled"} a pending prompt in ${targetName}.`,
    });
    return {
      resolved: true,
      session_id: targetId,
      prompt_id: promptId,
      action,
      target_session: targetSession,
    };
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
    this.rememberPreviousFocus(id);
    this.focusedSessionId = id;
    this.focusedSession = summary(created);
    this.sessionSummaries.set(id, this.focusedSession);
    this.recentSessionIds = [
      id,
      ...this.recentSessionIds.filter((sessionId) => sessionId !== id),
    ];
    await this.ensureOutputMonitor(id);
    this.fingerprints.set(id, this.fingerprint(created));
    this.recordAction({
      type: "session_started",
      session_id: id,
      name: sessionName(created),
      instruction: instruction.slice(0, 500),
      summary: `Started and focused ${sessionName(created)}: ${instruction.slice(0, 300)}`,
    });
    return { started: true, focused_session: summary(created) };
  }

  private requiredString(args: Record<string, unknown>, name: string): string {
    const value = typeof args[name] === "string" ? args[name].trim() : "";
    if (!value) throw new Error(`${name} is required`);
    return value;
  }

  private rememberPreviousFocus(nextId: string): void {
    const previous = this.focusedSessionId;
    if (!previous || previous === nextId) return;
    const existing = this.focusHistory.lastIndexOf(previous);
    if (existing >= 0) this.focusHistory.splice(existing, 1);
    this.focusHistory.push(previous);
    if (this.focusHistory.length > 20) this.focusHistory.splice(0, this.focusHistory.length - 20);
  }

  private recordAction(action: CoordinatorActionInput): void {
    const recorded: CoordinatorAction = {
      ...action,
      action_id: ++this.actionSequence,
      occurred_at: new Date().toISOString(),
    };
    this.recentActions.push(recorded);
    if (this.recentActions.length > 20) {
      this.recentActions.splice(0, this.recentActions.length - 20);
    }
    this.options.logger.info("coordinator.action.recorded", {
      actionId: recorded.action_id,
      type: recorded.type,
      summary: recorded.summary,
    });
  }

  private sessionFrom(args: Record<string, unknown>): string {
    const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
    const id = explicit || this.focusedSessionId;
    if (!id) throw new Error("No session is focused; list and focus a session first");
    return id;
  }

  private updatesAfter(afterEventId: number): JsonObject {
    const requested = Math.max(0, Math.floor(afterEventId));
    const earliest = this.updates[0]?.event_id;
    const cursorAhead = requested > this.updateSequence;
    const cursorExpired =
      cursorAhead || (earliest !== undefined && requested < earliest - 1);
    const effective = cursorAhead ? 0 : requested;
    return {
      updates: this.updates.filter((update) => update.event_id > effective),
      update_cursor: this.updateSequence,
      update_cursor_expired: cursorExpired,
    };
  }

  private seed(sessions: JsonObject[]): void {
    this.rememberSessions(sessions);
    for (const session of sessions) {
      const id = sessionId(session);
      if (id) this.fingerprints.set(id, this.fingerprint(session));
    }
  }

  private rememberSessions(sessions: JsonObject[]): void {
    this.recentSessionIds = sessions
      .map(sessionId)
      .filter((id): id is string => Boolean(id));
    for (const session of sessions) {
      const id = sessionId(session);
      if (!id) continue;
      const compact = summary(session);
      this.sessionSummaries.set(id, compact);
      if (id === this.focusedSessionId) this.focusedSession = compact;
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
    this.rememberSessions(sessions);
    await this.refreshPendingDecisions(sessions);
    await this.dispatchDeferredMessages(sessions);
    const monitoredIds = [...this.outputStates.keys()];
    const assistantOutputIds = new Set(
      (
        await Promise.all(
          monitoredIds.map(async (id) => ({ id, changed: await this.captureOutput(id) })),
        )
      )
        .filter(({ changed }) => changed)
        .map(({ id }) => id),
    );
    for (const session of sessions) {
      const id = sessionId(session);
      if (!id) continue;
      const before = this.fingerprints.get(id);
      const after = this.fingerprint(session);
      this.fingerprints.set(id, after);
      let previous: { status?: unknown; pending?: unknown } = {};
      const lifecycleChanged = Boolean(before && before !== after);
      if (lifecycleChanged && before) {
        try {
          previous = JSON.parse(before) as typeof previous;
        } catch {
          previous = {};
        }
      }
      const status = stringValue(session.status) ?? "unknown";
      const name = sessionName(session);
      let lifecycleUpdate = false;
      if (lifecycleChanged && status === "failed" && previous.status !== "failed") {
        lifecycleUpdate = true;
        this.pushUpdate({
          type: "session_failed",
          session_id: id,
          name,
          status,
          output_delta: this.readOutput(id, "notificationIndex"),
        });
      } else if (
        status === "idle" &&
        (previous.status === "running" || previous.status === "waiting")
      ) {
        lifecycleUpdate = true;
        this.pushUpdate({
          type: "session_completed",
          session_id: id,
          name,
          status,
          output_delta: this.readOutput(id, "notificationIndex"),
        });
      }
      if (
        lifecycleChanged &&
        pendingCount(session) > Number(previous.pending ?? 0)
      ) {
        lifecycleUpdate = true;
        this.pushUpdate({
          type: "decision_needed",
          session_id: id,
          name,
          pending_prompts: pendingCount(session),
          prompts: this.pendingDecisions.get(id)?.prompts ?? [],
          output_delta: this.readOutput(id, "notificationIndex"),
        });
      }
      if (!lifecycleUpdate && status === "running" && assistantOutputIds.has(id)) {
        this.pushUpdate({
          type: "session_output",
          session_id: id,
          name,
          status,
          output_delta: this.readOutput(id, "notificationIndex"),
        });
      }
    }
  }

  private async refreshPendingDecisions(sessions: JsonObject[]): Promise<void> {
    const present = new Set<string>();
    await Promise.all(
      sessions.map(async (session) => {
        const id = sessionId(session);
        if (!id) return;
        present.add(id);
        if (pendingCount(session) === 0) {
          this.pendingDecisions.delete(id);
          return;
        }
        let snapshot = session;
        if (voicePrompts(snapshot).length === 0) {
          try {
            snapshot = await this.options.omnigent.getSession(id);
          } catch (error) {
            this.options.logger.warn("coordinator.pending_prompt.failed", {
              session: sessionName(session),
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        }
        const prompts = voicePrompts(snapshot);
        if (prompts.length === 0) return;
        this.pendingDecisions.set(id, {
          session_id: id,
          name: sessionName(snapshot),
          prompts,
        });
      }),
    );
    for (const id of this.pendingDecisions.keys()) {
      if (!present.has(id)) this.pendingDecisions.delete(id);
    }
  }

  private async ensureOutputMonitor(id: string): Promise<void> {
    if (this.outputStates.has(id)) return;
    const existing = this.outputInitializations.get(id);
    if (existing) return existing;
    const initialization = this.options.omnigent
      .listItems(id, 30)
      .then((listing) => {
        const ids = listing.data.map(itemId).filter((value): value is string => Boolean(value));
        this.outputStates.set(id, {
          seenIds: new Set(ids),
          seenOrder: ids,
          entries: [],
          contextIndex: 0,
          notificationIndex: 0,
        });
      })
      .finally(() => this.outputInitializations.delete(id));
    this.outputInitializations.set(id, initialization);
    return initialization;
  }

  private async captureOutput(id: string): Promise<boolean> {
    const state = this.outputStates.get(id);
    if (!state) return false;
    const listing = await this.options.omnigent.listItems(id, 30);
    const unseen = listing.data
      .filter((raw) => {
        const id = itemId(raw);
        return Boolean(id && !state.seenIds.has(id));
      })
      .reverse();
    let assistantMessageChanged = false;
    for (const raw of unseen) {
      const id = itemId(raw);
      if (!id) continue;
      state.seenIds.add(id);
      state.seenOrder.push(id);
      if (isAssistantMessage(raw)) assistantMessageChanged = true;
      const text = meaningfulOutput(raw);
      if (text) state.entries.push({ id, text });
    }
    while (state.seenOrder.length > 300) {
      const removed = state.seenOrder.shift();
      if (removed) state.seenIds.delete(removed);
    }
    if (state.entries.length > 120) {
      const removeCount = state.entries.length - 120;
      state.entries.splice(0, removeCount);
      state.contextIndex = Math.max(0, state.contextIndex - removeCount);
      state.notificationIndex = Math.max(0, state.notificationIndex - removeCount);
    }
    return assistantMessageChanged;
  }

  private readOutput(
    id: string,
    cursor: "contextIndex" | "notificationIndex",
  ): JsonObject {
    const state = this.outputStates.get(id);
    if (!state) return { changed: false, output: "" };
    const entries = state.entries.slice(state[cursor]);
    state[cursor] = state.entries.length;
    const text = entries.map((entry) => entry.text).join("\n\n");
    return {
      changed: entries.length > 0,
      output: text.length > 8_000 ? `${text.slice(-8_000)}\n[older output omitted]` : text,
      cursor: entries.at(-1)?.id ?? null,
    };
  }

  private outputAfterCursor(id: string, cursor?: string): JsonObject {
    const state = this.outputStates.get(id);
    if (!state) return { changed: false, output: "", cursor: cursor ?? null };
    const cursorIndex = cursor
      ? state.entries.findIndex((entry) => entry.id === cursor)
      : -1;
    const cursorExpired = Boolean(cursor && cursorIndex < 0);
    const entries = state.entries.slice(cursorIndex + 1);
    const text = entries.map((entry) => entry.text).join("\n\n");
    return {
      changed: entries.length > 0,
      output: text.length > 8_000 ? `${text.slice(-8_000)}\n[older output omitted]` : text,
      cursor: entries.at(-1)?.id ?? cursor ?? null,
      cursor_expired: cursorExpired,
    };
  }

  private async dispatchDeferredMessages(sessions: JsonObject[]): Promise<void> {
    for (const session of sessions) {
      if (session.status !== "idle") continue;
      const id = sessionId(session);
      if (!id) continue;
      const index = this.deferredMessages.findIndex((item) => item.sessionId === id);
      if (index < 0) continue;
      const pending = this.deferredMessages[index]!;
      this.deferredMessages.splice(index, 1);
      try {
        await this.options.omnigent.sendMessage(id, pending.message);
        this.options.logger.info("coordinator.message.sent", {
          target: pending.sessionName,
          delivery: "queued_after_turn",
          characters: pending.message.length,
        });
        this.recordAction({
          type: "message_sent",
          session_id: id,
          name: pending.sessionName,
          delivery: "queued_after_turn",
          message: pending.message.slice(0, 500),
          summary: `Sent queued message to ${pending.sessionName}: ${pending.message.slice(0, 300)}`,
        });
      } catch (error) {
        this.deferredMessages.splice(index, 0, pending);
        throw error;
      }
    }
  }

  private pushUpdate(update: CoordinatorUpdateInput): void {
    const sequenced: CoordinatorUpdate = {
      ...update,
      event_id: ++this.updateSequence,
    };
    this.updates.push(sequenced);
    if (this.updates.length > 50) this.updates.splice(0, this.updates.length - 50);
    for (const listener of this.updateListeners) listener(sequenced);
  }
}
