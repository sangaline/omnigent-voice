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
        kokoro: {
          model: findFile(ttsFiles, /^model.*\.onnx$/i, "TTS model"),
          voices: findFile(ttsFiles, /^voices\.bin$/i, "TTS voices"),
          tokens: findFile(ttsFiles, /^tokens\.txt$/i, "TTS tokens"),
          dataDir: join(options.ttsModelDir, "espeak-ng-data"),
          lengthScale: 1,
          lang: "en-us",
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
    const started = performance.now();
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16_000 });
    stream.inputFinished();
    while (this.recognizer.isReady(stream)) this.recognizer.decode(stream);
    const text = this.recognizer.getResult(stream).text?.trim() ?? "";
    this.options.logger.info("asr.final", {
      durationMs: Math.round(performance.now() - started),
      audioMs: Math.round((samples.length / 16_000) * 1_000),
      characters: text.length,
    });
    return text;
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
}
