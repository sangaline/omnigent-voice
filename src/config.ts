export interface Config {
  voiceRuntime: "staged" | "kame";
  discordBotToken: string;
  discordGuildId?: string | undefined;
  discordVoiceChannelId?: string | undefined;
  allowedDiscordUserId?: string | undefined;
  discordSilenceMs: number;
  discordUtteranceMergeMs: number;
  discordBargeInPeak: number;
  semanticEndpointing: boolean;
  endpointFallbackMs: number;
  sileroVadModelPath: string;
  sileroVadThreshold: number;
  sileroVadSilenceMs: number;
  sileroVadMinSpeechMs: number;
  smartTurnPythonExecutable: string;
  smartTurnBridgePath: string;
  smartTurnModelPath: string;
  smartTurnThreads: number;
  omnigentBaseUrl: string;
  omnigentRefreshToken: string;
  omnigentAgentName: string;
  omnigentHostId?: string | undefined;
  omnigentWorkspace: string;
  celerisApiKey?: string | undefined;
  celerisBaseUrl: string;
  celerisModel: string;
  celerisHistoryCompactMessages: number;
  celerisHistoryCompactCharacters: number;
  celerisHistoryKeepMessages: number;
  celerisHistoryCompactionIdleMs: number;
  sherpaAsrModelDir: string;
  sherpaTtsModelDir: string;
  sherpaAsrThreads: number;
  sherpaTtsThreads: number;
  sherpaTtsSpeakerId: number;
  sherpaTtsSpeed: number;
  kameBridgePath?: string | undefined;
  kameConfigPath?: string | undefined;
  kameModelPath?: string | undefined;
  kameMimiPath?: string | undefined;
  kameTokenizerPath?: string | undefined;
  kameDevice: string;
  kameContextFrames: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logFile?: string | undefined;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const nonnegativeInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return value;
};

const positiveNumber = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
};

const optional = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value || undefined;
};

const boolean = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const raw = optional(env, name)?.toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean`);
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

  const voiceRuntime = optional(env, "VOICE_RUNTIME") ?? "staged";
  if (voiceRuntime !== "staged" && voiceRuntime !== "kame") {
    throw new Error("VOICE_RUNTIME must be staged or kame");
  }
  const kameBridgePath = optional(env, "KAME_BRIDGE_PATH");
  const kameConfigPath = optional(env, "KAME_CONFIG_PATH");
  const kameModelPath = optional(env, "KAME_MODEL_PATH");
  const kameMimiPath = optional(env, "KAME_MIMI_PATH");
  const kameTokenizerPath = optional(env, "KAME_TOKENIZER_PATH");
  if (
    voiceRuntime === "kame" &&
    (!kameBridgePath ||
      !kameConfigPath ||
      !kameModelPath ||
      !kameMimiPath ||
      !kameTokenizerPath)
  ) {
    throw new Error(
      "KAME bridge, config, model, Mimi, and tokenizer paths are required in kame mode",
    );
  }

  const celerisHistoryCompactMessages = positiveInteger(
    env,
    "CELERIS_HISTORY_COMPACT_MESSAGES",
    80,
  );
  const celerisHistoryKeepMessages = positiveInteger(
    env,
    "CELERIS_HISTORY_KEEP_MESSAGES",
    24,
  );
  if (celerisHistoryKeepMessages >= celerisHistoryCompactMessages) {
    throw new Error(
      "CELERIS_HISTORY_KEEP_MESSAGES must be less than CELERIS_HISTORY_COMPACT_MESSAGES",
    );
  }

  return {
    voiceRuntime,
    discordBotToken: required(env, "DISCORD_BOT_TOKEN"),
    discordGuildId: optional(env, "DISCORD_GUILD_ID"),
    discordVoiceChannelId: optional(env, "DISCORD_VOICE_CHANNEL_ID"),
    allowedDiscordUserId: optional(env, "ALLOWED_DISCORD_USER_ID"),
    discordSilenceMs: positiveInteger(env, "DISCORD_SILENCE_MS", 450),
    discordUtteranceMergeMs: nonnegativeInteger(
      env,
      "DISCORD_UTTERANCE_MERGE_MS",
      350,
    ),
    discordBargeInPeak: positiveNumber(env, "DISCORD_BARGE_IN_PEAK", 0.08),
    semanticEndpointing: boolean(env, "SEMANTIC_ENDPOINTING", true),
    endpointFallbackMs: positiveInteger(env, "ENDPOINT_FALLBACK_MS", 700),
    sileroVadModelPath:
      optional(env, "SILERO_VAD_MODEL_PATH") ?? "/opt/models/endpoint/silero_vad.onnx",
    sileroVadThreshold: positiveNumber(env, "SILERO_VAD_THRESHOLD", 0.5),
    sileroVadSilenceMs: positiveInteger(env, "SILERO_VAD_SILENCE_MS", 180),
    sileroVadMinSpeechMs: positiveInteger(env, "SILERO_VAD_MIN_SPEECH_MS", 100),
    smartTurnPythonExecutable:
      optional(env, "SMART_TURN_PYTHON") ?? "/usr/bin/python3",
    smartTurnBridgePath:
      optional(env, "SMART_TURN_BRIDGE_PATH") ??
      "/opt/omnigent-voice/smart-turn/bridge.py",
    smartTurnModelPath:
      optional(env, "SMART_TURN_MODEL_PATH") ??
      "/opt/models/endpoint/smart-turn-v3.2-cpu.onnx",
    smartTurnThreads: positiveInteger(env, "SMART_TURN_THREADS", 1),
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
    celerisHistoryCompactMessages,
    celerisHistoryCompactCharacters: positiveInteger(
      env,
      "CELERIS_HISTORY_COMPACT_CHARACTERS",
      48_000,
    ),
    celerisHistoryKeepMessages,
    celerisHistoryCompactionIdleMs: nonnegativeInteger(
      env,
      "CELERIS_HISTORY_COMPACTION_IDLE_MS",
      5_000,
    ),
    sherpaAsrModelDir: required(env, "SHERPA_ASR_MODEL_DIR"),
    sherpaTtsModelDir: required(env, "SHERPA_TTS_MODEL_DIR"),
    sherpaAsrThreads: positiveInteger(env, "SHERPA_ASR_THREADS", 4),
    sherpaTtsThreads: positiveInteger(env, "SHERPA_TTS_THREADS", 4),
    sherpaTtsSpeakerId: nonnegativeInteger(env, "SHERPA_TTS_SPEAKER_ID", 0),
    sherpaTtsSpeed: positiveNumber(env, "SHERPA_TTS_SPEED", 1),
    kameBridgePath,
    kameConfigPath,
    kameModelPath,
    kameMimiPath,
    kameTokenizerPath,
    kameDevice: optional(env, "KAME_DEVICE") ?? "Vulkan0",
    kameContextFrames: positiveInteger(env, "KAME_CONTEXT_FRAMES", 3_000),
    logLevel: logLevel as Config["logLevel"],
    logFile: optional(env, "LOG_FILE"),
  };
};
