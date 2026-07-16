import assert from 'node:assert/strict';
import test from 'node:test';
import { EnergyData } from '../types';
import {
  activeExperimentalEventAt,
  detectExperimentalEvents,
  experimentalLanePosition,
  experimentalLaneVerticalOffset,
  experimentalReceptorOpacity,
} from './experimental-events';

const energyTrack = (duration: number, energyAt: (time: number) => number): EnergyData[] =>
  Array.from({ length: Math.floor(duration * 4) + 1 }, (_, index) => {
    const time = index / 4;
    return {
      time,
      energy: energyAt(time),
      cumulativeDistance: time * 700,
    };
  });

test('detects spaced quiet breaks after loud sections deterministically', () => {
  const track = energyTrack(65, time => {
    if ((time >= 9 && time < 16) || (time >= 30 && time < 37)) return 0.9;
    if ((time >= 16 && time < 21) || (time >= 37 && time < 43)) return 0.12;
    return 0.45;
  });

  const first = detectExperimentalEvents(track, 65);
  const second = detectExperimentalEvents(track, 65);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map(event => event.kind), ['lane-swap', 'arrow-flight']);
  assert.ok(first[1].time - first[0].time >= 18);
});

test('does not create events for a track without a loud-to-quiet transition', () => {
  const steadyTrack = energyTrack(60, () => 0.65);
  assert.deepEqual(detectExperimentalEvents(steadyTrack, 60), []);
});

test('lane swaps animate in and back without changing logical lane values', () => {
  const event = detectExperimentalEvents(energyTrack(30, time => {
    if (time >= 9 && time < 16) return 0.9;
    if (time >= 16 && time < 21) return 0.1;
    return 0.4;
  }), 30)[0];
  assert.ok(event);
  assert.equal(event.kind, 'lane-swap');
  assert.equal(experimentalLanePosition(0, event, event.time - 0.1), 0);
  assert.equal(experimentalLanePosition(0, event, event.time + 1.2), event.laneOrder[0]);
  assert.equal(experimentalLanePosition(0, event, event.time + event.duration + 0.1), 0);
  assert.notEqual(experimentalLaneVerticalOffset(0, event, event.time + 0.3), 0);
  assert.equal(experimentalLaneVerticalOffset(0, event, event.time + 1.2), 0);
  assert.equal(activeExperimentalEventAt([event], event.time + 1), event);
});

test('arrow-flight events hide receptors only during the transition', () => {
  const event = {
    id: 'flight',
    time: 10,
    duration: 2.4,
    kind: 'arrow-flight' as const,
    laneOrder: [0, 1, 2, 3] as const,
  };
  assert.equal(experimentalReceptorOpacity(event, 9.9), 1);
  assert.equal(experimentalReceptorOpacity(event, 11), 0);
  assert.equal(experimentalReceptorOpacity(event, 12.5), 1);
});
