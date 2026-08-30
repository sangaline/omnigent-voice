import { readFileSync } from "node:fs";
import {
  CelerisConversation,
  CelerisTraceEvent,
  currentTurnActionInvariant,
  systemPrompt,
} from "./celeris.js";
import {
  FrozenCoordinatorExecutor,
  observationFromTrace,
  scoreVoiceEval,
  VoiceEvalCase,
} from "./evaluation.js";
import { Logger } from "./log.js";
import { CoordinatorMcpClient } from "./mcp.js";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hasOption = (name: string): boolean => process.argv.includes(name);

const required = (value: string | undefined, description: string): string => {
  if (!value) throw new Error(`Missing ${description}`);
  return value;
};

const apiKeyFile = option("--api-key-file");
const apiKey = required(
  process.env.CELERIS_API_KEY?.trim() ??
    (apiKeyFile ? readFileSync(apiKeyFile, "utf8").trim() : undefined),
  "CELERIS_API_KEY or --api-key-file PATH",
);
const casesPath = option("--cases") ?? "evals/cases.json";
const allCases = JSON.parse(readFileSync(casesPath, "utf8")) as VoiceEvalCase[];
const selectedId = option("--case");
const cases = selectedId
  ? allCases.filter((testCase) => testCase.id === selectedId)
  : allCases;
if (cases.length === 0) throw new Error(`No evaluation case matched ${selectedId}`);
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
for (const testCase of cases) {
  for (let run = 1; run <= runs; run += 1) {
    const coordinator = new FrozenCoordinatorExecutor(
      testCase.coordinatorState,
      testCase.toolResults,
    );
    const tools = await CoordinatorMcpClient.create(coordinator);
    const trace: CelerisTraceEvent[] = [];
    const started = performance.now();
    try {
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
      conversation.restoreHistory(testCase.history);
      const streamedSpeech: string[] = [];
      const speech = await conversation.respond(testCase.input, (segment) => {
        streamedSpeech.push(segment);
      });
      if (streamedSpeech.length > 0 && streamedSpeech.join(" ") !== speech) {
        throw new Error("Production streaming speech diverged from remembered speech");
      }
      const observation = observationFromTrace(
        trace,
        speech,
        Math.round(performance.now() - started),
      );
      const invalid = Boolean(
        observation.modelError &&
          /(?:HTTP 429|HTTP 5\d\d|fetch failed|aborted|timeout)/i.test(
            observation.modelError,
          ),
      );
      const score = invalid
        ? {
            passed: false,
            checks: 0,
            failures: [`invalid model trial: ${observation.modelError}`],
          }
        : scoreVoiceEval(testCase, observation);
      if (observation.modelError && !invalid) {
        score.passed = false;
        score.failures.push(`model returned an unusable turn: ${observation.modelError}`);
      }
      results.push({
        id: testCase.id,
        description: testCase.description,
        run,
        invalid,
        ...score,
        observation,
      });
      if (!hasOption("--json")) {
        const marker = invalid ? "INVALID" : score.passed ? "PASS" : "FAIL";
        const runLabel = runs > 1 ? ` run ${run}/${runs}` : "";
        console.log(
          `${marker} ${testCase.id}${runLabel} (${observation.durationMs} ms, ${observation.rounds} rounds)`,
        );
        for (const failure of score.failures) console.log(`  ${failure}`);
      }
    } finally {
      await tools.close();
    }
  }
}

const validResults = results.filter((result) => !result.invalid);
const passed = validResults.filter((result) => result.passed).length;
const invalid = results.length - validResults.length;
const report = {
  passed,
  failed: validResults.length - passed,
  invalid,
  total: results.length,
  valid: validResults.length,
  cases: cases.length,
  runs,
  passRate: validResults.length > 0 ? passed / validResults.length : null,
  durationMs: results.reduce(
    (total, result) => total + result.observation.durationMs,
    0,
  ),
  promptTokens: results.reduce(
    (total, result) => total + result.observation.promptTokens,
    0,
  ),
  completionTokens: results.reduce(
    (total, result) => total + result.observation.completionTokens,
    0,
  ),
  results,
};
if (hasOption("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(
    `${passed}/${validResults.length} valid trials passed across ${cases.length} cases; ${invalid} invalid`,
  );
}
if (invalid > 0) process.exitCode = 2;
else if (passed !== validResults.length) process.exitCode = 1;
