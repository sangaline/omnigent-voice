import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { Vad } from "sherpa-onnx-node";
import { Logger } from "./log.js";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node") as typeof import("sherpa-onnx-node");
const RESPONSE_BYTES = 12;

interface SmartTurnOptions {
  pythonExecutable: string;
  bridgePath: string;
  modelPath: string;
  threads: number;
  logger: Logger;
}

interface PendingPrediction {
  resolve: (result: SmartTurnResult) => void;
  reject: (error: Error) => void;
}

export interface SmartTurnResult {
  complete: boolean;
  probability: number;
  durationMs: number;
}

export class TailAudioBuffer {
  private readonly chunks: Float32Array[] = [];
  private sampleCount = 0;

  public constructor(private readonly capacity: number) {}

  public append(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.chunks.push(samples);
    this.sampleCount += samples.length;
    while (
      this.chunks.length > 1 &&
      this.sampleCount - this.chunks[0]!.length >= this.capacity
    ) {
      this.sampleCount -= this.chunks.shift()!.length;
    }
  }

  public snapshot(): Float32Array {
    const length = Math.min(this.sampleCount, this.capacity);
    const result = new Float32Array(length);
    let skip = this.sampleCount - length;
    let offset = 0;
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      const selected = chunk.subarray(skip);
      result.set(selected, offset);
      offset += selected.length;
      skip = 0;
    }
    return result;
  }
}

export interface SemanticEndpointOptions extends SmartTurnOptions {
  vadModelPath: string;
  vadThreshold: number;
  vadSilenceMs: number;
  vadMinSpeechMs: number;
}

export class SmartTurnRuntime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingPrediction>();

  public constructor(private readonly options: SmartTurnOptions) {}

  public async start(): Promise<void> {
    const started = performance.now();
    const child = spawn(
      this.options.pythonExecutable,
      [this.options.bridgePath, "--model", this.options.modelPath, "--threads", String(this.options.threads)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.options.logger.warn("endpoint.smart_turn.stderr", { message });
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.fail(new Error(`Smart Turn bridge exited (${code ?? signal ?? "unknown"})`));
    });
    const warmup = await this.predict(new Float32Array(16_000));
    this.options.logger.info("endpoint.smart_turn.ready", {
      startupMs: Math.round(performance.now() - started),
      warmupMs: Math.round(warmup.durationMs),
    });
  }

  public async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
    child?.kill("SIGTERM");
    this.fail(new Error("Smart Turn runtime stopped"));
  }

  public predict(samples: Float32Array): Promise<SmartTurnResult> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("Smart Turn is not running"));
    const id = this.nextId++;
    const request = Buffer.allocUnsafe(8 + samples.byteLength);
    request.writeUInt32LE(id, 0);
    request.writeUInt32LE(samples.length, 4);
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(request, 8);
    return new Promise<SmartTurnResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(request, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private consume(chunk: Buffer): void {
    this.stdout = Buffer.concat([this.stdout, chunk]);
    while (this.stdout.length >= RESPONSE_BYTES) {
      const response = this.stdout.subarray(0, RESPONSE_BYTES);
      this.stdout = this.stdout.subarray(RESPONSE_BYTES);
      const id = response.readUInt32LE(0);
      const probability = response.readFloatLE(4);
      const durationMs = response.readFloatLE(8);
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      pending.resolve({ complete: probability > 0.5, probability, durationMs });
    }
  }

  private fail(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

export class SemanticEndpointRuntime {
  public readonly smartTurn: SmartTurnRuntime;
  public readonly vadSilenceMs: number;

  public constructor(private readonly options: SemanticEndpointOptions) {
    this.smartTurn = new SmartTurnRuntime(options);
    this.vadSilenceMs = options.vadSilenceMs;
  }

  public start(): Promise<void> {
    return this.smartTurn.start();
  }

  public stop(): Promise<void> {
    return this.smartTurn.stop();
  }

  public createVad(): Vad {
    return new sherpa.Vad(
      {
        sileroVad: {
          model: this.options.vadModelPath,
          threshold: this.options.vadThreshold,
          minSilenceDuration: this.options.vadSilenceMs / 1_000,
          minSpeechDuration: this.options.vadMinSpeechMs / 1_000,
          windowSize: 512,
          maxSpeechDuration: 60,
        },
        sampleRate: 16_000,
        numThreads: 1,
        provider: "cpu",
        debug: false,
      },
      90,
    );
  }
}
