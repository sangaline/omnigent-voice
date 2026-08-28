import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { OfflineTts, OnlineRecognizer } from "sherpa-onnx-node";
import { Logger } from "./log.js";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node") as typeof import("sherpa-onnx-node");

interface SpeechOptions {
  asrModelDir: string;
  ttsModelDir: string;
  asrThreads: number;
  ttsThreads: number;
  ttsSpeakerId: number;
  ttsSpeed: number;
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
  private finished = false;

  public constructor(
    private readonly recognizer: OnlineRecognizer,
    private readonly logger: Logger,
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
    if (decoded && !this.firstPartialLogged) {
      const partial = this.recognizer.getResult(this.stream).text?.trim() ?? "";
      if (partial) {
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
    private readonly tts: OfflineTts,
    private readonly options: SpeechOptions,
  ) {}

  public static async create(options: SpeechOptions): Promise<LocalSpeech> {
    requireDirectory(options.asrModelDir, "SHERPA_ASR_MODEL_DIR");
    requireDirectory(options.ttsModelDir, "SHERPA_TTS_MODEL_DIR");
    const asrFiles = walkFiles(options.asrModelDir);
    const ttsFiles = walkFiles(options.ttsModelDir);
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

    const tts = await sherpa.OfflineTts.createAsync({
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
    options.logger.info("speech.models.ready", {
      sherpaVersion: sherpa.version,
      ttsSpeakers: tts.numSpeakers,
      ttsSampleRate: tts.sampleRate,
    });
    return new LocalSpeech(recognizer, tts, options);
  }

  public transcribe(samples: Float32Array): string {
    const transcription = this.createTranscription();
    transcription.accept(samples);
    return transcription.finish().text;
  }

  public createTranscription(): StreamingTranscription {
    return new StreamingTranscription(this.recognizer, this.options.logger);
  }

  public async synthesize(text: string): Promise<SynthesizedAudio> {
    const started = performance.now();
    this.options.logger.info("tts.started", { characters: text.length });
    const audio = await this.tts.generateAsync({
      text,
      sid: this.options.ttsSpeakerId,
      speed: this.options.ttsSpeed,
    });
    this.options.logger.info("tts.complete", {
      durationMs: Math.round(performance.now() - started),
      audioMs: Math.round((audio.samples.length / audio.sampleRate) * 1_000),
    });
    return audio;
  }

  public async synthesizeStreaming(
    text: string,
    onChunk: (audio: SynthesizedAudio) => boolean | void,
  ): Promise<void> {
    const started = performance.now();
    let chunks = 0;
    this.options.logger.info("tts.started", { characters: text.length });
    const audio = await this.tts.generateAsync({
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
        return onChunk({ samples, sampleRate: this.tts.sampleRate }) !== false;
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
}
