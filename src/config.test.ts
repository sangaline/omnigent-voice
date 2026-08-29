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
