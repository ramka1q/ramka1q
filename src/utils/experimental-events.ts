import { EnergyData } from '../types';
import { energyAtTime } from './beatmap';

export type ExperimentalEventKind = 'lane-swap' | 'arrow-flight';

export interface ExperimentalEvent {
  id: string;
  time: number;
  duration: number;
  kind: ExperimentalEventKind;
  laneOrder: readonly [number, number, number, number];
}

const SAMPLE_STEP_SECONDS = 0.25;
const MIN_EVENT_TIME_SECONDS = 7;
const MIN_EVENT_GAP_SECONDS = 18;
const QUIET_LOOKAHEAD_SECONDS = 1.5;
const DEFAULT_LANE_ORDER = [0, 1, 2, 3] as const;
const LANE_ORDERS = [
  [3, 2, 1, 0],
  [1, 0, 3, 2],
  [2, 3, 0, 1],
] as const;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number) => {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
};

const sampleWindow = (
  energyData: readonly EnergyData[],
  startTime: number,
  endTime: number,
): { average: number; peak: number } => {
  let total = 0;
  let peak = 0;
  let count = 0;
  for (let time = startTime; time <= endTime + 1e-9; time += SAMPLE_STEP_SECONDS) {
    const energy = energyAtTime(energyData, time);
    total += energy;
    peak = Math.max(peak, energy);
    count += 1;
  }
  return { average: count > 0 ? total / count : 0, peak };
};

/**
 * Finds sustained high-to-low energy transitions: the quiet, slower break that
 * follows a loud section. Results are deterministic on every client.
 */
export const detectExperimentalEvents = (
  energyData: readonly EnergyData[],
  trackDuration: number,
): ExperimentalEvent[] => {
  if (energyData.length < 2 || !Number.isFinite(trackDuration) || trackDuration <= 0) return [];
  const availableDuration = Math.min(
    trackDuration,
    energyData[energyData.length - 1].time,
  );
  if (availableDuration < MIN_EVENT_TIME_SECONDS + QUIET_LOOKAHEAD_SECONDS + 1) return [];

  const maximumEvents = Math.min(5, Math.max(1, Math.ceil(availableDuration / 45)));
  const events: ExperimentalEvent[] = [];
  let lastEventTime = -Infinity;

  for (
    let transitionTime = MIN_EVENT_TIME_SECONDS;
    transitionTime <= availableDuration - QUIET_LOOKAHEAD_SECONDS - 1;
    transitionTime += SAMPLE_STEP_SECONDS
  ) {
    if (transitionTime - lastEventTime < MIN_EVENT_GAP_SECONDS) continue;

    const before = sampleWindow(energyData, transitionTime - 2.5, transitionTime - 0.5);
    const after = sampleWindow(
      energyData,
      transitionTime + 0.25,
      transitionTime + QUIET_LOOKAHEAD_SECONDS,
    );
    const immediateBefore = energyAtTime(energyData, transitionTime - 0.2);
    const immediateAfter = energyAtTime(energyData, transitionTime + 0.35);
    const isLoudSection = before.average >= 0.58 && before.peak >= 0.72;
    const isQuietBreak = after.average <= 0.38;
    const isSharpEnoughDrop = before.average - after.average >= 0.24
      && immediateBefore - immediateAfter >= 0.18;
    if (!isLoudSection || !isQuietBreak || !isSharpEnoughDrop) continue;

    const eventTime = transitionTime + 0.35;
    const kind: ExperimentalEventKind = events.length % 2 === 0
      ? 'lane-swap'
      : 'arrow-flight';
    const laneOrder = kind === 'lane-swap'
      ? LANE_ORDERS[(Math.floor(eventTime * 4) + events.length) % LANE_ORDERS.length]
      : DEFAULT_LANE_ORDER;
    events.push({
      id: `experimental-${Math.round(eventTime * 1000).toString(36)}-${kind}`,
      time: eventTime,
      duration: kind === 'lane-swap' ? 3 : 2.4,
      kind,
      laneOrder,
    });
    lastEventTime = eventTime;
    if (events.length >= maximumEvents) break;
  }

  return events;
};

export const activeExperimentalEventAt = (
  events: readonly ExperimentalEvent[],
  time: number,
): ExperimentalEvent | null => events.find(event =>
  time >= event.time && time <= event.time + event.duration) ?? null;

/** Returns a fractional visual lane; hit data and note timing stay untouched. */
export const experimentalLanePosition = (
  lane: number,
  event: ExperimentalEvent | null,
  time: number,
): number => {
  if (!event || event.kind !== 'lane-swap' || lane < 0 || lane > 3) return lane;
  const elapsed = time - event.time;
  if (elapsed < 0 || elapsed > event.duration) return lane;
  const moveInSeconds = 0.65;
  const moveOutSeconds = 0.7;
  let amount = 1;
  if (elapsed < moveInSeconds) amount = smoothstep(elapsed / moveInSeconds);
  else if (elapsed > event.duration - moveOutSeconds) {
    amount = 1 - smoothstep((elapsed - (event.duration - moveOutSeconds)) / moveOutSeconds);
  }
  return lane + (event.laneOrder[lane] - lane) * amount;
};

/** Adds a small alternating arc while lanes cross so the swap stays readable. */
export const experimentalLaneVerticalOffset = (
  lane: number,
  event: ExperimentalEvent | null,
  time: number,
): number => {
  if (!event || event.kind !== 'lane-swap' || lane < 0 || lane > 3) return 0;
  const elapsed = time - event.time;
  if (elapsed < 0 || elapsed > event.duration) return 0;
  const moveInSeconds = 0.65;
  const moveOutSeconds = 0.7;
  let arc = 0;
  if (elapsed < moveInSeconds) {
    arc = Math.sin(Math.PI * (elapsed / moveInSeconds));
  } else if (elapsed > event.duration - moveOutSeconds) {
    arc = Math.sin(Math.PI * ((elapsed - (event.duration - moveOutSeconds)) / moveOutSeconds));
  }
  if (arc === 0) return 0;
  return arc * (lane % 2 === 0 ? -18 : 18);
};

export const experimentalReceptorOpacity = (
  event: ExperimentalEvent | null,
  time: number,
): number => {
  if (!event || event.kind !== 'arrow-flight') return 1;
  const elapsed = time - event.time;
  if (elapsed < 0 || elapsed > event.duration) return 1;
  if (elapsed < 0.25) return 1 - smoothstep(elapsed / 0.25);
  if (elapsed > event.duration - 0.45) {
    return smoothstep((elapsed - (event.duration - 0.45)) / 0.45);
  }
  return 0;
};
