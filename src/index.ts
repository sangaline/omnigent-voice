import { loadConfig } from "./config.js";
import { CelerisConversation } from "./celeris.js";
import { OmnigentCoordinator } from "./coordinator.js";
import { DiscordVoiceBot } from "./discord.js";
import { SemanticEndpointRuntime } from "./endpoint.js";
import { Logger } from "./log.js";
import { CoordinatorMcpClient } from "./mcp.js";
import { OmnigentClient } from "./omnigent.js";
import { PersonaConversation } from "./persona.js";
import {
  OllamaPersonaEmbedder,
  OpenAiPersonaAdviser,
  PersonaMemoryRuntime,
  PostgresPersonaMemoryStore,
} from "./persona-memory.js";
import { LocalSpeech } from "./speech.js";
import { KameS2SRuntime } from "./s2s.js";

const config = loadConfig(process.env);
const logger = new Logger(config.logLevel, config.logFile);

logger.info("startup", {
  celerisEnabled: Boolean(config.celerisApiKey),
  conversationMode: config.conversationMode,
  persistentLogEnabled: Boolean(config.logFile),
  voiceRuntime: config.voiceRuntime,
});

const speech = await LocalSpeech.create({
  asrModelDir: config.sherpaAsrModelDir,
  ttsModelDir: config.sherpaTtsModelDir,
  ttsRuntime: config.ttsRuntime,
  asrThreads: config.sherpaAsrThreads,
  ttsThreads: config.sherpaTtsThreads,
  ttsSpeakerId: config.sherpaTtsSpeakerId,
  ttsSpeed: config.sherpaTtsSpeed,
  pocketTtsPythonExecutable: config.pocketTtsPythonExecutable,
  pocketTtsBridgePath: config.pocketTtsBridgePath,
  pocketTtsVoice: config.pocketTtsVoice,
  pocketTtsQuantize: config.pocketTtsQuantize,
  logger,
});
let coordinator: OmnigentCoordinator | undefined;
let tools: CoordinatorMcpClient | undefined;
let coordinatorConversation: CelerisConversation | undefined;
let conversation: CelerisConversation | PersonaConversation;
let personaMemory: PersonaMemoryRuntime | undefined;
const memoryPolicy = {
  compactAfterMessages: config.celerisHistoryCompactMessages,
  compactAfterCharacters: config.celerisHistoryCompactCharacters,
  keepRecentMessages: config.celerisHistoryKeepMessages,
  compactionIdleMs: config.celerisHistoryCompactionIdleMs,
};
if (config.conversationMode === "persona") {
  if (config.personaMemoryEnabled) {
    if (
      !config.personaMemoryDatabaseHost ||
      !config.personaMemoryDatabaseName ||
      !config.personaMemoryDatabaseUser ||
      !config.personaMemoryDatabasePassword ||
      !config.personaEmbeddingBaseUrl ||
      !config.personaEmbeddingModel ||
      !config.personaAdviserBaseUrl ||
      !config.personaAdviserModel
    ) {
      throw new Error("Persona memory requires database, embedding, and adviser configuration");
    }
    const store = new PostgresPersonaMemoryStore({
      host: config.personaMemoryDatabaseHost,
      port: config.personaMemoryDatabasePort,
      database: config.personaMemoryDatabaseName,
      user: config.personaMemoryDatabaseUser,
      password: config.personaMemoryDatabasePassword,
      ssl: config.personaMemoryDatabaseSsl,
      embeddingDimensions: config.personaEmbeddingDimensions,
      logger,
    });
    const embedder = new OllamaPersonaEmbedder({
      baseUrl: config.personaEmbeddingBaseUrl,
      model: config.personaEmbeddingModel,
      dimensions: config.personaEmbeddingDimensions,
      timeoutMs: config.personaEmbeddingTimeoutMs,
    });
    const adviser = new OpenAiPersonaAdviser({
      baseUrl: config.personaAdviserBaseUrl,
      ...(config.personaAdviserApiKey
        ? { apiKey: config.personaAdviserApiKey }
        : {}),
      model: config.personaAdviserModel,
      ...(config.personaMemoryAnalysisModel
        ? { analysisModel: config.personaMemoryAnalysisModel }
        : {}),
      timeoutMs: config.personaAdviserTimeoutMs,
      logger,
    });
    personaMemory = new PersonaMemoryRuntime({
      ownerKey: config.personaMemoryOwnerKey,
      store,
      embedder,
      adviser,
      logger,
      backgroundModel: config.personaAdviserModel,
      retrievalLimit: config.personaMemoryRetrievalLimit,
      restoreTurns: config.personaMemoryRestoreTurns,
    });
  }
  conversation = new PersonaConversation({
    apiKey: config.celerisApiKey,
    baseUrl: config.celerisBaseUrl,
    model: config.celerisModel,
    logger,
    systemPrompt: config.personaSystemPrompt,
    maxResponseCharacters: config.personaMaxResponseCharacters,
    temperature: config.personaTemperature,
    memoryPolicy,
    ...(personaMemory ? { persistentMemory: personaMemory } : {}),
  });
  if (personaMemory) {
    const restored = await personaMemory.initialize();
    if (restored.length > 0) conversation.restoreHistory(restored);
  }
} else {
  if (
    !config.omnigentBaseUrl ||
    !config.omnigentRefreshToken ||
    !config.omnigentWorkspace
  ) {
    throw new Error("Coordinator mode requires Omnigent runtime configuration");
  }
  const omnigent = new OmnigentClient({
    baseUrl: config.omnigentBaseUrl,
    refreshToken: config.omnigentRefreshToken,
    agentName: config.omnigentAgentName,
    hostId: config.omnigentHostId,
    workspace: config.omnigentWorkspace,
    logger,
  });
  coordinator = new OmnigentCoordinator({ omnigent, logger });
  await coordinator.start();
  tools = await CoordinatorMcpClient.create(coordinator);
  coordinatorConversation = new CelerisConversation({
    apiKey: config.celerisApiKey,
    baseUrl: config.celerisBaseUrl,
    model: config.celerisModel,
    logger,
    tools,
    memoryPolicy,
  });
  conversation = coordinatorConversation;
}
await conversation.warmup();
logger.info("conversation.ready", {
  mode: config.conversationMode,
  coordinatorEnabled: Boolean(coordinator),
});
const s2s =
  config.voiceRuntime === "kame"
    ? new KameS2SRuntime({
        executable: config.kameBridgePath!,
        configPath: config.kameConfigPath!,
        modelPath: config.kameModelPath!,
        mimiPath: config.kameMimiPath!,
        tokenizerPath: config.kameTokenizerPath!,
        device: config.kameDevice,
        contextFrames: config.kameContextFrames,
        logger,
      })
    : undefined;
if (s2s) await s2s.start();
const endpoint = config.semanticEndpointing
  ? new SemanticEndpointRuntime({
      pythonExecutable: config.smartTurnPythonExecutable,
      bridgePath: config.smartTurnBridgePath,
      modelPath: config.smartTurnModelPath,
      threads: config.smartTurnThreads,
      completeThreshold: config.smartTurnCompleteThreshold,
      vadModelPath: config.sileroVadModelPath,
      vadThreshold: config.sileroVadThreshold,
      vadSilenceMs: config.sileroVadSilenceMs,
      vadMinSpeechMs: config.sileroVadMinSpeechMs,
      logger,
    })
  : undefined;
if (endpoint) await endpoint.start();
const bot = new DiscordVoiceBot({
  token: config.discordBotToken,
  guildId: config.discordGuildId,
  voiceChannelId: config.discordVoiceChannelId,
  allowedUserId: config.allowedDiscordUserId,
  silenceMs: config.discordSilenceMs,
  utteranceMergeMs: config.discordUtteranceMergeMs,
  bargeInPeak: config.discordBargeInPeak,
  endpointFallbackMs: config.endpointFallbackMs,
  s2sInputDelayMs: config.kameInputDelayMs,
  endpoint,
  logger,
  speech,
  conversation,
  coordinator,
  coordinatorConversation,
  turnErrorSpeech: config.conversationMode === "persona"
    ? "Sorry, I lost my train of thought for a moment."
    : undefined,
  s2s,
});

await bot.start();

const shutdown = async (signal: string): Promise<void> => {
  logger.info("shutdown.started", { signal });
  await bot.stop();
  await speech.stop();
  await endpoint?.stop();
  await s2s?.stop();
  await personaMemory?.close();
  coordinator?.stop();
  await tools?.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
