import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Logger } from "./log.js";
import { PocketTtsRuntime } from "./pocket-tts.js";

const bridgePath = fileURLToPath(
  new URL("../test/fixtures/fake-pocket-tts.mjs", import.meta.url),
);

describe("Pocket TTS bridge", () => {
  it("keeps one process warm and streams ordered float chunks", async () => {
    const runtime = new PocketTtsRuntime({
      executable: process.execPath,
      bridgePath,
      voice: "test",
      quantize: true,
      logger: new Logger("error"),
    });
    await expect(runtime.start()).resolves.toEqual({ sampleRate: 1_000 });

    const chunks: number[][] = [];
    await expect(
      runtime.generate("hello", (audio) => {
        chunks.push([...audio.samples]);
      }),
    ).resolves.toEqual({ audioMs: 4, chunks: 2 });
    expect(chunks).toEqual([
      [0.25, -0.5],
      [0.25, -0.5],
    ]);
    await runtime.stop();
  });

  it("surfaces a generation failure without killing the warm process", async () => {
    const runtime = new PocketTtsRuntime({
      executable: process.execPath,
      bridgePath,
      voice: "test",
      quantize: false,
      logger: new Logger("error"),
    });
    await runtime.start();
    await expect(runtime.generate("fail", () => undefined)).rejects.toThrow(
      "SyntheticError",
    );
    await expect(runtime.generate("recover", () => undefined)).resolves.toEqual({
      audioMs: 4,
      chunks: 2,
    });
    await runtime.stop();
  });

  it("cancels discarded audio without blocking the next generation", async () => {
    const runtime = new PocketTtsRuntime({
      executable: process.execPath,
      bridgePath,
      voice: "test",
      quantize: true,
      logger: new Logger("error"),
    });
    await runtime.start();
    let chunks = 0;
    await expect(
      runtime.generate("long", () => {
        chunks += 1;
        return false;
      }),
    ).resolves.toEqual({ audioMs: 2, chunks: 1 });
    expect(chunks).toBe(1);
    await expect(runtime.generate("next", () => undefined)).resolves.toEqual({
      audioMs: 4,
      chunks: 2,
    });
    await runtime.stop();
  });
});
