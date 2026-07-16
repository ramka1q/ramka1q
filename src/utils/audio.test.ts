import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeSamples,
  copyAudioChunkAtTimestamp,
  decodePcm16LeMono,
  type PlanarAudioBuffer,
} from './audio';

const SAMPLE_RATE = 1_000;
const TONE_SAMPLE_RATE = 8_000;

const impulseSignal = (
  durationSeconds: number,
  impulses: readonly { time: number; amplitude: number }[],
) => {
  const samples = new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
  impulses.forEach(({ time, amplitude }) => {
    samples[Math.round(time * SAMPLE_RATE)] = amplitude;
  });
  return samples;
};

const planarBuffer = (
  channels: readonly (readonly number[])[],
  sampleRate = 10,
): PlanarAudioBuffer => {
  const channelData = channels.map(channel => Float32Array.from(channel));
  return {
    length: channelData[0]?.length ?? 0,
    numberOfChannels: channelData.length,
    sampleRate,
    getChannelData: channel => channelData[channel],
  };
};

test('decoded video audio chunks are placed by timestamp and clipped at buffer edges', () => {
  const target = planarBuffer([[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]);
  const positiveChunk = planarBuffer([[1, 2], [3, 4]]);
  const negativeChunk = planarBuffer([[8, 9], [6, 7]]);

  copyAudioChunkAtTimestamp(target, positiveChunk, 0.2);
  copyAudioChunkAtTimestamp(target, negativeChunk, -0.1);

  assert.deepEqual([...target.getChannelData(0)], [9, 0, 1, 2, 0]);
  assert.deepEqual([...target.getChannelData(1)], [7, 0, 3, 4, 0]);
});

test('compatibility PCM decoder converts signed little-endian samples', () => {
  const pcm = Uint8Array.from([
    0x00, 0x80,
    0x00, 0xc0,
    0x00, 0x00,
    0xff, 0x3f,
    0xff, 0x7f,
  ]);

  const decoded = decodePcm16LeMono(pcm);
  assert.deepEqual([...decoded.slice(0, 3)], [-1, -0.5, 0]);
  assert.ok(Math.abs(decoded[3] - 16_383 / 32_767) < 1e-7);
  assert.equal(decoded[4], 1);
  assert.throws(() => decodePcm16LeMono(new Uint8Array()), /empty/);
  assert.throws(() => decodePcm16LeMono(Uint8Array.of(1)), /byte length/);
});

test('silence produces no notes and starts energy distance at zero', () => {
  const silence = new Float32Array(SAMPLE_RATE * 2);
  const analysis = analyzeSamples([silence], SAMPLE_RATE, 50);

  assert.deepEqual(analysis.beatmap, []);
  assert.deepEqual(analysis.energyData[0], {
    time: 0,
    energy: 0,
    cumulativeDistance: 0,
  });
  assert.ok(analysis.energyData.every((point) => point.energy === 0));
  assert.ok(analysis.energyData.every((point, index, points) =>
    index === 0 || point.cumulativeDistance >= points[index - 1].cumulativeDistance,
  ));
});

test('click impulses become accurately timed tap notes', () => {
  const clickTimes = [0.25, 0.75, 1.25];
  const samples = impulseSignal(
    1.5,
    clickTimes.map((time) => ({ time, amplitude: 1 })),
  );
  const { beatmap } = analyzeSamples([samples], SAMPLE_RATE, 50);

  assert.equal(beatmap.length, clickTimes.length);
  beatmap.forEach((note, index) => {
    assert.ok(Math.abs(note.time - clickTimes[index]) <= 0.01);
    assert.equal(note.duration, undefined);
  });
});

test('a quieter sustained body remains a long note after a loud attack', () => {
  const samples = new Float32Array(TONE_SAMPLE_RATE * 3);
  const startSample = Math.round(0.5 * TONE_SAMPLE_RATE);
  const endSample = Math.round(2 * TONE_SAMPLE_RATE);

  for (let index = startSample; index < endSample; index++) {
    const elapsed = (index - startSample) / TONE_SAMPLE_RATE;
    const amplitude = elapsed < 0.03 ? 0.9 : 0.16;
    samples[index] = amplitude * Math.sin(2 * Math.PI * 220 * index / TONE_SAMPLE_RATE);
  }

  const { beatmap } = analyzeSamples([samples], TONE_SAMPLE_RATE, 50);
  const onsetNote = beatmap.find(note => note.time >= 0.45 && note.time <= 0.65);

  assert.ok(onsetNote, 'the sustained tone onset should be detected');
  assert.ok((onsetNote.duration ?? 0) >= 1.3, 'the quieter body should remain a hold');
  assert.ok(
    (onsetNote.cumulativeDistanceEnd ?? 0) > (onsetNote.cumulativeDistance ?? 0),
    'the hold tail must extend beyond its head',
  );
});

test('transient accents do not cut off an uninterrupted sustained tone', () => {
  const samples = new Float32Array(TONE_SAMPLE_RATE * 4);
  const startSample = Math.round(0.5 * TONE_SAMPLE_RATE);
  const endSample = Math.round(3.5 * TONE_SAMPLE_RATE);

  for (let index = startSample; index < endSample; index++) {
    const elapsed = (index - startSample) / TONE_SAMPLE_RATE;
    const accentPhase = elapsed % 0.2;
    const amplitude = elapsed >= 0.2 && accentPhase < 0.03 ? 0.85 : 0.35;
    samples[index] = amplitude * Math.sin(2 * Math.PI * 220 * index / TONE_SAMPLE_RATE);
  }

  const { beatmap } = analyzeSamples([samples], TONE_SAMPLE_RATE, 50);
  const longestHold = Math.max(0, ...beatmap.map(note => note.duration ?? 0));

  assert.ok(longestHold >= 2, 'accents inside a continuous sound should preserve a hold');
});

test('a tap followed only by a very quiet background does not become a hold', () => {
  const samples = new Float32Array(TONE_SAMPLE_RATE * 2);
  const onsetSample = Math.round(0.25 * TONE_SAMPLE_RATE);
  samples[onsetSample] = 0.9;
  for (let index = onsetSample + 1; index < samples.length; index++) {
    samples[index] = 0.005 * Math.sin(2 * Math.PI * 220 * index / TONE_SAMPLE_RATE);
  }

  const { beatmap } = analyzeSamples([samples], TONE_SAMPLE_RATE, 50);
  const onsetNote = beatmap.find(note => Math.abs(note.time - 0.25) <= 0.02);

  assert.ok(onsetNote, 'the tap should still be detected');
  assert.equal(onsetNote.duration, undefined);
});

test('dense staccato bursts stay separate instead of merging into holds', () => {
  const samples = new Float32Array(TONE_SAMPLE_RATE * 2);
  const burstSpacing = 0.125;
  const burstDuration = 0.075;

  for (let burstTime = 0.25; burstTime < 1.75; burstTime += burstSpacing) {
    const startSample = Math.round(burstTime * TONE_SAMPLE_RATE);
    const endSample = Math.round((burstTime + burstDuration) * TONE_SAMPLE_RATE);
    for (let index = startSample; index < endSample; index++) {
      samples[index] = 0.7 * Math.sin(2 * Math.PI * 220 * index / TONE_SAMPLE_RATE);
    }
  }

  const { beatmap } = analyzeSamples([samples], TONE_SAMPLE_RATE, 50);

  assert.ok(beatmap.length >= 5, 'the staccato attacks should remain playable notes');
  assert.ok(
    beatmap.every(note => (note.duration ?? 0) < 0.3),
    'short separated bursts must not become long notes',
  );
});

test('high sensitivity does not duplicate one continuous tone into overlapping holds', () => {
  const samples = new Float32Array(TONE_SAMPLE_RATE * 3.5);
  const startSample = Math.round(0.5 * TONE_SAMPLE_RATE);
  const endSample = Math.round(3 * TONE_SAMPLE_RATE);

  for (let index = startSample; index < endSample; index++) {
    const elapsed = (index - startSample) / TONE_SAMPLE_RATE;
    const amplitude = 0.65 * Math.min(1, elapsed / 0.08);
    samples[index] = amplitude * Math.sin(2 * Math.PI * 220 * index / TONE_SAMPLE_RATE);
  }

  const { beatmap } = analyzeSamples([samples], TONE_SAMPLE_RATE, 100);
  const holds = beatmap.filter(note => (note.duration ?? 0) >= 0.3);

  assert.equal(holds.length, 1);
  assert.ok((holds[0].duration ?? 0) >= 2);
});

test('analysis, lane assignment, ids, and holds are deterministic', () => {
  const samples = new Float32Array(SAMPLE_RATE * 2);
  for (let index = 500; index < 1_200; index++) samples[index] = 0.7;
  samples[1_500] = 1;

  const first = analyzeSamples([samples], SAMPLE_RATE, 65);
  const second = analyzeSamples([samples], SAMPLE_RATE, 65);

  assert.deepEqual(first, second);
  assert.ok(first.beatmap.some((note) => (note.duration ?? 0) >= 0.3));
  assert.ok(first.beatmap.every((note) => note.id.startsWith('note-')));
});

test('higher sensitivity detects weak transients without losing strong ones', () => {
  const samples = impulseSignal(5, [
    { time: 0.5, amplitude: 1 },
    { time: 2, amplitude: 0.06 },
    { time: 3.5, amplitude: 1 },
    { time: 4.5, amplitude: 0.06 },
  ]);

  const lowSensitivity = analyzeSamples([samples], SAMPLE_RATE, 1).beatmap;
  const highSensitivity = analyzeSamples([samples], SAMPLE_RATE, 100).beatmap;

  assert.ok(lowSensitivity.length >= 2, 'strong clicks should remain detectable');
  assert.ok(highSensitivity.length > lowSensitivity.length);
  assert.ok(highSensitivity.length >= 4, 'weak clicks should appear at high sensitivity');
});
