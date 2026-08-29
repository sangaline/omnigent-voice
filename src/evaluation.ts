import { CelerisHistoryMessage, CelerisTraceEvent } from "./celeris.js";
import { CoordinatorExecutor } from "./mcp.js";
import { JsonObject } from "./omnigent.js";

export interface VoiceToolCallExpectation {
  index: number;
  name?: string | undefined;
  sessionId?: string | undefined;
  messageTerms?: Array<string> | undefined;
  delivery?: "immediate" | "queued" | "not_queued" | undefined;
  argumentEquals?: Record<string, unknown> | undefined;
}

export interface VoiceEvalExpectation {
  toolSequence: Array<string>;
  alternativeToolSequences?: Array<Array<string>> | undefined;
  forbiddenTools?: Array<string> | undefined;
  sessionId?: string | undefined;
  sessionIdIfTool?: string | undefined;
  messageTerms?: Array<string> | undefined;
  argumentTerms?: Record<string, Array<string>> | undefined;
  delivery?: "immediate" | "queued" | "not_queued" | undefined;
  argumentEquals?: Record<string, unknown> | undefined;
  speechTerms?: Array<string> | undefined;
  speechAnyTerms?: Array<Array<string>> | undefined;
  speechForbiddenTerms?: Array<string> | undefined;
  allowedSpeechNumbers?: Array<number> | undefined;
  speechExact?: string | undefined;
  maxRounds?: number | undefined;
  callExpectations?: VoiceToolCallExpectation[] | undefined;
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

const authoritativeEnvelope = (state: JsonObject): JsonObject => ({
  focused_session: state.focused_session ?? null,
  known_sessions: state.known_sessions ?? [],
  pending_decisions: state.pending_decisions ?? [],
  recent_actions: state.recent_actions ?? [],
  updates: state.updates ?? [],
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
    if (name === "check_updates") return { ...this.state };
    const envelope = authoritativeEnvelope(this.state);
    const supplied = this.resultQueues.get(name)?.shift();
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
  for (const expectedCall of testCase.expected.callExpectations ?? []) {
    const call = observation.toolCalls[expectedCall.index];
    check(Boolean(call), `missing tool call at index ${expectedCall.index}`);
    if (!call) continue;
    if (expectedCall.name) {
      check(
        call.name === expectedCall.name,
        `tool call ${expectedCall.index} name ${call.name} != ${expectedCall.name}`,
      );
    }
    if (expectedCall.sessionId) {
      check(
        call.arguments.session_id === expectedCall.sessionId,
        `tool call ${expectedCall.index} session_id ${String(call.arguments.session_id)} != ${expectedCall.sessionId}`,
      );
    }
    if (expectedCall.messageTerms) {
      const message = typeof call.arguments.message === "string"
        ? call.arguments.message
        : "";
      for (const term of expectedCall.messageTerms) {
        check(
          lowerIncludes(message, term),
          `tool call ${expectedCall.index} message omitted ${JSON.stringify(term)}`,
        );
      }
    }
    if (expectedCall.delivery) {
      const delivery = call.arguments.delivery;
      check(
        expectedCall.delivery === "not_queued"
          ? delivery !== "queued"
          : delivery === expectedCall.delivery,
        `tool call ${expectedCall.index} delivery ${String(delivery)} != ${expectedCall.delivery}`,
      );
    }
    for (const [name, value] of Object.entries(expectedCall.argumentEquals ?? {})) {
      check(
        JSON.stringify(call.arguments[name]) === JSON.stringify(value),
        `tool call ${expectedCall.index} argument ${name} ${JSON.stringify(call.arguments[name])} != ${JSON.stringify(value)}`,
      );
    }
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
  if (testCase.expected.maxRounds) {
    check(
      observation.rounds <= testCase.expected.maxRounds,
      `used ${observation.rounds} rounds, maximum ${testCase.expected.maxRounds}`,
    );
  }
  return { passed: failures.length === 0, checks, failures };
};
