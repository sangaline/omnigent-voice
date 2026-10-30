import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Logger } from "./log.js";

export type VoiceRecordingRole = "human" | "coordinator";

export interface VoiceRecordingDetails {
  outcome: string;
  endpoint?: string | undefined;
  retry?: number | undefined;
  source?: "turn" | "notification" | undefined;
}

interface VoiceRecordingStoreOptions {
  directory: string;
  retentionDays: number;
  maxBytes: number;
  logger: Logger;
}

interface PendingRecording {
  recordingId: string;
  turnId: string;
  role: VoiceRecordingRole;
  chunks: Float32Array[];
  sampleRate: number;
  samples: number;
  details: VoiceRecordingDetails;
}

const wavBuffer = (
  chunks: readonly Float32Array[],
  samples: number,
  sampleRate: number,
): Buffer => {
  const bytesPerSample = 2;
  const dataBytes = samples * bytesPerSample;
  const output = Buffer.allocUnsafe(44 + dataBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * bytesPerSample, 28);
  output.writeUInt16LE(bytesPerSample, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);

  let byteOffset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const bounded = Math.max(-1, Math.min(1, sample));
      output.writeInt16LE(
        bounded < 0 ? Math.round(bounded * 32_768) : Math.round(bounded * 32_767),
        byteOffset,
      );
      byteOffset += bytesPerSample;
    }
  }
  return output;
};

const timestampPart = (): string =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const recordingFilename = (recording: PendingRecording): string =>
  `${timestampPart()}-${recording.turnId}-${recording.role}-${recording.recordingId}.wav`;

const managedRecording = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f-]+-(?:human|coordinator)-[0-9a-f-]+\.wav$/;

export class VoiceRecording {
  private readonly chunks: Float32Array[] = [];
  private sampleRate = 0;
  private samples = 0;
  private finished = false;

  public constructor(
    private readonly store: VoiceRecordingStore,
    public readonly recordingId: string,
    public readonly turnId: string,
    public readonly role: VoiceRecordingRole,
  ) {}

  public append(samples: Float32Array, sampleRate: number): void {
    if (this.finished || samples.length === 0) return;
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
      throw new Error("Voice recording sample rate must be a positive integer");
    }
    if (this.sampleRate !== 0 && this.sampleRate !== sampleRate) {
      throw new Error("Voice recording sample rate changed during one recording");
    }
    this.sampleRate = sampleRate;
    this.samples += samples.length;
    this.chunks.push(samples.slice());
  }

  public finish(details: VoiceRecordingDetails): void {
    if (this.finished) return;
    this.finished = true;
    if (this.samples === 0 || this.sampleRate === 0) return;
    this.store.enqueue({
      recordingId: this.recordingId,
      turnId: this.turnId,
      role: this.role,
      chunks: this.chunks,
      sampleRate: this.sampleRate,
      samples: this.samples,
      details,
    });
  }

  public discard(): void {
    this.finished = true;
    this.chunks.length = 0;
    this.samples = 0;
  }
}

export class VoiceRecordingStore {
  private tail: Promise<void> = Promise.resolve();
  private persistedSinceCleanup = 0;

  public constructor(private readonly options: VoiceRecordingStoreOptions) {}

  public async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await this.cleanup();
    this.options.logger.info("voice.recording.ready", {
      retentionDays: this.options.retentionDays,
      maxMiB: Math.round(this.options.maxBytes / (1024 * 1024)),
    });
  }

  public newTurnId(): string {
    return randomUUID();
  }

  public begin(role: VoiceRecordingRole, turnId = this.newTurnId()): VoiceRecording {
    return new VoiceRecording(this, randomUUID(), turnId, role);
  }

  public enqueue(recording: PendingRecording): void {
    this.tail = this.tail
      .then(() => this.persist(recording))
      .catch((error) => this.options.logger.error("voice.recording.failed", error));
  }

  public async close(): Promise<void> {
    await this.tail;
  }

  private async persist(recording: PendingRecording): Promise<void> {
    const filename = recordingFilename(recording);
    const path = join(this.options.directory, filename);
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    const wav = wavBuffer(recording.chunks, recording.samples, recording.sampleRate);
    await writeFile(temporaryPath, wav, { mode: 0o600 });
    await rename(temporaryPath, path);
    this.options.logger.info("voice.recording.saved", {
      recordingId: recording.recordingId,
      turnId: recording.turnId,
      role: recording.role,
      file: filename,
      sampleRate: recording.sampleRate,
      audioMs: Math.round((recording.samples / recording.sampleRate) * 1_000),
      outcome: recording.details.outcome,
      ...(recording.details.endpoint ? { endpoint: recording.details.endpoint } : {}),
      ...(recording.details.retry !== undefined ? { retry: recording.details.retry } : {}),
      ...(recording.details.source ? { source: recording.details.source } : {}),
    });
    this.persistedSinceCleanup += 1;
    if (this.persistedSinceCleanup >= 20) {
      this.persistedSinceCleanup = 0;
      await this.cleanup();
    }
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    const retentionMs = this.options.retentionDays * 24 * 60 * 60 * 1_000;
    const files = [] as Array<{ name: string; size: number; mtimeMs: number }>;
    for (const entry of await readdir(this.options.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !managedRecording.test(entry.name)) continue;
      const metadata = await stat(join(this.options.directory, entry.name));
      files.push({ name: entry.name, size: metadata.size, mtimeMs: metadata.mtimeMs });
    }

    let removedFiles = 0;
    let removedBytes = 0;
    const retained = [] as typeof files;
    for (const file of files) {
      if (now - file.mtimeMs > retentionMs) {
        await unlink(join(this.options.directory, file.name));
        removedFiles += 1;
        removedBytes += file.size;
      } else {
        retained.push(file);
      }
    }

    retained.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let retainedBytes = retained.reduce((total, file) => total + file.size, 0);
    while (retainedBytes > this.options.maxBytes && retained.length > 0) {
      const file = retained.shift()!;
      await unlink(join(this.options.directory, file.name));
      retainedBytes -= file.size;
      removedFiles += 1;
      removedBytes += file.size;
    }
    if (removedFiles > 0) {
      this.options.logger.info("voice.recording.cleanup", {
        removedFiles,
        removedBytes,
        retainedBytes,
      });
    }
  }
}
