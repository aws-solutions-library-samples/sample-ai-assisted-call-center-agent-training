export interface SpeechTiming {
  startTime: number;  // seconds from session start
  duration: number;   // seconds
}

/**
 * Tracks trainee speech timing from VAD events for the enriched transcript.
 *
 * A turn can contain several VAD segments (pauses mid-sentence), and Strands
 * emits one transcript per turn, so a turn spans from the start of its first
 * segment to the end of its last.
 */
export class SpeechTurnTracker {
  private sessionStartMs: number | null = null;
  private speechStartMs: number | null = null;
  private turnSpanMs: { startMs: number; endMs: number } | null = null;

  setSessionStart(sessionStartMs: number | null): void {
    this.sessionStartMs = sessionStartMs;
    this.speechStartMs = null;
    this.turnSpanMs = null;
  }

  onVad(speaking: boolean, nowMs: number): void {
    if (speaking) {
      this.speechStartMs = nowMs;
    } else if (this.speechStartMs !== null) {
      this.extendSpan(nowMs);
    }
  }

  /** Return the timing of the turn so far and reset for the next turn. */
  getAndReset(nowMs: number): SpeechTiming | null {
    // If currently speaking, finalize the span up to now
    if (this.speechStartMs !== null) {
      this.extendSpan(nowMs);
    }

    const span = this.turnSpanMs;
    this.turnSpanMs = null;
    if (!span || this.sessionStartMs === null) return null;
    return {
      startTime: (span.startMs - this.sessionStartMs) / 1000,
      duration: (span.endMs - span.startMs) / 1000,
    };
  }

  private extendSpan(endMs: number): void {
    const startMs = this.turnSpanMs?.startMs ?? (this.speechStartMs as number);
    this.turnSpanMs = { startMs, endMs };
    this.speechStartMs = null;
  }
}
