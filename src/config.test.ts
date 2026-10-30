import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const requiredEnvironment = (): NodeJS.ProcessEnv => ({
  DISCORD_BOT_TOKEN: "test-token",
  OMNIGENT_BASE_URL: "http://omnigent.invalid",
  OMNIGENT_REFRESH_TOKEN: "test-refresh-token",
  OMNIGENT_WORKSPACE: "/test/workspace",
  SHERPA_ASR_MODEL_DIR: "/test/asr",
  SHERPA_TTS_MODEL_DIR: "/test/tts",
});

describe("Smart Turn configuration", () => {
  it("uses the live-calibrated completion threshold by default", () => {
    expect(loadConfig(requiredEnvironment()).smartTurnCompleteThreshold).toBe(0.65);
  });

  it("accepts a deployment override within the probability range", () => {
    expect(
      loadConfig({
        ...requiredEnvironment(),
        SMART_TURN_COMPLETE_THRESHOLD: "0.8",
      }).smartTurnCompleteThreshold,
    ).toBe(0.8);
  });

  it("rejects a completion threshold outside the probability range", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment(),
        SMART_TURN_COMPLETE_THRESHOLD: "1.1",
      }),
    ).toThrow("SMART_TURN_COMPLETE_THRESHOLD must be a number between 0 and 1");
  });
});

describe("conversation mode configuration", () => {
  it("keeps coordinator mode as the default and requires its credentials", () => {
    expect(loadConfig(requiredEnvironment()).conversationMode).toBe("coordinator");
    expect(loadConfig({
      ...requiredEnvironment(),
      CELERIS_OPENROUTER_PROVIDER: "deepinfra/turbo",
    }).celerisOpenRouterProvider).toBe("deepinfra/turbo");
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "test-token",
        SHERPA_ASR_MODEL_DIR: "/test/asr",
        SHERPA_TTS_MODEL_DIR: "/test/tts",
      }),
    ).toThrow("Missing required environment variable: OMNIGENT_BASE_URL");
  });

  it("allows persona mode without any Omnigent configuration", () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "test-token",
      SHERPA_ASR_MODEL_DIR: "/test/asr",
      SHERPA_TTS_MODEL_DIR: "/test/tts",
      CONVERSATION_MODE: "persona",
      PERSONA_SYSTEM_PROMPT: "Speak like a thoughtful old friend.",
      PERSONA_MAX_RESPONSE_CHARACTERS: "500",
      PERSONA_TEMPERATURE: "0.7",
    });

    expect(config.conversationMode).toBe("persona");
    expect(config.omnigentBaseUrl).toBeUndefined();
    expect(config.omnigentRefreshToken).toBeUndefined();
    expect(config.omnigentWorkspace).toBeUndefined();
    expect(config.personaSystemPrompt).toBe("Speak like a thoughtful old friend.");
    expect(config.personaMaxResponseCharacters).toBe(500);
    expect(config.personaTemperature).toBe(0.7);
    expect(config.personaMemoryEnabled).toBe(false);
  });

  it("lets persona chat use another OpenAI-compatible provider without changing coordinator settings", () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "test-token",
      SHERPA_ASR_MODEL_DIR: "/test/asr",
      SHERPA_TTS_MODEL_DIR: "/test/tts",
      CONVERSATION_MODE: "persona",
      CELERIS_API_KEY: "coordinator-key",
      CELERIS_MODEL: "celeris-1",
      PERSONA_CHAT_API_KEY: "persona-key",
      PERSONA_CHAT_BASE_URL: "https://openrouter.invalid/api/v1",
      PERSONA_CHAT_MODEL: "google/gemma-test",
      PERSONA_CHAT_OPENROUTER_PROVIDER: "provider/fp16",
    });

    expect(config.celerisModel).toBe("celeris-1");
    expect(config.personaChatApiKey).toBe("persona-key");
    expect(config.personaChatBaseUrl).toBe("https://openrouter.invalid/api/v1");
    expect(config.personaChatModel).toBe("google/gemma-test");
    expect(config.personaChatOpenRouterProvider).toBe("provider/fp16");
  });

  it("validates the opt-in persistent persona memory dependencies", () => {
    const base = {
      DISCORD_BOT_TOKEN: "test-token",
      SHERPA_ASR_MODEL_DIR: "/test/asr",
      SHERPA_TTS_MODEL_DIR: "/test/tts",
      CONVERSATION_MODE: "persona",
      PERSONA_MEMORY_ENABLED: "true",
    };
    expect(() => loadConfig(base)).toThrow(
      "Missing required environment variable: PERSONA_MEMORY_DATABASE_HOST",
    );
    const config = loadConfig({
      ...base,
      PERSONA_MEMORY_DATABASE_HOST: "postgres.invalid",
      PERSONA_MEMORY_DATABASE_NAME: "persona",
      PERSONA_MEMORY_DATABASE_USER: "persona",
      PERSONA_MEMORY_DATABASE_PASSWORD: "test-password",
      PERSONA_EMBEDDING_BASE_URL: "http://ollama.invalid",
      PERSONA_EMBEDDING_MODEL: "embedding-test",
      PERSONA_ADVISER_BASE_URL: "https://adviser.invalid/v1",
      PERSONA_ADVISER_MODEL: "adviser-test",
    });
    expect(config.personaMemoryEnabled).toBe(true);
    expect(config.personaEmbeddingDimensions).toBe(1024);
    expect(config.personaMemoryRestoreTurns).toBe(12);
    expect(config.personaMemoryAnalysisModel).toBe("adviser-test");
  });

  it("rejects unknown conversation modes and invalid persona temperatures", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment(), CONVERSATION_MODE: "agent" }),
    ).toThrow("CONVERSATION_MODE must be coordinator or persona");
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "test-token",
        SHERPA_ASR_MODEL_DIR: "/test/asr",
        SHERPA_TTS_MODEL_DIR: "/test/tts",
        CONVERSATION_MODE: "persona",
        PERSONA_TEMPERATURE: "2.1",
      }),
    ).toThrow("PERSONA_TEMPERATURE must be a number between 0 and 2");
  });
});

describe("private voice recording configuration", () => {
  it("keeps recordings off unless an absolute private runtime directory is supplied", () => {
    const disabled = loadConfig(requiredEnvironment());
    expect(disabled.voiceRecordingEnabled).toBe(false);
    expect(disabled.voiceRecordingDirectory).toBeUndefined();

    expect(() => loadConfig({
      ...requiredEnvironment(),
      VOICE_RECORDING_ENABLED: "true",
    })).toThrow("Missing required environment variable: VOICE_RECORDING_DIRECTORY");
    expect(() => loadConfig({
      ...requiredEnvironment(),
      VOICE_RECORDING_ENABLED: "true",
      VOICE_RECORDING_DIRECTORY: "recordings",
    })).toThrow("VOICE_RECORDING_DIRECTORY must be an absolute path");
  });

  it("accepts bounded retention settings for an enabled private directory", () => {
    const config = loadConfig({
      ...requiredEnvironment(),
      VOICE_RECORDING_ENABLED: "true",
      VOICE_RECORDING_DIRECTORY: "/private/recordings",
      VOICE_RECORDING_RETENTION_DAYS: "7",
      VOICE_RECORDING_MAX_MIB: "512",
    });
    expect(config.voiceRecordingEnabled).toBe(true);
    expect(config.voiceRecordingDirectory).toBe("/private/recordings");
    expect(config.voiceRecordingRetentionDays).toBe(7);
    expect(config.voiceRecordingMaxBytes).toBe(512 * 1024 * 1024);
  });
});
