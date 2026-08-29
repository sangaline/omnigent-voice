declare module "sherpa-onnx-node" {
  interface OnlineStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  }

  export class OnlineRecognizer {
    public constructor(config: Record<string, unknown>);
    public createStream(): OnlineStream;
    public isReady(stream: OnlineStream): boolean;
    public decode(stream: OnlineStream): void;
    public getResult(stream: OnlineStream): { text?: string };
  }

  export class OfflineTts {
    public readonly numSpeakers: number;
    public readonly sampleRate: number;
    public static createAsync(config: Record<string, unknown>): Promise<OfflineTts>;
    public generateAsync(input: {
      text: string;
      sid: number;
      speed: number;
      onProgress?: (info: { samples: Float32Array; progress: number }) =>
        | number
        | boolean
        | void;
    }): Promise<{ samples: Float32Array; sampleRate: number }>;
  }

  export class Vad {
    public constructor(config: Record<string, unknown>, bufferSizeInSeconds: number);
    public acceptWaveform(samples: Float32Array): void;
    public isEmpty(): boolean;
    public isDetected(): boolean;
    public pop(): void;
    public clear(): void;
    public reset(): void;
    public flush(): void;
  }

  export const version: string;
}
