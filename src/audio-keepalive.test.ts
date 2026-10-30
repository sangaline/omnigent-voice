import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmSilenceKeepalive } from "./audio-keepalive.js";

afterEach(() => vi.useRealTimers());

describe("PCM silence keepalive", () => {
  it("fills only an explicitly active gap and can resume for a later gap", async () => {
    vi.useFakeTimers();
    const frames: Buffer[] = [];
    const keepalive = new PcmSilenceKeepalive((frame) => frames.push(frame), 16, 20);

    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toHaveLength(0);

    keepalive.resume();
    await vi.advanceTimersByTimeAsync(61);
    keepalive.pause();
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.equals(Buffer.alloc(16)))).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toHaveLength(3);
    keepalive.resume();
    await vi.advanceTimersByTimeAsync(20);
    keepalive.close();
    expect(frames).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toHaveLength(4);
  });
});
