import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { OfflineTts, OnlineRecognizer } from "sherpa-onnx-node";
import { Logger } from "./log.js";
import { PocketTtsRuntime } from "./pocket-tts.js";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node") as typeof import("sherpa-onnx-node");

interface SpeechOptions {
  asrModelDir: string;
  ttsModelDir: string;
  ttsRuntime?: "piper" | "pocket" | undefined;
  asrThreads: number;
  ttsThreads: number;
  ttsSpeakerId: number;
  ttsSpeed: number;
  pocketTtsPythonExecutable?: string | undefined;
  pocketTtsBridgePath?: string | undefined;
  pocketTtsVoice?: string | undefined;
  pocketTtsQuantize?: boolean | undefined;
  logger: Logger;
}

export interface SynthesizedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface TranscriptionResult {
  text: string;
  audioMs: number;
  peakAmplitude: number;
}

export class StreamingTranscription {
  private readonly stream: ReturnType<OnlineRecognizer["createStream"]>;
  private readonly started = performance.now();
  private sampleCount = 0;
  private peak = 0;
  private firstPartialLogged = false;
  private lastPartial = "";
  private finished = false;

  public constructor(
    private readonly recognizer: OnlineRecognizer,
    private readonly logger: Logger,
    private readonly onPartial?: ((text: string) => void) | undefined,
  ) {
    this.stream = recognizer.createStream();
  }

  public accept(samples: Float32Array): void {
    if (this.finished) throw new Error("Cannot add audio to a finished ASR stream");
    this.sampleCount += samples.length;
    for (const sample of samples) this.peak = Math.max(this.peak, Math.abs(sample));
    this.stream.acceptWaveform({ samples, sampleRate: 16_000 });
    this.decodeReady();
  }

  public finish(): TranscriptionResult {
    if (this.finished) throw new Error("ASR stream was already finished");
    this.finished = true;
    const finalizeStarted = performance.now();
    // The transducer needs right-hand acoustic context to flush its last token.
    // This is decoder padding, not caller audio, so it is excluded from audioMs.
    this.stream.acceptWaveform({ samples: new Float32Array(8_000), sampleRate: 16_000 });
    this.stream.inputFinished();
    this.decodeReady();
    const text = this.recognizer.getResult(this.stream).text?.trim() ?? "";
    const result = {
      text,
      audioMs: Math.round((this.sampleCount / 16_000) * 1_000),
      peakAmplitude: this.peak,
    };
    this.logger.info("asr.final", {
      finalizeMs: Math.round(performance.now() - finalizeStarted),
      streamMs: Math.round(performance.now() - this.started),
      audioMs: result.audioMs,
      characters: text.length,
    });
    return result;
  }

  private decodeReady(): void {
    let decoded = false;
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream);
      decoded = true;
    }
    if (decoded) {
      const partial = this.recognizer.getResult(this.stream).text?.trim() ?? "";
      if (partial && partial !== this.lastPartial) {
        this.lastPartial = partial;
        this.onPartial?.(partial);
      }
      if (partial && !this.firstPartialLogged) {
        this.firstPartialLogged = true;
        this.logger.info("asr.first_partial", {
          durationMs: Math.round(performance.now() - this.started),
          characters: partial.length,
        });
      }
    }
  }
}

const walkFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const findFile = (files: readonly string[], pattern: RegExp, label: string): string => {
  const matches = files.filter((path) => pattern.test(path.split("/").pop() ?? ""));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label} model file, found ${matches.length}`);
  }
  return matches[0]!;
};

const requireDirectory = (path: string, label: string): string => {
  if (!statSync(path).isDirectory()) throw new Error(`${label} is not a directory`);
  return path;
};

export class LocalSpeech {
  private constructor(
    private readonly recognizer: OnlineRecognizer,
    private readonly tts: OfflineTts | undefined,
    private readonly pocketTts: PocketTtsRuntime | undefined,
    private readonly options: SpeechOptions,
  ) {}

  public static async create(options: SpeechOptions): Promise<LocalSpeech> {
    requireDirectory(options.asrModelDir, "SHERPA_ASR_MODEL_DIR");
    const asrFiles = walkFiles(options.asrModelDir);
    const recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: findFile(asrFiles, /^encoder.*\.onnx$/i, "ASR encoder"),
          decoder: findFile(asrFiles, /^decoder.*\.onnx$/i, "ASR decoder"),
          joiner: findFile(asrFiles, /^joiner.*\.onnx$/i, "ASR joiner"),
        },
        tokens: findFile(asrFiles, /^tokens\.txt$/i, "ASR tokens"),
        numThreads: options.asrThreads,
        provider: "cpu",
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      enableEndpoint: false,
    });

    const ttsRuntime = options.ttsRuntime ?? "piper";
    let tts: OfflineTts | undefined;
    let pocketTts: PocketTtsRuntime | undefined;
    if (ttsRuntime === "pocket") {
      if (!options.pocketTtsPythonExecutable || !options.pocketTtsBridgePath) {
        throw new Error("Pocket TTS Python executable and bridge path are required");
      }
      pocketTts = new PocketTtsRuntime({
        executable: options.pocketTtsPythonExecutable,
        bridgePath: options.pocketTtsBridgePath,
        voice: options.pocketTtsVoice ?? "alba",
        quantize: options.pocketTtsQuantize ?? true,
        logger: options.logger,
      });
      await pocketTts.start();
    } else {
      requireDirectory(options.ttsModelDir, "SHERPA_TTS_MODEL_DIR");
      const ttsFiles = walkFiles(options.ttsModelDir);
      tts = await sherpa.OfflineTts.createAsync({
        model: {
          vits: {
            model: findFile(ttsFiles, /^en_US-lessac-medium\.onnx$/i, "TTS model"),
            tokens: findFile(ttsFiles, /^tokens\.txt$/i, "TTS tokens"),
            dataDir: join(options.ttsModelDir, "espeak-ng-data"),
            noiseScale: 0.667,
            noiseScaleW: 0.8,
            lengthScale: 1,
          },
        },
        maxNumSentences: 1,
        silenceScale: 0.25,
        numThreads: options.ttsThreads,
        provider: "cpu",
      });
      if (options.ttsSpeakerId >= tts.numSpeakers) {
        throw new Error(
          `SHERPA_TTS_SPEAKER_ID must be below ${tts.numSpeakers}`,
        );
      }
    }
    options.logger.info("speech.models.ready", {
      sherpaVersion: sherpa.version,
      ttsRuntime,
      ttsSpeakers: tts?.numSpeakers ?? 1,
      ttsSampleRate: tts?.sampleRate ?? pocketTts?.ready.sampleRate,
    });
    return new LocalSpeech(recognizer, tts, pocketTts, options);
  }

  public transcribe(samples: Float32Array): string {
    const transcription = this.createTranscription();
    transcription.accept(samples);
    return transcription.finish().text;
  }

  public createTranscription(
    onPartial?: ((text: string) => void) | undefined,
  ): StreamingTranscription {
    return new StreamingTranscription(this.recognizer, this.options.logger, onPartial);
  }

  public async synthesize(text: string): Promise<SynthesizedAudio> {
    const chunks: Float32Array[] = [];
    let samples = 0;
    let sampleRate = 0;
    await this.synthesizeStreaming(text, (audio) => {
      chunks.push(audio.samples);
      samples += audio.samples.length;
      sampleRate = audio.sampleRate;
    });
    const combined = new Float32Array(samples);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    if (sampleRate <= 0) throw new Error("TTS returned no audio");
    return { samples: combined, sampleRate };
  }

  public async synthesizeStreaming(
    text: string,
    onChunk: (audio: SynthesizedAudio) => boolean | void,
  ): Promise<void> {
    const started = performance.now();
    let chunks = 0;
    this.options.logger.info("tts.started", { characters: text.length });
    if (this.pocketTts) {
      const result = await this.pocketTts.generate(text, (audio) => {
        chunks += 1;
        if (chunks === 1) {
          this.options.logger.info("tts.first_chunk", {
            durationMs: Math.round(performance.now() - started),
          });
        }
        return onChunk(audio);
      });
      this.options.logger.info("tts.complete", {
        durationMs: Math.round(performance.now() - started),
        audioMs: result.audioMs,
        chunks: result.chunks,
        runtime: "pocket",
      });
      return;
    }
    const tts = this.tts;
    if (!tts) throw new Error("No TTS runtime is available");
    const audio = await tts.generateAsync({
      text,
      sid: this.options.ttsSpeakerId,
      speed: this.options.ttsSpeed,
      onProgress: ({ samples }) => {
        if (samples.length === 0) return true;
        chunks += 1;
        if (chunks === 1) {
          this.options.logger.info("tts.first_chunk", {
            durationMs: Math.round(performance.now() - started),
          });
        }
        return onChunk({ samples, sampleRate: tts.sampleRate }) !== false;
      },
    });
    if (chunks === 0 && audio.samples.length > 0) {
      onChunk(audio);
      chunks = 1;
    }
    this.options.logger.info("tts.complete", {
      durationMs: Math.round(performance.now() - started),
      audioMs: Math.round((audio.samples.length / audio.sampleRate) * 1_000),
      chunks,
    });
  }

  public async stop(): Promise<void> {
    await this.pocketTts?.stop();
  }
}
