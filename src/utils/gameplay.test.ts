import assert from 'node:assert/strict';
import test from 'node:test';
import { Note } from '../types';
import {
  cumulativeHoldScore,
  estimateAudibleContextTime,
  findClosestHittableNote,
} from './gameplay';

const note = (id: string, time: number, lane = 0): Note => ({
  id,
  time,
  lane,
  hit: false,
  missed: false,
});

test('findClosestHittableNote chooses the nearest note, not array order', () => {
  const notes = [note('earlier', 1), note('closer', 1.2), note('wrong-lane', 1.12, 1)];
  const match = findClosestHittableNote(notes, 0, 1.12, 0.135);

  assert.equal(match?.note.id, 'closer');
  assert.equal(match?.index, 1);
  assert.ok(Math.abs((match?.offset ?? 0) - 0.08) < 1e-12);
});

test('findClosestHittableNote ignores completed notes and breaks ties earlier', () => {
  const earlier = note('earlier', 0.9);
  const later = note('later', 1.1);
  const alreadyHit = note('hit', 1);
  alreadyHit.hit = true;

  const match = findClosestHittableNote([later, alreadyHit, earlier], 0, 1, 0.11);
  assert.equal(match?.note.id, 'earlier');
});

test('audible clock follows the output timestamp instead of running ahead with Web Audio', () => {
  const audibleTime = estimateAudibleContextTime({
    currentTime: 1,
    performanceNow: 1_050,
    outputTimestamp: { contextTime: 0.84, performanceTime: 1_000 },
    outputLatency: 0.2,
    baseLatency: 0.01,
  });

  assert.ok(Math.abs(audibleTime - 0.89) < 1e-12);
});

test('audible clock falls back to device output latency', () => {
  assert.equal(estimateAudibleContextTime({
    currentTime: 1,
    performanceNow: 1_000,
    outputLatency: 0.12,
    baseLatency: 0.01,
  }), 0.88);
});

const simulateHoldAtFps = (fps: number, duration: number): number => {
  let awardedScore = 0;
  let previousCumulativeScore = 0;
  const frameCount = Math.ceil(duration * fps);

  for (let frame = 1; frame <= frameCount; frame++) {
    const elapsed = Math.min(duration, frame / fps);
    const cumulativeScore = cumulativeHoldScore(elapsed);
    awardedScore += cumulativeScore - previousCumulativeScore;
    previousCumulativeScore = cumulativeScore;
  }
  return awardedScore;
};

test('cumulativeHoldScore awards the same total at 60 and 144 FPS', () => {
  const scoreAt60Fps = simulateHoldAtFps(60, 1);
  const scoreAt144Fps = simulateHoldAtFps(144, 1);

  assert.equal(scoreAt60Fps, 120);
  assert.equal(scoreAt144Fps, 120);
  assert.equal(scoreAt60Fps, scoreAt144Fps);
});

test('a late hold hit does not retroactively award earlier ticks', () => {
  const baselineAtHit = cumulativeHoldScore(0.12);
  const scoreAtRelease = cumulativeHoldScore(0.53) - baselineAtHit;
  const scoreAtEnd = cumulativeHoldScore(1) - baselineAtHit;

  assert.equal(baselineAtHit, 12);
  assert.equal(scoreAtRelease, 48);
  assert.equal(scoreAtEnd, 108);
});
