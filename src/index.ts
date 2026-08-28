import { loadConfig } from "./config.js";
import { CelerisAdapter } from "./celeris.js";
import { DiscordVoiceBot } from "./discord.js";
import { Logger } from "./log.js";
import { OmnigentClient } from "./omnigent.js";
import { LocalSpeech } from "./speech.js";

const config = loadConfig(process.env);
const logger = new Logger(config.logLevel);

logger.info("startup", { celerisEnabled: Boolean(config.celerisApiKey) });

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
const celeris = new CelerisAdapter({
  apiKey: config.celerisApiKey,
  baseUrl: config.celerisBaseUrl,
  model: config.celerisModel,
  logger,
});
const bot = new DiscordVoiceBot({
  token: config.discordBotToken,
  guildId: config.discordGuildId,
  voiceChannelId: config.discordVoiceChannelId,
  allowedUserId: config.allowedDiscordUserId,
  silenceMs: config.discordSilenceMs,
  logger,
  speech,
  omnigent,
  celeris,
});

await omnigent.start();
await bot.start();

const shutdown = async (signal: string): Promise<void> => {
  logger.info("shutdown.started", { signal });
  await bot.stop();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
