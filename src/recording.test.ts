import { describe, expect, it } from "vitest";
import { ConfirmedRecordingTracker } from "./recording.js";

describe("confirmed Discord recording tracking", () => {
  it("does not let an empty provisional stream block transcript delivery", () => {
    const tracker = new ConfirmedRecordingTracker();
    const emptyStream = tracker.createLease();

    expect(tracker.size).toBe(0);
    expect(emptyStream.close()).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("tracks meaningful streams from first audio through close", () => {
    const tracker = new ConfirmedRecordingTracker();
    const recording = tracker.createLease();

    expect(recording.confirm()).toBe(true);
    expect(recording.confirm()).toBe(false);
    expect(tracker.size).toBe(1);
    expect(recording.close()).toBe(true);
    expect(recording.close()).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("tracks overlapping confirmed streams independently", () => {
    const tracker = new ConfirmedRecordingTracker();
    const first = tracker.createLease();
    const second = tracker.createLease();

    first.confirm();
    second.confirm();
    expect(tracker.size).toBe(2);
    first.close();
    expect(tracker.size).toBe(1);
    second.close();
    expect(tracker.size).toBe(0);
  });
});
