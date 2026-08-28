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
  resampleLinear,
  stereoPcm16ToMono16k,
} from "./audio.js";
import { CelerisConversation } from "./celeris.js";
import { OmnigentCoordinator } from "./coordinator.js";
import { isCancelCommand } from "./control.js";
import { Logger } from "./log.js";
import { LocalSpeech } from "./speech.js";

interface DiscordVoiceOptions {
  token: string;
  guildId?: string | undefined;
  voiceChannelId?: string | undefined;
  allowedUserId?: string | undefined;
  silenceMs: number;
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
  private connection?: VoiceConnection;
  private turnTail: Promise<void> = Promise.resolve();
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
    this.options.logger.info("discord.voice.ready");
  }

  public async stop(): Promise<void> {
    this.shuttingDown = true;
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

    this.playbackEpoch += 1;
    this.player.stop(true);
    this.recordingUsers.add(userId);
    const started = performance.now();
    this.options.logger.info("speech.started");
    const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    const transcription = this.options.speech.createTranscription();
    const stream = this.connection!.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.options.silenceMs,
      },
    });
    stream.on("data", (packet: Buffer) => {
      try {
        transcription.accept(stereoPcm16ToMono16k(decoder.decode(packet)));
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
      void this.handleRecording(result.text, result.audioMs, result.peakAmplitude);
    };
    stream.once("end", finalize);
    stream.once("close", finalize);
  }

  private async handleRecording(
    transcript: string,
    audioMs: number,
    peak: number,
  ): Promise<void> {
    if (audioMs < 250 || peak < 0.002) {
      this.options.logger.debug("speech.ignored", { audioMs });
      return;
    }
    if (!transcript) return;

    this.options.logger.info("conversation.user.recognized", {
      text: transcript,
      audioMs,
    });
    this.responseEpoch += 1;
    this.player.stop(true);
    const epoch = this.responseEpoch;

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

  private async speak(text: string, epoch: number, retry = 0): Promise<void> {
    if (!text || !(await this.waitForRecordingToSettle(epoch))) return;
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
      if (epoch !== this.responseEpoch) return;
      if (playbackEpoch !== this.playbackEpoch) {
        if (retry < 2 && (await this.waitForRecordingToSettle(epoch))) {
          this.options.logger.info("tts.playback.retry", { retry: retry + 1 });
          await this.speak(text, epoch, retry + 1);
        }
        return;
      }
      if (playbackStarted === undefined) return;
      await entersState(this.player, AudioPlayerStatus.Idle, 15 * 60_000);
      if (playbackEpoch !== this.playbackEpoch) return;
      this.options.logger.info("discord.playback.finished", {
        durationMs: Math.round(performance.now() - playbackStarted),
      });
    } catch (error) {
      stream.destroy();
      this.options.logger.error("tts.playback.failed", error);
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
