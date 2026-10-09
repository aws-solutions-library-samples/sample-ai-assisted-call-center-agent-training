import { beforeEach, describe, expect, it } from 'vitest';
import { SpeechTurnTracker } from './speechTurnTracker';

const SESSION_START = 1_000_000;
const at = (seconds: number) => SESSION_START + seconds * 1000;

describe('SpeechTurnTracker', () => {
  let tracker: SpeechTurnTracker;

  beforeEach(() => {
    tracker = new SpeechTurnTracker();
    tracker.setSessionStart(SESSION_START);
  });

  it('times a single speech segment', () => {
    tracker.onVad(true, at(2));
    tracker.onVad(false, at(4.5));

    expect(tracker.getAndReset(at(5))).toEqual({ startTime: 2, duration: 2.5 });
  });

  it('spans every segment of a turn that contains pauses', () => {
    // Regression: only the last segment was kept, so pauses mid-sentence
    // were counted as agent silence after Strands moved to one transcript per turn.
    tracker.onVad(true, at(55));
    tracker.onVad(false, at(58));
    tracker.onVad(true, at(59));
    tracker.onVad(false, at(62));
    tracker.onVad(true, at(65.4));
    tracker.onVad(false, at(66.7));

    expect(tracker.getAndReset(at(67.5))).toEqual({ startTime: 55, duration: 11.7 });
  });

  it('finalizes the span at pickup time if the trainee is still speaking', () => {
    tracker.onVad(true, at(10));
    tracker.onVad(false, at(11));
    tracker.onVad(true, at(12));

    expect(tracker.getAndReset(at(14))).toEqual({ startTime: 10, duration: 4 });
  });

  it('starts a fresh span after each pickup', () => {
    tracker.onVad(true, at(1));
    tracker.onVad(false, at(3));
    tracker.getAndReset(at(3.5));

    tracker.onVad(true, at(20));
    tracker.onVad(false, at(21));

    expect(tracker.getAndReset(at(22))).toEqual({ startTime: 20, duration: 1 });
  });

  it('returns null when there was no speech since the last pickup', () => {
    tracker.onVad(true, at(1));
    tracker.onVad(false, at(2));
    tracker.getAndReset(at(3));

    expect(tracker.getAndReset(at(4))).toBeNull();
  });

  it('ignores a speech-end event without a matching start', () => {
    tracker.onVad(false, at(5));

    expect(tracker.getAndReset(at(6))).toBeNull();
  });

  it('returns null and clears pending speech when the session start is unset', () => {
    tracker.onVad(true, at(1));
    tracker.onVad(false, at(2));
    tracker.setSessionStart(null);

    expect(tracker.getAndReset(at(3))).toBeNull();
  });
});
