import { loadConfig } from "./config.js";
import { CelerisConversation } from "./celeris.js";
import { OmnigentCoordinator } from "./coordinator.js";
import { DiscordVoiceBot } from "./discord.js";
import { SemanticEndpointRuntime } from "./endpoint.js";
import { Logger } from "./log.js";
import { CoordinatorMcpClient } from "./mcp.js";
import { OmnigentClient } from "./omnigent.js";
import { LocalSpeech } from "./speech.js";
import { KameS2SRuntime } from "./s2s.js";

const config = loadConfig(process.env);
const logger = new Logger(config.logLevel, config.logFile);

logger.info("startup", {
  celerisEnabled: Boolean(config.celerisApiKey),
  persistentLogEnabled: Boolean(config.logFile),
  voiceRuntime: config.voiceRuntime,
});

const speech = await LocalSpeech.create({
  asrModelDir: config.sherpaAsrModelDir,
  ttsModelDir: config.sherpaTtsModelDir,
  asrThreads: config.sherpaAsrThreads,
  ttsThreads: config.sherpaTtsThreads,
  ttsSpeakerId: config.sherpaTtsSpeakerId,
  ttsSpeed: config.sherpaTtsSpeed,
  logger,
});
const omnigent = new OmnigentClient({
  baseUrl: config.omnigentBaseUrl,
  refreshToken: config.omnigentRefreshToken,
  agentName: config.omnigentAgentName,
  hostId: config.omnigentHostId,
  workspace: config.omnigentWorkspace,
  logger,
});
const coordinator = new OmnigentCoordinator({ omnigent, logger });
await coordinator.start();
const tools = await CoordinatorMcpClient.create(coordinator);
const celeris = new CelerisConversation({
  apiKey: config.celerisApiKey,
  baseUrl: config.celerisBaseUrl,
  model: config.celerisModel,
  logger,
  tools,
  memoryPolicy: {
    compactAfterMessages: config.celerisHistoryCompactMessages,
    compactAfterCharacters: config.celerisHistoryCompactCharacters,
    keepRecentMessages: config.celerisHistoryKeepMessages,
    compactionIdleMs: config.celerisHistoryCompactionIdleMs,
  },
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
  endpoint,
  logger,
  speech,
  coordinator,
  celeris,
  s2s,
});

await bot.start();

const shutdown = async (signal: string): Promise<void> => {
  logger.info("shutdown.started", { signal });
  await bot.stop();
  await endpoint?.stop();
  await s2s?.stop();
  coordinator.stop();
  await tools.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
