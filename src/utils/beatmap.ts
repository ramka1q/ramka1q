import { EnergyData, Note } from '../types';

const EPSILON = 1e-9;

export interface NormalizeBeatmapOptions {
  energyData: readonly EnergyData[];
  audioDuration?: number;
}

const interpolate = (
  input: number,
  inputStart: number,
  inputEnd: number,
  outputStart: number,
  outputEnd: number,
) => {
  if (Math.abs(inputEnd - inputStart) <= EPSILON) return outputStart;
  const progress = (input - inputStart) / (inputEnd - inputStart);
  return outputStart + (outputEnd - outputStart) * progress;
};

const lowerBound = (
  length: number,
  predicate: (index: number) => boolean,
): number => {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (predicate(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
};

const assertValidEnergyData = (energyData: readonly EnergyData[]) => {
  if (energyData.length === 0) {
    throw new TypeError('energyData must contain at least one point');
  }

  energyData.forEach((point, index) => {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.energy)
      || !Number.isFinite(point.cumulativeDistance)) {
      throw new TypeError(`energyData[${index}] must contain finite numbers`);
    }
    if (point.energy < 0 || point.energy > 1) {
      throw new RangeError(`energyData[${index}].energy must be between 0 and 1`);
    }
    if (index > 0) {
      const previous = energyData[index - 1];
      if (point.time <= previous.time) {
        throw new RangeError('energyData times must be strictly increasing');
      }
      if (point.cumulativeDistance < previous.cumulativeDistance) {
        throw new RangeError('energyData distances must be non-decreasing');
      }
    }
  });
};

/** Binary-search interpolation of normalized energy at a song time. */
export const energyAtTime = (
  energyData: readonly EnergyData[],
  time: number,
): number => {
  if (!Number.isFinite(time)) throw new RangeError('time must be finite');
  if (energyData.length === 0) return 0;
  if (time <= energyData[0].time) return energyData[0].energy;
  const last = energyData[energyData.length - 1];
  if (time >= last.time) return last.energy;

  const upperIndex = lowerBound(energyData.length, (index) => energyData[index].time >= time);
  const lower = energyData[upperIndex - 1];
  const upper = energyData[upperIndex];
  return interpolate(time, lower.time, upper.time, lower.energy, upper.energy);
};

/** Binary-search interpolation from song time to cumulative scroll distance. */
export const distanceAtTime = (
  energyData: readonly EnergyData[],
  time: number,
): number => {
  if (!Number.isFinite(time)) throw new RangeError('time must be finite');
  if (energyData.length === 0) return 0;
  if (time <= energyData[0].time) return energyData[0].cumulativeDistance;
  const last = energyData[energyData.length - 1];
  if (time >= last.time) return last.cumulativeDistance;

  const upperIndex = lowerBound(energyData.length, (index) => energyData[index].time >= time);
  const lower = energyData[upperIndex - 1];
  const upper = energyData[upperIndex];
  return interpolate(
    time,
    lower.time,
    upper.time,
    lower.cumulativeDistance,
    upper.cumulativeDistance,
  );
};

/** Binary-search interpolation from cumulative scroll distance back to song time. */
export const timeAtDistance = (
  energyData: readonly EnergyData[],
  distance: number,
): number => {
  if (!Number.isFinite(distance)) throw new RangeError('distance must be finite');
  if (energyData.length === 0) return 0;
  if (distance <= energyData[0].cumulativeDistance) return energyData[0].time;
  const last = energyData[energyData.length - 1];
  if (distance >= last.cumulativeDistance) return last.time;

  const upperIndex = lowerBound(
    energyData.length,
    (index) => energyData[index].cumulativeDistance >= distance,
  );
  const lower = energyData[upperIndex - 1];
  const upper = energyData[upperIndex];
  return interpolate(
    distance,
    lower.cumulativeDistance,
    upper.cumulativeDistance,
    lower.time,
    upper.time,
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredFiniteNumber = (
  value: unknown,
  path: string,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
};

/**
 * Strictly validates imported notes and rebuilds every runtime-derived field.
 * Uploaded hit flags and cumulative distances are intentionally never trusted.
 */
export const normalizeBeatmap = (
  input: unknown,
  options: NormalizeBeatmapOptions,
): Note[] => {
  if (!Array.isArray(input)) throw new TypeError('beatmap must be an array');
  assertValidEnergyData(options.energyData);

  const lastEnergyTime = options.energyData[options.energyData.length - 1].time;
  const audioDuration = options.audioDuration ?? lastEnergyTime;
  if (!Number.isFinite(audioDuration) || audioDuration < 0) {
    throw new RangeError('audioDuration must be a non-negative finite number');
  }

  const ids = new Set<string>();
  const normalized = input.map((rawNote, originalIndex) => {
    const path = `beatmap[${originalIndex}]`;
    if (!isRecord(rawNote)) throw new TypeError(`${path} must be an object`);

    const time = requiredFiniteNumber(rawNote.time, `${path}.time`);
    const lane = requiredFiniteNumber(rawNote.lane, `${path}.lane`);
    if (time < 0 || time > audioDuration) {
      throw new RangeError(`${path}.time must be inside the audio duration`);
    }
    if (!Number.isInteger(lane) || lane < 0 || lane > 3) {
      throw new RangeError(`${path}.lane must be an integer from 0 to 3`);
    }

    const duration = rawNote.duration === undefined
      ? 0
      : requiredFiniteNumber(rawNote.duration, `${path}.duration`);
    if (duration < 0 || time + duration > audioDuration + EPSILON) {
      throw new RangeError(`${path}.duration must fit inside the audio duration`);
    }

    const id = rawNote.id === undefined
      ? `note-${Math.round(time * 1000).toString(36)}-${lane}-${originalIndex.toString(36)}`
      : rawNote.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new TypeError(`${path}.id must be a non-empty string when provided`);
    }
    if (ids.has(id)) throw new RangeError(`duplicate note id: ${id}`);
    ids.add(id);

    const note: Note & { originalIndex: number } = {
      id,
      time,
      lane,
      hit: false,
      missed: false,
      cumulativeDistance: distanceAtTime(options.energyData, time),
      originalIndex,
    };
    if (duration > 0) {
      note.duration = duration;
      note.cumulativeDistanceEnd = distanceAtTime(options.energyData, time + duration);
    }
    return note;
  });

  normalized.sort((left, right) =>
    left.time - right.time || left.lane - right.lane || left.originalIndex - right.originalIndex,
  );

  for (let index = 1; index < normalized.length; index++) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous.lane === current.lane && Math.abs(previous.time - current.time) <= EPSILON) {
      throw new RangeError(`duplicate note at time ${current.time} in lane ${current.lane}`);
    }
  }

  return normalized.map(({ originalIndex: _originalIndex, ...note }) => note);
};
