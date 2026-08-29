export const MIN_RECORDING_PEAK = 0.002;

export interface RecordingLease {
  confirm(): boolean;
  close(): boolean;
}

/**
 * Tracks only receive streams that have carried meaningful audio. Discord can
 * open a second stream containing a few zero samples after a caller stops; a
 * provisional lease must not hold transcript delivery open while that stream
 * waits for its silence timeout.
 */
export class ConfirmedRecordingTracker {
  private readonly active = new Set<symbol>();

  public get size(): number {
    return this.active.size;
  }

  public createLease(): RecordingLease {
    const id = Symbol("discord-recording");
    let confirmed = false;
    let closed = false;

    return {
      confirm: (): boolean => {
        if (closed || confirmed) return false;
        confirmed = true;
        this.active.add(id);
        return true;
      },
      close: (): boolean => {
        if (closed) return false;
        closed = true;
        return confirmed && this.active.delete(id);
      },
    };
  }
}
