import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import path from "node:path";
import express from "express";
import { Server, type Socket } from "socket.io";
import type { ViteDevServer } from "vite";
import type {
  Lane,
  OpponentHitPayload,
  ScoreSnapshot,
  StartGamePayload,
} from "./src/protocol";
import { cumulativeHoldScore, TIMING_EPSILON } from "./src/utils/gameplay";

const DEFAULT_PORT = 3000;
const ROOM_ID_LENGTH = 6;
const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_ID_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const ROOM_TTL_MS = 30 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;
const GAME_START_DELAY_MS = 4_000;
const GAME_EXPIRY_GRACE_MS = 60_000;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_SOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_ROOMS = 50;
const MAX_TOTAL_ROOM_STORAGE_BYTES = 256 * 1024 * 1024;
const MAX_NOTES = 50_000;
const MAX_NOTES_PER_SECOND = 64;
const MAX_HIT_REPORTS_PER_SECOND = 160;
const MAX_ENERGY_POINTS = 150_001;
const MAX_TRACK_SECONDS = 25 * 60;
const MAX_SCORE = 1_000_000_000;
const MAX_COMBO = 1_000_000;
const MAX_MISSES = 1_000_000;
const SCORE_CLOCK_TOLERANCE_SECONDS = 0.25;
const SICK_HIT_WINDOW_SECONDS = 0.045;
const GOOD_HIT_WINDOW_SECONDS = 0.09;
const MAX_HIT_WINDOW_SECONDS = 0.135;
const ESTIMATED_ROOM_OVERHEAD_BYTES = 16 * 1024;
const ESTIMATED_NOTE_BYTES = 384;
const ESTIMATED_ENERGY_POINT_BYTES = 160;
const MAX_CONNECTIONS_PER_ADDRESS = 12;
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = 30;
const MAX_ROOM_CREATES_PER_MINUTE = 8;
const MAX_ROOM_JOINS_PER_MINUTE = 30;
const MAX_ADDRESS_RATE_LIMIT_ENTRIES = 10_000;

type RoomState = "waiting" | "playing";

interface BeatmapNote {
  id: string;
  time: number;
  lane: Lane;
  hit: boolean;
  missed: boolean;
  cumulativeDistance?: number;
  duration?: number;
  cumulativeDistanceEnd?: number;
}

interface EnergyPoint {
  time: number;
  energy: number;
  cumulativeDistance: number;
}

interface Player {
  id: string;
  score: number;
  combo: number;
  misses: number;
  ready: boolean;
  hitNotes: Map<string, { headScore: number; holdBaselinePoints: number }>;
  lastScoreSequence: number;
}

interface Room {
  id: string;
  players: Map<string, Player>;
  beatmap: BeatmapNote[];
  energyData: EnergyPoint[];
  notesById: Map<string, BeatmapNote>;
  audioBuffer: Buffer;
  mimeType: string;
  experimentalEffects: boolean;
  storageBytes: number;
  state: RoomState;
  startTime?: number;
  lastActivityAt: number;
}

interface RoomJoinedPayload {
  roomId: string;
  requestId: string;
  beatmap: BeatmapNote[];
  energyData: EnergyPoint[];
  audioBuffer: Buffer;
  mimeType: string;
  experimentalEffects: boolean;
}

interface ClientToServerEvents {
  createRoom: (payload: unknown) => void;
  joinRoom: (roomId: unknown) => void;
  playerReady: (roomId: unknown) => void;
  updateScore: (payload: unknown) => void;
  opponentHit: (payload: unknown) => void;
  leaveRoom: (roomId?: unknown) => void;
  timeSync: (ack: (serverTime: number) => void) => void;
}

interface ServerToClientEvents {
  roomCreated: (roomId: string, requestId: string) => void;
  roomJoined: (payload: RoomJoinedPayload) => void;
  playerJoined: (payload: { roomId: string; playerCount: number }) => void;
  playerLeft: (roomId: string) => void;
  startGame: (payload: StartGamePayload) => void;
  opponentScore: (payload: ScoreSnapshot) => void;
  opponentHit: (payload: OpponentHitPayload) => void;
  roomError: (message: string, requestId?: string) => void;
  gameplayError: (message: string) => void;
}

interface InterServerEvents {}

interface SocketData {
  roomId?: string;
  taskQueue?: Promise<void>;
  rateLimits?: Map<string, { count: number; startedAt: number }>;
  clientAddress?: string;
}

type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

interface ValidatedCreateRoomPayload {
  requestId: string;
  beatmap: BeatmapNote[];
  energyData: EnergyPoint[];
  audioBuffer: Buffer;
  mimeType: string;
  experimentalEffects: boolean;
}

class ClientPayloadError extends Error {}

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }
  return port;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientPayloadError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ClientPayloadError(`${label} must be a finite number.`);
  }
  if (value < minimum || value > maximum) {
    throw new ClientPayloadError(`${label} is out of range.`);
  }
  return value;
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return finiteNumber(value, label, minimum, maximum);
}

function nonnegativeSafeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ClientPayloadError(`${label} must be a non-negative safe integer.`);
  }
  if ((value as number) > maximum) {
    throw new ClientPayloadError(`${label} exceeds the current allowed maximum.`);
  }
  return value as number;
}

function parseLane(value: unknown): Lane {
  const lane = finiteNumber(value, "lane", 0, 3);
  if (!Number.isInteger(lane)) {
    throw new ClientPayloadError("lane must be an integer from 0 to 3.");
  }
  return lane as Lane;
}

function parseBeatmap(value: unknown): BeatmapNote[] {
  if (!Array.isArray(value)) {
    throw new ClientPayloadError("beatmap must be an array.");
  }
  if (value.length > MAX_NOTES) {
    throw new ClientPayloadError(`beatmap exceeds the ${MAX_NOTES} note limit.`);
  }

  const ids = new Set<string>();
  const beatmap = value.map((rawNote, index): BeatmapNote => {
    const note = asRecord(rawNote, `beatmap[${index}]`);
    if (typeof note.id !== "string" || note.id.trim() === "" || note.id.length > 128) {
      throw new ClientPayloadError(`beatmap[${index}].id is invalid.`);
    }
    if (ids.has(note.id)) {
      throw new ClientPayloadError(`beatmap[${index}].id must be unique.`);
    }
    ids.add(note.id);

    if (note.hit !== undefined && typeof note.hit !== "boolean") {
      throw new ClientPayloadError(`beatmap[${index}].hit must be a boolean.`);
    }
    if (note.missed !== undefined && typeof note.missed !== "boolean") {
      throw new ClientPayloadError(`beatmap[${index}].missed must be a boolean.`);
    }

    const parsed: BeatmapNote = {
      id: note.id,
      time: finiteNumber(note.time, `beatmap[${index}].time`, 0, MAX_TRACK_SECONDS),
      lane: parseLane(note.lane),
      hit: false,
      missed: false,
    };

    const cumulativeDistance = optionalFiniteNumber(
      note.cumulativeDistance,
      `beatmap[${index}].cumulativeDistance`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const duration = optionalFiniteNumber(
      note.duration,
      `beatmap[${index}].duration`,
      0,
      MAX_TRACK_SECONDS,
    );
    const cumulativeDistanceEnd = optionalFiniteNumber(
      note.cumulativeDistanceEnd,
      `beatmap[${index}].cumulativeDistanceEnd`,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    if (cumulativeDistance !== undefined) parsed.cumulativeDistance = cumulativeDistance;
    if (duration !== undefined) parsed.duration = duration;
    if (cumulativeDistanceEnd !== undefined) {
      parsed.cumulativeDistanceEnd = cumulativeDistanceEnd;
    }
    if (duration !== undefined && parsed.time + duration > MAX_TRACK_SECONDS) {
      throw new ClientPayloadError(`beatmap[${index}] extends beyond the track limit.`);
    }
    if (
      cumulativeDistance !== undefined &&
      cumulativeDistanceEnd !== undefined &&
      cumulativeDistanceEnd < cumulativeDistance
    ) {
      throw new ClientPayloadError(
        `beatmap[${index}].cumulativeDistanceEnd cannot precede its start.`,
      );
    }
    return parsed;
  });

  beatmap.sort((left, right) => left.time - right.time || left.lane - right.lane);
  let densityWindowStart = 0;
  for (let index = 0; index < beatmap.length; index += 1) {
    while (
      densityWindowStart < index
      && beatmap[index].time - beatmap[densityWindowStart].time >= 1
    ) {
      densityWindowStart += 1;
    }
    if (index - densityWindowStart + 1 > MAX_NOTES_PER_SECOND) {
      throw new ClientPayloadError(
        `beatmap exceeds ${MAX_NOTES_PER_SECOND} notes in a one-second window.`,
      );
    }
  }
  return beatmap;
}

function parseEnergyData(value: unknown): EnergyPoint[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClientPayloadError("energyData must be a non-empty array.");
  }
  if (value.length > MAX_ENERGY_POINTS) {
    throw new ClientPayloadError(
      `energyData exceeds the ${MAX_ENERGY_POINTS} point limit.`,
    );
  }

  let previousTime = -1;
  let previousDistance = -1;
  return value.map((rawPoint, index): EnergyPoint => {
    const point = asRecord(rawPoint, `energyData[${index}]`);
    const time = finiteNumber(
      point.time,
      `energyData[${index}].time`,
      0,
      MAX_TRACK_SECONDS,
    );
    const energy = finiteNumber(point.energy, `energyData[${index}].energy`, 0, 1);
    const cumulativeDistance = finiteNumber(
      point.cumulativeDistance,
      `energyData[${index}].cumulativeDistance`,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    if (index === 0 && (time !== 0 || cumulativeDistance !== 0)) {
      throw new ClientPayloadError("energyData must start at time 0 and distance 0.");
    }

    if (index > 0 && time <= previousTime) {
      throw new ClientPayloadError("energyData times must be strictly increasing.");
    }
    if (index > 0 && cumulativeDistance <= previousDistance) {
      throw new ClientPayloadError("energyData distance must be strictly increasing.");
    }
    previousTime = time;
    previousDistance = cumulativeDistance;
    return { time, energy, cumulativeDistance };
  });
}

function parseAudioBuffer(value: unknown): Buffer {
  let audioBuffer: Buffer;
  try {
    if (Buffer.isBuffer(value)) {
      audioBuffer = value;
    } else if (value instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(value);
    } else if (ArrayBuffer.isView(value)) {
      audioBuffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new ClientPayloadError("audioBuffer must contain binary audio data.");
    }
  } catch (error) {
    if (error instanceof ClientPayloadError) throw error;
    throw new ClientPayloadError("audioBuffer is invalid or detached.");
  }

  if (audioBuffer.byteLength === 0) {
    throw new ClientPayloadError("audioBuffer cannot be empty.");
  }
  if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
    throw new ClientPayloadError("Audio files are limited to 32 MiB.");
  }
  return audioBuffer;
}

function parseMimeType(value: unknown): string {
  if (value === undefined || value === "") {
    return "application/octet-stream";
  }
  if (typeof value !== "string" || value.length > 128) {
    throw new ClientPayloadError("mimeType is invalid.");
  }

  const mimeType = value.trim().toLowerCase();
  if (
    !/^(audio|video)\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) &&
    mimeType !== "application/ogg" &&
    mimeType !== "application/octet-stream"
  ) {
    throw new ClientPayloadError("mimeType is not a supported audio/video type.");
  }
  return mimeType;
}

function parseExperimentalEffects(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ClientPayloadError("experimentalEffects must be a boolean.");
  }
  return value;
}

function parseRequestId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new ClientPayloadError("requestId is invalid.");
  }
  return value;
}

function readRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length <= 128
    ? requestId
    : undefined;
}

function parseCreateRoomPayload(value: unknown): ValidatedCreateRoomPayload {
  const payload = asRecord(value, "createRoom payload");
  const requestId = parseRequestId(payload.requestId);
  const beatmap = parseBeatmap(payload.beatmap);
  const energyData = parseEnergyData(payload.energyData);
  const energyEndTime = energyData[energyData.length - 1].time;
  if (beatmap.some((note) => note.time + (note.duration ?? 0) > energyEndTime + 0.02)) {
    throw new ClientPayloadError("beatmap notes must fit inside the analyzed track.");
  }
  const mimeType = parseMimeType(payload.mimeType);
  const experimentalEffects = parseExperimentalEffects(payload.experimentalEffects);
  return {
    requestId,
    beatmap,
    energyData,
    audioBuffer: parseAudioBuffer(payload.audioBuffer),
    mimeType,
    experimentalEffects,
  };
}

function normalizeRoomId(value: unknown): string {
  if (typeof value !== "string") {
    throw new ClientPayloadError("Room code must be a string.");
  }
  const roomId = value.trim().toUpperCase();
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new ClientPayloadError("Room code must contain 6 valid characters.");
  }
  return roomId;
}

function generateRoomId(rooms: Map<string, Room>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let roomId = "";
    for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
      roomId += ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)];
    }
    if (!rooms.has(roomId)) return roomId;
  }
  throw new Error("Unable to allocate a unique room code.");
}

function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.split(",", 1)[0]?.trim();
}

function normalizeClientAddress(address: string | undefined): string {
  const value = address?.trim() || "unknown";
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function parseTrustProxy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error("TRUST_PROXY must be either true or false.");
}

function resolveClientAddress(
  request: IncomingMessage,
  directAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwardedAddress = firstForwardedValue(request.headers["x-forwarded-for"]);
    if (forwardedAddress) return normalizeClientAddress(forwardedAddress);
  }
  return normalizeClientAddress(directAddress);
}

function isSameOriginRequest(request: IncomingMessage, trustProxy: boolean): boolean {
  const originHeader = firstForwardedValue(request.headers.origin);
  if (!originHeader) return true;

  const host = trustProxy
    ? firstForwardedValue(request.headers["x-forwarded-host"])
      ?? firstForwardedValue(request.headers.host)
    : firstForwardedValue(request.headers.host);
  if (!host) return false;

  const forwardedProtocol = trustProxy
    ? firstForwardedValue(request.headers["x-forwarded-proto"])
    : undefined;
  const encrypted = (
    request.socket as IncomingMessage["socket"] & { encrypted?: boolean }
  ).encrypted;
  const protocol = forwardedProtocol ?? (encrypted === true ? "https" : "http");

  try {
    const origin = new URL(originHeader);
    return (
      origin.protocol.toLowerCase() === `${protocol.toLowerCase()}:` &&
      origin.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function parseAllowedOrigin(rawOrigin: string | undefined): string | undefined {
  if (!rawOrigin?.trim()) return undefined;
  try {
    const origin = new URL(rawOrigin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new Error("APP_ORIGIN must use http or https.");
    }
    return origin.origin;
  } catch (error) {
    if (error instanceof Error && error.message === "APP_ORIGIN must use http or https.") {
      throw error;
    }
    throw new Error(`Invalid APP_ORIGIN value: ${rawOrigin}`);
  }
}

function isAllowedOriginRequest(
  request: IncomingMessage,
  allowedOrigin: string | undefined,
  trustProxy: boolean,
): boolean {
  if (!allowedOrigin) return isSameOriginRequest(request, trustProxy);
  const originHeader = firstForwardedValue(request.headers.origin);
  if (!originHeader) return true;
  try {
    return new URL(originHeader).origin === allowedOrigin;
  } catch {
    return false;
  }
}

function headScoreForOffset(offsetSeconds: number): number {
  const absoluteOffset = Math.abs(offsetSeconds);
  if (absoluteOffset <= SICK_HIT_WINDOW_SECONDS) return 350;
  if (absoluteOffset <= GOOD_HIT_WINDOW_SECONDS) return 200;
  return 50;
}

function maximumPlayerScoreAt(room: Room, player: Player, now: number): number {
  if (room.startTime === undefined) return 0;
  const elapsedSeconds = Math.max(
    0,
    (now - room.startTime) / 1000 + SCORE_CLOCK_TOLERANCE_SECONDS,
  );
  let maximumScore = 0;

  for (const [noteId, hit] of player.hitNotes) {
    const note = room.notesById.get(noteId);
    if (!note) continue;
    if (note.time > elapsedSeconds + MAX_HIT_WINDOW_SECONDS) continue;
    maximumScore += hit.headScore;
    if (note.duration && note.duration > 0) {
      const availableHoldSeconds = Math.min(
        note.duration,
        Math.max(0, elapsedSeconds - note.time),
      );
      const availableHoldPoints = cumulativeHoldScore(availableHoldSeconds);
      maximumScore += Math.max(0, availableHoldPoints - hit.holdBaselinePoints);
    }
  }
  return Math.min(MAX_SCORE, maximumScore);
}

function maximumMissesAt(room: Room, now: number): number {
  if (room.startTime === undefined) return 0;
  const elapsedSeconds = Math.max(
    0,
    (now - room.startTime) / 1000 + SCORE_CLOCK_TOLERANCE_SECONDS,
  );
  let resolvedNotes = 0;
  for (const note of room.beatmap) {
    if (note.time + MAX_HIT_WINDOW_SECONDS > elapsedSeconds) break;
    resolvedNotes += 1;
  }
  return resolvedNotes;
}

function maximumPlayerComboAt(room: Room, player: Player, now: number): number {
  if (room.startTime === undefined) return 0;
  const elapsedSeconds = Math.max(
    0,
    (now - room.startTime) / 1000 + SCORE_CLOCK_TOLERANCE_SECONDS,
  );
  let availableHits = 0;
  for (const noteId of player.hitNotes.keys()) {
    const note = room.notesById.get(noteId);
    if (note && note.time <= elapsedSeconds + MAX_HIT_WINDOW_SECONDS) {
      availableHits += 1;
    }
  }
  return availableHits;
}

function estimateRoomStorageBytes(payload: ValidatedCreateRoomPayload): number {
  const noteBytes = payload.beatmap.reduce(
    (total, note) => total + ESTIMATED_NOTE_BYTES + note.id.length * 2,
    0,
  );
  return ESTIMATED_ROOM_OVERHEAD_BYTES
    + payload.audioBuffer.byteLength
    + noteBytes
    + payload.energyData.length * ESTIMATED_ENERGY_POINT_BYTES
    + payload.mimeType.length * 2;
}

function clientErrorMessage(error: unknown): string {
  return error instanceof ClientPayloadError
    ? error.message
    : "Unexpected server error. Please try again.";
}

function runSocketTask(
  socket: GameSocket,
  eventName: string,
  task: () => Promise<void>,
  requestId?: string,
): void {
  const rateLimit = eventName === "updateScore"
    ? 12
    : eventName === "opponentHit"
      ? MAX_HIT_REPORTS_PER_SECOND
      : 6;
  const isGameplayEvent = eventName === "updateScore" || eventName === "opponentHit";
  if (!takeRateLimitSlot(socket, eventName, rateLimit)) {
    if (isGameplayEvent) {
      socket.emit("gameplayError", `Too many ${eventName} requests.`);
    } else {
      socket.emit("roomError", `Too many ${eventName} requests.`, requestId);
    }
    return;
  }
  const previousTask = socket.data.taskQueue ?? Promise.resolve();
  const nextTask = previousTask.then(async () => {
    if (!socket.connected) return;
    try {
      await task();
    } catch (error: unknown) {
      if (!(error instanceof ClientPayloadError)) {
        console.error(`Socket event ${eventName} failed for ${socket.id}:`, error);
      }
      if (socket.connected) {
        if (isGameplayEvent) {
          socket.emit("gameplayError", clientErrorMessage(error));
        } else {
          socket.emit("roomError", clientErrorMessage(error), requestId);
        }
      }
    }
  });
  socket.data.taskQueue = nextTask;
  void nextTask.finally(() => {
    if (socket.data.taskQueue === nextTask) delete socket.data.taskQueue;
  });
}

function takeRateLimitSlot(
  socket: GameSocket,
  eventName: string,
  maximumEvents: number,
  windowMs = 1_000,
): boolean {
  const now = Date.now();
  const rateLimits = socket.data.rateLimits ?? new Map();
  socket.data.rateLimits = rateLimits;
  const current = rateLimits.get(eventName);
  if (!current || now - current.startedAt >= windowMs) {
    rateLimits.set(eventName, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= maximumEvents) return false;
  current.count += 1;
  return true;
}

function takeSharedRateLimitSlot(
  rateLimits: Map<string, { count: number; startedAt: number }>,
  key: string,
  maximumEvents: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    if (!current && rateLimits.size >= MAX_ADDRESS_RATE_LIMIT_ENTRIES) return false;
    rateLimits.set(key, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= maximumEvents) return false;
  current.count += 1;
  return true;
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => reject(error);
    server.once("error", handleError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", handleError);
      resolve();
    });
  });
}

async function startServer(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const allowedOrigin = parseAllowedOrigin(
    process.env.APP_ORIGIN?.trim() || process.env.RENDER_EXTERNAL_URL,
  );
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const isDevelopment = process.argv.includes("--dev");
  const app = express();
  const server = http.createServer(app);
  const rooms = new Map<string, Room>();
  const addressRateLimits = new Map<string, { count: number; startedAt: number }>();
  const activeConnectionsByAddress = new Map<string, number>();
  let vite: ViteDevServer | undefined;

  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(server, {
    maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
    serveClient: false,
    ...(allowedOrigin ? {
      cors: { origin: allowedOrigin, methods: ["GET", "POST"] },
    } : {}),
    // Same-origin browser requests are accepted; cross-origin handshakes are rejected.
    allowRequest: (request, callback) => callback(
      null,
      isAllowedOriginRequest(request, allowedOrigin, trustProxy),
    ),
  });

  const addressRateLimitKey = (address: string, eventName: string): string =>
    `${address}\u0000${eventName}`;

  const takeAddressRateLimitSlot = (
    socket: GameSocket,
    eventName: string,
    maximumEvents: number,
  ): boolean => {
    const address = socket.data.clientAddress
      ?? normalizeClientAddress(socket.handshake.address);
    return takeSharedRateLimitSlot(
      addressRateLimits,
      addressRateLimitKey(address, eventName),
      maximumEvents,
      60_000,
    );
  };

  io.use((socket, next) => {
    const address = resolveClientAddress(
      socket.request,
      socket.handshake.address,
      trustProxy,
    );
    socket.data.clientAddress = address;
    if (!takeAddressRateLimitSlot(socket, "connection", MAX_CONNECTION_ATTEMPTS_PER_MINUTE)) {
      next(new Error("Too many connection attempts from this address."));
      return;
    }
    if ((activeConnectionsByAddress.get(address) ?? 0) >= MAX_CONNECTIONS_PER_ADDRESS) {
      next(new Error("Too many active connections from this address."));
      return;
    }
    next();
  });

  const touchRoom = (room: Room): void => {
    room.lastActivityAt = Date.now();
  };

  const destroyRoom = (roomId: string, message?: string): void => {
    const room = rooms.get(roomId);
    if (!room) return;
    rooms.delete(roomId);

    for (const playerId of room.players.keys()) {
      const peer = io.sockets.sockets.get(playerId);
      if (!peer) continue;
      if (peer.data.roomId === roomId) delete peer.data.roomId;
      if (message) peer.emit("roomError", message);
      void Promise.resolve(peer.leave(roomId)).catch((error: unknown) => {
        console.error(`Failed to remove ${playerId} from expired room ${roomId}:`, error);
      });
    }
  };

  const leaveCurrentRoom = async (socket: GameSocket, notifyPeer = true): Promise<void> => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    delete socket.data.roomId;

    try {
      await socket.leave(roomId);
    } finally {
      const room = rooms.get(roomId);
      if (!room) return;
      room.players.delete(socket.id);
      if (notifyPeer) io.to(roomId).emit("playerLeft", roomId);
      destroyRoom(roomId);
    }
  };

  const requireMembership = (
    socket: GameSocket,
    rawRoomId: unknown,
  ): { roomId: string; room: Room; player: Player } => {
    const roomId = normalizeRoomId(rawRoomId);
    const room = rooms.get(roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player || socket.data.roomId !== roomId) {
      if (!room && socket.data.roomId === roomId) delete socket.data.roomId;
      throw new ClientPayloadError("You are not a member of this room.");
    }
    return { roomId, room, player };
  };

  io.on("connection", (socket) => {
    const clientAddress = socket.data.clientAddress ?? "unknown";
    activeConnectionsByAddress.set(
      clientAddress,
      (activeConnectionsByAddress.get(clientAddress) ?? 0) + 1,
    );
    console.log("User connected", socket.id);

    socket.on("createRoom", (rawPayload) => {
      const requestId = readRequestId(rawPayload);
      if (!takeAddressRateLimitSlot(socket, "createRoom", MAX_ROOM_CREATES_PER_MINUTE)) {
        socket.emit(
          "roomError",
          "Too many room creation requests from this address.",
          requestId,
        );
        return;
      }
      runSocketTask(socket, "createRoom", async () => {
        const payload = parseCreateRoomPayload(rawPayload);
        await leaveCurrentRoom(socket);
        if (!socket.connected) return;
        if (rooms.size >= MAX_ROOMS) {
          throw new ClientPayloadError("The server has reached its room limit.");
        }
        const roomStorageBytes = estimateRoomStorageBytes(payload);
        const storedRoomBytes = [...rooms.values()].reduce(
          (total, room) => total + room.storageBytes,
          0,
        );
        if (storedRoomBytes + roomStorageBytes > MAX_TOTAL_ROOM_STORAGE_BYTES) {
          throw new ClientPayloadError("The server has reached its shared room-memory limit.");
        }

        const roomId = generateRoomId(rooms);
        const player: Player = {
          id: socket.id,
          score: 0,
          combo: 0,
          misses: 0,
          ready: false,
          hitNotes: new Map(),
          lastScoreSequence: -1,
        };
        const room: Room = {
          id: roomId,
          players: new Map([[socket.id, player]]),
          beatmap: payload.beatmap,
          energyData: payload.energyData,
          notesById: new Map(payload.beatmap.map(note => [note.id, note])),
          audioBuffer: payload.audioBuffer,
          mimeType: payload.mimeType,
          experimentalEffects: payload.experimentalEffects,
          storageBytes: roomStorageBytes,
          state: "waiting",
          lastActivityAt: Date.now(),
        };

        rooms.set(roomId, room);
        try {
          await socket.join(roomId);
          if (!socket.connected) throw new Error("Socket disconnected while creating room.");
          socket.data.roomId = roomId;
        } catch (error) {
          rooms.delete(roomId);
          throw error;
        }
        socket.emit("roomCreated", roomId, payload.requestId);
      }, requestId);
    });

    socket.on("joinRoom", (rawRequest) => {
      const requestId = readRequestId(rawRequest);
      if (!takeAddressRateLimitSlot(socket, "joinRoom", MAX_ROOM_JOINS_PER_MINUTE)) {
        socket.emit(
          "roomError",
          "Too many room join requests from this address.",
          requestId,
        );
        return;
      }
      runSocketTask(socket, "joinRoom", async () => {
        const request = asRecord(rawRequest, "joinRoom payload");
        const parsedRequestId = parseRequestId(request.requestId);
        const roomId = normalizeRoomId(request.roomId);
        const initialRoom = rooms.get(roomId);
        if (!initialRoom) throw new ClientPayloadError("Room not found.");
        if (initialRoom.state !== "waiting") {
          throw new ClientPayloadError("This room has already started.");
        }
        if (initialRoom.players.size >= 2) {
          throw new ClientPayloadError("This room is full.");
        }
        if (initialRoom.players.has(socket.id) || socket.data.roomId === roomId) {
          throw new ClientPayloadError("You have already joined this room.");
        }

        await leaveCurrentRoom(socket);
        if (!socket.connected) return;
        const room = rooms.get(roomId);
        if (!room || room.state !== "waiting" || room.players.size >= 2) {
          throw new ClientPayloadError("Room is no longer available.");
        }

        const player: Player = {
          id: socket.id,
          score: 0,
          combo: 0,
          misses: 0,
          ready: false,
          hitNotes: new Map(),
          lastScoreSequence: -1,
        };
        room.players.set(socket.id, player);
        try {
          await socket.join(roomId);
          if (!socket.connected) throw new Error("Socket disconnected while joining room.");
          socket.data.roomId = roomId;
        } catch (error) {
          room.players.delete(socket.id);
          throw error;
        }
        touchRoom(room);

        socket.emit("roomJoined", {
          roomId,
          requestId: parsedRequestId,
          beatmap: room.beatmap,
          energyData: room.energyData,
          audioBuffer: room.audioBuffer,
          mimeType: room.mimeType,
          experimentalEffects: room.experimentalEffects,
        });
        io.to(roomId).emit("playerJoined", {
          roomId,
          playerCount: room.players.size,
        });
      }, requestId);
    });

    socket.on("playerReady", (rawRoomId) => {
      runSocketTask(socket, "playerReady", async () => {
        const { roomId, room, player } = requireMembership(socket, rawRoomId);
        if (room.state !== "waiting") return;

        player.ready = true;
        touchRoom(room);
        if (
          room.players.size === 2 &&
          room.startTime === undefined &&
          [...room.players.values()].every((candidate) => candidate.ready)
        ) {
          room.state = "playing";
          room.startTime = Date.now() + GAME_START_DELAY_MS;
          io.to(roomId).emit("startGame", { roomId, startTime: room.startTime });
        }
      });
    });

    socket.on("updateScore", (rawPayload) => {
      runSocketTask(socket, "updateScore", async () => {
        const payload = asRecord(rawPayload, "updateScore payload");
        const { roomId, room, player } = requireMembership(socket, payload.roomId);
        if (room.state !== "playing") {
          throw new ClientPayloadError("The game has not started.");
        }

        const now = Date.now();
        const sequence = nonnegativeSafeInteger(
          payload.sequence,
          "sequence",
          Number.MAX_SAFE_INTEGER,
        );
        if (sequence <= player.lastScoreSequence) return;

        const score = nonnegativeSafeInteger(
          payload.score,
          "score",
          maximumPlayerScoreAt(room, player, now),
        );
        const combo = nonnegativeSafeInteger(
          payload.combo,
          "combo",
          Math.min(MAX_COMBO, maximumPlayerComboAt(room, player, now)),
        );
        const misses = nonnegativeSafeInteger(
          payload.misses,
          "misses",
          Math.min(MAX_MISSES, maximumMissesAt(room, now)),
        );
        if (score < player.score) {
          throw new ClientPayloadError("score cannot decrease.");
        }
        if (misses < player.misses) {
          throw new ClientPayloadError("misses cannot decrease.");
        }

        player.lastScoreSequence = sequence;
        if (score === player.score && combo === player.combo && misses === player.misses) {
          return;
        }
        player.score = score;
        player.combo = combo;
        player.misses = misses;
        touchRoom(room);

        socket.to(roomId).emit("opponentScore", {
          score: player.score,
          combo: player.combo,
          misses: player.misses,
        });
      });
    });

    socket.on("opponentHit", (rawPayload) => {
      runSocketTask(socket, "opponentHit", async () => {
        const payload = asRecord(rawPayload, "opponentHit payload");
        const { roomId, room, player } = requireMembership(socket, payload.roomId);
        if (room.state !== "playing") {
          throw new ClientPayloadError("The game has not started.");
        }

        if (typeof payload.noteId !== "string" || payload.noteId.length > 128) {
          throw new ClientPayloadError("noteId is invalid.");
        }
        const note = room.notesById.get(payload.noteId);
        if (!note) throw new ClientPayloadError("The reported note does not exist.");
        if (player.hitNotes.has(note.id)) return;

        const hitTime = finiteNumber(
          payload.hitTime,
          "hitTime",
          0,
          MAX_TRACK_SECONDS,
        );
        const hitOffset = hitTime - note.time;
        if (Math.abs(hitOffset) > MAX_HIT_WINDOW_SECONDS + TIMING_EPSILON) {
          throw new ClientPayloadError("The reported hit is outside the timing window.");
        }

        const serverElapsed = (Date.now() - room.startTime!) / 1000;
        if (
          note.time > serverElapsed
            + SCORE_CLOCK_TOLERANCE_SECONDS
            + MAX_HIT_WINDOW_SECONDS
        ) {
          throw new ClientPayloadError("The reported hit is ahead of the server clock.");
        }

        const heldBeforeHit = note.duration
          ? Math.min(note.duration, Math.max(0, hitTime - note.time))
          : 0;
        player.hitNotes.set(note.id, {
          headScore: headScoreForOffset(hitOffset),
          holdBaselinePoints: cumulativeHoldScore(heldBeforeHit),
        });
        touchRoom(room);
        socket.to(roomId).emit("opponentHit", { lane: note.lane });
      });
    });

    socket.on("leaveRoom", (rawRoomId) => {
      runSocketTask(socket, "leaveRoom", async () => {
        if (rawRoomId !== undefined) {
          const roomId = normalizeRoomId(rawRoomId);
          if (socket.data.roomId !== roomId) return;
        }
        await leaveCurrentRoom(socket);
      });
    });

    socket.on("timeSync", (ack) => {
      if (typeof ack === "function" && takeRateLimitSlot(socket, "timeSync", 10)) {
        ack(Date.now());
      }
    });

    socket.on("disconnect", () => {
      const remainingConnections = (activeConnectionsByAddress.get(clientAddress) ?? 1) - 1;
      if (remainingConnections > 0) {
        activeConnectionsByAddress.set(clientAddress, remainingConnections);
      } else {
        activeConnectionsByAddress.delete(clientAddress);
      }
      const roomId = socket.data.roomId;
      delete socket.data.roomId;
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.players.delete(socket.id);
          io.to(roomId).emit("playerLeft", roomId);
          destroyRoom(roomId);
        }
      }
      console.log("User disconnected", socket.id);
    });
  });

  try {
    if (isDevelopment) {
      const { createServer: createViteServer } = await import("vite");
      const entryDirectory = process.argv[1]
        ? path.dirname(path.resolve(process.argv[1]))
        : process.cwd();
      vite = await createViteServer({
        root: entryDirectory,
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      const serverDirectory = process.argv[1]
        ? path.dirname(path.resolve(process.argv[1]))
        : path.resolve(process.cwd(), "dist", "server");
      const clientDirectory = path.resolve(serverDirectory, "..", "client");
      const indexPath = path.join(clientDirectory, "index.html");
      if (!existsSync(indexPath)) {
        throw new Error(`Production client was not found at ${indexPath}`);
      }

      app.use(express.static(clientDirectory, { index: false }));
      app.get("/{*splat}", (_request, response) => {
        response.sendFile(indexPath);
      });
    }

    await listen(server, port);
  } catch (error) {
    await vite?.close().catch(() => undefined);
    io.close();
    throw error;
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    const expirationThreshold = now - ROOM_TTL_MS;
    for (const [roomId, room] of rooms) {
      const trackEndTime = room.energyData[room.energyData.length - 1]?.time ?? 0;
      const gameExpired = room.startTime !== undefined
        && now > room.startTime + trackEndTime * 1000 + GAME_EXPIRY_GRACE_MS;
      if (gameExpired || room.lastActivityAt < expirationThreshold) {
        destroyRoom(
          roomId,
          gameExpired
            ? "Room expired after the game ended."
            : "Room expired due to inactivity.",
        );
      }
    }
    const rateLimitExpirationThreshold = now - 2 * 60_000;
    for (const [key, rateLimit] of addressRateLimits) {
      if (rateLimit.startedAt < rateLimitExpirationThreshold) {
        addressRateLimits.delete(key);
      }
    }
  }, ROOM_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  let isShuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(cleanupTimer);
    console.log(`Received ${signal}; shutting down.`);

    for (const roomId of [...rooms.keys()]) destroyRoom(roomId);
    await vite?.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    console.log("Server stopped.");
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).catch((error: unknown) => {
        console.error("Graceful shutdown failed:", error);
        process.exitCode = 1;
      });
    });
  }

  console.log(
    `Server running on http://localhost:${port} (${isDevelopment ? "development" : "production"})`,
  );
}

void startServer().catch((error: unknown) => {
  console.error("Failed to start server:", error);
  process.exitCode = 1;
});
