import { describe, expect, it } from "vitest";
import {
  acceptS2SSpeechTurnFrame,
  DelayedS2SInput,
  decodeS2SReady,
  encodeS2SGuidance,
  guidanceWordRecall,
  S2SAudioGate,
  s2sCompletionTimeoutMs,
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

  it("keeps S2S output fail-closed outside the current guided response", () => {
    const gate = new S2SAudioGate();
    const first = gate.begin();
    expect(gate.isOpen).toBe(false);
    expect(gate.open(first)).toBe(true);
    expect(gate.isOpen).toBe(true);
    gate.close(first);
    expect(gate.isOpen).toBe(false);

    const second = gate.begin();
    expect(gate.open(first)).toBe(false);
    expect(gate.isOpen).toBe(false);
    expect(gate.open(second)).toBe(true);
    gate.close();
    expect(gate.isOpen).toBe(false);
    expect(gate.open(second)).toBe(false);
  });

  it("bounds guided speech completion by response length", () => {
    expect(s2sCompletionTimeoutMs("Short answer.")).toBe(10_000);
    expect(s2sCompletionTimeoutMs(Array(30).fill("word").join(" "))).toBe(22_500);
    expect(s2sCompletionTimeoutMs(Array(200).fill("word").join(" "))).toBe(120_000);
  });

  it("scores oracle guidance against independently recognized words", () => {
    expect(guidanceWordRecall("The bot is fully offline", "the bot is offline")).toBe(0.8);
    expect(guidanceWordRecall("The bot is fully offline", "unrelated speech")).toBe(0);
  });

  it("delays live S2S audio without turning the delay into backlog", () => {
    const input = new DelayedS2SInput();
    input.push(new Float32Array([1, 2, 3]), 640);
    expect([...input.take(2, 639)]).toEqual([0, 0]);
    expect(input.samples).toBe(3);
    expect(input.lagMs(1_000)).toBe(360);
    expect([...input.take(2, 1_000)]).toEqual([1, 2]);
    expect([...input.take(2, 1_000)]).toEqual([3, 0]);
    expect(input.samples).toBe(0);
  });
});
