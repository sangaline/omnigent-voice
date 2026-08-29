import { CelerisHistoryMessage, CelerisTraceEvent } from "./celeris.js";
import { CoordinatorExecutor } from "./mcp.js";
import { JsonObject } from "./omnigent.js";

export interface VoiceToolCallExpectation {
  index: number;
  name?: string | undefined;
  sessionId?: string | undefined;
  messageTerms?: Array<string> | undefined;
  messageAnyTerms?: Array<Array<string>> | undefined;
  delivery?: "immediate" | "queued" | "not_queued" | undefined;
  argumentEquals?: Record<string, unknown> | undefined;
}

export type VoiceUnorderedToolCallExpectation = Omit<
  VoiceToolCallExpectation,
  "index"
>;

export interface VoiceEvalExpectation {
  toolSequence: Array<string>;
  alternativeToolSequences?: Array<Array<string>> | undefined;
  forbiddenTools?: Array<string> | undefined;
  sessionId?: string | undefined;
  sessionIdIfTool?: string | undefined;
  messageTerms?: Array<string> | undefined;
  messageAnyTerms?: Array<Array<string>> | undefined;
  argumentTerms?: Record<string, Array<string>> | undefined;
  delivery?: "immediate" | "queued" | "not_queued" | undefined;
  argumentEquals?: Record<string, unknown> | undefined;
  speechTerms?: Array<string> | undefined;
  speechAnyTerms?: Array<Array<string>> | undefined;
  speechForbiddenTerms?: Array<string> | undefined;
  allowedSpeechNumbers?: Array<number> | undefined;
  speechExact?: string | undefined;
  maxSpeechWords?: number | undefined;
  maxRounds?: number | undefined;
  callExpectations?: VoiceToolCallExpectation[] | undefined;
  unorderedCallExpectations?: VoiceUnorderedToolCallExpectation[] | undefined;
}

export interface VoiceEvalCase {
  id: string;
  description: string;
  history: CelerisHistoryMessage[];
  input: string;
  coordinatorState: JsonObject;
  toolResults?: Record<string, unknown> | undefined;
  expected: VoiceEvalExpectation;
}

export interface ObservedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: JsonObject;
}

export interface VoiceEvalObservation {
  toolCalls: ObservedToolCall[];
  speech: string;
  rounds: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  modelError?: string | undefined;
}

export interface VoiceEvalScore {
  passed: boolean;
  checks: number;
  failures: string[];
}

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const lowerIncludes = (value: string, term: string): boolean =>
  value.toLocaleLowerCase().includes(term.toLocaleLowerCase());

export const parseReplayCoordinatorUpdates = (
  serialized: string | undefined,
  fallback: unknown[],
): unknown[] => {
  if (serialized) {
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Older or interrupted audit records use the bounded synthetic fallback.
    }
  }
  return fallback;
};

const updatesAfter = (state: JsonObject, afterEventId = 0): unknown[] =>
  Array.isArray(state.updates)
    ? state.updates.filter((value) => {
        const update = isJsonObject(value) ? value : undefined;
        return typeof update?.event_id === "number" && update.event_id > afterEventId;
      })
    : [];

const authoritativeEnvelope = (state: JsonObject, afterEventId = 0): JsonObject => ({
  focused_session: state.focused_session ?? null,
  known_sessions: state.known_sessions ?? [],
  pending_decisions: state.pending_decisions ?? [],
  recent_actions: state.recent_actions ?? [],
  updates: updatesAfter(state, afterEventId),
  update_cursor: state.update_cursor ?? 0,
  update_cursor_expired: state.update_cursor_expired ?? false,
});

export class FrozenCoordinatorExecutor implements CoordinatorExecutor {
  public readonly calls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    afterEventId: number | undefined;
  }> = [];

  private readonly resultQueues = new Map<string, unknown[]>();
  private state: JsonObject;

  public constructor(
    state: JsonObject,
    toolResults: Record<string, unknown> = {},
  ) {
    this.state = { ...state };
    this.replaceToolResults(toolResults);
  }

  public replaceState(state: JsonObject): void {
    this.state = { ...state };
  }

  public replaceToolResults(toolResults: Record<string, unknown> = {}): void {
    this.resultQueues.clear();
    for (const [name, value] of Object.entries(toolResults)) {
      this.resultQueues.set(name, Array.isArray(value) ? [...value] : [value]);
    }
  }

  public async execute(
    name: string,
    args: Record<string, unknown>,
    afterEventId?: number,
  ): Promise<JsonObject> {
    this.calls.push({ name, arguments: args, afterEventId });
    if (name === "check_updates") {
      return { ...this.state, updates: updatesAfter(this.state, afterEventId) };
    }
    const envelope = authoritativeEnvelope(this.state, afterEventId);
    const queue = this.resultQueues.get(name);
    let supplied: unknown;
    if (queue && queue.length > 0) {
      const requestedSessionId = typeof args.session_id === "string"
        ? args.session_id
        : undefined;
      const matchingIndex = requestedSessionId
        ? queue.findIndex((candidate) => {
            if (!isJsonObject(candidate)) return false;
            if (candidate.session_id === requestedSessionId) return true;
            const target = isJsonObject(candidate.target_session)
              ? candidate.target_session
              : undefined;
            return target?.id === requestedSessionId;
          })
        : -1;
      [supplied] = matchingIndex >= 0
        ? queue.splice(matchingIndex, 1)
        : queue.splice(0, 1);
    }
    if (isJsonObject(supplied)) {
      const result = { ...envelope, ...supplied };
      for (const key of [
        "focused_session",
        "known_sessions",
        "pending_decisions",
        "recent_actions",
        "updates",
        "update_cursor",
        "update_cursor_expired",
      ]) {
        if (key in supplied) this.state[key] = supplied[key];
      }
      return result;
    }
    return {
      error: `Frozen coordinator has no supplied result for ${name}`,
      ...envelope,
    };
  }
}

export const observationFromTrace = (
  trace: readonly CelerisTraceEvent[],
  speech: string,
  durationMs: number,
): VoiceEvalObservation => {
  const completions = trace.filter(
    (event): event is Extract<CelerisTraceEvent, { type: "completion" }> =>
      event.type === "completion" && event.phase.startsWith("round_"),
  );
  return {
    toolCalls: trace
      .filter(
        (event): event is Extract<CelerisTraceEvent, { type: "tool" }> =>
          event.type === "tool",
      )
      .map((event) => ({
        name: event.name,
        arguments: event.arguments,
        result: event.result,
      })),
    speech,
    rounds: completions.length,
    durationMs,
    promptTokens: completions.reduce(
      (total, event) => total + (event.promptTokens ?? 0),
      0,
    ),
    completionTokens: completions.reduce(
      (total, event) => total + (event.completionTokens ?? 0),
      0,
    ),
    modelError: trace.find(
      (event): event is Extract<CelerisTraceEvent, { type: "error" }> =>
        event.type === "error" && event.phase === "turn",
    )?.message,
  };
};

export const scoreVoiceEval = (
  testCase: VoiceEvalCase,
  observation: VoiceEvalObservation,
): VoiceEvalScore => {
  const failures: string[] = [];
  let checks = 0;
  const check = (condition: boolean, failure: string): void => {
    checks += 1;
    if (!condition) failures.push(failure);
  };
  const observedSequence = observation.toolCalls.map(({ name }) => name);
  const allowedSequences = [
    testCase.expected.toolSequence,
    ...(testCase.expected.alternativeToolSequences ?? []),
  ];
  check(
    allowedSequences.some(
      (sequence) => JSON.stringify(observedSequence) === JSON.stringify(sequence),
    ),
    `tool sequence ${JSON.stringify(observedSequence)} not in ${JSON.stringify(allowedSequences)}`,
  );
  for (const forbidden of testCase.expected.forbiddenTools ?? []) {
    check(!observedSequence.includes(forbidden), `called forbidden tool ${forbidden}`);
  }
  const first = observation.toolCalls[0];
  if (testCase.expected.sessionId) {
    check(
      first?.arguments.session_id === testCase.expected.sessionId,
      `session_id ${String(first?.arguments.session_id)} != ${testCase.expected.sessionId}`,
    );
  }
  if (testCase.expected.sessionIdIfTool && first) {
    check(
      first.arguments.session_id === testCase.expected.sessionIdIfTool,
      `session_id ${String(first.arguments.session_id)} != ${testCase.expected.sessionIdIfTool}`,
    );
  }
  if (testCase.expected.messageTerms) {
    const message = typeof first?.arguments.message === "string"
      ? first.arguments.message
      : "";
    for (const term of testCase.expected.messageTerms) {
      check(lowerIncludes(message, term), `message omitted ${JSON.stringify(term)}`);
    }
  }
  if (testCase.expected.messageAnyTerms) {
    const message = typeof first?.arguments.message === "string"
      ? first.arguments.message
      : "";
    for (const alternatives of testCase.expected.messageAnyTerms) {
      check(
        alternatives.some((term) => lowerIncludes(message, term)),
        `message omitted all of ${JSON.stringify(alternatives)}`,
      );
    }
  }
  for (const [name, terms] of Object.entries(testCase.expected.argumentTerms ?? {})) {
    const argument = typeof first?.arguments[name] === "string"
      ? first.arguments[name]
      : "";
    for (const term of terms) {
      check(lowerIncludes(argument, term), `argument ${name} omitted ${JSON.stringify(term)}`);
    }
  }
  if (testCase.expected.delivery) {
    const delivery = first?.arguments.delivery;
    check(
      testCase.expected.delivery === "not_queued"
        ? delivery !== "queued"
        : delivery === testCase.expected.delivery,
      `delivery ${String(delivery)} != ${testCase.expected.delivery}`,
    );
  }
  for (const [name, value] of Object.entries(testCase.expected.argumentEquals ?? {})) {
    check(
      JSON.stringify(first?.arguments[name]) === JSON.stringify(value),
      `argument ${name} ${JSON.stringify(first?.arguments[name])} != ${JSON.stringify(value)}`,
    );
  }
  const scoreExpectedCall = (
    expectedCall: VoiceUnorderedToolCallExpectation,
    call: ObservedToolCall | undefined,
    label: string,
  ): void => {
    check(Boolean(call), `missing tool call ${label}`);
    if (!call) return;
    if (expectedCall.name) {
      check(
        call.name === expectedCall.name,
        `tool call ${label} name ${call.name} != ${expectedCall.name}`,
      );
    }
    if (expectedCall.sessionId) {
      check(
        call.arguments.session_id === expectedCall.sessionId,
        `tool call ${label} session_id ${String(call.arguments.session_id)} != ${expectedCall.sessionId}`,
      );
    }
    if (expectedCall.messageTerms) {
      const message = typeof call.arguments.message === "string"
        ? call.arguments.message
        : "";
      for (const term of expectedCall.messageTerms) {
        check(
          lowerIncludes(message, term),
          `tool call ${label} message omitted ${JSON.stringify(term)}`,
        );
      }
    }
    if (expectedCall.messageAnyTerms) {
      const message = typeof call.arguments.message === "string"
        ? call.arguments.message
        : "";
      for (const alternatives of expectedCall.messageAnyTerms) {
        check(
          alternatives.some((term) => lowerIncludes(message, term)),
          `tool call ${label} message omitted all of ${JSON.stringify(alternatives)}`,
        );
      }
    }
    if (expectedCall.delivery) {
      const delivery = call.arguments.delivery;
      check(
        expectedCall.delivery === "not_queued"
          ? delivery !== "queued"
          : delivery === expectedCall.delivery,
        `tool call ${label} delivery ${String(delivery)} != ${expectedCall.delivery}`,
      );
    }
    for (const [name, value] of Object.entries(expectedCall.argumentEquals ?? {})) {
      check(
        JSON.stringify(call.arguments[name]) === JSON.stringify(value),
        `tool call ${label} argument ${name} ${JSON.stringify(call.arguments[name])} != ${JSON.stringify(value)}`,
      );
    }
  };
  for (const expectedCall of testCase.expected.callExpectations ?? []) {
    scoreExpectedCall(
      expectedCall,
      observation.toolCalls[expectedCall.index],
      String(expectedCall.index),
    );
  }
  const unmatchedCalls = [...observation.toolCalls];
  for (const expectedCall of testCase.expected.unorderedCallExpectations ?? []) {
    const callIndex = unmatchedCalls.findIndex(
      (call) =>
        (!expectedCall.name || call.name === expectedCall.name) &&
        (!expectedCall.sessionId ||
          call.arguments.session_id === expectedCall.sessionId),
    );
    const [call] = callIndex >= 0 ? unmatchedCalls.splice(callIndex, 1) : [];
    scoreExpectedCall(expectedCall, call, `named ${expectedCall.name ?? "call"}`);
  }
  for (const term of testCase.expected.speechTerms ?? []) {
    check(lowerIncludes(observation.speech, term), `speech omitted ${JSON.stringify(term)}`);
  }
  for (const alternatives of testCase.expected.speechAnyTerms ?? []) {
    check(
      alternatives.some((term) => lowerIncludes(observation.speech, term)),
      `speech omitted all of ${JSON.stringify(alternatives)}`,
    );
  }
  for (const term of testCase.expected.speechForbiddenTerms ?? []) {
    check(!lowerIncludes(observation.speech, term), `speech included forbidden ${JSON.stringify(term)}`);
  }
  if (testCase.expected.allowedSpeechNumbers) {
    const allowed = new Set(testCase.expected.allowedSpeechNumbers);
    const spokenNumbers = [...observation.speech.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)]
      .map(([value]) => Number(value.replaceAll(",", "")))
      .filter((value) => Number.isFinite(value));
    for (const value of spokenNumbers) {
      check(allowed.has(value), `speech included unapproved number ${value}`);
    }
  }
  if (testCase.expected.speechExact) {
    check(
      observation.speech === testCase.expected.speechExact,
      `speech ${JSON.stringify(observation.speech)} != ${JSON.stringify(testCase.expected.speechExact)}`,
    );
  }
  if (testCase.expected.maxSpeechWords !== undefined) {
    const spokenWords = observation.speech.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? [];
    check(
      spokenWords.length <= testCase.expected.maxSpeechWords,
      `speech used ${spokenWords.length} words, maximum ${testCase.expected.maxSpeechWords}`,
    );
  }
  if (testCase.expected.maxRounds !== undefined) {
    check(
      observation.rounds <= testCase.expected.maxRounds,
      `used ${observation.rounds} rounds, maximum ${testCase.expected.maxRounds}`,
    );
  }
  return { passed: failures.length === 0, checks, failures };
};
