import { readFileSync } from "node:fs";
import {
  CelerisConversation,
  CelerisHistoryMessage,
  CelerisTraceEvent,
  currentTurnActionInvariant,
  systemPrompt,
} from "./celeris.js";
import { CoordinatorUpdate } from "./coordinator.js";
import {
  FrozenCoordinatorExecutor,
  observationFromTrace,
  scoreVoiceEval,
  VoiceEvalCase,
  VoiceEvalExpectation,
  VoiceEvalObservation,
} from "./evaluation.js";
import { Logger } from "./log.js";
import { CoordinatorMcpClient } from "./mcp.js";
import { JsonObject } from "./omnigent.js";

interface UserScenarioTurn {
  type: "user";
  input: string;
  coordinatorState: JsonObject;
  toolResults?: Record<string, unknown> | undefined;
  expected: VoiceEvalExpectation;
  checkUpdatesAfter?: number | undefined;
}

interface NotificationScenarioTurn {
  type: "notification";
  updates: CoordinatorUpdate[];
  expected: VoiceEvalExpectation;
}

type ScenarioTurn = UserScenarioTurn | NotificationScenarioTurn;

interface VoiceEvalScenario {
  id: string;
  description: string;
  initialHistory: CelerisHistoryMessage[];
  initialCoordinatorState: JsonObject;
  turns: ScenarioTurn[];
}

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hasOption = (name: string): boolean => process.argv.includes(name);

const required = (value: string | undefined, description: string): string => {
  if (!value) throw new Error(`Missing ${description}`);
  return value;
};

const invalidModelError = (message: string | undefined): boolean =>
  Boolean(message && /(?:HTTP 429|HTTP 5\d\d|fetch failed|aborted|timeout)/i.test(message));

const scoreTurn = (
  id: string,
  description: string,
  expected: VoiceEvalExpectation,
  observation: VoiceEvalObservation,
) =>
  scoreVoiceEval(
    {
      id,
      description,
      history: [],
      input: "",
      coordinatorState: {},
      expected,
    } satisfies VoiceEvalCase,
    observation,
  );

const apiKeyFile = option("--api-key-file");
const apiKey = required(
  process.env.CELERIS_API_KEY?.trim() ??
    (apiKeyFile ? readFileSync(apiKeyFile, "utf8").trim() : undefined),
  "CELERIS_API_KEY or --api-key-file PATH",
);
const scenariosPath = option("--scenarios") ?? "evals/scenarios.json";
const allScenarios = JSON.parse(
  readFileSync(scenariosPath, "utf8"),
) as VoiceEvalScenario[];
const selectedId = option("--case");
const scenarios = selectedId
  ? allScenarios.filter((scenario) => scenario.id === selectedId)
  : allScenarios;
if (scenarios.length === 0) throw new Error(`No evaluation scenario matched ${selectedId}`);
const runs = Math.max(1, Number(option("--runs") ?? "1"));
if (!Number.isInteger(runs)) throw new Error("--runs must be a positive integer");

const promptPath = option("--system-prompt-file");
const promptSuffixPath = option("--system-prompt-suffix-file");
const invariantPath = option("--action-invariant-file");
const selectedSystemPrompt =
  (promptPath ? readFileSync(promptPath, "utf8").trim() : systemPrompt) +
  (promptSuffixPath ? `\n${readFileSync(promptSuffixPath, "utf8").trim()}` : "");
const selectedActionInvariant = invariantPath
  ? readFileSync(invariantPath, "utf8").trim()
  : currentTurnActionInvariant;

const results = [];
for (const scenario of scenarios) {
  for (let run = 1; run <= runs; run += 1) {
    const coordinator = new FrozenCoordinatorExecutor(scenario.initialCoordinatorState);
    const tools = await CoordinatorMcpClient.create(coordinator);
    const trace: CelerisTraceEvent[] = [];
    const conversation = new CelerisConversation({
      apiKey,
      baseUrl:
        process.env.CELERIS_BASE_URL?.replace(/\/$/, "") ??
        "https://inference.celeris.ai/celeris-1/v1",
      model: process.env.CELERIS_MODEL ?? "celeris-1",
      logger: new Logger("error"),
      tools,
      systemPromptOverride: selectedSystemPrompt,
      actionInvariantOverride: hasOption("--omit-action-invariant")
        ? ""
        : selectedActionInvariant,
      temperature: Number(option("--temperature") ?? "0"),
      seed: Number(option("--seed") ?? "7"),
      trace: (event) => trace.push(event),
    });
    conversation.restoreHistory(scenario.initialHistory);
    const turnResults = [];
    try {
      for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
        const turn = scenario.turns[turnIndex];
        if (!turn) continue;
        trace.length = 0;
        const started = performance.now();
        let observation: VoiceEvalObservation;
        const extraFailures: string[] = [];

        if (turn.type === "user") {
          coordinator.replaceState(turn.coordinatorState);
          coordinator.replaceToolResults(turn.toolResults);
          const callStart = coordinator.calls.length;
          const speech = await conversation.respond(turn.input);
          observation = observationFromTrace(
            trace,
            speech,
            Math.round(performance.now() - started),
          );
          if (turn.checkUpdatesAfter !== undefined) {
            const checkUpdates = coordinator.calls
              .slice(callStart)
              .find((call) => call.name === "check_updates");
            if (checkUpdates?.afterEventId !== turn.checkUpdatesAfter) {
              extraFailures.push(
                `check_updates cursor ${String(checkUpdates?.afterEventId)} != ${turn.checkUpdatesAfter}`,
              );
            }
          }
        } else {
          const speech =
            (await conversation.announceUpdate(
              turn.updates,
              new AbortController().signal,
            )) ?? "";
          if (speech) conversation.acknowledgeSpokenUpdates(turn.updates, speech);
          const notificationError = trace.find(
            (event): event is Extract<CelerisTraceEvent, { type: "error" }> =>
              event.type === "error" && event.phase === "notification",
          )?.message;
          const completions = trace.filter(
            (event): event is Extract<CelerisTraceEvent, { type: "completion" }> =>
              event.type === "completion" && event.phase === "background_update",
          );
          observation = {
            toolCalls: [],
            speech,
            rounds: completions.length,
            durationMs: Math.round(performance.now() - started),
            promptTokens: completions.reduce(
              (total, event) => total + (event.promptTokens ?? 0),
              0,
            ),
            completionTokens: completions.reduce(
              (total, event) => total + (event.completionTokens ?? 0),
              0,
            ),
            modelError: notificationError,
          };
        }

        const invalid = invalidModelError(observation.modelError);
        const score = invalid
          ? {
              passed: false,
              checks: 0,
              failures: [`invalid model trial: ${observation.modelError}`],
            }
          : scoreTurn(
              `${scenario.id}:${turnIndex + 1}`,
              scenario.description,
              turn.expected,
              observation,
            );
        if (observation.modelError && !invalid) {
          score.passed = false;
          score.failures.push(`model returned an unusable turn: ${observation.modelError}`);
        }
        if (!invalid && extraFailures.length > 0) {
          score.passed = false;
          score.failures.push(...extraFailures);
        }
        const result = {
          turn: turnIndex + 1,
          type: turn.type,
          input: turn.type === "user" ? turn.input : undefined,
          invalid,
          ...score,
          observation,
          ...(hasOption("--include-trace") ? { trace: trace.map((event) => ({ ...event })) } : {}),
        };
        turnResults.push(result);
        if (!hasOption("--json")) {
          const marker = invalid ? "INVALID" : score.passed ? "PASS" : "FAIL";
          console.log(
            `${marker} ${scenario.id} turn ${turnIndex + 1}/${scenario.turns.length} ` +
              `(${observation.durationMs} ms, ${observation.rounds} rounds)`,
          );
          for (const failure of score.failures) console.log(`  ${failure}`);
        }
      }
    } finally {
      await tools.close();
    }
    const validTurns = turnResults.filter((result) => !result.invalid);
    results.push({
      id: scenario.id,
      description: scenario.description,
      run,
      passed:
        validTurns.length === turnResults.length &&
        validTurns.every((result) => result.passed),
      invalid: turnResults.length - validTurns.length,
      turns: turnResults,
    });
  }
}

const invalid = results.reduce((total, result) => total + result.invalid, 0);
const validScenarios = results.filter((result) => result.invalid === 0);
const passed = validScenarios.filter((result) => result.passed).length;
const report = {
  passed,
  failed: validScenarios.length - passed,
  invalid,
  total: results.length,
  valid: validScenarios.length,
  scenarios: scenarios.length,
  runs,
  passRate: validScenarios.length > 0 ? passed / validScenarios.length : null,
  turns: results.reduce((total, result) => total + result.turns.length, 0),
  durationMs: results.reduce(
    (total, result) =>
      total + result.turns.reduce((subtotal, turn) => subtotal + turn.observation.durationMs, 0),
    0,
  ),
  promptTokens: results.reduce(
    (total, result) =>
      total + result.turns.reduce((subtotal, turn) => subtotal + turn.observation.promptTokens, 0),
    0,
  ),
  completionTokens: results.reduce(
    (total, result) =>
      total + result.turns.reduce(
        (subtotal, turn) => subtotal + turn.observation.completionTokens,
        0,
      ),
    0,
  ),
  results,
};
if (hasOption("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(
    `${passed}/${validScenarios.length} valid scenario runs passed across ` +
      `${scenarios.length} scenarios and ${report.turns} turns; ${invalid} invalid turns`,
  );
}
if (invalid > 0) process.exitCode = 2;
else if (passed !== validScenarios.length) process.exitCode = 1;
