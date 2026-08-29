import { concatFloat32, resampleLinear } from "./audio.js";
import { Logger } from "./log.js";
import { LocalSpeech } from "./speech.js";
import {
  KameS2SRuntime,
  DelayedS2SInput,
  S2SAudioGate,
  guidanceWordRecall,
  s2sCompletionTimeoutMs,
} from "./s2s.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface SmokeCase {
  id: string;
  input: string;
  guidance: string;
}

const cases: SmokeCase[] = [
  {
    id: "status",
    input: "What is the current status?",
    guidance: "The voice experiment is paused while I fix the audio.",
  },
  {
    id: "next_step",
    input: "What are you doing next?",
    guidance: "I am testing the response offline before reconnecting Discord.",
  },
  {
    id: "confirmation",
    input: "Is the unsafe version still running?",
    guidance: "No. The Discord bot is fully offline.",
  },
  {
    id: "longer_explanation",
    input: "Can you explain the plan in a little more detail?",
    guidance:
      "I am delaying model input just enough for verified guidance to arrive, then opening audio only for that response and closing it again at the natural turn boundary.",
  },
];

const logger = new Logger("warn");
const speech = await LocalSpeech.create({
  asrModelDir: process.env.SHERPA_ASR_MODEL_DIR ?? "/opt/models/asr",
  ttsModelDir: process.env.SHERPA_TTS_MODEL_DIR ?? "/opt/models/tts",
  asrThreads: 4,
  ttsThreads: 4,
  ttsSpeakerId: 0,
  ttsSpeed: 1,
  logger,
});
const runtime = new KameS2SRuntime({
  executable: process.env.KAME_BRIDGE_PATH ?? "/opt/omnigent-voice/bin/kame-bridge",
  configPath: required("KAME_CONFIG_PATH"),
  modelPath: required("KAME_MODEL_PATH"),
  mimiPath: required("KAME_MIMI_PATH"),
  tokenizerPath: required("KAME_TOKENIZER_PATH"),
  device: process.env.KAME_DEVICE ?? "Vulkan0",
  contextFrames: Number(process.env.KAME_CONTEXT_FRAMES ?? "3000"),
  depthTemperature: Number(process.env.KAME_DEPTH_TEMPERATURE ?? "0.8"),
  textTemperature: Number(process.env.KAME_TEXT_TEMPERATURE ?? "0.7"),
  logger,
});

const results: Array<Record<string, boolean | number | string>> = [];
try {
  const ready = await runtime.start();
  const frameMs = 1_000 / ready.frameRate;
  const inputDelayMs = Number(process.env.KAME_INPUT_DELAY_MS ?? "560");
  const guidanceProcessingMs = Number(process.env.KAME_GUIDANCE_PROCESSING_MS ?? "200");

  const requestedCase = process.env.KAME_SMOKE_CASE?.trim();
  const selectedCases = requestedCase
    ? cases.filter((testCase) => testCase.id === requestedCase)
    : cases;
  if (selectedCases.length === 0) throw new Error("KAME_SMOKE_CASE did not match a case");

  for (const testCase of selectedCases) {
    const synthesized = await speech.synthesize(testCase.input);
    const input = resampleLinear(synthesized.samples, synthesized.sampleRate, ready.sampleRate);
    const inputBuffer = new DelayedS2SInput();
    inputBuffer.push(input, performance.now() + inputDelayMs);
    let running = true;
    let resolveInput!: () => void;
    const inputComplete = new Promise<void>((resolve) => {
      resolveInput = resolve;
    });
    const clock = async (): Promise<void> => {
      let deadline = performance.now();
      while (running) {
        const frame = inputBuffer.take(ready.frameSize, performance.now());
        if (inputBuffer.samples === 0) resolveInput();
        runtime.sendAudio(frame);
        deadline += frameMs;
        await sleep(Math.max(0, deadline - performance.now()));
      }
    };
    const clockTask = clock();
    // Simulate final local ASR plus the fast Celeris round in wall time. The
    // native model is intentionally behind by inputDelayMs, so guidance lands
    // before it observes the caller's endpoint.
    await sleep((input.length / ready.sampleRate) * 1_000 + guidanceProcessingMs);

    const output: Float32Array[] = [];
    const gate = new S2SAudioGate();
    const unsubscribe = runtime.subscribeAudio((audio) => {
      if (gate.isOpen) output.push(audio.slice());
    });
    const timeoutMs = s2sCompletionTimeoutMs(testCase.guidance);
    const started = performance.now();
    let speechStartedMs: number | undefined;
    const runGuidance = async (startTimeoutMs: number): Promise<boolean> => {
      const generation = gate.begin();
      const completion = runtime.waitForSpeechTurn({
        startTimeoutMs,
        completionTimeoutMs: timeoutMs,
        onStarted: () => {
          speechStartedMs ??= performance.now() - started;
          gate.open(generation);
        },
      });
      runtime.guide(testCase.guidance, true);
      const completed = await completion;
      gate.close(generation);
      return completed;
    };
    let attempts = 1;
    let completedPromise = runGuidance(3_000);
    await inputComplete;
    let completed = await completedPromise;
    if (!completed && speechStartedMs === undefined) {
      attempts += 1;
      const retry = await speech.synthesize("Could you answer that?");
      inputBuffer.clear();
      inputBuffer.push(
        resampleLinear(retry.samples, retry.sampleRate, ready.sampleRate),
        performance.now(),
      );
      completedPromise = runGuidance(5_000);
      completed = await completedPromise;
    }
    const completionMs = performance.now() - started;
    unsubscribe();
    // Keep advancing the full-duplex model through inter-turn silence. Pausing
    // stdin here freezes KAME in its just-finished turn and makes the next case
    // unlike the continuously clocked Discord runtime.
    await sleep(2_000);
    running = false;
    await clockTask;

    const captured = concatFloat32(output);
    const transcript = captured.length
      ? speech.transcribe(resampleLinear(captured, ready.sampleRate, 16_000))
      : "";
    const recall = guidanceWordRecall(testCase.guidance, transcript);
    results.push({
      id: testCase.id,
      attempts,
      completed,
      guidanceToSpeechMs: Math.round(speechStartedMs ?? -1),
      guidanceToCompletionMs: Math.round(completionMs),
      endpointToSpeechMs: Math.round(
        speechStartedMs === undefined ? -1 : guidanceProcessingMs + speechStartedMs,
      ),
      audioMs: Math.round((captured.length / ready.sampleRate) * 1_000),
      guidanceWordRecall: Number(recall.toFixed(3)),
      transcript,
      pass: completed && captured.length > 0 && recall >= 0.6,
    });
  }
} finally {
  await runtime.stop();
}

const passed = results.every((result) => result.pass === true);
console.log(JSON.stringify({ passed, results }));
if (!passed) process.exitCode = 1;
