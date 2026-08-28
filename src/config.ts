export interface Config {
  discordBotToken: string;
  discordGuildId?: string | undefined;
  discordVoiceChannelId?: string | undefined;
  allowedDiscordUserId?: string | undefined;
  discordSilenceMs: number;
  omnigentBaseUrl: string;
  omnigentRefreshToken: string;
  omnigentAgentName: string;
  omnigentHostId?: string | undefined;
  omnigentWorkspace: string;
  celerisApiKey?: string | undefined;
  celerisBaseUrl: string;
  celerisModel: string;
  sherpaAsrModelDir: string;
  sherpaTtsModelDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const optional = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value || undefined;
};

const positiveInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export const loadConfig = (env: NodeJS.ProcessEnv): Config => {
  const logLevel = optional(env, "LOG_LEVEL") ?? "info";
  if (!(["debug", "info", "warn", "error"] as const).includes(logLevel as never)) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  return {
    discordBotToken: required(env, "DISCORD_BOT_TOKEN"),
    discordGuildId: optional(env, "DISCORD_GUILD_ID"),
    discordVoiceChannelId: optional(env, "DISCORD_VOICE_CHANNEL_ID"),
    allowedDiscordUserId: optional(env, "ALLOWED_DISCORD_USER_ID"),
    discordSilenceMs: positiveInteger(env, "DISCORD_SILENCE_MS", 700),
    omnigentBaseUrl: required(env, "OMNIGENT_BASE_URL").replace(/\/$/, ""),
    omnigentRefreshToken: required(env, "OMNIGENT_REFRESH_TOKEN"),
    omnigentAgentName: optional(env, "OMNIGENT_AGENT_NAME") ?? "codex-native-ui",
    omnigentHostId: optional(env, "OMNIGENT_HOST_ID"),
    omnigentWorkspace: required(env, "OMNIGENT_WORKSPACE"),
    celerisApiKey: optional(env, "CELERIS_API_KEY"),
    celerisBaseUrl:
      optional(env, "CELERIS_BASE_URL") ??
      "https://inference.celeris.ai/celeris-1/v1",
    celerisModel: optional(env, "CELERIS_MODEL") ?? "celeris-1",
    sherpaAsrModelDir: required(env, "SHERPA_ASR_MODEL_DIR"),
    sherpaTtsModelDir: required(env, "SHERPA_TTS_MODEL_DIR"),
    logLevel: logLevel as Config["logLevel"],
  };
};
