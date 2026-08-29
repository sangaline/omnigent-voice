import { ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { Logger } from "./log.js";

export interface S2SRuntimeOptions {
  executable: string;
  configPath: string;
  modelPath: string;
  mimiPath: string;
  tokenizerPath: string;
  device: string;
  contextFrames: number;
  logger: Logger;
}

export interface S2SReady {
  sampleRate: number;
  frameRate: number;
  frameSize: number;
}

export const encodeS2SGuidance = (text: string, reset = true): string => {
  const normalized = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return `${reset ? "R" : "A"}\t${normalized}\n`;
};

const lines = (stream: Readable, onLine: (line: string) => void): void => {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trimEnd();
      pending = pending.slice(newline + 1);
      if (line) onLine(line);
      newline = pending.indexOf("\n");
    }
  });
};

export class KameS2SRuntime {
  private child: ChildProcess | undefined;
  private input: Writable | undefined;
  private control: Writable | undefined;
  private readyState: S2SReady | undefined;
  private audioPending = Buffer.alloc(0);
  private readonly audioListeners = new Set<(audio: Float32Array) => void>();
  private stopping = false;

  public constructor(private readonly options: S2SRuntimeOptions) {}

  public get ready(): S2SReady {
    if (!this.readyState) throw new Error("KAME S2S runtime is not ready");
    return this.readyState;
  }

  public async start(): Promise<S2SReady> {
    if (this.child) throw new Error("KAME S2S runtime has already started");
    const child = spawn(
      this.options.executable,
      [
        "--config",
        this.options.configPath,
        "--model",
        this.options.modelPath,
        "--mimi",
        this.options.mimiPath,
        "--tokenizer",
        this.options.tokenizerPath,
        "--device",
        this.options.device,
        "--context",
        String(this.options.contextFrames),
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
    );
    this.child = child;
    this.input = child.stdin!;
    this.control = child.stdio[3] as Writable;
    const audio = child.stdout!;
    const events = child.stdio[4] as Readable;
    const stderr = child.stderr!;

    lines(stderr, (line) => {
      this.options.logger.debug("s2s.native", { message: line.slice(0, 1_000) });
    });

    const started = performance.now();
    const ready = new Promise<S2SReady>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("KAME S2S runtime did not become ready within 10 minutes"));
      }, 10 * 60_000);
      const finish = (result: S2SReady): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`KAME S2S runtime exited before ready: ${code ?? signal}`));
        }
        if (!this.stopping) {
          this.options.logger.error(
            "s2s.exited",
            new Error(`native runtime exited: ${code ?? signal}`),
          );
        }
      });
      lines(events, (line) => {
        const kind = line.slice(0, 1);
        const payload = line.slice(2);
        if (kind === "R") {
          const parsed = JSON.parse(payload) as S2SReady;
          if (
            !Number.isFinite(parsed.sampleRate) ||
            !Number.isFinite(parsed.frameRate) ||
            !Number.isSafeInteger(parsed.frameSize)
          ) {
            throw new Error("KAME S2S runtime returned invalid audio metadata");
          }
          this.readyState = parsed;
          this.options.logger.info("s2s.ready", {
            loadMs: Math.round(performance.now() - started),
            sampleRate: parsed.sampleRate,
            frameRate: parsed.frameRate,
            frameSize: parsed.frameSize,
          });
          finish(parsed);
        } else {
          this.handleEvent(kind, payload);
        }
      });
    });

    audio.on("data", (chunk: Buffer) => this.acceptOutput(chunk));
    audio.on("error", (error) => this.options.logger.error("s2s.audio.failed", error));
    return ready;
  }

  public subscribeAudio(listener: (audio: Float32Array) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  public sendAudio(frame: Float32Array): boolean {
    if (!this.input || !this.readyState) return false;
    if (frame.length !== this.readyState.frameSize) {
      throw new Error(
        `KAME input frame has ${frame.length} samples, expected ${this.readyState.frameSize}`,
      );
    }
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    const accepted = this.input.write(bytes);
    if (!accepted) {
      this.options.logger.warn("s2s.input.backpressure", {
        queuedBytes: this.input.writableLength,
      });
    }
    return accepted;
  }

  public guide(text: string, reset = true): boolean {
    if (!this.control || !this.readyState) return false;
    const accepted = this.control.write(encodeS2SGuidance(text, reset));
    this.options.logger.info("s2s.guidance.sent", {
      characters: text.length,
      reset,
    });
    return accepted;
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.input?.end();
    this.control?.end();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    this.child = undefined;
    this.input = undefined;
    this.control = undefined;
    this.readyState = undefined;
  }

  private acceptOutput(chunk: Buffer): void {
    if (!this.readyState) return;
    this.audioPending = Buffer.concat([this.audioPending, chunk]);
    const frameBytes = this.readyState.frameSize * Float32Array.BYTES_PER_ELEMENT;
    while (this.audioPending.length >= frameBytes) {
      const bytes = this.audioPending.subarray(0, frameBytes);
      this.audioPending = this.audioPending.subarray(frameBytes);
      const copy = Buffer.from(bytes);
      const frame = new Float32Array(
        copy.buffer,
        copy.byteOffset,
        this.readyState.frameSize,
      );
      for (const listener of this.audioListeners) listener(frame);
    }
  }

  private handleEvent(kind: string, payload: string): void {
    if (kind === "G") {
      this.options.logger.info("s2s.guidance.accepted", { tokens: Number(payload) });
      return;
    }
    if (kind === "T") {
      this.options.logger.info("conversation.assistant.s2s_transcript", {
        text: payload.trim(),
      });
      return;
    }
    if (kind === "M") {
      try {
        const metrics = JSON.parse(payload) as Record<string, number>;
        this.options.logger.info("s2s.frame_metrics", {
          frames: metrics.frames,
          meanMs: metrics.mean_ms,
          p95Ms: metrics.p95_ms,
          p99Ms: metrics.p99_ms,
          maxMs: metrics.max_ms,
        });
      } catch (error) {
        this.options.logger.error("s2s.metrics.invalid", error);
      }
      return;
    }
    if (kind === "E") {
      this.options.logger.error("s2s.native.error", new Error(payload));
    }
  }
}
