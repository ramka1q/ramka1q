import type { Note } from '../types';

export const TIMING_EPSILON = 1e-9;

export interface HittableNoteMatch {
  note: Note;
  index: number;
  /** note.time - currentTime; negative means the note is late. */
  offset: number;
}

export interface HoldScoreConfig {
  tickSeconds: number;
  pointsPerTick: number;
}

export const DEFAULT_HOLD_SCORE_CONFIG: Readonly<HoldScoreConfig> = Object.freeze({
  tickSeconds: 0.05,
  pointsPerTick: 6,
});

/** Returns the closest pending note in the requested lane and inclusive hit window. */
export const findClosestHittableNote = (
  notes: readonly Note[],
  lane: number,
  currentTime: number,
  hitWindowSeconds: number,
): HittableNoteMatch | null => {
  if (!Number.isInteger(lane) || lane < 0 || lane > 3) {
    throw new RangeError('lane must be an integer from 0 to 3');
  }
  if (!Number.isFinite(currentTime)) throw new RangeError('currentTime must be finite');
  if (!Number.isFinite(hitWindowSeconds) || hitWindowSeconds < 0) {
    throw new RangeError('hitWindowSeconds must be a non-negative finite number');
  }

  let best: HittableNoteMatch | null = null;
  let bestAbsoluteOffset = Infinity;

  notes.forEach((note, index) => {
    if (note.lane !== lane || note.hit || note.missed || !Number.isFinite(note.time)) return;
    const offset = note.time - currentTime;
    const absoluteOffset = Math.abs(offset);
    if (absoluteOffset > hitWindowSeconds + TIMING_EPSILON) return;

    const isCloser = absoluteOffset < bestAbsoluteOffset - TIMING_EPSILON;
    const isEarlierTie = Math.abs(absoluteOffset - bestAbsoluteOffset) <= TIMING_EPSILON
      && best !== null
      && note.time < best.note.time;
    if (best === null || isCloser || isEarlierTie) {
      best = { note, index, offset };
      bestAbsoluteOffset = absoluteOffset;
    }
  });

  return best;
};

/**
 * Returns the total score earned by a continuously held note up to heldSeconds.
 * Callers award `newTotal - previousTotal`, making the result independent of FPS.
 */
export const cumulativeHoldScore = (
  heldSeconds: number,
  config: Readonly<HoldScoreConfig> = DEFAULT_HOLD_SCORE_CONFIG,
): number => {
  if (!Number.isFinite(heldSeconds)) throw new RangeError('heldSeconds must be finite');
  if (!Number.isFinite(config.tickSeconds) || config.tickSeconds <= 0) {
    throw new RangeError('tickSeconds must be a positive finite number');
  }
  if (!Number.isFinite(config.pointsPerTick) || config.pointsPerTick < 0) {
    throw new RangeError('pointsPerTick must be a non-negative finite number');
  }
  if (heldSeconds <= 0) return 0;

  const completedTicks = Math.floor((heldSeconds + TIMING_EPSILON) / config.tickSeconds);
  return completedTicks * config.pointsPerTick;
};
