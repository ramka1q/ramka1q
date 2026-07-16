import { EnergyData, Note } from '../types';
import { distanceAtTime } from './beatmap';

const FRAME_SECONDS = 0.01;
const LOCAL_WINDOW_SECONDS = 1.5;
const SUSTAIN_LOOKBACK_SECONDS = 0.25;
const SUSTAIN_BODY_DELAY_SECONDS = 0.03;
const SUSTAIN_BODY_WINDOW_SECONDS = 0.12;
const SUSTAIN_ATTACK_FLOOR_RATIO = 0.42;
const SUSTAIN_BODY_FLOOR_RATIO = 0.75;
const SUSTAIN_MIN_ATTACK_RATIO = 0.08;
const SUSTAIN_GAP_TOLERANCE_SECONDS = 0.06;
const SUSTAIN_REARTICULATION_GAP_SECONDS = 0.02;
const SUSTAIN_LATE_BODY_WINDOW_SECONDS = 0.2;
const SUSTAIN_MIN_EXCESS_POWER_RATIO = 0.04;
const SUSTAIN_LATE_EXCESS_POWER_RATIO = 0.3;
const SUSTAIN_FLOOR_EXCESS_POWER_RATIO = 0.5;
const SUSTAIN_ATTACK_SPECTRAL_FACTOR_LIMIT = 2.4;
const SUSTAIN_BASELINE_SPECTRAL_FACTOR_LIMIT = 1.2;
const SUSTAIN_REARTICULATION_SPECTRAL_FACTOR_LIMIT = 1.75;
const SUSTAIN_MIN_SPECTRAL_RATIO = 0.015;
const SUSTAIN_SPECTRAL_MAD_LIMIT = 0.32;
const SUSTAIN_SPECTRAL_BLOCK_SECONDS = 0.1;
const SUSTAIN_SPECTRAL_BLOCK_DEVIATION_LIMIT = 0.3;
const SUSTAIN_UNSTABLE_BLOCK_LIMIT = 3;
const MIN_HOLD_SECONDS = 0.4;
const MAX_HOLD_SECONDS = 3;
const MAX_AUDIO_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ANALYSIS_SECONDS = 25 * 60;
const BASE_SCROLL_SPEED = 700;
const SCROLL_SPEED_RANGE = 400;
const ENERGY_SMOOTHING_TAU_SECONDS = 0.975;
const EPSILON = 1e-9;

export type SampleChannel = ArrayLike<number>;

export interface SampleAnalysis {
  beatmap: Note[];
  energyData: EnergyData[];
}

export interface AudioAnalysis extends SampleAnalysis {
  buffer: AudioBuffer;
}

export class VideoAudioExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VideoAudioExtractionError';
  }
}

export interface PlanarAudioBuffer {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData: (channel: number) => Float32Array;
}

interface FrameFeatures {
  rms: number[];
  transient: number[];
  spectralRatio: number[];
  times: number[];
  duration: number;
  frameDuration: number;
}

class TrackDurationError extends RangeError {}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export const copyAudioChunkAtTimestamp = (
  target: PlanarAudioBuffer,
  chunk: PlanarAudioBuffer,
  timestamp: number,
): void => {
  if (!Number.isFinite(timestamp)) throw new RangeError('timestamp must be finite');
  if (target.sampleRate !== chunk.sampleRate) {
    throw new RangeError('decoded audio chunks must use the target sample rate');
  }

  const signedTargetStart = Math.round(timestamp * target.sampleRate);
  const sourceStart = Math.max(0, -signedTargetStart);
  const targetStart = Math.max(0, signedTargetStart);
  const copyLength = Math.min(
    chunk.length - sourceStart,
    target.length - targetStart,
  );
  if (copyLength <= 0) return;

  const channelCount = Math.min(target.numberOfChannels, chunk.numberOfChannels);
  for (let channel = 0; channel < channelCount; channel++) {
    target.getChannelData(channel).set(
      chunk.getChannelData(channel).subarray(sourceStart, sourceStart + copyLength),
      targetStart,
    );
  }
};

export const decodePcm16LeMono = (bytes: Uint8Array): Float32Array => {
  if (bytes.byteLength === 0) {
    throw new RangeError('The decoded audio track is empty.');
  }
  if (bytes.byteLength % 2 !== 0) {
    throw new RangeError('The decoded PCM audio has an invalid byte length.');
  }

  const samples = new Float32Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index++) {
    const value = view.getInt16(index * 2, true);
    samples[index] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return samples;
};

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * clamp(quantile, 0, 1));
  return sorted[index];
};

const maximum = (values: readonly number[]): number => {
  let result = 0;
  for (const value of values) result = Math.max(result, value);
  return result;
};

const prefixSums = (values: readonly number[]) => {
  const sums = new Float64Array(values.length + 1);
  const squaredSums = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    sums[index + 1] = sums[index] + value;
    squaredSums[index + 1] = squaredSums[index] + value * value;
  }
  return { sums, squaredSums };
};

const localMeanAndDeviation = (
  values: readonly number[],
  radius: number,
): { means: number[]; deviations: number[] } => {
  const { sums, squaredSums } = prefixSums(values);
  const means = new Array<number>(values.length);
  const deviations = new Array<number>(values.length);

  for (let index = 0; index < values.length; index++) {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    const count = end - start;
    const sum = sums[end] - sums[start];
    const squaredSum = squaredSums[end] - squaredSums[start];
    const mean = count > 0 ? sum / count : 0;
    const variance = count > 0 ? Math.max(0, squaredSum / count - mean * mean) : 0;
    means[index] = mean;
    deviations[index] = Math.sqrt(variance);
  }

  return { means, deviations };
};

const extractFrameFeatures = (
  channels: readonly SampleChannel[],
  sampleRate: number,
): FrameFeatures => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('sampleRate must be a positive finite number');
  }
  if (channels.length === 0) {
    throw new TypeError('at least one audio channel is required');
  }

  const sampleCount = channels[0].length;
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    if (channels[channelIndex].length !== sampleCount) {
      throw new RangeError('all audio channels must contain the same number of samples');
    }
  }

  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frameDuration = frameSize / sampleRate;
  const frameCount = Math.ceil(sampleCount / frameSize);
  const rms = new Array<number>(frameCount);
  const differenceRms = new Array<number>(frameCount);
  const transient = new Array<number>(frameCount);
  const spectralRatio = new Array<number>(frameCount);
  const times = new Array<number>(frameCount);
  const previousSamples = new Array<number>(channels.length).fill(0);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const start = frameIndex * frameSize;
    const end = Math.min(sampleCount, start + frameSize);
    let squaredSum = 0;
    let differenceSquaredSum = 0;
    let valueCount = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
        const value = Number(channels[channelIndex][sampleIndex]);
        if (!Number.isFinite(value)) {
          throw new TypeError(`channel ${channelIndex} contains a non-finite sample at ${sampleIndex}`);
        }
        const difference = value - previousSamples[channelIndex];
        previousSamples[channelIndex] = value;
        squaredSum += value * value;
        differenceSquaredSum += difference * difference;
        valueCount++;
      }
    }

    rms[frameIndex] = valueCount > 0 ? Math.sqrt(squaredSum / valueCount) : 0;
    differenceRms[frameIndex] = valueCount > 0
      ? Math.sqrt(differenceSquaredSum / valueCount)
      : 0;
    times[frameIndex] = start / sampleRate;

    const previousRms = frameIndex > 0 ? rms[frameIndex - 1] : 0;
    const previousDifferenceRms = frameIndex > 0 ? differenceRms[frameIndex - 1] : 0;
    const rmsRise = Math.max(0, rms[frameIndex] - previousRms);
    const differenceRise = Math.max(0, differenceRms[frameIndex] - previousDifferenceRms);
    transient[frameIndex] = rmsRise + differenceRise * 0.35;
    // The first-difference/RMS ratio is a cheap, sample-rate-independent proxy
    // for spectral character. A sustained source should keep it reasonably stable.
    spectralRatio[frameIndex] = rms[frameIndex] > EPSILON
      ? differenceRms[frameIndex] / rms[frameIndex]
      : 0;
  }

  return {
    rms,
    transient,
    spectralRatio,
    times,
    duration: sampleCount / sampleRate,
    frameDuration,
  };
};

const energyMode = (energy: number): number => {
  if (energy > 0.8) return 1.5;
  if (energy > 0.6) return 0.8;
  if (energy > 0.4) return 0.4;
  if (energy > 0.2) return 0;
  return -0.4;
};

const buildEnergyData = (features: FrameFeatures): EnergyData[] => {
  if (features.rms.length === 0) {
    return [{ time: 0, energy: 0, cumulativeDistance: 0 }];
  }

  const robustMaximum = percentile(features.rms, 0.95);
  const maximumRms = maximum(features.rms);
  const normalizationScale = robustMaximum > EPSILON ? robustMaximum : maximumRms;
  const normalizedEnergy = features.rms.map((value) =>
    normalizationScale > EPSILON ? clamp(Math.pow(value / normalizationScale, 0.6), 0, 1) : 0,
  );

  const energyData: EnergyData[] = [{
    time: 0,
    energy: normalizedEnergy[0] ?? 0,
    cumulativeDistance: 0,
  }];
  let cumulativeDistance = 0;
  let smoothedMode = energyMode(normalizedEnergy[0] ?? 0);
  let previousTime = 0;

  const appendPoint = (time: number, energy: number) => {
    const deltaTime = Math.max(0, time - previousTime);
    const alpha = 1 - Math.exp(-deltaTime / ENERGY_SMOOTHING_TAU_SECONDS);
    smoothedMode += (energyMode(energy) - smoothedMode) * alpha;
    const scrollSpeed = BASE_SCROLL_SPEED + smoothedMode * SCROLL_SPEED_RANGE;
    cumulativeDistance += scrollSpeed * deltaTime;
    energyData.push({ time, energy, cumulativeDistance });
    previousTime = time;
  };

  for (let frameIndex = 1; frameIndex < features.times.length; frameIndex++) {
    appendPoint(features.times[frameIndex], normalizedEnergy[frameIndex]);
  }

  if (features.duration > previousTime + EPSILON) {
    appendPoint(features.duration, normalizedEnergy[normalizedEnergy.length - 1] ?? 0);
  }

  return energyData;
};

const deterministicLane = (
  frameIndex: number,
  noteIndex: number,
  availableLanes: readonly number[],
  previousLane: number | null,
): number => {
  let hash = Math.imul(frameIndex + 1, 0x45d9f3b);
  hash ^= Math.imul(noteIndex + 1, 0x119de1f3);
  hash ^= hash >>> 16;
  const startLane = (hash >>> 0) % 4;
  const orderedLanes = [startLane, (startLane + 2) % 4, (startLane + 1) % 4, (startLane + 3) % 4];
  return orderedLanes.find((lane) => availableLanes.includes(lane) && lane !== previousLane)
    ?? orderedLanes.find((lane) => availableLanes.includes(lane))
    ?? availableLanes[0];
};

/**
 * Pure beatmap analysis over decoded PCM channels.
 *
 * Notes are detected from 10 ms RMS rises plus a time-domain transient feature.
 * The threshold is local to a 1.5 second window, so quiet and loud song sections
 * do not share a single absolute cutoff.
 */
export const analyzeSamples = (
  channels: readonly SampleChannel[],
  sampleRate: number,
  sensitivity: number,
): SampleAnalysis => {
  if (!Number.isFinite(sensitivity)) {
    throw new RangeError('sensitivity must be finite');
  }

  const features = extractFrameFeatures(channels, sampleRate);
  const energyData = buildEnergyData(features);
  if (features.rms.length === 0) return { beatmap: [], energyData };

  const normalizedSensitivity = (clamp(sensitivity, 1, 100) - 1) / 99;
  const localRadius = Math.max(
    1,
    Math.round((LOCAL_WINDOW_SECONDS / features.frameDuration) / 2),
  );
  const { means: transientMeans, deviations: transientDeviations } =
    localMeanAndDeviation(features.transient, localRadius);
  const maximumTransient = maximum(features.transient);
  const robustRms = percentile(features.rms, 0.95) || maximum(features.rms);
  const deviationMultiplier = 3.25 - normalizedSensitivity * 2.5;
  const globalFloorRatio = 0.075 - normalizedSensitivity * 0.06;
  const thresholds = features.transient.map((_, index) =>
    transientMeans[index]
      + transientDeviations[index] * deviationMultiplier
      + maximumTransient * globalFloorRatio,
  );

  const onsetCandidates = features.transient.map((strength, index) => {
    if (strength <= Math.max(EPSILON, thresholds[index])) return false;
    const previous = index > 0 ? features.transient[index - 1] : -Infinity;
    const next = index + 1 < features.transient.length
      ? features.transient[index + 1]
      : -Infinity;
    return strength > previous && strength >= next;
  });

  const sustainLookbackFrames = Math.max(
    1,
    Math.round(SUSTAIN_LOOKBACK_SECONDS / features.frameDuration),
  );
  const sustainBodyDelayFrames = Math.max(
    1,
    Math.round(SUSTAIN_BODY_DELAY_SECONDS / features.frameDuration),
  );
  const sustainBodyWindowFrames = Math.max(
    1,
    Math.round(SUSTAIN_BODY_WINDOW_SECONDS / features.frameDuration),
  );
  const maximumSustainGapFrames = Math.max(
    2,
    Math.round(SUSTAIN_GAP_TOLERANCE_SECONDS / features.frameDuration),
  );
  const minimumRearticulationGapFrames = Math.max(
    1,
    Math.round(SUSTAIN_REARTICULATION_GAP_SECONDS / features.frameDuration),
  );
  const sustainLateBodyWindowFrames = Math.max(
    1,
    Math.round(SUSTAIN_LATE_BODY_WINDOW_SECONDS / features.frameDuration),
  );
  const sustainSpectralBlockFrames = Math.max(
    1,
    Math.round(SUSTAIN_SPECTRAL_BLOCK_SECONDS / features.frameDuration),
  );
  const minimumSpacing = 0.16 - normalizedSensitivity * 0.08;
  const activeLongNotesEndTime = [0, 0, 0, 0];
  const beatmap: Note[] = [];
  let lastNoteTime = -Infinity;
  let previousLane: number | null = null;

  for (let frameIndex = 0; frameIndex < onsetCandidates.length; frameIndex++) {
    if (!onsetCandidates[frameIndex]) continue;

    const frameStart = features.times[frameIndex];
    const nextFrameStart = frameIndex + 1 < features.times.length
      ? features.times[frameIndex + 1]
      : features.duration;
    const noteTime = clamp((frameStart + nextFrameStart) / 2, 0, features.duration);
    if (noteTime - lastNoteTime + EPSILON < minimumSpacing) continue;

    const availableLanes = activeLongNotesEndTime
      .map((endTime, lane) => ({ endTime, lane }))
      .filter(({ endTime }) => noteTime + EPSILON >= endTime)
      .map(({ lane }) => lane);
    if (availableLanes.length === 0) continue;
    const overlapsActiveHold = activeLongNotesEndTime.some(
      endTime => noteTime + EPSILON < endTime,
    );
    const lookbackStart = Math.max(0, frameIndex - sustainLookbackFrames);
    const precedingRms = percentile(
      features.rms.slice(lookbackStart, frameIndex),
      0.5,
    );
    const precedingSpectralRatio = percentile(
      features.spectralRatio.slice(lookbackStart, frameIndex),
      0.5,
    );
    const bodyWindowStart = Math.min(
      features.rms.length,
      frameIndex + sustainBodyDelayFrames,
    );
    const bodyWindowEnd = Math.min(
      features.rms.length,
      bodyWindowStart + sustainBodyWindowFrames,
    );
    const bodyRms = percentile(
      features.rms.slice(bodyWindowStart, bodyWindowEnd),
      0.25,
    );
    const bodySpectralRatio = percentile(
      features.spectralRatio.slice(bodyWindowStart, bodyWindowEnd),
      0.5,
    );
    const attackSpectralRatio = features.spectralRatio[frameIndex];
    const lowerSpectralRatio = Math.min(attackSpectralRatio, bodySpectralRatio);
    const upperSpectralRatio = Math.max(attackSpectralRatio, bodySpectralRatio);
    const spectralFactor = upperSpectralRatio / Math.max(lowerSpectralRatio, EPSILON);
    const lowerBaselineBodyRatio = Math.min(
      precedingSpectralRatio,
      bodySpectralRatio,
    );
    const upperBaselineBodyRatio = Math.max(
      precedingSpectralRatio,
      bodySpectralRatio,
    );
    const baselineBodySpectralFactor = upperBaselineBodyRatio
      / Math.max(lowerBaselineBodyRatio, EPSILON);
    const bodyDiffersFromBaseline = lowerBaselineBodyRatio < SUSTAIN_MIN_SPECTRAL_RATIO
      || baselineBodySpectralFactor > SUSTAIN_BASELINE_SPECTRAL_FACTOR_LIMIT;
    const hasSpectralContinuity = lowerSpectralRatio < SUSTAIN_MIN_SPECTRAL_RATIO
      || spectralFactor <= SUSTAIN_ATTACK_SPECTRAL_FACTOR_LIMIT
      || bodyDiffersFromBaseline;
    const baselinePower = precedingRms * precedingRms;
    const bodyPower = bodyRms * bodyRms;
    const bodyExcessPower = Math.max(0, bodyPower - baselinePower);
    const hasBodyExcess = precedingRms <= EPSILON
      ? bodyRms > EPSILON
      : bodyExcessPower >= baselinePower * SUSTAIN_MIN_EXCESS_POWER_RATIO;
    const sustainFloor = Math.max(
      Math.max(
        features.rms[frameIndex] * SUSTAIN_MIN_ATTACK_RATIO,
        Math.min(
          features.rms[frameIndex] * SUSTAIN_ATTACK_FLOOR_RATIO,
          bodyRms * SUSTAIN_BODY_FLOOR_RATIO,
        ),
      ),
      Math.sqrt(
        baselinePower + bodyExcessPower * SUSTAIN_FLOOR_EXCESS_POWER_RATIO,
      ),
      robustRms * 0.04,
    );
    let lastSustainFrame = frameIndex;
    let gapFrames = 0;

    for (let forwardIndex = frameIndex + 1; forwardIndex < features.rms.length; forwardIndex++) {
      const forwardTime = features.times[forwardIndex];
      if (forwardTime - noteTime > MAX_HOLD_SECONDS + features.frameDuration) break;

      if (features.rms[forwardIndex] >= sustainFloor) {
        if (
          gapFrames >= minimumRearticulationGapFrames
          && onsetCandidates[forwardIndex]
        ) {
          break;
        }
        if (onsetCandidates[forwardIndex] && forwardIndex >= bodyWindowEnd) {
          const rearticulationBodyStart = Math.min(
            features.spectralRatio.length,
            forwardIndex + sustainBodyDelayFrames,
          );
          const rearticulationBodyEnd = Math.min(
            features.spectralRatio.length,
            rearticulationBodyStart + sustainBodyWindowFrames,
          );
          const rearticulationSpectralRatio = percentile(
            features.spectralRatio.slice(rearticulationBodyStart, rearticulationBodyEnd),
            0.5,
          );
          const lowerRearticulationRatio = Math.min(
            bodySpectralRatio,
            rearticulationSpectralRatio,
          );
          const upperRearticulationRatio = Math.max(
            bodySpectralRatio,
            rearticulationSpectralRatio,
          );
          const rearticulationFactor = upperRearticulationRatio
            / Math.max(lowerRearticulationRatio, EPSILON);
          if (
            lowerRearticulationRatio >= SUSTAIN_MIN_SPECTRAL_RATIO
            && rearticulationFactor > SUSTAIN_REARTICULATION_SPECTRAL_FACTOR_LIMIT
          ) {
            break;
          }
        }
        lastSustainFrame = forwardIndex;
        gapFrames = 0;
      } else {
        gapFrames++;
        if (gapFrames > maximumSustainGapFrames) break;
      }
    }

    if (bodySpectralRatio >= SUSTAIN_MIN_SPECTRAL_RATIO) {
      let unstableSpectralBlocks = 0;
      for (
        let blockStart = bodyWindowEnd;
        blockStart <= lastSustainFrame;
        blockStart += sustainSpectralBlockFrames
      ) {
        const blockEnd = Math.min(
          lastSustainFrame + 1,
          blockStart + sustainSpectralBlockFrames,
        );
        const blockSpectralRatio = percentile(
          features.spectralRatio
            .slice(blockStart, blockEnd)
            .filter(value => value >= SUSTAIN_MIN_SPECTRAL_RATIO),
          0.5,
        );
        const relativeDeviation = blockSpectralRatio > EPSILON
          ? Math.abs(blockSpectralRatio - bodySpectralRatio) / bodySpectralRatio
          : 0;
        unstableSpectralBlocks = relativeDeviation > SUSTAIN_SPECTRAL_BLOCK_DEVIATION_LIMIT
          ? unstableSpectralBlocks + 1
          : 0;
        if (unstableSpectralBlocks >= SUSTAIN_UNSTABLE_BLOCK_LIMIT) {
          lastSustainFrame = Math.max(
            frameIndex,
            blockStart - sustainSpectralBlockFrames - 1,
          );
          break;
        }
      }
    }

    const sustainEnd = Math.min(
      features.duration,
      (lastSustainFrame + 1) * features.frameDuration,
    );
    const possibleDuration = Math.max(0, sustainEnd - noteTime);
    const lateBodyWindowEnd = lastSustainFrame + 1;
    const lateBodyWindowStart = Math.max(
      bodyWindowEnd,
      lateBodyWindowEnd - sustainLateBodyWindowFrames,
    );
    const lateBodyRms = percentile(
      features.rms.slice(lateBodyWindowStart, lateBodyWindowEnd),
      0.25,
    );
    const lateBodyPower = lateBodyRms * lateBodyRms;
    const lateBodyExcessPower = Math.max(0, lateBodyPower - baselinePower);
    const hasStableLateBody = lateBodyExcessPower
      >= bodyExcessPower * SUSTAIN_LATE_EXCESS_POWER_RATIO;
    const sustainedSpectralRatios = features.spectralRatio
      .slice(bodyWindowStart, lastSustainFrame + 1)
      .filter(value => value >= SUSTAIN_MIN_SPECTRAL_RATIO);
    const sustainedSpectralMedian = percentile(sustainedSpectralRatios, 0.5);
    const sustainedSpectralMad = sustainedSpectralMedian > EPSILON
      ? percentile(
          sustainedSpectralRatios.map(value => (
            Math.abs(value - sustainedSpectralMedian) / sustainedSpectralMedian
          )),
          0.5,
        )
      : 0;
    const hasStableSpectralBody = sustainedSpectralRatios.length === 0
      || sustainedSpectralMad <= SUSTAIN_SPECTRAL_MAD_LIMIT;
    const duration = possibleDuration >= MIN_HOLD_SECONDS
      && (!overlapsActiveHold || bodyDiffersFromBaseline)
      && hasBodyExcess
      && hasStableLateBody
      && hasSpectralContinuity
      && hasStableSpectralBody
      ? Math.min(MAX_HOLD_SECONDS, possibleDuration)
      : 0;
    const lane = deterministicLane(frameIndex, beatmap.length, availableLanes, previousLane);
    const note: Note = {
      id: `note-${frameIndex.toString(36)}-${lane}-${beatmap.length.toString(36)}`,
      time: noteTime,
      lane,
      hit: false,
      missed: false,
      cumulativeDistance: distanceAtTime(energyData, noteTime),
    };

    if (duration > 0) {
      note.duration = duration;
      note.cumulativeDistanceEnd = distanceAtTime(energyData, noteTime + duration);
      activeLongNotesEndTime[lane] = noteTime + duration;
    }

    beatmap.push(note);
    previousLane = lane;
    lastNoteTime = noteTime;
  }

  return { beatmap, energyData };
};

const decodeVideoAudioTrack = async (
  media: Blob,
  audioContext: AudioContext,
): Promise<AudioBuffer> => {
  const {
    ALL_FORMATS,
    AudioBufferSink,
    BlobSource,
    Input,
  } = await import('mediabunny');
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(media),
  });

  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) throw new Error('The fast decoder could not detect an audio track.');
    if (!await audioTrack.canDecode()) {
      throw new RangeError(
        'This browser cannot decode the video audio codec. Try MP4 with AAC audio or WebM with Opus audio.',
      );
    }

    const [duration, numberOfChannels, sampleRate] = await Promise.all([
      input.computeDuration(),
      audioTrack.getNumberOfChannels(),
      audioTrack.getSampleRate(),
    ]);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new RangeError('The video audio track has an invalid duration.');
    }
    if (duration > MAX_ANALYSIS_SECONDS) {
      throw new TrackDurationError('Tracks longer than 25 minutes are not supported.');
    }
    if (!Number.isInteger(numberOfChannels) || numberOfChannels <= 0) {
      throw new RangeError('The video audio track has an invalid channel count.');
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('The video audio track has an invalid sample rate.');
    }

    const frameCount = Math.max(1, Math.ceil(duration * sampleRate));
    const decodedBuffer = audioContext.createBuffer(numberOfChannels, frameCount, sampleRate);
    const sink = new AudioBufferSink(audioTrack);
    for await (const { buffer: chunk, timestamp } of sink.buffers()) {
      copyAudioChunkAtTimestamp(decodedBuffer, chunk, timestamp);
    }
    return decodedBuffer;
  } finally {
    input.dispose();
  }
};

export const decodeMediaAudio = async (
  media: Blob,
  audioContext: AudioContext,
  isVideo = media.type.startsWith('video/'),
  onCompatibilityFallback?: (message: string) => void,
): Promise<AudioBuffer> => {
  const encodedData = await media.arrayBuffer();
  try {
    return await audioContext.decodeAudioData(encodedData);
  } catch (nativeError) {
    if (!isVideo) throw nativeError;

    let mediaBunnyError: unknown;
    try {
      return await decodeVideoAudioTrack(media, audioContext);
    } catch (error) {
      if (error instanceof TrackDurationError) throw error;
      mediaBunnyError = error;
    }

    onCompatibilityFallback?.('Loading compatibility video decoder (this may take a moment)…');
    try {
      const { extractVideoAudioPcm, OUTPUT_SAMPLE_RATE } = await import('./ffmpeg-audio');
      const pcmBytes = await extractVideoAudioPcm(media);
      const samples = decodePcm16LeMono(pcmBytes);
      const duration = samples.length / OUTPUT_SAMPLE_RATE;
      if (duration > MAX_ANALYSIS_SECONDS) {
        throw new TrackDurationError('Tracks longer than 25 minutes are not supported.');
      }

      const decodedBuffer = audioContext.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
      decodedBuffer.getChannelData(0).set(samples);
      return decodedBuffer;
    } catch (compatibilityError) {
      if (compatibilityError instanceof TrackDurationError) throw compatibilityError;
      console.error('Browser video audio decoding failed:', nativeError);
      console.error('Media demuxer audio decoding failed:', mediaBunnyError);
      console.error('Compatibility video audio decoding failed:', compatibilityError);
      throw new VideoAudioExtractionError(
        'Could not extract audio from this video. Try MP4 with AAC audio or WebM with Opus audio.',
        { cause: compatibilityError },
      );
    }
  }
};

export const analyzeAudio = async (
  file: File,
  sensitivity: number,
  onCompatibilityFallback?: (message: string) => void,
): Promise<AudioAnalysis> => {
  if (file.size <= 0) throw new RangeError('The audio file is empty.');
  if (file.size > MAX_AUDIO_FILE_BYTES) {
    throw new RangeError('Audio files are limited to 100 MiB.');
  }
  const AudioContextClass = window.AudioContext || (window as typeof window & {
    webkitAudioContext: typeof AudioContext;
  }).webkitAudioContext;
  const audioContext = new AudioContextClass();

  try {
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name);
    const buffer = await decodeMediaAudio(file, audioContext, isVideo, onCompatibilityFallback);
    if (buffer.duration > MAX_ANALYSIS_SECONDS) {
      throw new RangeError('Tracks longer than 25 minutes are not supported.');
    }
    const channels = Array.from(
      { length: buffer.numberOfChannels },
      (_, channelIndex) => buffer.getChannelData(channelIndex),
    );
    return { buffer, ...analyzeSamples(channels, buffer.sampleRate, sensitivity) };
  } finally {
    void audioContext.close().catch(() => undefined);
  }
};

export const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
};
