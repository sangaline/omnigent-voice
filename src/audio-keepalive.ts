export class PcmSilenceKeepalive {
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly frame: Buffer;

  public constructor(
    private readonly write: (frame: Buffer) => void,
    frameBytes: number,
    private readonly intervalMs: number,
  ) {
    if (!Number.isSafeInteger(frameBytes) || frameBytes < 1) {
      throw new Error("Silence keepalive frame size must be positive");
    }
    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
      throw new Error("Silence keepalive interval must be positive");
    }
    this.frame = Buffer.alloc(frameBytes);
  }

  public resume(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.write(this.frame), this.intervalMs);
    this.timer.unref();
  }

  public pause(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public close(): void {
    this.pause();
    this.closed = true;
  }
}
