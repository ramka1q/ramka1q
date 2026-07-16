import { EnergyData, Note } from '../types';

const MAX_TRACK_SECONDS = 25 * 60;
const SILENT_SAMPLE_RATE = 8_000;
const FALLBACK_SCROLL_SPEED = 700;
const FALLBACK_LANES = [0, 2, 1, 3, 0, 1, 3, 2] as const;

export interface DirectMediaAnalysis {
  beatmap: Note[];
  energyData: EnergyData[];
}

const validatedDuration = (duration: number): number => {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError('This video has an invalid duration and cannot be played.');
  }
  if (duration > MAX_TRACK_SECONDS) {
    throw new RangeError('Tracks longer than 25 minutes are not supported.');
  }
  return duration;
};

/**
 * Builds a deterministic chart when the browser can play a video's sound but
 * cannot expose decoded samples for rhythm analysis.
 */
export const buildDirectMediaAnalysis = (
  duration: number,
  sensitivity: number,
): DirectMediaAnalysis => {
  const safeDuration = validatedDuration(duration);
  const normalizedSensitivity = (Math.min(100, Math.max(1, sensitivity)) - 1) / 99;
  const noteInterval = 0.78 - normalizedSensitivity * 0.48;
  const energy = 0.45;
  const energyData: EnergyData[] = [
    { time: 0, energy, cumulativeDistance: 0 },
    {
      time: safeDuration,
      energy,
      cumulativeDistance: safeDuration * FALLBACK_SCROLL_SPEED,
    },
  ];

  const beatmap: Note[] = [];
  const firstNoteTime = Math.min(0.75, safeDuration / 3);
  const finalNoteTime = safeDuration - 0.2;
  for (
    let time = firstNoteTime, index = 0;
    time <= finalNoteTime;
    time = firstNoteTime + (++index * noteInterval)
  ) {
    const lane = FALLBACK_LANES[index % FALLBACK_LANES.length];
    beatmap.push({
      id: `fallback-${index.toString(36)}-${lane}`,
      time,
      lane,
      hit: false,
      missed: false,
      cumulativeDistance: time * FALLBACK_SCROLL_SPEED,
    });
  }

  return { beatmap, energyData };
};

/** Creates a silent Web Audio clock with the same duration as the media file. */
export const createSilentPlaybackBuffer = (
  audioContext: AudioContext,
  duration: number,
): AudioBuffer => {
  const safeDuration = validatedDuration(duration);
  const frameCount = Math.max(1, Math.ceil(safeDuration * SILENT_SAMPLE_RATE));
  return audioContext.createBuffer(1, frameCount, SILENT_SAMPLE_RATE);
};

/** Reads duration without decoding or displaying the video. */
export const readDirectMediaDuration = (media: Blob): Promise<number> =>
  new Promise((resolve, reject) => {
    const mediaUrl = URL.createObjectURL(media);
    const video = document.createElement('video');
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      const duration = video.duration;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(mediaUrl);
      if (error) reject(error);
      else {
        try {
          resolve(validatedDuration(duration));
        } catch (validationError) {
          reject(validationError);
        }
      }
    };

    const timeoutId = window.setTimeout(() => {
      finish(new Error('Timed out while reading this video. The browser may not support its format.'));
    }, 10_000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('loadedmetadata', () => finish(), { once: true });
    video.addEventListener('error', () => {
      finish(new Error('This browser cannot play the selected video format, even without showing it.'));
    }, { once: true });
    video.src = mediaUrl;
    video.load();
  });
