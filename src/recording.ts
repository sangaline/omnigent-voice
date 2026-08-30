export const MIN_RECORDING_PEAK = 0.002;

/**
 * Smart Turn's positive result is the only endpoint that establishes a
 * complete semantic turn. A fallback can land just before Discord opens the
 * continuation receive stream, so retain the ordinary merge grace for it.
 */
export const transcriptMergeDelay = (
  endpointReason: string,
  utteranceMergeMs: number,
  transcript = "",
  continuationMs = 700,
): number => {
  const semanticDelay = endpointReason === "smart_turn" ? 0 : utteranceMergeMs;
  const contentFreeActionPreamble =
    /^(?:(?:okay|ok|uh|um|hey|please)[,!.]?\s+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?send\s+(?:a\s+)?message(?:\s+for\s+me)?[?.!\s]*$/i.test(
      transcript.trim(),
    );
  return contentFreeActionPreamble
    ? Math.max(semanticDelay, continuationMs)
    : semanticDelay;
};

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
