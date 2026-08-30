export interface Config {
  conversationMode: "coordinator" | "persona";
  voiceRuntime: "staged" | "kame";
  ttsRuntime: "piper" | "pocket";
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
  smartTurnCompleteThreshold: number;
  omnigentBaseUrl?: string | undefined;
  omnigentRefreshToken?: string | undefined;
  omnigentAgentName: string;
  omnigentHostId?: string | undefined;
  omnigentWorkspace?: string | undefined;
  celerisApiKey?: string | undefined;
  celerisBaseUrl: string;
  celerisModel: string;
  celerisHistoryCompactMessages: number;
  celerisHistoryCompactCharacters: number;
  celerisHistoryKeepMessages: number;
  celerisHistoryCompactionIdleMs: number;
  personaChatApiKey?: string | undefined;
  personaChatBaseUrl: string;
  personaChatModel: string;
  personaChatOpenRouterProvider?: string | undefined;
  personaSystemPrompt: string;
  personaMaxResponseCharacters: number;
  personaTemperature: number;
  personaMemoryEnabled: boolean;
  personaMemoryOwnerKey: string;
  personaMemoryDatabaseHost?: string | undefined;
  personaMemoryDatabasePort: number;
  personaMemoryDatabaseName?: string | undefined;
  personaMemoryDatabaseUser?: string | undefined;
  personaMemoryDatabasePassword?: string | undefined;
  personaMemoryDatabaseSsl: boolean;
  personaMemoryRetrievalLimit: number;
  personaMemoryRestoreTurns: number;
  personaPreparedDraftsEnabled: boolean;
  personaEmbeddingBaseUrl?: string | undefined;
  personaEmbeddingModel?: string | undefined;
  personaEmbeddingDimensions: number;
  personaEmbeddingTimeoutMs: number;
  personaAdviserBaseUrl?: string | undefined;
  personaAdviserApiKey?: string | undefined;
  personaAdviserModel?: string | undefined;
  personaMemoryAnalysisModel?: string | undefined;
  personaAdviserTimeoutMs: number;
  personaAdviserHotTimeoutMs: number;
  sherpaAsrModelDir: string;
  sherpaTtsModelDir: string;
  sherpaAsrThreads: number;
  sherpaTtsThreads: number;
  sherpaTtsSpeakerId: number;
  sherpaTtsSpeed: number;
  pocketTtsPythonExecutable: string;
  pocketTtsBridgePath: string;
  pocketTtsVoice: string;
  pocketTtsQuantize: boolean;
  kameBridgePath?: string | undefined;
  kameConfigPath?: string | undefined;
  kameModelPath?: string | undefined;
  kameMimiPath?: string | undefined;
  kameTokenizerPath?: string | undefined;
  kameDevice: string;
  kameContextFrames: number;
  kameInputDelayMs: number;
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

const boundedNumber = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
};

const probability = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
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

  const conversationMode = optional(env, "CONVERSATION_MODE") ?? "coordinator";
  if (conversationMode !== "coordinator" && conversationMode !== "persona") {
    throw new Error("CONVERSATION_MODE must be coordinator or persona");
  }
  const personaMemoryEnabled = boolean(env, "PERSONA_MEMORY_ENABLED", false);
  if (personaMemoryEnabled && conversationMode !== "persona") {
    throw new Error("PERSONA_MEMORY_ENABLED requires CONVERSATION_MODE=persona");
  }

  const voiceRuntime = optional(env, "VOICE_RUNTIME") ?? "staged";
  if (voiceRuntime !== "staged" && voiceRuntime !== "kame") {
    throw new Error("VOICE_RUNTIME must be staged or kame");
  }
  const ttsRuntime = optional(env, "TTS_RUNTIME") ?? "piper";
  if (ttsRuntime !== "piper" && ttsRuntime !== "pocket") {
    throw new Error("TTS_RUNTIME must be piper or pocket");
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
    conversationMode,
    voiceRuntime,
    ttsRuntime,
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
    smartTurnCompleteThreshold: probability(
      env,
      "SMART_TURN_COMPLETE_THRESHOLD",
      0.65,
    ),
    omnigentBaseUrl: conversationMode === "coordinator"
      ? required(env, "OMNIGENT_BASE_URL").replace(/\/$/, "")
      : optional(env, "OMNIGENT_BASE_URL")?.replace(/\/$/, ""),
    omnigentRefreshToken: conversationMode === "coordinator"
      ? required(env, "OMNIGENT_REFRESH_TOKEN")
      : optional(env, "OMNIGENT_REFRESH_TOKEN"),
    omnigentAgentName: optional(env, "OMNIGENT_AGENT_NAME") ?? "codex-native-ui",
    omnigentHostId: optional(env, "OMNIGENT_HOST_ID"),
    omnigentWorkspace: conversationMode === "coordinator"
      ? required(env, "OMNIGENT_WORKSPACE")
      : optional(env, "OMNIGENT_WORKSPACE"),
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
    personaChatApiKey:
      optional(env, "PERSONA_CHAT_API_KEY") ?? optional(env, "CELERIS_API_KEY"),
    personaChatBaseUrl:
      optional(env, "PERSONA_CHAT_BASE_URL") ??
      optional(env, "CELERIS_BASE_URL") ??
      "https://inference.celeris.ai/celeris-1/v1",
    personaChatModel:
      optional(env, "PERSONA_CHAT_MODEL") ??
      optional(env, "CELERIS_MODEL") ??
      "celeris-1",
    personaChatOpenRouterProvider: optional(
      env,
      "PERSONA_CHAT_OPENROUTER_PROVIDER",
    ),
    personaSystemPrompt: optional(env, "PERSONA_SYSTEM_PROMPT") ?? "",
    personaMaxResponseCharacters: positiveInteger(
      env,
      "PERSONA_MAX_RESPONSE_CHARACTERS",
      420,
    ),
    personaTemperature: boundedNumber(env, "PERSONA_TEMPERATURE", 0.4, 0, 2),
    personaMemoryEnabled,
    personaMemoryOwnerKey: optional(env, "PERSONA_MEMORY_OWNER_KEY") ?? "primary",
    personaMemoryDatabaseHost: personaMemoryEnabled
      ? required(env, "PERSONA_MEMORY_DATABASE_HOST")
      : optional(env, "PERSONA_MEMORY_DATABASE_HOST"),
    personaMemoryDatabasePort: positiveInteger(
      env,
      "PERSONA_MEMORY_DATABASE_PORT",
      5432,
    ),
    personaMemoryDatabaseName: personaMemoryEnabled
      ? required(env, "PERSONA_MEMORY_DATABASE_NAME")
      : optional(env, "PERSONA_MEMORY_DATABASE_NAME"),
    personaMemoryDatabaseUser: personaMemoryEnabled
      ? required(env, "PERSONA_MEMORY_DATABASE_USER")
      : optional(env, "PERSONA_MEMORY_DATABASE_USER"),
    personaMemoryDatabasePassword: personaMemoryEnabled
      ? required(env, "PERSONA_MEMORY_DATABASE_PASSWORD")
      : optional(env, "PERSONA_MEMORY_DATABASE_PASSWORD"),
    personaMemoryDatabaseSsl: boolean(env, "PERSONA_MEMORY_DATABASE_SSL", false),
    personaMemoryRetrievalLimit: positiveInteger(
      env,
      "PERSONA_MEMORY_RETRIEVAL_LIMIT",
      4,
    ),
    personaMemoryRestoreTurns: positiveInteger(
      env,
      "PERSONA_MEMORY_RESTORE_TURNS",
      12,
    ),
    personaPreparedDraftsEnabled: boolean(
      env,
      "PERSONA_PREPARED_DRAFTS_ENABLED",
      false,
    ),
    personaEmbeddingBaseUrl: personaMemoryEnabled
      ? required(env, "PERSONA_EMBEDDING_BASE_URL")
      : optional(env, "PERSONA_EMBEDDING_BASE_URL"),
    personaEmbeddingModel: personaMemoryEnabled
      ? required(env, "PERSONA_EMBEDDING_MODEL")
      : optional(env, "PERSONA_EMBEDDING_MODEL"),
    personaEmbeddingDimensions: positiveInteger(
      env,
      "PERSONA_EMBEDDING_DIMENSIONS",
      1024,
    ),
    personaEmbeddingTimeoutMs: positiveInteger(
      env,
      "PERSONA_EMBEDDING_TIMEOUT_MS",
      5_000,
    ),
    personaAdviserBaseUrl: personaMemoryEnabled
      ? required(env, "PERSONA_ADVISER_BASE_URL")
      : optional(env, "PERSONA_ADVISER_BASE_URL"),
    personaAdviserApiKey: optional(env, "PERSONA_ADVISER_API_KEY"),
    personaAdviserModel: personaMemoryEnabled
      ? required(env, "PERSONA_ADVISER_MODEL")
      : optional(env, "PERSONA_ADVISER_MODEL"),
    personaMemoryAnalysisModel:
      optional(env, "PERSONA_MEMORY_ANALYSIS_MODEL") ??
      (personaMemoryEnabled ? required(env, "PERSONA_ADVISER_MODEL") : undefined),
    personaAdviserTimeoutMs: positiveInteger(
      env,
      "PERSONA_ADVISER_TIMEOUT_MS",
      30_000,
    ),
    personaAdviserHotTimeoutMs: positiveInteger(
      env,
      "PERSONA_ADVISER_HOT_TIMEOUT_MS",
      6_000,
    ),
    sherpaAsrModelDir: required(env, "SHERPA_ASR_MODEL_DIR"),
    sherpaTtsModelDir: required(env, "SHERPA_TTS_MODEL_DIR"),
    sherpaAsrThreads: positiveInteger(env, "SHERPA_ASR_THREADS", 4),
    sherpaTtsThreads: positiveInteger(env, "SHERPA_TTS_THREADS", 4),
    sherpaTtsSpeakerId: nonnegativeInteger(env, "SHERPA_TTS_SPEAKER_ID", 0),
    sherpaTtsSpeed: positiveNumber(env, "SHERPA_TTS_SPEED", 1),
    pocketTtsPythonExecutable:
      optional(env, "POCKET_TTS_PYTHON") ?? "/opt/pocket-tts/bin/python",
    pocketTtsBridgePath:
      optional(env, "POCKET_TTS_BRIDGE_PATH") ??
      "/opt/omnigent-voice/pocket-tts/bridge.py",
    pocketTtsVoice: optional(env, "POCKET_TTS_VOICE") ?? "alba",
    pocketTtsQuantize: boolean(env, "POCKET_TTS_QUANTIZE", true),
    kameBridgePath,
    kameConfigPath,
    kameModelPath,
    kameMimiPath,
    kameTokenizerPath,
    kameDevice: optional(env, "KAME_DEVICE") ?? "Vulkan0",
    kameContextFrames: positiveInteger(env, "KAME_CONTEXT_FRAMES", 3_000),
    kameInputDelayMs: nonnegativeInteger(env, "KAME_INPUT_DELAY_MS", 640),
    logLevel: logLevel as Config["logLevel"],
    logFile: optional(env, "LOG_FILE"),
  };
};
