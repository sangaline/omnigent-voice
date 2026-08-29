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
} from "./audio.js";
import { CelerisConversation } from "./celeris.js";
import { CoordinatorUpdate, OmnigentCoordinator } from "./coordinator.js";
import { isCancelCommand } from "./control.js";
import { Logger } from "./log.js";
import { LocalSpeech } from "./speech.js";

interface DiscordVoiceOptions {
  token: string;
  guildId?: string | undefined;
  voiceChannelId?: string | undefined;
  allowedUserId?: string | undefined;
  silenceMs: number;
  utteranceMergeMs: number;
  bargeInPeak: number;
  logger: Logger;
  speech: LocalSpeech;
  coordinator: OmnigentCoordinator;
  celeris: CelerisConversation;
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
  private notificationAbort: AbortController | undefined;
  private unsubscribeCoordinator?: () => void;
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
    this.unsubscribeCoordinator = this.options.coordinator.subscribeUpdates((update) => {
      this.queueCoordinatorUpdate(update);
    });
    this.options.logger.info("discord.voice.ready");
  }

  public async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationAbort?.abort();
    this.unsubscribeCoordinator?.();
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
    let inputEpoch: number | undefined;
    const stream = this.connection!.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.options.silenceMs,
      },
    });
    stream.on("data", (packet: Buffer) => {
      try {
        const samples = stereoPcm16ToMono16k(decoder.decode(packet));
        transcription.accept(samples);
        const packetPeak = peakAmplitude(samples);
        if (inputEpoch === undefined && packetPeak >= this.options.bargeInPeak) {
          const interruptedPlayback = this.player.state.status !== AudioPlayerStatus.Idle;
          inputEpoch = ++this.responseEpoch;
          this.playbackEpoch += 1;
          this.player.stop(true);
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
      this.playbackEpoch += 1;
      this.player.stop(true);
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
    }, this.options.utteranceMergeMs);
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
    this.player.stop(true);
    try {
      if (isCancelCommand(transcript)) {
        try {
          const interrupted = await this.options.coordinator.interruptFocused();
          await this.speak(interrupted ? "Stopped." : "Nothing is running.", epoch);
        } catch (error) {
          this.options.logger.error("omnigent.interrupt.failed", error);
          await this.speak("I couldn't stop it cleanly.", epoch);
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
      await this.speak(spoken, epoch);
    } catch (error) {
      this.options.logger.error("voice.turn.failed", error);
      if (epoch === this.responseEpoch) {
        await this.speak("I couldn't reach the coordination layer.", epoch);
      }
    }
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

  private scheduleCoordinatorNotification(): void {
    if (
      this.shuttingDown ||
      this.pendingCoordinatorUpdates.length === 0 ||
      this.notificationTimer
    ) {
      return;
    }
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      void this.processCoordinatorNotification();
    }, 250);
  }

  private async processCoordinatorNotification(): Promise<void> {
    if (
      this.shuttingDown ||
      this.recordingUsers.size > 0 ||
      this.activeUserTurns > 0 ||
      this.player.state.status !== AudioPlayerStatus.Idle
    ) {
      this.scheduleCoordinatorNotification();
      return;
    }
    const updates = this.pendingCoordinatorUpdates.splice(0);
    const controller = new AbortController();
    this.notificationAbort = controller;
    const epoch = this.responseEpoch;
    try {
      const spoken = await this.options.celeris.announceUpdate(updates, controller.signal);
      if (!spoken || controller.signal.aborted || epoch !== this.responseEpoch) return;
      this.options.logger.info("conversation.assistant.generated", {
        text: spoken,
        superseded: false,
        source: "background_update",
      });
      if (await this.speak(spoken, epoch)) {
        this.options.celeris.acknowledgeSpokenUpdates(updates, spoken);
      }
    } finally {
      if (this.notificationAbort === controller) this.notificationAbort = undefined;
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
