export class SpeechSegmentBatcher {
  private readonly pending: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(
    private readonly render: (text: string) => Promise<void>,
    private readonly coalesceMs = 15,
  ) {
    if (coalesceMs < 0) throw new Error("Speech segment coalescing cannot be negative");
  }

  public enqueue(text: string): void {
    const segment = text.trim();
    if (!segment || this.closed) return;
    this.pending.push(segment);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushPending();
    }, this.coalesceMs);
  }

  public async finish(): Promise<void> {
    if (this.closed) return this.tail;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flushPending();
    this.closed = true;
    await this.tail;
  }

  public cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.splice(0);
    this.closed = true;
  }

  private flushPending(): void {
    if (this.pending.length === 0 || this.closed) return;
    const speech = this.pending.splice(0).join(" ");
    this.tail = this.tail.then(() => this.render(speech));
  }
}
