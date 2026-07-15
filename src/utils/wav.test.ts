import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeMonoPcm16Wav,
  MAX_SHARED_WAV_BYTES,
  MAX_SHARED_WAV_DURATION_SECONDS,
  MAX_SHARED_WAV_SAMPLES,
  PCM16_WAV_HEADER_BYTES,
  planMonoPcm16Wav,
  SHARED_WAV_SAMPLE_RATE,
  WAV_MIME_TYPE,
  type AudioBufferLike,
} from './wav';

const source = (
  channels: readonly Float32Array[],
  sampleRate = SHARED_WAV_SAMPLE_RATE,
): AudioBufferLike => ({
  length: channels[0]?.length ?? 0,
  numberOfChannels: channels.length,
  sampleRate,
  getChannelData: channel => channels[channel],
});

const ascii = (view: DataView, offset: number, length: number): string =>
  String.fromCharCode(...Array.from(
    { length },
    (_, index) => view.getUint8(offset + index),
  ));

const pcmSamples = (wav: ArrayBuffer): number[] => {
  const view = new DataView(wav);
  const samples: number[] = [];
  for (let offset = PCM16_WAV_HEADER_BYTES; offset < wav.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
};

test('exports a standard mono PCM16 RIFF/WAVE header and exact data sizes', () => {
  const wav = encodeMonoPcm16Wav(source([
    new Float32Array([0, -1, 1, 0.5]),
  ]));
  const view = new DataView(wav);

  assert.equal(WAV_MIME_TYPE, 'audio/wav');
  assert.equal(wav.byteLength, PCM16_WAV_HEADER_BYTES + 8);
  assert.equal(ascii(view, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(ascii(view, 8, 4), 'WAVE');
  assert.equal(ascii(view, 12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), SHARED_WAV_SAMPLE_RATE);
  assert.equal(view.getUint32(28, true), SHARED_WAV_SAMPLE_RATE * 2);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(view, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual(pcmSamples(wav), [0, -32768, 32767, 16384]);
});

test('layout preserves duration while resampling to 32 kHz', () => {
  const layout = planMonoPcm16Wav(48_000, 48_000);

  assert.deepEqual(layout, {
    sampleRate: 32_000,
    sampleCount: 32_000,
    dataByteLength: 64_000,
    byteLength: 64_044,
    durationSeconds: 1,
  });
});

test('linearly upsamples source samples', () => {
  const wav = encodeMonoPcm16Wav(source([
    new Float32Array([0, 1]),
  ], 16_000));

  assert.deepEqual(pcmSamples(wav), [0, 16384, 32767, 32767]);
});

test('downmixes every channel with equal weight', () => {
  const wav = encodeMonoPcm16Wav(source([
    new Float32Array([1, 0, -1]),
    new Float32Array([-1, 1, 0]),
  ]));

  assert.deepEqual(pcmSamples(wav), [0, 16384, -16384]);
});

test('clips out-of-range samples and silences non-finite values', () => {
  const wav = encodeMonoPcm16Wav(source([
    new Float32Array([2, -2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
  ]));

  assert.deepEqual(pcmSamples(wav), [32767, -32768, 0, 0, 0]);
});

test('accepts the largest representable layout and rejects one sample more', () => {
  const largest = planMonoPcm16Wav(MAX_SHARED_WAV_SAMPLES, SHARED_WAV_SAMPLE_RATE);

  assert.ok(largest.byteLength <= MAX_SHARED_WAV_BYTES);
  assert.equal(largest.sampleCount, MAX_SHARED_WAV_SAMPLES);
  assert.equal(largest.durationSeconds, MAX_SHARED_WAV_DURATION_SECONDS);
  assert.throws(
    () => planMonoPcm16Wav(MAX_SHARED_WAV_SAMPLES + 1, SHARED_WAV_SAMPLE_RATE),
    /32 MiB WAV limit/,
  );
});

test('rejects oversized audio before reading channels or allocating output', () => {
  let channelWasRead = false;
  const oversized: AudioBufferLike = {
    length: MAX_SHARED_WAV_SAMPLES + 1,
    numberOfChannels: 1,
    sampleRate: SHARED_WAV_SAMPLE_RATE,
    getChannelData: () => {
      channelWasRead = true;
      throw new Error('channel data must not be read');
    },
  };

  assert.throws(() => encodeMonoPcm16Wav(oversized), /32 MiB WAV limit/);
  assert.equal(channelWasRead, false);
});

test('rejects malformed source metadata and channel data', () => {
  assert.throws(() => planMonoPcm16Wav(0, 32_000), /at least one source sample/);
  assert.throws(() => planMonoPcm16Wav(1, 0), /positive finite/);
  assert.throws(
    () => encodeMonoPcm16Wav({
      length: 1,
      numberOfChannels: 0,
      sampleRate: 32_000,
      getChannelData: () => new Float32Array(1),
    }),
    /at least one channel/,
  );
  assert.throws(
    () => encodeMonoPcm16Wav({
      length: 2,
      numberOfChannels: 1,
      sampleRate: 32_000,
      getChannelData: () => new Float32Array(1),
    }),
    /invalid sample data/,
  );
});
