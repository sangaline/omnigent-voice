import { readFileSync } from "node:fs";
import {
  CelerisConversation,
  CelerisHistoryMessage,
  CelerisTraceEvent,
  currentTurnActionInvariant,
  systemPrompt,
} from "./celeris.js";
import {
  FrozenCoordinatorExecutor,
  parseReplayCoordinatorUpdates,
} from "./evaluation.js";
import { Logger } from "./log.js";
import { CoordinatorMcpClient } from "./mcp.js";

interface AuditRecord {
  time?: string;
  event?: string;
  text?: string;
  source?: string;
  actionId?: number;
  type?: string;
  summary?: string;
  coordinatorUpdates?: string;
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

const logPath = required(option("--log"), "--log PATH");
const apiKeyFile = option("--api-key-file");
const apiKey = required(
  process.env.CELERIS_API_KEY?.trim() ??
    (apiKeyFile ? readFileSync(apiKeyFile, "utf8").trim() : undefined),
  "CELERIS_API_KEY or --api-key-file PATH",
);
const records = readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as AuditRecord);
const recognized = records
  .map((record, recordIndex) => ({ record, recordIndex }))
  .filter(({ record }) => record.event === "conversation.user.recognized");
const targetTime = option("--target-time");
const targetIndexOption = option("--target-index");
const selected = targetTime
  ? recognized.find(({ record }) => record.time === targetTime)
  : targetIndexOption
    ? recognized[Number(targetIndexOption) - 1]
    : recognized.at(-1);
if (!selected?.record.text || !selected.record.time) {
  throw new Error("Could not resolve a recognized target turn");
}
const targetText = selected.record.text;

let startupIndex = -1;
for (let index = 0; index < selected.recordIndex; index += 1) {
  if (records[index]?.event === "startup") startupIndex = index;
}
const preceding = records.slice(startupIndex + 1, selected.recordIndex);
const focusedName = option("--focused-name") ?? "focused session from runtime log";
const focusedSessionId = "replay-focused-session";
const restoredDialogue: CelerisHistoryMessage[] = [];
for (const [recordOffset, record] of preceding.entries()) {
  if (record.event === "conversation.user.recognized" && typeof record.text === "string") {
    restoredDialogue.push({ role: "user", content: record.text });
  }
  if (record.event === "conversation.assistant.generated" && typeof record.text === "string") {
    if (record.source === "background_update") {
      const name = /["“]([^"”]+)["”]/.exec(record.text)?.[1] ?? "background session";
      const replayUpdates = parseReplayCoordinatorUpdates(record.coordinatorUpdates, [
        {
          event_id: recordOffset + 1,
          type: "session_completed",
          session_id:
            name === focusedName
              ? focusedSessionId
              : `replay-background-session-${recordOffset + 1}`,
          name,
        },
      ]);
      restoredDialogue.push({
        role: "system",
        content: `Omnigent background update: ${JSON.stringify(replayUpdates)}`,
      });
    }
    restoredDialogue.push({ role: "assistant", content: record.text });
  }
}
const dialogue = restoredDialogue.slice(-80);
const actions = preceding
  .filter(
    (record) =>
      record.event === "coordinator.action.recorded" && typeof record.summary === "string",
  )
  .slice(-5)
  .map((record) => ({
    action_id: record.actionId ?? null,
    type: record.type ?? "unknown",
    summary: record.summary,
  }));

const toolResultsPath = option("--tool-results-file");
const toolResults = toolResultsPath
  ? (JSON.parse(readFileSync(toolResultsPath, "utf8")) as Record<string, unknown>)
  : {};
const promptPath = option("--system-prompt-file");
const promptSuffixPath = option("--system-prompt-suffix-file");
const invariantPath = option("--action-invariant-file");
const selectedSystemPrompt =
  (promptPath ? readFileSync(promptPath, "utf8").trim() : systemPrompt) +
  (promptSuffixPath ? `\n${readFileSync(promptSuffixPath, "utf8").trim()}` : "");
const selectedActionInvariant = invariantPath
  ? readFileSync(invariantPath, "utf8").trim()
  : currentTurnActionInvariant;

const coordinator = new FrozenCoordinatorExecutor(
  {
    focused_session: {
      id: focusedSessionId,
      name: focusedName,
      status: "idle",
    },
    recent_actions: actions,
    output_delta: { changed: false, output: "" },
    updates: [],
    update_cursor: 0,
    update_cursor_expired: false,
  },
  toolResults,
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
  conversation.restoreHistory(dialogue);
  const streamedSpeech: string[] = [];
  const speech = await conversation.respond(targetText, (segment) => {
    streamedSpeech.push(segment);
  });
  if (streamedSpeech.length > 0 && streamedSpeech.join(" ") !== speech) {
    throw new Error("Production streaming speech diverged from remembered speech");
  }
  const rounds = trace
    .filter(
      (event): event is Extract<CelerisTraceEvent, { type: "completion" }> =>
        event.type === "completion" && event.phase.startsWith("round_"),
    )
    .map((event) => ({
      finishReason: event.finishReason,
      message: event.message,
      usage: {
        prompt_tokens: event.promptTokens ?? null,
        completion_tokens: event.completionTokens ?? null,
      },
      durationMs: event.durationMs,
    }));
  console.log(
    JSON.stringify(
      {
        targetTime: selected.record.time,
        targetText,
        restoredDialogueMessages: dialogue.length,
        actionInvariant: !hasOption("--omit-action-invariant"),
        durationMs: Math.round(performance.now() - started),
        suppliedToolResults: Boolean(toolResultsPath),
        initialResponse: rounds[0]?.message ?? null,
        response: rounds.at(-1)?.message ?? null,
        speech,
        streamedSpeech,
        rounds,
        coordinatorCalls: coordinator.calls,
        toolCalls: trace.filter((event) => event.type === "tool"),
      },
      null,
      2,
    ),
  );
} finally {
  await tools.close();
}
