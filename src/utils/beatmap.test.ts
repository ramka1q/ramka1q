import assert from 'node:assert/strict';
import test from 'node:test';
import { EnergyData } from '../types';
import { distanceAtTime, energyAtTime, normalizeBeatmap, timeAtDistance } from './beatmap';

const energyData: EnergyData[] = [
  { time: 0, energy: 0, cumulativeDistance: 0 },
  { time: 1, energy: 0.5, cumulativeDistance: 100 },
  { time: 2, energy: 1, cumulativeDistance: 300 },
];

test('binary time/distance helpers interpolate and clamp both directions', () => {
  assert.equal(energyAtTime(energyData, -1), 0);
  assert.equal(energyAtTime(energyData, 1.5), 0.75);
  assert.equal(energyAtTime(energyData, 3), 1);

  assert.equal(distanceAtTime(energyData, -1), 0);
  assert.equal(distanceAtTime(energyData, 0.5), 50);
  assert.equal(distanceAtTime(energyData, 1.5), 200);
  assert.equal(distanceAtTime(energyData, 3), 300);

  assert.equal(timeAtDistance(energyData, -1), 0);
  assert.equal(timeAtDistance(energyData, 50), 0.5);
  assert.equal(timeAtDistance(energyData, 200), 1.5);
  assert.equal(timeAtDistance(energyData, 500), 2);
});

test('normalizeBeatmap rejects malformed notes', () => {
  assert.throws(() => normalizeBeatmap({}, { energyData, audioDuration: 2 }), /array/);
  assert.throws(() => normalizeBeatmap([
    { id: 'nan', time: Number.NaN, lane: 0 },
  ], { energyData, audioDuration: 2 }), /finite number/);
  assert.throws(() => normalizeBeatmap([
    { id: 'lane', time: 1, lane: 4 },
  ], { energyData, audioDuration: 2 }), /0 to 3/);
  assert.throws(() => normalizeBeatmap([
    { id: 'duration', time: 1.5, lane: 0, duration: 1 },
  ], { energyData, audioDuration: 2 }), /fit inside/);
});

test('normalizeBeatmap ignores stale runtime fields and recomputes distances', () => {
  const normalized = normalizeBeatmap([
    {
      id: 'hold',
      time: 0.5,
      lane: 2,
      duration: 1,
      hit: true,
      missed: true,
      cumulativeDistance: 9_999,
      cumulativeDistanceEnd: 10_000,
    },
  ], { energyData, audioDuration: 2 });

  assert.deepEqual(normalized, [{
    id: 'hold',
    time: 0.5,
    lane: 2,
    duration: 1,
    hit: false,
    missed: false,
    cumulativeDistance: 50,
    cumulativeDistanceEnd: 200,
  }]);
});

test('normalizeBeatmap sorts notes and creates stable ids when absent', () => {
  const input = [
    { time: 1, lane: 3 },
    { time: 0.5, lane: 1 },
  ];
  const first = normalizeBeatmap(input, { energyData, audioDuration: 2 });
  const second = normalizeBeatmap(input, { energyData, audioDuration: 2 });

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((note) => note.time), [0.5, 1]);
  assert.ok(first.every((note) => note.id.startsWith('note-')));
});
