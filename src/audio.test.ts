import { describe, expect, it } from "vitest";
import {
  concatFloat32,
  monoFloatToStereoPcm16,
  resampleLinear,
  stereoPcm16ToMono16k,
} from "./audio.js";

describe("audio conversion", () => {
  it("concatenates float samples", () => {
    expect([...concatFloat32([new Float32Array([1, 2]), new Float32Array([3])])]).toEqual([
      1, 2, 3,
    ]);
  });

  it("downsamples 48 kHz stereo PCM to 16 kHz mono", () => {
    const pcm = Buffer.alloc(3 * 4);
    pcm.writeInt16LE(16_384, 0);
    pcm.writeInt16LE(16_384, 2);
    const result = stereoPcm16ToMono16k(pcm);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(0.5);
  });

  it("resamples and creates interleaved stereo PCM", () => {
    const resampled = resampleLinear(new Float32Array([0, 1]), 2, 4);
    expect([...resampled]).toEqual([0, 0.5, 1, 1]);
    const pcm = monoFloatToStereoPcm16(new Float32Array([-1, 1]));
    expect(pcm.readInt16LE(0)).toBe(-32_768);
    expect(pcm.readInt16LE(2)).toBe(-32_768);
    expect(pcm.readInt16LE(4)).toBe(32_767);
    expect(pcm.readInt16LE(6)).toBe(32_767);
  });
});

