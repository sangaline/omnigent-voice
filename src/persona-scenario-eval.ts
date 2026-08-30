import { readFileSync } from "node:fs";
import type { CelerisHistoryMessage } from "./celeris.js";
import { Logger } from "./log.js";
import {
  OpenAiPersonaAdviser,
  PersonaEmbedder,
  PersonaMemoryRuntime,
  PersonaMemorySelection,
  PersonaMemoryStore,
  PersonaTurnAnalysis,
} from "./persona-memory.js";
import { PersonaConversation, defaultPersonaSystemPrompt } from "./persona.js";

interface PersonaExpected {
  speechTerms?: string[] | undefined;
  speechAnyTerms?: string[][] | undefined;
  speechForbiddenTerms?: string[] | undefined;
  maxSpeechWords?: number | undefined;
}

interface PersonaScenarioTurn {
  input: string;
  partials?: string[] | undefined;
  partialDelayMs?: number | undefined;
  prethinkMs?: number | undefined;
  memorySelection?: PersonaMemorySelection | undefined;
  expected: PersonaExpected;
}

interface PersonaScenario {
  id: string;
  description: string;
  initialHistory: CelerisHistoryMessage[];
  turns: PersonaScenarioTurn[];
  sequenceExpected?: PersonaSequenceExpected | undefined;
  analysisTerms?: string[] | undefined;
  analysisForbiddenTerms?: string[] | undefined;
}

interface PersonaSequenceExpected {
  maxQuestionReplies?: number | undefined;
  maxConsecutiveQuestionReplies?: number | undefined;
  maxRepeatedOpeningCount?: number | undefined;
}

class ScenarioMemoryStore implements PersonaMemoryStore {
  public selection: PersonaMemorySelection = { memories: [] };
  public readonly analyses: PersonaTurnAnalysis[] = [];

  public async initialize(): Promise<void> {}
  public async recentDialogue(): Promise<CelerisHistoryMessage[]> {
    return [];
  }
  public async recordTurn(): Promise<string> {
    return String(this.analyses.length + 1);
  }
  public async retrieve(): Promise<PersonaMemorySelection> {
    return this.selection;
  }
  public async saveAnalysis(
    _ownerKey: string,
    _turnId: string,
    analysis: PersonaTurnAnalysis,
  ): Promise<void> {
    this.analyses.push(analysis);
  }
  public async consumeThought(): Promise<void> {}
  public async close(): Promise<void> {}
}

class ScenarioLogger extends Logger {
  public readonly failures: Array<{ event: string; message: string }> = [];

  public override error(
    event: string,
    error: unknown,
    fields?: Record<string, boolean | number | string | null | undefined>,
  ): void {
    this.failures.push({
      event,
      message: error instanceof Error ? error.message : String(error),
    });
    super.error(event, error, fields);
  }
}

const embedder: PersonaEmbedder = {
  embed: async (texts) => texts.map(() => [1]),
};

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasOption = (name: string): boolean => process.argv.includes(name);
const required = (value: string | undefined, description: string): string => {
  if (!value) throw new Error(`Missing ${description}`);
  return value;
};
const pause = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));
const includes = (value: string, term: string): boolean => {
  const escaped = term
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const left = /^[\p{L}\p{N}]/u.test(term) ? "(?<![\\p{L}\\p{N}])" : "";
  const right = /[\p{L}\p{N}]$/u.test(term) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${left}${escaped}${right}`, "iu").test(value);
};
const transientFailure = (message: string): boolean =>
  /(?:HTTP 429|HTTP 5\d\d|fetch failed|aborted|timeout)/i.test(message);

const scoreSpeech = (speech: string, expected: PersonaExpected): string[] => {
  const failures: string[] = [];
  for (const term of expected.speechTerms ?? []) {
    if (!includes(speech, term)) failures.push(`speech omitted ${JSON.stringify(term)}`);
  }
  for (const alternatives of expected.speechAnyTerms ?? []) {
    if (!alternatives.some((term) => includes(speech, term))) {
      failures.push(`speech omitted every alternative ${JSON.stringify(alternatives)}`);
    }
  }
  for (const term of expected.speechForbiddenTerms ?? []) {
    if (includes(speech, term)) failures.push(`speech contained forbidden ${JSON.stringify(term)}`);
  }
  const words = speech.trim().split(/\s+/).filter(Boolean).length;
  if (expected.maxSpeechWords !== undefined && words > expected.maxSpeechWords) {
    failures.push(`speech had ${words} words, limit ${expected.maxSpeechWords}`);
  }
  return failures;
};

const scoreSequence = (
  speeches: readonly string[],
  expected: PersonaSequenceExpected | undefined,
): string[] => {
  if (!expected) return [];
  const failures: string[] = [];
  const questionReplies = speeches.map((speech) => speech.includes("?"));
  const questionCount = questionReplies.filter(Boolean).length;
  if (
    expected.maxQuestionReplies !== undefined &&
    questionCount > expected.maxQuestionReplies
  ) {
    failures.push(
      `sequence had ${questionCount} question-bearing replies, limit ${expected.maxQuestionReplies}`,
    );
  }
  let currentQuestionRun = 0;
  let longestQuestionRun = 0;
  for (const containsQuestion of questionReplies) {
    currentQuestionRun = containsQuestion ? currentQuestionRun + 1 : 0;
    longestQuestionRun = Math.max(longestQuestionRun, currentQuestionRun);
  }
  if (
    expected.maxConsecutiveQuestionReplies !== undefined &&
    longestQuestionRun > expected.maxConsecutiveQuestionReplies
  ) {
    failures.push(
      `sequence had ${longestQuestionRun} consecutive question-bearing replies, limit ` +
        expected.maxConsecutiveQuestionReplies,
    );
  }
  if (expected.maxRepeatedOpeningCount !== undefined) {
    const openingCounts = new Map<string, number>();
    for (const speech of speeches) {
      const opening = speech
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}'\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");
      if (opening) openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + 1);
    }
    const repeated = Math.max(0, ...openingCounts.values());
    if (repeated > expected.maxRepeatedOpeningCount) {
      failures.push(
        `sequence repeated one three-word opening ${repeated} times, limit ` +
          expected.maxRepeatedOpeningCount,
      );
    }
  }
  return failures;
};

const celerisKeyFile = option("--celeris-api-key-file") ?? option("--api-key-file");
const adviserKeyFile = option("--adviser-api-key-file");
const celerisApiKey = required(
  process.env.CELERIS_API_KEY?.trim() ??
    (celerisKeyFile ? readFileSync(celerisKeyFile, "utf8").trim() : undefined),
  "CELERIS_API_KEY or --celeris-api-key-file PATH",
);
const adviserApiKey = required(
  process.env.PERSONA_ADVISER_API_KEY?.trim() ??
    (adviserKeyFile ? readFileSync(adviserKeyFile, "utf8").trim() : undefined),
  "PERSONA_ADVISER_API_KEY or --adviser-api-key-file PATH",
);
const scenariosPath = option("--scenarios") ?? "evals/persona-scenarios.json";
const allScenarios = JSON.parse(readFileSync(scenariosPath, "utf8")) as PersonaScenario[];
const selectedId = option("--case");
const scenarios = selectedId
  ? allScenarios.filter((scenario) => scenario.id === selectedId)
  : allScenarios;
if (scenarios.length === 0) throw new Error(`No persona scenario matched ${selectedId}`);
const runs = Math.max(1, Number(option("--runs") ?? "1"));
if (!Number.isInteger(runs)) throw new Error("--runs must be a positive integer");

const results: Array<Record<string, unknown>> = [];
for (const scenario of scenarios) {
  for (let run = 1; run <= runs; run += 1) {
    const store = new ScenarioMemoryStore();
    const evalLogger = new ScenarioLogger(hasOption("--verbose") ? "info" : "error");
    const adviser = new OpenAiPersonaAdviser({
      baseUrl: process.env.PERSONA_ADVISER_BASE_URL ?? "https://api.paretoinference.com/v1",
      apiKey: adviserApiKey,
      model: process.env.PERSONA_ADVISER_MODEL ?? "deepseek/deepseek-v4-flash",
      analysisModel:
        process.env.PERSONA_MEMORY_ANALYSIS_MODEL ?? "deepseek/deepseek-v4-flash",
      timeoutMs: Number(process.env.PERSONA_ADVISER_TIMEOUT_MS ?? "30000"),
      logger: evalLogger,
    });
    const memory = new PersonaMemoryRuntime({
      ownerKey: "synthetic-eval",
      store,
      embedder,
      adviser,
      logger: evalLogger,
      backgroundModel:
        process.env.PERSONA_ADVISER_MODEL ?? "deepseek/deepseek-v4-flash",
      retrievalLimit: 4,
      restoreTurns: 12,
      analyzeCompletedTurns: Boolean(
        scenario.analysisTerms?.length || scenario.analysisForbiddenTerms?.length,
      ),
      usePreparedDrafts: true,
    });
    await memory.initialize();
    const conversation = new PersonaConversation({
      apiKey: celerisApiKey,
      baseUrl:
        process.env.CELERIS_BASE_URL?.replace(/\/$/, "") ??
        "https://inference.celeris.ai/celeris-1/v1",
      model: process.env.CELERIS_MODEL ?? "celeris-1",
      logger: evalLogger,
      systemPrompt: defaultPersonaSystemPrompt,
      temperature: Number(option("--temperature") ?? "0"),
      seed: Number(option("--seed") ?? "7"),
      persistentMemory: memory,
    });
    conversation.restoreHistory(scenario.initialHistory);
    const turnResults: Array<Record<string, unknown>> = [];
    const speeches: string[] = [];
    let invalid = false;
    try {
      for (const [turnIndex, turn] of scenario.turns.entries()) {
        store.selection = turn.memorySelection ?? { memories: [] };
        for (const partial of turn.partials ?? []) {
          conversation.prepare(partial);
          if ((turn.partialDelayMs ?? 0) > 0) await pause(turn.partialDelayMs ?? 0);
        }
        if ((turn.prethinkMs ?? 0) > 0) await pause(turn.prethinkMs ?? 0);
        const started = performance.now();
        try {
          const segments: string[] = [];
          const speech = await conversation.respond(
            turn.input,
            (segment) => segments.push(segment),
          );
          if (segments.length > 0 && segments.join(" ") !== speech) {
            throw new Error("Production streaming speech diverged from remembered speech");
          }
          const failures = scoreSpeech(speech, turn.expected);
          speeches.push(speech);
          const result = {
            turn: turnIndex + 1,
            input: turn.input,
            speech,
            durationMs: Math.round(performance.now() - started),
            passed: failures.length === 0,
            failures,
          };
          turnResults.push(result);
          if (!hasOption("--json")) {
            console.log(
              `${failures.length === 0 ? "PASS" : "FAIL"} ${scenario.id} turn ${turnIndex + 1}` +
                ` (${result.durationMs} ms): ${speech}`,
            );
            for (const failure of failures) console.log(`  ${failure}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          invalid = transientFailure(message);
          turnResults.push({
            turn: turnIndex + 1,
            input: turn.input,
            passed: false,
            invalid,
            failures: [message],
          });
          break;
        }
      }
    } finally {
      await memory.close();
    }

    const backgroundTransportFailure = evalLogger.failures.find(
      ({ event, message }) =>
        event === "persona.memory.turn.failed" && transientFailure(message),
    );
    if (backgroundTransportFailure) invalid = true;

    const analysisText = JSON.stringify(store.analyses);
    const analysisFailures: string[] = [];
    const sequenceFailures = invalid
      ? []
      : scoreSequence(speeches, scenario.sequenceExpected);
    if (!invalid) {
      for (const term of scenario.analysisTerms ?? []) {
        if (!includes(analysisText, term)) {
          analysisFailures.push(`analysis omitted ${JSON.stringify(term)}`);
        }
      }
      for (const term of scenario.analysisForbiddenTerms ?? []) {
        if (includes(analysisText, term)) {
          analysisFailures.push(`analysis contained forbidden ${JSON.stringify(term)}`);
        }
      }
    }
    const passed =
      !invalid &&
      turnResults.length === scenario.turns.length &&
      turnResults.every((result) => result.passed === true) &&
      sequenceFailures.length === 0 &&
      analysisFailures.length === 0;
    results.push({
      id: scenario.id,
      description: scenario.description,
      run,
      passed,
      invalid,
      turns: turnResults,
      sequenceFailures,
      analysisCount: store.analyses.length,
      analysisFailures,
    });
    if (!hasOption("--json") && analysisFailures.length > 0) {
      for (const failure of analysisFailures) console.log(`  ${failure}`);
    }
    if (!hasOption("--json") && sequenceFailures.length > 0) {
      for (const failure of sequenceFailures) console.log(`  ${failure}`);
    }
  }
}

const valid = results.filter((result) => result.invalid !== true);
const passed = valid.filter((result) => result.passed === true).length;
const report = {
  passed,
  failed: valid.length - passed,
  invalid: results.length - valid.length,
  total: results.length,
  passRate: valid.length > 0 ? passed / valid.length : null,
  results,
};
if (hasOption("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${passed}/${valid.length} valid persona scenarios passed; ${report.invalid} invalid`);
}
if (report.invalid > 0) process.exitCode = 2;
else if (passed !== valid.length) process.exitCode = 1;
