export const SHARED_WAV_SAMPLE_RATE = 32_000;
export const PCM16_BYTES_PER_SAMPLE = 2;
export const PCM16_WAV_HEADER_BYTES = 44;
export const MAX_SHARED_WAV_BYTES = 32 * 1024 * 1024;
export const WAV_MIME_TYPE = 'audio/wav';

export const MAX_SHARED_WAV_SAMPLES = Math.floor(
  (MAX_SHARED_WAV_BYTES - PCM16_WAV_HEADER_BYTES) / PCM16_BYTES_PER_SAMPLE,
);
export const MAX_SHARED_WAV_DURATION_SECONDS =
  MAX_SHARED_WAV_SAMPLES / SHARED_WAV_SAMPLE_RATE;

export interface AudioBufferLike {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface MonoPcm16WavLayout {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly dataByteLength: number;
  readonly byteLength: number;
  readonly durationSeconds: number;
}

const validateSourceMetadata = (
  sourceLength: number,
  sourceSampleRate: number,
): void => {
  if (!Number.isSafeInteger(sourceLength) || sourceLength <= 0) {
    throw new TypeError('Audio must contain at least one source sample.');
  }
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new TypeError('Audio sample rate must be a positive finite number.');
  }
};

/**
 * Calculates the exact output size before an output ArrayBuffer is allocated.
 */
export const planMonoPcm16Wav = (
  sourceLength: number,
  sourceSampleRate: number,
): MonoPcm16WavLayout => {
  validateSourceMetadata(sourceLength, sourceSampleRate);

  const rawSampleCount = Math.round(
    sourceLength * SHARED_WAV_SAMPLE_RATE / sourceSampleRate,
  );
  const sampleCount = Math.max(1, rawSampleCount);
  if (!Number.isSafeInteger(sampleCount)) {
    throw new RangeError('The resampled audio is too large to encode safely.');
  }

  const dataByteLength = sampleCount * PCM16_BYTES_PER_SAMPLE;
  const byteLength = PCM16_WAV_HEADER_BYTES + dataByteLength;
  if (byteLength > MAX_SHARED_WAV_BYTES) {
    throw new RangeError(
      `Shared audio exceeds the ${MAX_SHARED_WAV_BYTES / 1024 / 1024} MiB WAV limit.`,
    );
  }

  return {
    sampleRate: SHARED_WAV_SAMPLE_RATE,
    sampleCount,
    dataByteLength,
    byteLength,
    durationSeconds: sampleCount / SHARED_WAV_SAMPLE_RATE,
  };
};

const writeAscii = (view: DataView, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
};

const floatToPcm16 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const clipped = Math.max(-1, Math.min(1, value));
  return clipped < 0
    ? Math.round(clipped * 0x8000)
    : Math.round(clipped * 0x7fff);
};

/**
 * Downmixes all input channels equally, linearly resamples to 32 kHz, and
 * returns a mono little-endian PCM16 RIFF/WAVE file.
 */
export const encodeMonoPcm16Wav = (source: AudioBufferLike): ArrayBuffer => {
  if (!Number.isSafeInteger(source.numberOfChannels) || source.numberOfChannels <= 0) {
    throw new TypeError('Audio must contain at least one channel.');
  }

  // This call enforces the byte limit before channel access or output allocation.
  const layout = planMonoPcm16Wav(source.length, source.sampleRate);
  const channels = Array.from({ length: source.numberOfChannels }, (_, channelIndex) => {
    const channel = source.getChannelData(channelIndex);
    if (!(channel instanceof Float32Array) || channel.length < source.length) {
      throw new TypeError(`Audio channel ${channelIndex} has invalid sample data.`);
    }
    return channel;
  });

  const output = new ArrayBuffer(layout.byteLength);
  const view = new DataView(output);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, layout.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, layout.sampleRate, true);
  view.setUint32(28, layout.sampleRate * PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(32, PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, layout.dataByteLength, true);

  const sourceStep = source.sampleRate / layout.sampleRate;
  for (let outputIndex = 0; outputIndex < layout.sampleCount; outputIndex += 1) {
    const sourcePosition = outputIndex * sourceStep;
    const leftIndex = Math.min(source.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const interpolation = Math.max(0, Math.min(1, sourcePosition - leftIndex));

    let mixedSample = 0;
    for (const channel of channels) {
      const leftValue = channel[leftIndex];
      const rightValue = channel[rightIndex];
      const left = Number.isFinite(leftValue) ? leftValue : 0;
      const right = Number.isFinite(rightValue) ? rightValue : 0;
      mixedSample += left + (right - left) * interpolation;
    }
    mixedSample /= channels.length;

    view.setInt16(
      PCM16_WAV_HEADER_BYTES + outputIndex * PCM16_BYTES_PER_SAMPLE,
      floatToPcm16(mixedSample),
      true,
    );
  }

  return output;
};
