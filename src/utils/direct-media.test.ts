import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDirectMediaAnalysis } from './direct-media';

test('direct-media fallback analysis is deterministic and spans the track', () => {
  const first = buildDirectMediaAnalysis(12, 55);
  const second = buildDirectMediaAnalysis(12, 55);

  assert.deepEqual(first, second);
  assert.equal(first.energyData.length, 2);
  assert.deepEqual(first.energyData[0], {
    time: 0,
    energy: 0.45,
    cumulativeDistance: 0,
  });
  assert.equal(first.energyData[1].time, 12);
  assert.ok(first.energyData[1].cumulativeDistance > 0);
  assert.ok(first.beatmap.length > 0);
  assert.ok(first.beatmap.every(note => note.time >= 0 && note.time <= 12));
  assert.ok(first.beatmap.every(note => Number.isInteger(note.lane) && note.lane >= 0 && note.lane <= 3));
});

test('direct-media sensitivity changes note density without exceeding safe limits', () => {
  const sparse = buildDirectMediaAnalysis(30, 1).beatmap;
  const dense = buildDirectMediaAnalysis(30, 100).beatmap;

  assert.ok(dense.length > sparse.length);
  assert.ok(dense.length < 30 * 64);
});

test('direct-media fallback rejects invalid and oversized durations', () => {
  assert.throws(() => buildDirectMediaAnalysis(0, 50), /invalid duration/i);
  assert.throws(() => buildDirectMediaAnalysis(25 * 60 + 0.01, 50), /25 minutes/i);
});
