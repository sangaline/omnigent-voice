import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechSegmentBatcher } from "./speech-batcher.js";

afterEach(() => vi.useRealTimers());

describe("speech segment batching", () => {
  it("renders adjacent completion segments as one utterance", async () => {
    vi.useFakeTimers();
    const rendered: string[] = [];
    const batcher = new SpeechSegmentBatcher(async (text) => {
      rendered.push(text);
    });

    batcher.enqueue("The first sentence.");
    batcher.enqueue("The second sentence.");
    await batcher.finish();

    expect(rendered).toEqual(["The first sentence. The second sentence."]);
  });

  it("preserves early streaming when later content arrives after the grace window", async () => {
    vi.useFakeTimers();
    const rendered: string[] = [];
    const batcher = new SpeechSegmentBatcher(async (text) => {
      rendered.push(text);
    });

    batcher.enqueue("The first sentence.");
    await vi.advanceTimersByTimeAsync(15);
    batcher.enqueue("The second sentence.");
    await batcher.finish();

    expect(rendered).toEqual(["The first sentence.", "The second sentence."]);
  });

  it("drops buffered speech when playback is cancelled", async () => {
    vi.useFakeTimers();
    const render = vi.fn<(_: string) => Promise<void>>().mockResolvedValue();
    const batcher = new SpeechSegmentBatcher(render);

    batcher.enqueue("Do not play this.");
    batcher.cancel();
    await vi.runAllTimersAsync();

    expect(render).not.toHaveBeenCalled();
  });
});
