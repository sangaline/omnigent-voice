import { describe, expect, it } from "vitest";
import { isSmartTurnComplete, TailAudioBuffer } from "./endpoint.js";

describe("Smart Turn completion confidence", () => {
  it("keeps marginal endpoint predictions on the incomplete-turn fallback", () => {
    expect(isSmartTurnComplete(0.6067, 0.65)).toBe(false);
    expect(isSmartTurnComplete(0.65, 0.65)).toBe(true);
    expect(isSmartTurnComplete(0.9486, 0.65)).toBe(true);
  });
});

describe("tail audio buffer", () => {
  it("retains samples chronologically up to its capacity", () => {
    const audio = new TailAudioBuffer(5);
    audio.append(Float32Array.from([1, 2, 3]));
    audio.append(Float32Array.from([4, 5, 6, 7]));
    expect([...audio.snapshot()]).toEqual([3, 4, 5, 6, 7]);
  });

  it("returns independent snapshots", () => {
    const audio = new TailAudioBuffer(4);
    const chunk = Float32Array.from([1, 2]);
    audio.append(chunk);
    const snapshot = audio.snapshot();
    chunk[0] = 9;
    expect([...snapshot]).toEqual([1, 2]);
  });
});
