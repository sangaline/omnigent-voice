import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "./log.js";
import { VoiceRecordingStore } from "./voice-recordings.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "omnigent-voice-recordings-"));
  temporaryDirectories.push(path);
  return path;
};

describe("private voice recordings", () => {
  it("writes mono PCM WAV audio with private turn metadata in the filename", async () => {
    const path = await directory();
    const store = new VoiceRecordingStore({
      directory: path,
      retentionDays: 14,
      maxBytes: 1024 * 1024,
      logger: new Logger("error"),
    });
    await store.initialize();
    const recording = store.begin("human", "11111111-1111-4111-8111-111111111111");
    recording.append(Float32Array.from([-1, -0.5, 0, 0.5, 1]), 16_000);
    recording.finish({ outcome: "recognized", endpoint: "smart_turn" });
    await store.close();

    const files = (await readdir(path)).filter((name) => name.endsWith(".wav"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("-11111111-1111-4111-8111-111111111111-human-");
    const wav = await readFile(join(path, files[0]!));
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(10);
    expect(wav.readInt16LE(44)).toBe(-32_768);
    expect(wav.readInt16LE(52)).toBe(32_767);
  });

  it("removes only managed recordings that exceed retention", async () => {
    const path = await directory();
    const oldRecording = join(
      path,
      "20260801T000000Z-11111111-1111-4111-8111-111111111111-human-22222222-2222-4222-8222-222222222222.wav",
    );
    const unrelated = join(path, "keep-me.wav");
    await writeFile(oldRecording, "old");
    await writeFile(unrelated, "private");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    await utimes(oldRecording, old, old);
    const store = new VoiceRecordingStore({
      directory: path,
      retentionDays: 1,
      maxBytes: 1024 * 1024,
      logger: new Logger("error"),
    });
    await store.initialize();

    expect(await readdir(path)).toEqual(["keep-me.wav"]);
  });
});
