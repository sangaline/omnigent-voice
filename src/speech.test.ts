import type { OnlineRecognizer } from "sherpa-onnx-node";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "./log.js";
import { StreamingTranscription } from "./speech.js";

describe("streaming transcription", () => {
  it("decodes accepted audio before end-of-turn and only flushes at finish", () => {
    const state = { ready: false, decodes: 0, accepted: 0, inputFinished: false };
    const stream = {
      acceptWaveform: ({ samples }: { samples: Float32Array }) => {
        state.accepted += samples.length;
        state.ready = true;
      },
      inputFinished: () => {
        state.inputFinished = true;
      },
    };
    const recognizer = {
      createStream: vi.fn(() => stream),
      isReady: vi.fn(() => state.ready),
      decode: vi.fn(() => {
        state.decodes += 1;
        state.ready = false;
      }),
      getResult: vi.fn(() => ({ text: state.decodes > 1 ? "hello" : "hel" })),
    } as unknown as OnlineRecognizer;
    const transcription = new StreamingTranscription(recognizer, new Logger("error"));

    transcription.accept(new Float32Array(1_600).fill(0.5));
    expect(state.decodes).toBe(1);
    expect(state.inputFinished).toBe(false);

    expect(transcription.finish()).toEqual({
      text: "hello",
      audioMs: 100,
      peakAmplitude: 0.5,
    });
    expect(state.decodes).toBe(2);
    expect(state.accepted).toBe(9_600);
    expect(state.inputFinished).toBe(true);
  });
});
