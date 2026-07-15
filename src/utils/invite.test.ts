import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInviteUrl,
  isLoopbackHostname,
  normalizeRoomCode,
  roomCodeFromSearch,
} from './invite';

test('room invite helpers normalize and validate room codes', () => {
  assert.equal(normalizeRoomCode(' abcd23 '), 'ABCD23');
  assert.equal(normalizeRoomCode('AIO10Z'), 'AZ');
  assert.equal(roomCodeFromSearch('?room=abcd23'), 'ABCD23');
  assert.equal(roomCodeFromSearch('?room=invalid'), null);
});

test('createInviteUrl keeps the public path and replaces stale query/hash data', () => {
  assert.equal(
    createInviteUrl('https://game.example/play?old=1#section', 'ABCD23'),
    'https://game.example/play?room=ABCD23',
  );
});

test('loopback hosts are not presented as remote invite links', () => {
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('game.example'), false);
});
