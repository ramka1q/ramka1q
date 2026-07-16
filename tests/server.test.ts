import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { ScoreSnapshot, StartGamePayload } from '../src/protocol';

const getAvailablePort = async () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') {
      probe.close();
      reject(new Error('Could not allocate a test port.'));
      return;
    }
    const { port } = address;
    probe.close(error => error ? reject(error) : resolve(port));
  });
});

const waitForServer = async (url: string, process: ChildProcess) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Test server exited with ${process.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child is still starting Vite.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the test server.');
};

const waitFor = <T extends unknown[]>(socket: Socket, event: string, timeout = 5_000) =>
  new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${event}.`)), timeout);
    socket.once(event, (...args: unknown[]) => {
      clearTimeout(timeoutId);
      resolve(args as T);
    });
  });

const connectClient = async (url: string) => {
  const socket = io(url, {
    extraHeaders: { Origin: url },
    transports: ['websocket'],
    reconnection: false,
  });
  await waitFor(socket, 'connect');
  return socket;
};

const expectNoEvent = async (
  socket: Socket,
  event: string,
  action: () => void,
  timeout = 250,
) => new Promise<void>((resolve, reject) => {
  const handleUnexpectedEvent = () => {
    clearTimeout(timeoutId);
    reject(new Error(`Unexpected ${event} event.`));
  };
  const timeoutId = setTimeout(() => {
    socket.off(event, handleUnexpectedEvent);
    resolve();
  }, timeout);
  socket.once(event, handleUnexpectedEvent);
  action();
});

const tinyWav = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x28, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00,
  0x01, 0x00, 0x08, 0x00, 0x64, 0x61, 0x74, 0x61,
  0x04, 0x00, 0x00, 0x00, 0x80, 0x81, 0x7f, 0x80,
]);

const binaryBytes = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Expected a binary Socket.IO payload.');
};

const roomPayload = {
  beatmap: [{
    id: 'note-1',
    time: 0.1,
    lane: 0,
    hit: false,
    missed: false,
    cumulativeDistance: 70,
    duration: 0.3,
  }],
  energyData: [
    { time: 0, energy: 0, cumulativeDistance: 0 },
    { time: 1, energy: 1, cumulativeDistance: 700 },
  ],
  audioBuffer: tinyWav,
  mimeType: 'audio/wav',
};

test('multiplayer rooms serialize commands and enforce lifecycle/membership', { timeout: 25_000 }, async (context) => {
  const port = await getAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const serverProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'server.ts', '--dev'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        APP_ORIGIN: url,
        TRUST_PROXY: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLogs = '';
  serverProcess.stdout.on('data', chunk => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', chunk => { serverLogs += chunk.toString(); });
  context.after(() => {
    if (serverProcess.exitCode === null) serverProcess.kill();
  });

  try {
    await waitForServer(url, serverProcess);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverLogs}`);
  }

  const healthResponse = await fetch(`${url}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok' });

  const host = await connectClient(url);
  const guest = await connectClient(url);
  const outsider = await connectClient(url);
  context.after(() => {
    host.disconnect();
    guest.disconnect();
    outsider.disconnect();
  });

  const serverTime = await new Promise<number>(resolve => host.emit('timeSync', resolve));
  assert.ok(Number.isFinite(serverTime));

  const densityError = waitFor<[string, string]>(host, 'roomError');
  host.emit('createRoom', {
    ...roomPayload,
    requestId: 'dense-create',
    beatmap: Array.from({ length: 65 }, (_, index) => ({
      id: `dense-${index}`,
      time: 0.1 + index / 1000,
      lane: index % 4,
      hit: false,
      missed: false,
    })),
  });
  const [densityMessage, densityRequestId] = await densityError;
  assert.match(densityMessage, /64 notes/i);
  assert.equal(densityRequestId, 'dense-create');

  const experimentalEffectsError = waitFor<[string, string]>(host, 'roomError');
  host.emit('createRoom', {
    ...roomPayload,
    requestId: 'invalid-experimental-effects',
    experimentalEffects: 'yes',
  });
  const [experimentalEffectsMessage, experimentalEffectsRequestId] = await experimentalEffectsError;
  assert.match(experimentalEffectsMessage, /must be a boolean/i);
  assert.equal(experimentalEffectsRequestId, 'invalid-experimental-effects');

  const createdRoomIds: string[] = [];
  const echoedRequestIds: string[] = [];
  const twoRoomsCreated = new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error('Timed out waiting for serialized rooms.')), 5_000);
    host.on('roomCreated', (roomId: string, requestId: string) => {
      createdRoomIds.push(roomId);
      echoedRequestIds.push(requestId);
      if (createdRoomIds.length === 2) {
        clearTimeout(timeoutId);
        resolve();
      }
    });
  });
  host.emit('createRoom', { ...roomPayload, requestId: 'create-1' });
  host.emit('createRoom', { ...roomPayload, requestId: 'create-2' });
  await twoRoomsCreated;
  assert.deepEqual(echoedRequestIds, ['create-1', 'create-2']);
  const [orphanedRoomId, activeRoomId] = createdRoomIds;
  assert.notEqual(orphanedRoomId, activeRoomId);

  const orphanError = waitFor<[string, string]>(outsider, 'roomError');
  outsider.emit('joinRoom', { roomId: orphanedRoomId, requestId: 'join-orphan' });
  const [orphanMessage, orphanRequestId] = await orphanError;
  assert.match(orphanMessage, /not found/i);
  assert.equal(orphanRequestId, 'join-orphan');

  const hostPlayerJoined = waitFor<[{ roomId: string; playerCount: number }]>(
    host,
    'playerJoined',
  );
  const guestPlayerJoined = waitFor<[{ roomId: string; playerCount: number }]>(
    guest,
    'playerJoined',
  );
  const joined = waitFor<[{
    requestId: string;
    audioBuffer: unknown;
    mimeType: string;
    experimentalEffects: boolean;
  }]>(guest, 'roomJoined');
  guest.emit('joinRoom', { roomId: activeRoomId, requestId: 'join-active' });
  const [joinedPayload] = await joined;
  assert.equal(joinedPayload.requestId, 'join-active');
  assert.equal(joinedPayload.mimeType, 'audio/wav');
  assert.equal(joinedPayload.experimentalEffects, false);
  assert.deepEqual(binaryBytes(joinedPayload.audioBuffer), tinyWav);
  assert.deepEqual((await hostPlayerJoined)[0], {
    roomId: activeRoomId,
    playerCount: 2,
  });
  assert.deepEqual((await guestPlayerJoined)[0], {
    roomId: activeRoomId,
    playerCount: 2,
  });

  // A delayed cleanup for an older operation must not leave the current room.
  host.emit('leaveRoom', orphanedRoomId);

  const hostStart = waitFor<[StartGamePayload]>(host, 'startGame');
  const guestStart = waitFor<[StartGamePayload]>(guest, 'startGame');
  host.emit('playerReady', activeRoomId);
  guest.emit('playerReady', activeRoomId);
  const [[hostStartPayload], [guestStartPayload]] = await Promise.all([hostStart, guestStart]);
  assert.equal(hostStartPayload.roomId, activeRoomId);
  assert.deepEqual(hostStartPayload, guestStartPayload);

  const unclaimedScoreError = waitFor<[string]>(host, 'gameplayError');
  host.emit('updateScore', {
    roomId: activeRoomId,
    sequence: 1,
    score: 350,
    combo: 1,
    misses: 0,
  });
  assert.match((await unclaimedScoreError)[0], /score exceeds/i);

  const futureHitError = waitFor<[string]>(host, 'gameplayError');
  host.emit('opponentHit', {
    roomId: activeRoomId,
    noteId: 'note-1',
    hitTime: 0.1,
  });
  assert.match((await futureHitError)[0], /ahead of the server clock/i);

  const membershipError = waitFor<[string]>(outsider, 'gameplayError');
  outsider.emit('opponentHit', { roomId: activeRoomId, lane: 0 });
  assert.match((await membershipError)[0], /not a member/i);

  const waitUntilFirstNote = Math.max(0, hostStartPayload.startTime + 120 - Date.now());
  await new Promise(resolve => setTimeout(resolve, waitUntilFirstNote));

  const opponentHit = waitFor<[{ lane: number }]>(guest, 'opponentHit');
  host.emit('opponentHit', {
    roomId: activeRoomId,
    noteId: 'note-1',
    hitTime: 0.1,
  });
  assert.deepEqual((await opponentHit)[0], { lane: 0 });

  await expectNoEvent(guest, 'opponentHit', () => {
    host.emit('opponentHit', {
      roomId: activeRoomId,
      noteId: 'note-1',
      hitTime: 0.1,
    });
  });

  const waitUntilHoldEnd = Math.max(0, hostStartPayload.startTime + 420 - Date.now());
  await new Promise(resolve => setTimeout(resolve, waitUntilHoldEnd));

  const acceptedScore = waitFor<[ScoreSnapshot]>(guest, 'opponentScore');
  host.emit('updateScore', {
    roomId: activeRoomId,
    sequence: 1,
    score: 386,
    combo: 1,
    misses: 0,
  });
  assert.deepEqual((await acceptedScore)[0], { score: 386, combo: 1, misses: 0 });

  const oversizedScoreError = waitFor<[string]>(host, 'gameplayError');
  host.emit('updateScore', {
    roomId: activeRoomId,
    sequence: 2,
    score: 387,
    combo: 1,
    misses: 0,
  });
  assert.match((await oversizedScoreError)[0], /score exceeds/i);

  await expectNoEvent(guest, 'opponentScore', () => {
    host.emit('updateScore', {
      roomId: activeRoomId,
      sequence: 2,
      score: 386,
      combo: 1,
      misses: 0,
    });
  });

  const playerLeft = waitFor(host, 'playerLeft');
  guest.disconnect();
  await playerLeft;

  const destroyedRoomError = waitFor<[string, string]>(outsider, 'roomError');
  outsider.emit('joinRoom', { roomId: activeRoomId, requestId: 'join-destroyed' });
  const [destroyedMessage, destroyedRequestId] = await destroyedRoomError;
  assert.match(destroyedMessage, /not found/i);
  assert.equal(destroyedRequestId, 'join-destroyed');

  // Hosting belongs to the socket that creates a room; it is not restricted to
  // the player that hosted an earlier room. Video containers can still be relayed
  // as audio sources, independently of the experimental visual-effects setting.
  const alternateRoomCreated = waitFor<[string, string]>(outsider, 'roomCreated');
  outsider.emit('createRoom', {
    ...roomPayload,
    requestId: 'alternate-host',
    mimeType: 'video/mp4',
    experimentalEffects: true,
  });
  const [alternateRoomId, alternateRequestId] = await alternateRoomCreated;
  assert.equal(alternateRequestId, 'alternate-host');

  const alternateJoin = waitFor<[{
    requestId: string;
    audioBuffer: unknown;
    mimeType: string;
    experimentalEffects: boolean;
  }]>(host, 'roomJoined');
  host.emit('joinRoom', { roomId: alternateRoomId, requestId: 'join-alternate' });
  const [alternatePayload] = await alternateJoin;
  assert.equal(alternatePayload.requestId, 'join-alternate');
  assert.equal(alternatePayload.mimeType, 'video/mp4');
  assert.equal(alternatePayload.experimentalEffects, true);
  assert.deepEqual(binaryBytes(alternatePayload.audioBuffer), tinyWav);
});
