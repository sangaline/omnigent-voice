import { describe, expect, it } from "vitest";
import {
  acceptS2SSpeechTurnFrame,
  decodeS2SReady,
  encodeS2SGuidance,
} from "./s2s.js";

describe("KAME S2S control protocol", () => {
  it("encodes replacement guidance as one safe line", () => {
    expect(encodeS2SGuidance("First line\nsecond\tline")).toBe(
      "R\tFirst line second line\n",
    );
  });

  it("can append guidance without resetting queued tokens", () => {
    expect(encodeS2SGuidance("next", false)).toBe("A\tnext\n");
  });

  it("confirms a speech turn only after trailing silence", () => {
    const state = { started: false, silentFrames: 0 };
    expect(acceptS2SSpeechTurnFrame(state, new Float32Array([0.001]))).toBe(false);
    expect(acceptS2SSpeechTurnFrame(state, new Float32Array([0.2]))).toBe(false);
    for (let frame = 0; frame < 7; frame += 1) {
      expect(acceptS2SSpeechTurnFrame(state, new Float32Array([0.001]))).toBe(false);
    }
    expect(acceptS2SSpeechTurnFrame(state, new Float32Array([0.001]))).toBe(true);
  });

  it("decodes the native snake-case readiness protocol", () => {
    expect(
      decodeS2SReady(
        '{"sample_rate":24000,"frame_rate":12.5,"frame_size":1920}',
      ),
    ).toEqual({ sampleRate: 24_000, frameRate: 12.5, frameSize: 1_920 });
  });

  it("rejects incomplete or nonpositive readiness metadata", () => {
    expect(() => decodeS2SReady('{"frame_rate":12.5}')).toThrow(
      "invalid audio metadata",
    );
  });
});
