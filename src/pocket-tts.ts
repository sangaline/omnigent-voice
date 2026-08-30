import { ChildProcess, spawn } from "node:child_process";
import { Logger } from "./log.js";
import type { SynthesizedAudio } from "./speech.js";

interface PocketTtsOptions {
  executable: string;
  bridgePath: string;
  voice: string;
  quantize: boolean;
  logger: Logger;
}

interface PocketTtsReady {
  sampleRate: number;
}

interface PocketTtsGeneration {
  audioMs: number;
  chunks: number;
}

interface PendingGeneration {
  onChunk: (audio: SynthesizedAudio) => boolean | void;
  resolve: (result: PocketTtsGeneration) => void;
  reject: (error: Error) => void;
  samples: number;
  chunks: number;
  accepting: boolean;
  callbackError?: Error | undefined;
}

interface BridgeMessage {
  type?: unknown;
  id?: unknown;
  sample_rate?: unknown;
  audio?: unknown;
  error?: unknown;
}

const decodeSamples = (encoded: string): Float32Array => {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Pocket TTS returned a malformed audio chunk");
  }
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
};

export class PocketTtsRuntime {
  private child: ChildProcess | undefined;
  private readyState: PocketTtsReady | undefined;
  private readonly pending = new Map<number, PendingGeneration>();
  private nextRequestId = 1;
  private tail: Promise<void> = Promise.resolve();
  private stopping = false;

  public constructor(private readonly options: PocketTtsOptions) {}

  public get ready(): PocketTtsReady {
    if (!this.readyState) throw new Error("Pocket TTS is not ready");
    return this.readyState;
  }

  public async start(): Promise<PocketTtsReady> {
    if (this.child) throw new Error("Pocket TTS has already started");
    const started = performance.now();
    const child = spawn(
      this.options.executable,
      [
        this.options.bridgePath,
        "--voice",
        this.options.voice,
        this.options.quantize ? "--quantize" : "--no-quantize",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, POCKET_TTS_NO_BEARTYPE: "1" },
      },
    );
    this.child = child;
    child.stderr!.on("data", () => undefined);

    return new Promise<PocketTtsReady>((resolve, reject) => {
      let settled = false;
      let lines = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("Pocket TTS did not become ready within two minutes"));
      }, 120_000);
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        this.rejectPending(error);
        if (!this.stopping && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      };
      child.once("error", (error) => fail(error));
      child.once("exit", (code, signal) => {
        if (this.stopping) return;
        fail(new Error(`Pocket TTS exited: ${code ?? signal}`));
      });
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        lines += chunk;
        let newline = lines.indexOf("\n");
        while (newline >= 0) {
          const line = lines.slice(0, newline);
          lines = lines.slice(newline + 1);
          try {
            const message = JSON.parse(line) as BridgeMessage;
            if (message.type === "ready") {
              if (!Number.isSafeInteger(message.sample_rate) || Number(message.sample_rate) <= 0) {
                throw new Error("Pocket TTS returned an invalid sample rate");
              }
              const ready = { sampleRate: Number(message.sample_rate) };
              this.readyState = ready;
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                this.options.logger.info("tts.pocket.ready", {
                  loadMs: Math.round(performance.now() - started),
                  sampleRate: ready.sampleRate,
                  quantized: this.options.quantize,
                });
                resolve(ready);
              }
            } else {
              this.acceptMessage(message);
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
          newline = lines.indexOf("\n");
        }
      });
    });
  }

  public generate(
    text: string,
    onChunk: (audio: SynthesizedAudio) => boolean | void,
  ): Promise<PocketTtsGeneration> {
    const run = (): Promise<PocketTtsGeneration> => this.generateNow(text, onChunk);
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.stdin?.end();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    this.child = undefined;
    this.readyState = undefined;
    this.rejectPending(new Error("Pocket TTS stopped"));
  }

  private generateNow(
    text: string,
    onChunk: (audio: SynthesizedAudio) => boolean | void,
  ): Promise<PocketTtsGeneration> {
    const child = this.child;
    const ready = this.readyState;
    if (!child?.stdin || !ready || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(new Error("Pocket TTS is unavailable"));
    }
    const id = this.nextRequestId++;
    return new Promise<PocketTtsGeneration>((resolve, reject) => {
      this.pending.set(id, {
        onChunk,
        resolve,
        reject,
        samples: 0,
        chunks: 0,
        accepting: true,
      });
      child.stdin!.write(`${JSON.stringify({ id, text })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private acceptMessage(message: BridgeMessage): void {
    if (!Number.isSafeInteger(message.id)) throw new Error("Pocket TTS omitted a request id");
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.type === "chunk") {
      if (typeof message.audio !== "string") {
        throw new Error("Pocket TTS omitted chunk audio");
      }
      const samples = decodeSamples(message.audio);
      pending.samples += samples.length;
      pending.chunks += 1;
      if (!pending.accepting) return;
      try {
        pending.accepting = pending.onChunk({
          samples,
          sampleRate: this.ready.sampleRate,
        }) !== false;
      } catch (error) {
        pending.accepting = false;
        pending.callbackError = error instanceof Error ? error : new Error(String(error));
      }
      if (!pending.accepting) this.cancel(id);
      return;
    }
    this.pending.delete(id);
    if (message.type === "done") {
      if (pending.callbackError) pending.reject(pending.callbackError);
      else {
        pending.resolve({
          audioMs: Math.round((pending.samples / this.ready.sampleRate) * 1_000),
          chunks: pending.chunks,
        });
      }
      return;
    }
    if (message.type === "error") {
      pending.reject(new Error(`Pocket TTS generation failed: ${String(message.error)}`));
      return;
    }
    throw new Error("Pocket TTS returned an unknown message");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private cancel(id: number): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(`${JSON.stringify({ type: "cancel", id })}\n`);
  }
}
