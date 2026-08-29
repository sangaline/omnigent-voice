import { PassThrough } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  VoiceChannel,
} from "discord.js";
import OpusScript from "opusscript";
import {
  monoFloatToStereoPcm16,
  peakAmplitude,
  resampleLinear,
  stereoPcm16ToMono16k,
  stereoPcm16ToMono24k,
} from "./audio.js";
import { CelerisConversation } from "./celeris.js";
import { CoordinatorUpdate, OmnigentCoordinator } from "./coordinator.js";
import { isCancelCommand } from "./control.js";
import { SemanticEndpointRuntime, TailAudioBuffer } from "./endpoint.js";
import { Logger } from "./log.js";
import { shouldScheduleCoordinatorNotification } from "./notification.js";
import { LocalSpeech } from "./speech.js";
import {
  KameS2SRuntime,
  DelayedS2SInput,
  S2SAudioGate,
  s2sCompletionTimeoutMs,
} from "./s2s.js";

interface DiscordVoiceOptions {
  token: string;
  guildId?: string | undefined;
  voiceChannelId?: string | undefined;
  allowedUserId?: string | undefined;
  silenceMs: number;
  utteranceMergeMs: number;
  bargeInPeak: number;
  endpointFallbackMs: number;
  endpoint?: SemanticEndpointRuntime | undefined;
  s2sInputDelayMs: number;
  logger: Logger;
  speech: LocalSpeech;
  coordinator: OmnigentCoordinator;
  celeris: CelerisConversation;
  s2s?: KameS2SRuntime | undefined;
}

export class DiscordVoiceBot {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  private readonly player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  private readonly recordingUsers = new Set<string>();
  private readonly recordingSettledWaiters = new Set<() => void>();
  private readonly pendingCoordinatorUpdates: CoordinatorUpdate[] = [];
  private connection?: VoiceConnection;
  private turnTail: Promise<void> = Promise.resolve();
  private pendingTranscript = "";
  private pendingTranscriptAudioMs = 0;
  private pendingTranscriptEpoch = 0;
  private transcriptTimer: NodeJS.Timeout | undefined;
  private notificationTimer: NodeJS.Timeout | undefined;
  private notificationInFlight = false;
  private notificationAbort: AbortController | undefined;
  private unsubscribeCoordinator?: () => void;
  private unsubscribeS2SAudio?: () => void;
  private s2sTimer?: NodeJS.Timeout | undefined;
  private s2sOutput: PassThrough | undefined;
  private readonly s2sInput = new DelayedS2SInput();
  private s2sResponseAbort: AbortController | undefined;
  private s2sResponseActive = false;
  private readonly s2sOutputGate = new S2SAudioGate();
  private activeUserTurns = 0;
  private responseEpoch = 0;
  private playbackEpoch = 0;
  private shuttingDown = false;

  public constructor(private readonly options: DiscordVoiceOptions) {}

  public async start(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => reject(error);
      this.client.once(Events.Error, fail);
      this.client.once(Events.ClientReady, () => {
        this.client.off(Events.Error, fail);
        resolve();
      });
    });
    await this.client.login(this.options.token);
    await ready;
    const channel = await this.resolveVoiceChannel();
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection.subscribe(this.player);
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.connection.receiver.speaking.on("start", (userId) => {
      this.onSpeakingStart(userId);
    });
    this.connection.on("stateChange", (_oldState, newState) => {
      this.options.logger.info("discord.voice.state", { status: newState.status });
    });
    this.player.on("error", (error) => {
      this.options.logger.error("discord.playback.failed", error);
    });
    this.player.on("stateChange", (_oldState, newState) => {
      this.options.logger.info("discord.playback.state", {
        status: newState.status,
        runtime: this.options.s2s ? "kame" : "staged",
      });
    });
    if (this.options.s2s) this.startS2SLoop();
    this.unsubscribeCoordinator = this.options.coordinator.subscribeUpdates((update) => {
      this.queueCoordinatorUpdate(update);
    });
    this.options.logger.info("discord.voice.ready");
  }

  public async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    if (this.s2sTimer) clearTimeout(this.s2sTimer);
    this.notificationAbort?.abort();
    this.s2sResponseAbort?.abort();
    this.s2sOutputGate.close();
    this.unsubscribeCoordinator?.();
    this.unsubscribeS2SAudio?.();
    this.s2sOutput?.end();
    this.playbackEpoch += 1;
    this.player.stop(true);
    this.connection?.destroy();
    this.client.destroy();
    this.notifyRecordingSettled();
    await this.turnTail.catch(() => undefined);
  }

  private async resolveVoiceChannel(): Promise<VoiceChannel> {
    const guild = await this.resolveGuild();
    if (this.options.voiceChannelId) {
      const channel = await guild.channels.fetch(this.options.voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        throw new Error("DISCORD_VOICE_CHANNEL_ID is not a voice channel");
      }
      return channel;
    }
    const channels = await guild.channels.fetch();
    const voiceChannels = [...channels.values()].filter(
      (channel): channel is VoiceChannel => channel?.type === ChannelType.GuildVoice,
    );
    if (voiceChannels.length !== 1) {
      throw new Error(
        "DISCORD_VOICE_CHANNEL_ID is required unless the guild has exactly one voice channel",
      );
    }
    return voiceChannels[0]!;
  }

  private async resolveGuild(): Promise<Guild> {
    if (this.options.guildId) return this.client.guilds.fetch(this.options.guildId);
    const guilds = [...this.client.guilds.cache.values()];
    if (guilds.length !== 1) {
      throw new Error("DISCORD_GUILD_ID is required unless the bot is in exactly one guild");
    }
    return guilds[0]!;
  }

  private startS2SLoop(): void {
    const s2s = this.options.s2s!;
    this.unsubscribeS2SAudio = s2s.subscribeAudio((audio) => {
      const output = this.s2sOutput;
      if (
        this.shuttingDown ||
        !this.s2sOutputGate.isOpen ||
        !output ||
        output.destroyed ||
        output.writableEnded
      ) {
        return;
      }
      const pcm = monoFloatToStereoPcm16(
        resampleLinear(audio, s2s.ready.sampleRate, 48_000),
      );
      if (!output.write(pcm)) {
        this.options.logger.warn("s2s.output.backpressure", {
          queuedBytes: output.writableLength,
        });
      }
    });

    const intervalMs = 1_000 / s2s.ready.frameRate;
    let deadline = performance.now();
    const tick = (): void => {
      if (this.shuttingDown) return;
      const now = performance.now();
      if (now - deadline > intervalMs) {
        this.options.logger.warn("s2s.input.clock_late", {
          lateMs: Math.round(now - deadline),
        });
        deadline = now;
      }
      s2s.sendAudio(this.takeS2SInputFrame(s2s.ready.frameSize));
      deadline += intervalMs;
      this.s2sTimer = setTimeout(tick, Math.max(0, deadline - performance.now()));
    };
    tick();
    this.options.logger.info("discord.s2s.started", {
      frameMs: intervalMs,
    });
  }

  private beginS2SOutput(): PassThrough {
    // A Discord raw resource is intentionally scoped to one guided response.
    // @discordjs/voice destroys a playing resource after five missing 20 ms
    // frames, so a process-lifetime resource cannot survive KAME's gated idle
    // periods. A fresh buffering resource per transaction stays alive until
    // verified guided audio arrives and never needs unguided keepalive audio.
    this.s2sOutput?.end();
    const output = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.s2sOutput = output;
    this.player.play(createAudioResource(output, { inputType: StreamType.Raw }));
    return output;
  }

  private endS2SOutput(output: PassThrough): void {
    if (this.s2sOutput !== output) return;
    this.s2sOutput = undefined;
    output.end();
  }

  private queueS2SInput(
    samples: Float32Array,
    warnOnBacklog = true,
    delayMs = this.options.s2sInputDelayMs,
  ): void {
    if (!this.options.s2s || samples.length === 0) return;
    const now = performance.now();
    this.s2sInput.push(samples, now + delayMs);
    const lagMs = this.s2sInput.lagMs(now);
    if (warnOnBacklog && lagMs > 500) {
      this.options.logger.warn("s2s.input.audio_backlog", {
        queuedMs: Math.round(lagMs),
      });
    }
  }

  private takeS2SInputFrame(frameSize: number): Float32Array {
    return this.s2sInput.take(frameSize, performance.now());
  }

  private clearS2SInput(): void {
    this.s2sInput.clear();
  }

  private onSpeakingStart(userId: string): void {
    if (this.shuttingDown || this.recordingUsers.size > 0) return;
    if (userId === this.client.user?.id) return;
    if (this.options.allowedUserId && userId !== this.options.allowedUserId) return;

    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = undefined;
    }
    this.recordingUsers.add(userId);
    const started = performance.now();
    this.options.logger.info("speech.started");
    const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    const transcription = this.options.speech.createTranscription();
    const endpoint = this.options.endpoint;
    const vad = endpoint?.createVad();
    const endpointAudio = endpoint ? new TailAudioBuffer(8 * 16_000) : undefined;
    const vadWindow = new Float32Array(512);
    const vadSilence = new Float32Array(512);
    let vadWindowOffset = 0;
    let vadSpeaking = false;
    let speechGeneration = 0;
    let smartTurnRunning = false;
    let smartTurnQueued = false;
    let lastPacketAt = performance.now();
    let endpointReason = endpoint ? "hard_fallback" : "discord_silence";
    let endpointFallbackTimer: NodeJS.Timeout | undefined;
    let vadSilenceTimer: NodeJS.Timeout | undefined;
    let inputEpoch: number | undefined;
    const stream = this.connection!.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: endpoint ? this.options.endpointFallbackMs : this.options.silenceMs,
      },
    });

    const scheduleHardFallback = (): void => {
      if (!endpoint || endpointFallbackTimer) return;
      endpointFallbackTimer = setTimeout(() => {
        endpointFallbackTimer = undefined;
        if (finalized) return;
        endpointReason = "semantic_fallback";
        stream.destroy();
      }, Math.max(0, this.options.endpointFallbackMs - endpoint.vadSilenceMs));
    };

    const evaluateEndpoint = (): void => {
      if (!endpoint || !endpointAudio || finalized) return;
      while (vad && !vad.isEmpty()) vad.pop();
      scheduleHardFallback();
      if (smartTurnRunning) {
        smartTurnQueued = true;
        return;
      }
      smartTurnRunning = true;
      const generation = speechGeneration;
      const audio = endpointAudio.snapshot();
      void endpoint.smartTurn
        .predict(audio)
        .then((result) => {
          const stale = generation !== speechGeneration;
          this.options.logger.info("endpoint.smart_turn.result", {
            complete: result.complete,
            probability: Number(result.probability.toFixed(4)),
            durationMs: Math.round(result.durationMs),
            audioMs: Math.round((audio.length / 16_000) * 1_000),
            stale,
          });
          if (!finalized && !stale && result.complete) {
            endpointReason = "smart_turn";
            stream.destroy();
          }
        })
        .catch((error) => this.options.logger.error("endpoint.smart_turn.failed", error))
        .finally(() => {
          smartTurnRunning = false;
          if (smartTurnQueued && !finalized) {
            smartTurnQueued = false;
            evaluateEndpoint();
          }
        });
    };

    const acceptVad = (samples: Float32Array): void => {
      if (!vad) return;
      let offset = 0;
      while (offset < samples.length) {
        const count = Math.min(vadWindow.length - vadWindowOffset, samples.length - offset);
        vadWindow.set(samples.subarray(offset, offset + count), vadWindowOffset);
        vadWindowOffset += count;
        offset += count;
        if (vadWindowOffset !== vadWindow.length) continue;
        vad.acceptWaveform(vadWindow);
        vadWindowOffset = 0;
        const detected = vad.isDetected();
        if (detected && !vadSpeaking) {
          speechGeneration += 1;
          if (endpointFallbackTimer) clearTimeout(endpointFallbackTimer);
          endpointFallbackTimer = undefined;
        }
        vadSpeaking = detected;
        if (!vad.isEmpty()) evaluateEndpoint();
      }
    };

    if (endpoint) {
      vadSilenceTimer = setInterval(() => {
        if (finalized || performance.now() - lastPacketAt < 28) return;
        endpointAudio!.append(vadSilence);
        acceptVad(vadSilence);
      }, 32);
    }
    stream.on("data", (packet: Buffer) => {
      try {
        const decoded = decoder.decode(packet);
        const samples = stereoPcm16ToMono16k(decoded);
        lastPacketAt = performance.now();
        endpointAudio?.append(samples);
        acceptVad(samples);
        this.queueS2SInput(stereoPcm16ToMono24k(decoded));
        transcription.accept(samples);
        const packetPeak = peakAmplitude(samples);
        if (inputEpoch === undefined && packetPeak >= this.options.bargeInPeak) {
          const interruptedPlayback = this.options.s2s
            ? this.s2sOutputGate.isOpen
            : this.player.state.status !== AudioPlayerStatus.Idle;
          inputEpoch = ++this.responseEpoch;
          this.s2sResponseAbort?.abort();
          if (!this.options.s2s) {
            this.playbackEpoch += 1;
            this.player.stop(true);
          }
          if (this.options.s2s && this.notificationAbort) this.clearS2SInput();
          this.notificationAbort?.abort();
          this.options.logger.info("speech.voice.confirmed", {
            peakAmplitude: Number(packetPeak.toFixed(4)),
            interruptedPlayback,
          });
        }
      } catch (error) {
        this.options.logger.error("discord.decode.failed", error);
      }
    });
    stream.once("error", (error) => {
      this.options.logger.error("discord.receive.failed", error);
    });
    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      if (endpointFallbackTimer) clearTimeout(endpointFallbackTimer);
      if (vadSilenceTimer) clearInterval(vadSilenceTimer);
      decoder.delete();
      this.recordingUsers.delete(userId);
      let result;
      try {
        result = transcription.finish();
      } catch (error) {
        this.options.logger.error("asr.failed", error);
        this.notifyRecordingSettled();
        return;
      }
      this.options.logger.info("speech.ended", {
        durationMs: Math.round(performance.now() - started),
        audioMs: result.audioMs,
        peakAmplitude: Number(result.peakAmplitude.toFixed(4)),
        endpoint: endpointReason,
      });
      this.notifyRecordingSettled();
      this.queueRecording(result.text, result.audioMs, result.peakAmplitude, inputEpoch);
    };
    stream.once("end", finalize);
    stream.once("close", finalize);
  }

  private queueRecording(
    transcript: string,
    audioMs: number,
    peak: number,
    inputEpoch?: number,
  ): void {
    if (audioMs < 250 || peak < 0.002) {
      this.options.logger.debug("speech.ignored", { audioMs });
      this.scheduleTranscriptFlush();
      return;
    }
    if (!transcript) {
      this.scheduleTranscriptFlush();
      return;
    }

    const epoch = inputEpoch ?? ++this.responseEpoch;
    if (inputEpoch === undefined) {
      if (!this.options.s2s) {
        this.playbackEpoch += 1;
        this.player.stop(true);
      }
      this.notificationAbort?.abort();
    }
    this.options.logger.info("conversation.user.segment", {
      text: transcript,
      audioMs,
    });
    this.pendingTranscript = `${this.pendingTranscript} ${transcript}`.trim();
    this.pendingTranscriptAudioMs += audioMs;
    this.pendingTranscriptEpoch = epoch;
    this.scheduleTranscriptFlush();
  }

  private scheduleTranscriptFlush(): void {
    if (!this.pendingTranscript || this.recordingUsers.size > 0 || this.shuttingDown) return;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = undefined;
      if (this.recordingUsers.size > 0 || this.shuttingDown) return;
      const transcript = this.pendingTranscript;
      const audioMs = this.pendingTranscriptAudioMs;
      const epoch = this.pendingTranscriptEpoch;
      this.pendingTranscript = "";
      this.pendingTranscriptAudioMs = 0;
      void this.handleUtterance(transcript, audioMs, epoch);
    }, this.options.endpoint ? 0 : this.options.utteranceMergeMs);
  }

  private async handleUtterance(
    transcript: string,
    audioMs: number,
    epoch: number,
  ): Promise<void> {
    this.activeUserTurns += 1;
    this.pendingCoordinatorUpdates.splice(0);
    this.notificationAbort?.abort();

    this.options.logger.info("conversation.user.recognized", {
      text: transcript,
      audioMs,
    });
    if (!this.options.s2s) this.player.stop(true);
    try {
      if (isCancelCommand(transcript)) {
        try {
          const interrupted = await this.options.coordinator.interruptFocused();
          await this.deliverSpeech(
            interrupted ? "Stopped." : "Nothing is running.",
            epoch,
          );
        } catch (error) {
          this.options.logger.error("omnigent.interrupt.failed", error);
          await this.deliverSpeech("I couldn't stop it cleanly.", epoch);
        }
        return;
      }

      this.turnTail = this.turnTail
        .then(() => this.processTurn(transcript, epoch))
        .catch((error) => this.options.logger.error("turn.failed", error));
      await this.turnTail;
    } finally {
      this.activeUserTurns -= 1;
      this.scheduleCoordinatorNotification();
    }
  }

  private async processTurn(transcript: string, epoch: number): Promise<void> {
    try {
      const spoken = await this.options.celeris.respond(transcript);
      this.options.logger.info("conversation.assistant.generated", {
        text: spoken,
        superseded: epoch !== this.responseEpoch,
      });
      if (epoch !== this.responseEpoch) return;
      await this.deliverSpeech(spoken, epoch);
    } catch (error) {
      this.options.logger.error("voice.turn.failed", error);
      if (epoch === this.responseEpoch) {
        await this.deliverSpeech("I couldn't reach the coordination layer.", epoch);
      }
    }
  }

  private async deliverSpeech(text: string, epoch: number): Promise<boolean> {
    if (!text || epoch !== this.responseEpoch) return false;
    if (this.options.s2s) {
      return this.guideS2S(text, epoch, false, undefined, undefined, true);
    }
    return this.speak(text, epoch);
  }

  private async guideS2S(
    text: string,
    epoch: number,
    waitForCompletion: boolean,
    parentSignal?: AbortSignal,
    timeouts?: { startMs: number; completionMs: number },
    allowSilentRetry = false,
  ): Promise<boolean> {
    const s2s = this.options.s2s;
    if (!s2s || !text || epoch !== this.responseEpoch || parentSignal?.aborted) {
      return false;
    }
    this.s2sResponseAbort?.abort();
    const outputGeneration = this.s2sOutputGate.begin();
    const output = this.beginS2SOutput();
    const controller = new AbortController();
    this.s2sResponseAbort = controller;
    const abort = (): void => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => {
        this.s2sOutputGate.close(outputGeneration);
        this.endS2SOutput(output);
      },
      { once: true },
    );
    this.s2sResponseActive = true;
    let playbackStarted: number | undefined;
    const completion = s2s.waitForSpeechTurn({
      signal: controller.signal,
      startTimeoutMs: timeouts?.startMs ?? 3_000,
      completionTimeoutMs: Math.min(
        timeouts?.completionMs ?? Number.POSITIVE_INFINITY,
        s2sCompletionTimeoutMs(text),
      ),
      onStarted: () => {
        if (!this.s2sOutputGate.open(outputGeneration)) return;
        playbackStarted = performance.now();
        this.options.logger.info("conversation.assistant.playback_started", {
          text,
          retry: 0,
          runtime: "kame",
        });
        this.options.logger.info("discord.playback.started", { runtime: "kame" });
      },
    });
    if (!s2s.guide(text, true)) controller.abort();

    const settle = async (): Promise<boolean> => {
      const completed = await completion;
      this.s2sOutputGate.close(outputGeneration);
      this.endS2SOutput(output);
      parentSignal?.removeEventListener("abort", abort);
      if (this.s2sResponseAbort === controller) {
        this.s2sResponseAbort = undefined;
        this.s2sResponseActive = false;
      }
      if (completed && playbackStarted !== undefined) {
        this.options.logger.info("discord.playback.finished", {
          durationMs: Math.round(performance.now() - playbackStarted),
          runtime: "kame",
        });
      } else if (playbackStarted !== undefined) {
        this.options.logger.info("discord.playback.interrupted", {
          runtime: "kame",
        });
      } else if (!controller.signal.aborted) {
        this.options.logger.warn("s2s.response.unconfirmed", {
          characters: text.length,
        });
      }
      if (
        allowSilentRetry &&
        !completed &&
        playbackStarted === undefined &&
        !controller.signal.aborted &&
        !parentSignal?.aborted &&
        epoch === this.responseEpoch
      ) {
        this.options.logger.warn("s2s.response.retry", { reason: "no_speech" });
        return this.retrySilentS2SResponse(text, epoch, parentSignal);
      }
      this.scheduleCoordinatorNotification();
      return completed;
    };
    if (waitForCompletion) return settle();
    void settle();
    return !controller.signal.aborted;
  }

  private async retrySilentS2SResponse(
    text: string,
    epoch: number,
    parentSignal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.options.s2s || parentSignal?.aborted || epoch !== this.responseEpoch) {
      return false;
    }
    this.clearS2SInput();
    let samples = 0;
    try {
      await this.options.speech.synthesizeStreaming("Could you answer that?", (audio) => {
        if (parentSignal?.aborted || epoch !== this.responseEpoch) return false;
        const trigger = resampleLinear(
          audio.samples,
          audio.sampleRate,
          this.options.s2s!.ready.sampleRate,
        );
        samples += trigger.length;
        this.queueS2SInput(trigger, false, 0);
        return true;
      });
    } catch (error) {
      this.options.logger.error("s2s.response.retry_trigger_failed", error);
      return false;
    }
    if (samples === 0 || parentSignal?.aborted || epoch !== this.responseEpoch) {
      return false;
    }
    return this.guideS2S(text, epoch, true, parentSignal, {
      startMs: 5_000,
      completionMs: s2sCompletionTimeoutMs(text),
    });
  }

  private async deliverProactiveSpeech(
    text: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.options.s2s) return this.speak(text, epoch);
    if (!(await this.waitForRecordingToSettle(epoch)) || signal.aborted) return false;
    this.clearS2SInput();
    let samples = 0;
    try {
      await this.options.speech.synthesizeStreaming(
        "Can you give me the update?",
        (audio) => {
          if (signal.aborted || epoch !== this.responseEpoch) return false;
          const trigger = resampleLinear(
            audio.samples,
            audio.sampleRate,
            this.options.s2s!.ready.sampleRate,
          );
          samples += trigger.length;
          // Guidance is already known for proactive turns. Queue the hidden
          // stimulus immediately, then install oracle text while that audio is
          // still entering KAME rather than waiting until its endpoint.
          this.queueS2SInput(trigger, false, 0);
          return true;
        },
      );
    } catch (error) {
      this.options.logger.error("s2s.proactive.trigger_failed", error);
      return false;
    }
    if (samples === 0 || signal.aborted || epoch !== this.responseEpoch) return false;
    this.options.logger.info("s2s.proactive.trigger_complete", {
      audioMs: Math.round((samples / this.options.s2s.ready.sampleRate) * 1_000),
    });
    return this.guideS2S(text, epoch, true, signal, {
      startMs: 5_000,
      completionMs: 30_000,
    });
  }

  private async speak(text: string, epoch: number, retry = 0): Promise<boolean> {
    if (!text || !(await this.waitForRecordingToSettle(epoch))) return false;
    const playbackEpoch = ++this.playbackEpoch;
    const stream = new PassThrough();
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    let playbackStarted: number | undefined;
    try {
      await this.options.speech.synthesizeStreaming(text, (audio) => {
        if (epoch !== this.responseEpoch || playbackEpoch !== this.playbackEpoch) return false;
        const pcm = monoFloatToStereoPcm16(
          resampleLinear(audio.samples, audio.sampleRate, 48_000),
        );
        stream.write(pcm);
        if (playbackStarted === undefined) {
          playbackStarted = performance.now();
          this.player.play(resource);
          this.options.logger.info("conversation.assistant.playback_started", {
            text,
            retry,
          });
          this.options.logger.info("discord.playback.started");
        }
        return true;
      });
      stream.end();
      if (epoch !== this.responseEpoch) return false;
      if (playbackEpoch !== this.playbackEpoch) {
        if (retry < 2 && (await this.waitForRecordingToSettle(epoch))) {
          this.options.logger.info("tts.playback.retry", { retry: retry + 1 });
          return this.speak(text, epoch, retry + 1);
        }
        return false;
      }
      if (playbackStarted === undefined) return false;
      await entersState(this.player, AudioPlayerStatus.Idle, 15 * 60_000);
      if (playbackEpoch !== this.playbackEpoch) {
        this.options.logger.info("discord.playback.interrupted", { retry });
        return false;
      }
      this.options.logger.info("discord.playback.finished", {
        durationMs: Math.round(performance.now() - playbackStarted),
      });
      return true;
    } catch (error) {
      stream.destroy();
      this.options.logger.error("tts.playback.failed", error);
      return false;
    }
  }

  private queueCoordinatorUpdate(update: CoordinatorUpdate): void {
    if (this.shuttingDown || this.recordingUsers.size > 0 || this.activeUserTurns > 0) return;
    this.pendingCoordinatorUpdates.push(update);
    this.scheduleCoordinatorNotification();
  }

  private scheduleCoordinatorNotification(delayMs = 250): void {
    if (!shouldScheduleCoordinatorNotification({
      shuttingDown: this.shuttingDown,
      pendingUpdates: this.pendingCoordinatorUpdates.length,
      timerActive: Boolean(this.notificationTimer),
      deliveryInFlight: this.notificationInFlight,
    })) {
      return;
    }
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      void this.processCoordinatorNotification();
    }, delayMs);
  }

  private async processCoordinatorNotification(): Promise<void> {
    if (this.notificationInFlight) return;
    if (
      this.shuttingDown ||
      this.recordingUsers.size > 0 ||
      this.activeUserTurns > 0 ||
      this.s2sResponseActive ||
      (!this.options.s2s && this.player.state.status !== AudioPlayerStatus.Idle)
    ) {
      this.scheduleCoordinatorNotification();
      return;
    }
    this.notificationInFlight = true;
    const updates = this.pendingCoordinatorUpdates.splice(0);
    const controller = new AbortController();
    this.notificationAbort = controller;
    const epoch = this.responseEpoch;
    this.options.logger.info("coordinator.notification.delivery_started", {
      updates: updates.length,
    });
    try {
      const spoken = await this.options.celeris.announceUpdate(updates, controller.signal);
      if (!spoken || controller.signal.aborted || epoch !== this.responseEpoch) return;
      this.options.logger.info("conversation.assistant.generated", {
        text: spoken,
        superseded: false,
        source: "background_update",
      });
      let delivered = await this.deliverProactiveSpeech(spoken, epoch, controller.signal);
      if (!delivered && !controller.signal.aborted && epoch === this.responseEpoch) {
        this.options.logger.warn("s2s.proactive.retry", { attempt: 1 });
        delivered = await this.deliverProactiveSpeech(spoken, epoch, controller.signal);
      }
      if (delivered) {
        this.options.celeris.acknowledgeSpokenUpdates(updates, spoken);
      } else if (!controller.signal.aborted && epoch === this.responseEpoch) {
        for (const update of updates.toReversed()) {
          if (!this.pendingCoordinatorUpdates.some((item) => item.event_id === update.event_id)) {
            this.pendingCoordinatorUpdates.unshift(update);
          }
        }
        this.options.logger.warn("s2s.proactive.requeued", { updates: updates.length });
        this.scheduleCoordinatorNotification(5_000);
      }
    } finally {
      if (this.notificationAbort === controller) this.notificationAbort = undefined;
      this.notificationInFlight = false;
      this.options.logger.info("coordinator.notification.delivery_finished", {
        pendingUpdates: this.pendingCoordinatorUpdates.length,
      });
      this.scheduleCoordinatorNotification();
    }
  }

  private async waitForRecordingToSettle(epoch: number): Promise<boolean> {
    while (
      !this.shuttingDown &&
      epoch === this.responseEpoch &&
      this.recordingUsers.size > 0
    ) {
      await new Promise<void>((resolve) => {
        const waiter = (): void => {
          this.recordingSettledWaiters.delete(waiter);
          resolve();
        };
        this.recordingSettledWaiters.add(waiter);
      });
    }
    return !this.shuttingDown && epoch === this.responseEpoch;
  }

  private notifyRecordingSettled(): void {
    if (this.recordingUsers.size > 0 && !this.shuttingDown) return;
    for (const waiter of [...this.recordingSettledWaiters]) waiter();
  }
}
