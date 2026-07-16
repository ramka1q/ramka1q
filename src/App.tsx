import { Check, Copy, Loader2, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import Game from './components/Game';
import Setup from './components/Setup';
import {
  HitReport,
  ScoreSnapshot,
  ScoreUpdatePayload,
  StartGamePayload,
} from './protocol';
import { EnergyData, Note } from './types';
import { analyzeAudio, decodeMediaAudio } from './utils/audio';
import { normalizeBeatmap } from './utils/beatmap';
import { createInviteUrl, isLoopbackHostname } from './utils/invite';
import { encodeMonoPcm16Wav, WAV_MIME_TYPE } from './utils/wav';

type MultiplayerState = 'waiting' | 'playing' | null;
type MultiplayerRole = 'host' | 'guest' | null;
type InviteCopyState = 'idle' | 'copied';

interface RoomJoinedPayload {
  roomId: string;
  requestId: string;
  beatmap: unknown;
  energyData: unknown;
  audioBuffer: unknown;
  mimeType: unknown;
}

interface PlayerJoinedPayload {
  roomId: string;
  playerCount: number;
}

const MAX_SHARED_VIDEO_BYTES = 32 * 1024 * 1024;

const isVideoFile = (file: File): boolean =>
  file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name);

const videoMimeType = (file: File): string => {
  if (file.type.startsWith('video/')) return file.type;
  if (/\.webm$/i.test(file.name)) return 'video/webm';
  return 'video/mp4';
};

const createRequestId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
};

const createPlaybackContext = () => {
  const AudioContextClass = window.AudioContext || (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio is not supported by this browser.');
  return new AudioContextClass();
};

const toArrayBuffer = (value: unknown): ArrayBuffer => {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return bytes.slice().buffer;
  }
  if (typeof value === 'object' && value !== null && 'data' in value) {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data) && data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      return Uint8Array.from(data).buffer;
    }
  }
  throw new TypeError('The room audio payload is invalid.');
};

const copyTextToClipboard = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for browsers that expose Clipboard API but deny access.
    }
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.readOnly = true;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy command was rejected.');
  } finally {
    textArea.remove();
  }
};

const parseEnergyData = (value: unknown): EnergyData[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('The room energy data is invalid.');
  }
  return value.map((point, index) => {
    if (typeof point !== 'object' || point === null) {
      throw new TypeError(`energyData[${index}] must be an object.`);
    }
    const candidate = point as Record<string, unknown>;
    if (typeof candidate.time !== 'number'
      || typeof candidate.energy !== 'number'
      || typeof candidate.cumulativeDistance !== 'number') {
      throw new TypeError(`energyData[${index}] contains invalid values.`);
    }
    return {
      time: candidate.time,
      energy: candidate.energy,
      cumulativeDistance: candidate.cumulativeDistance,
    };
  });
};

const synchronizeClock = async (socket: Socket): Promise<number> => {
  const samples: Array<{ offset: number; roundTrip: number }> = [];

  for (let attempt = 0; attempt < 4; attempt++) {
    const sample = await new Promise<{ offset: number; roundTrip: number } | null>(resolve => {
      const sentAtEpoch = Date.now();
      const sentAtPerformance = performance.now();
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, 1500);

      socket.emit('timeSync', (serverTime: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        const receivedAtEpoch = Date.now();
        if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) {
          resolve(null);
          return;
        }
        resolve({
          offset: serverTime - ((sentAtEpoch + receivedAtEpoch) / 2),
          roundTrip: performance.now() - sentAtPerformance,
        });
      });
    });
    if (sample) samples.push(sample);
  }

  if (samples.length === 0) throw new Error('Could not synchronize with the multiplayer server.');
  samples.sort((left, right) => left.roundTrip - right.roundTrip);
  return samples[0].offset;
};

export default function App() {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoShareNotice, setVideoShareNotice] = useState<string | null>(null);
  const [playbackContext, setPlaybackContext] = useState<AudioContext | null>(null);
  const [beatmap, setBeatmap] = useState<Note[]>([]);
  const [energyData, setEnergyData] = useState<EnergyData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Generating beatmap…');
  const [appError, setAppError] = useState<string | null>(null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [multiplayerState, setMultiplayerState] = useState<MultiplayerState>(null);
  const [multiplayerRole, setMultiplayerRole] = useState<MultiplayerRole>(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [inviteCopyState, setInviteCopyState] = useState<InviteCopyState>('idle');
  const [serverStartTime, setServerStartTime] = useState<number | null>(null);
  const [opponentScore, setOpponentScore] = useState<ScoreSnapshot>({ score: 0, combo: 0, misses: 0 });

  const socketRef = useRef<Socket | null>(null);
  const socketConnectionRef = useRef<Promise<Socket> | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const clockOffsetRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const pendingMultiplayerGenerationRef = useRef(0);
  const pendingRequestIdRef = useRef<string | null>(null);
  const scoreSequenceRef = useRef(0);
  const videoUrlRef = useRef<string | null>(null);

  const replaceVideo = useCallback((blob: Blob | null) => {
    const previousUrl = videoUrlRef.current;
    const nextUrl = blob ? URL.createObjectURL(blob) : null;
    videoUrlRef.current = nextUrl;
    setVideoUrl(nextUrl);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }, []);

  const ensurePlaybackContext = useCallback(async () => {
    let context = playbackContextRef.current;
    if (!context || context.state === 'closed') {
      context = createPlaybackContext();
      playbackContextRef.current = context;
      setPlaybackContext(context);
    }
    if (context.state === 'suspended') await context.resume();
    return context;
  }, []);

  const resetSession = useCallback((leaveRoom = true) => {
    sessionGenerationRef.current += 1;
    const activeRoomId = roomIdRef.current;
    if (leaveRoom && activeRoomId && socketRef.current) {
      socketRef.current.emit('leaveRoom', activeRoomId);
    }
    roomIdRef.current = null;
    pendingRequestIdRef.current = null;
    setRoomId(null);
    setAudioBuffer(null);
    replaceVideo(null);
    setVideoShareNotice(null);
    setPlaybackContext(null);
    setBeatmap([]);
    setEnergyData([]);
    setIsMultiplayer(false);
    setMultiplayerState(null);
    setMultiplayerRole(null);
    setPlayerCount(0);
    setInviteCopyState('idle');
    setServerStartTime(null);
    setOpponentScore({ score: 0, combo: 0, misses: 0 });
    setIsLoading(false);
    scoreSequenceRef.current = 0;

    const context = playbackContextRef.current;
    playbackContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }, [replaceVideo]);

  const connectSocket = useCallback(async (): Promise<Socket> => {
    const existing = socketRef.current;
    if (existing?.connected) return existing;
    if (socketConnectionRef.current) return socketConnectionRef.current;

    const connection = new Promise<Socket>((resolve, reject) => {
      const socket = existing ?? io({ autoConnect: false });
      socketRef.current = socket;

      if (!existing) {
        socket.on('roomCreated', (id: string, requestId: string) => {
          if (pendingMultiplayerGenerationRef.current !== sessionGenerationRef.current
            || requestId !== pendingRequestIdRef.current) {
            if (typeof id === 'string') socket.emit('leaveRoom', id);
            return;
          }
          roomIdRef.current = id;
          setRoomId(id);
          setIsMultiplayer(true);
          setMultiplayerState('waiting');
          setMultiplayerRole('host');
          setPlayerCount(1);
          setIsLoading(false);
          socket.emit('playerReady', id);
        });

        socket.on('roomJoined', (payload: RoomJoinedPayload) => {
          void (async () => {
            const generation = pendingMultiplayerGenerationRef.current;
            const requestId = pendingRequestIdRef.current;
            const isCurrentRequest = () => generation === sessionGenerationRef.current
              && requestId !== null
              && requestId === pendingRequestIdRef.current
              && payload?.requestId === requestId;
            if (!isCurrentRequest()) {
              if (typeof payload?.roomId === 'string') socket.emit('leaveRoom', payload.roomId);
              return;
            }
            roomIdRef.current = payload.roomId;
            setRoomId(payload.roomId);
            setLoadingText('Decoding shared audio…');
            setIsLoading(true);
            try {
              const context = await ensurePlaybackContext();
              if (!isCurrentRequest()) {
                socket.emit('leaveRoom', payload.roomId);
                return;
              }
              const sharedMedia = toArrayBuffer(payload.audioBuffer);
              const sharedMimeType = typeof payload.mimeType === 'string'
                ? payload.mimeType.trim().toLowerCase()
                : '';
              const sharedVideo = sharedMimeType.startsWith('video/')
                ? new Blob([sharedMedia.slice(0)], { type: sharedMimeType })
                : null;
              const decodedBuffer = sharedVideo
                ? await decodeMediaAudio(sharedVideo, context, true, message => {
                    if (isCurrentRequest()) setLoadingText(message);
                  })
                : await context.decodeAudioData(sharedMedia);
              if (!isCurrentRequest()) {
                socket.emit('leaveRoom', payload.roomId);
                return;
              }
              const joinedEnergyData = parseEnergyData(payload.energyData);
              const joinedBeatmap = normalizeBeatmap(payload.beatmap, {
                energyData: joinedEnergyData,
                audioDuration: decodedBuffer.duration,
              });

              setAudioBuffer(decodedBuffer);
              replaceVideo(sharedVideo);
              setVideoShareNotice(null);
              setBeatmap(joinedBeatmap);
              setEnergyData(joinedEnergyData);
              setIsMultiplayer(true);
              setMultiplayerState('waiting');
              setMultiplayerRole('guest');
              setPlayerCount(2);
              setIsLoading(false);
              const currentUrl = new URL(window.location.href);
              if (currentUrl.searchParams.has('room')) {
                currentUrl.searchParams.delete('room');
                window.history.replaceState(window.history.state, '', currentUrl);
              }
              socket.emit('playerReady', payload.roomId);
            } catch (error) {
              if (!isCurrentRequest()) return;
              console.error(error);
              socket.emit('leaveRoom', payload.roomId);
              resetSession(false);
              setAppError(error instanceof Error ? error.message : 'Could not load the room audio.');
            }
          })();
        });

        socket.on('startGame', (payload: StartGamePayload) => {
          if (!payload
            || payload.roomId !== roomIdRef.current
            || pendingMultiplayerGenerationRef.current !== sessionGenerationRef.current) {
            return;
          }
          if (!Number.isFinite(payload.startTime)) {
            setAppError('The server returned an invalid start time.');
            return;
          }
          setServerStartTime(payload.startTime - clockOffsetRef.current);
          setMultiplayerState('playing');
          setIsLoading(false);
        });

        socket.on('opponentScore', (data: ScoreSnapshot) => {
          if (data && Number.isFinite(data.score) && Number.isFinite(data.combo) && Number.isFinite(data.misses)) {
            setOpponentScore(data);
          }
        });

        socket.on('playerJoined', (payload: PlayerJoinedPayload) => {
          if (!payload
            || payload.roomId !== roomIdRef.current
            || !Number.isInteger(payload.playerCount)
            || payload.playerCount < 1
            || payload.playerCount > 2) {
            return;
          }
          setPlayerCount(payload.playerCount);
        });

        socket.on('playerLeft', (leftRoomId: string) => {
          if (leftRoomId !== roomIdRef.current) return;
          resetSession(true);
          setAppError('The other player left the room.');
        });

        socket.on('roomError', (message: unknown, requestId?: string) => {
          if (requestId !== undefined && requestId !== pendingRequestIdRef.current) return;
          if (!roomIdRef.current && (
            requestId === undefined
            || pendingMultiplayerGenerationRef.current !== sessionGenerationRef.current
          )) {
            return;
          }
          resetSession(true);
          setAppError(typeof message === 'string' ? message : 'The multiplayer request failed.');
        });

        socket.on('gameplayError', (message: unknown) => {
          if (!roomIdRef.current) return;
          setAppError(typeof message === 'string' ? message : 'A gameplay update was rejected.');
        });

        socket.on('connect_error', (error: Error) => {
          if (!roomIdRef.current
            && pendingMultiplayerGenerationRef.current !== sessionGenerationRef.current) {
            return;
          }
          setIsLoading(false);
          setAppError(`Multiplayer connection failed: ${error.message}`);
        });

        socket.on('disconnect', () => {
          const hasPendingRequest = pendingMultiplayerGenerationRef.current !== 0
            && pendingMultiplayerGenerationRef.current === sessionGenerationRef.current;
          if (!roomIdRef.current && !hasPendingRequest) return;
          resetSession(false);
          setAppError('The multiplayer connection was lost.');
        });
      }

      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while connecting to the multiplayer server.'));
      }, 8000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        socket.off('connect', handleConnect);
        socket.off('connect_error', handleInitialError);
      };
      const handleConnect = () => {
        cleanup();
        resolve(socket);
      };
      const handleInitialError = (error: Error) => {
        cleanup();
        reject(error);
      };

      socket.once('connect', handleConnect);
      socket.once('connect_error', handleInitialError);
      socket.connect();
    });

    socketConnectionRef.current = connection;
    try {
      return await connection;
    } finally {
      socketConnectionRef.current = null;
    }
  }, [ensurePlaybackContext, replaceVideo, resetSession]);

  useEffect(() => () => {
    sessionGenerationRef.current += 1;
    roomIdRef.current = null;
    socketRef.current?.disconnect();
    const context = playbackContextRef.current;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
  }, []);

  const handleStart = async (
    file: File,
    sensitivity: number,
    beatmapFile?: File,
    mode: 'single' | 'create' = 'single',
  ) => {
    const generation = sessionGenerationRef.current + 1;
    const requestId = mode === 'create' ? createRequestId() : null;
    sessionGenerationRef.current = generation;
    pendingMultiplayerGenerationRef.current = mode === 'create' ? generation : 0;
    pendingRequestIdRef.current = requestId;
    scoreSequenceRef.current = 0;
    setIsLoading(true);
    setAppError(null);
    setLoadingText('Analyzing transients and generating beatmap…');

    try {
      const contextPromise = ensurePlaybackContext();
      const socketPromise = mode === 'create' ? connectSocket() : Promise.resolve(null);
      const [{ buffer, beatmap: generatedBeatmap, energyData: generatedEnergyData }, context, socket] = await Promise.all([
        analyzeAudio(file, sensitivity, message => {
          if (generation === sessionGenerationRef.current) setLoadingText(message);
        }),
        contextPromise,
        socketPromise,
      ]);
      if (generation !== sessionGenerationRef.current) return;

      let finalBeatmap = generatedBeatmap;
      if (beatmapFile) {
        const beatmapText = await beatmapFile.text();
        if (generation !== sessionGenerationRef.current) return;
        finalBeatmap = normalizeBeatmap(JSON.parse(beatmapText) as unknown, {
          energyData: generatedEnergyData,
          audioDuration: buffer.duration,
        });
      }

      setPlaybackContext(context);
      setAudioBuffer(buffer);
      const sourceIsVideo = isVideoFile(file);
      replaceVideo(sourceIsVideo ? file : null);
      setVideoShareNotice(null);
      setBeatmap(finalBeatmap);
      setEnergyData(generatedEnergyData);

      if (mode === 'create' && socket) {
        const canShareVideo = sourceIsVideo && file.size <= MAX_SHARED_VIDEO_BYTES;
        setLoadingText(canShareVideo ? 'Preparing shared video…' : 'Optimizing shared audio…');
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        if (generation !== sessionGenerationRef.current
          || requestId !== pendingRequestIdRef.current) return;
        const sharedMedia = canShareVideo
          ? await file.arrayBuffer()
          : encodeMonoPcm16Wav(buffer);
        if (generation !== sessionGenerationRef.current
          || requestId !== pendingRequestIdRef.current) return;
        const sharedMimeType = canShareVideo ? videoMimeType(file) : WAV_MIME_TYPE;
        if (sourceIsVideo && !canShareVideo) {
          setVideoShareNotice('The video is over 32 MiB, so your friend will receive synchronized audio without the video.');
        }

        setLoadingText('Creating room…');
        clockOffsetRef.current = await synchronizeClock(socket);
        if (generation !== sessionGenerationRef.current
          || requestId !== pendingRequestIdRef.current) return;
        setIsMultiplayer(true);
        setMultiplayerState('waiting');
        socket.emit('createRoom', {
          requestId,
          beatmap: finalBeatmap,
          energyData: generatedEnergyData,
          audioBuffer: sharedMedia,
          mimeType: sharedMimeType,
        });
      } else {
        setIsMultiplayer(false);
        setMultiplayerState(null);
        setIsLoading(false);
      }
    } catch (error) {
      if (generation !== sessionGenerationRef.current) return;
      console.error(error);
      resetSession(false);
      setAppError(error instanceof Error ? error.message : 'Could not process the selected files.');
    }
  };

  const handleJoin = async (id: string) => {
    const generation = sessionGenerationRef.current + 1;
    const requestId = createRequestId();
    sessionGenerationRef.current = generation;
    pendingMultiplayerGenerationRef.current = generation;
    pendingRequestIdRef.current = requestId;
    scoreSequenceRef.current = 0;
    setLoadingText('Joining room…');
    setIsLoading(true);
    setAppError(null);
    try {
      await ensurePlaybackContext();
      if (generation !== sessionGenerationRef.current) return;
      const socket = await connectSocket();
      if (generation !== sessionGenerationRef.current) return;
      clockOffsetRef.current = await synchronizeClock(socket);
      if (generation !== sessionGenerationRef.current
        || requestId !== pendingRequestIdRef.current) return;
      socket.emit('joinRoom', {
        roomId: id.trim().toUpperCase(),
        requestId,
      });
    } catch (error) {
      if (generation !== sessionGenerationRef.current) return;
      resetSession(false);
      setAppError(error instanceof Error ? error.message : 'Could not join the room.');
    }
  };

  const handleScoreUpdate = useCallback((score: number, combo: number, misses: number) => {
    const id = roomIdRef.current;
    if (id && socketRef.current) {
      const payload: ScoreUpdatePayload = {
        roomId: id,
        sequence: scoreSequenceRef.current + 1,
        score,
        combo,
        misses,
      };
      scoreSequenceRef.current = payload.sequence;
      socketRef.current.emit('updateScore', payload);
    }
  }, []);

  const handleHit = useCallback(({ noteId, hitTime }: HitReport) => {
    const id = roomIdRef.current;
    if (id && socketRef.current) {
      socketRef.current.emit('opponentHit', { roomId: id, noteId, hitTime });
    }
  }, []);

  const configuredPublicAppUrl = typeof import.meta.env.VITE_PUBLIC_APP_URL === 'string'
    ? import.meta.env.VITE_PUBLIC_APP_URL.trim()
    : '';
  let inviteUrl: string | null = null;
  if (roomId) {
    try {
      inviteUrl = createInviteUrl(configuredPublicAppUrl || window.location.href, roomId);
    } catch {
      try {
        inviteUrl = createInviteUrl(window.location.href, roomId);
      } catch {
        inviteUrl = null;
      }
    }
  }
  const inviteIsLocal = inviteUrl !== null
    && isLoopbackHostname(new URL(inviteUrl).hostname);
  const nativeShare = (navigator as unknown as {
    share?: (data?: ShareData) => Promise<void>;
  }).share;

  const handleCopyInvite = async () => {
    if (!inviteUrl || inviteIsLocal) return;
    try {
      await copyTextToClipboard(inviteUrl);
      setInviteCopyState('copied');
      window.setTimeout(() => setInviteCopyState('idle'), 2_000);
    } catch (error) {
      console.error(error);
      setAppError('Could not copy the invite link. Select and copy it manually.');
    }
  };

  const handleShareInvite = async () => {
    if (!inviteUrl || inviteIsLocal) return;
    if (!nativeShare) {
      await handleCopyInvite();
      return;
    }
    try {
      await nativeShare.call(navigator, {
        title: 'FNF X-CREATOR room',
        text: `Join my room ${roomId ?? ''}. You do not need the audio file.`,
        url: inviteUrl,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error(error);
      setAppError('Could not open the share menu. You can copy the invite link instead.');
    }
  };

  return (
    <div className="min-h-[100dvh] bg-gray-950 font-sans text-white selection:bg-purple-500/30">
      {appError && (
        <div role="alert" className="fixed left-1/2 top-4 z-[70] flex w-[min(92vw,42rem)] -translate-x-1/2 items-center justify-between gap-4 rounded-xl border border-red-400/30 bg-red-950/95 px-5 py-4 text-sm text-red-100 shadow-2xl backdrop-blur">
          <span>{appError}</span>
          <button type="button" onClick={() => setAppError(null)} aria-label="Dismiss error" className="rounded p-1 hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 px-6 text-center">
            <Loader2 className="h-12 w-12 animate-spin text-cyan-400" />
            <h2 className="animate-pulse bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-xl font-bold text-transparent">{loadingText}</h2>
          </div>
        </div>
      )}

      {!audioBuffer || !playbackContext ? (
        <Setup
          onStart={(file, sensitivity, importedMap) => void handleStart(file, sensitivity, importedMap, 'single')}
          onCreate={(file, sensitivity, importedMap) => void handleStart(file, sensitivity, importedMap, 'create')}
          onJoin={(id) => void handleJoin(id)}
        />
      ) : isMultiplayer && multiplayerState === 'waiting' ? (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center overflow-y-auto bg-gray-900 px-6 py-10 text-center">
          {multiplayerRole === 'host' ? (
            <>
              <h2 className="mb-3 text-4xl font-black text-white">ROOM READY</h2>
              <p className="mb-6 max-w-xl text-base text-gray-300 sm:text-lg">
                Send this invite to your friend. The synchronized track{videoUrl && !videoShareNotice ? ' and video download' : ' downloads'} automatically.
              </p>
              {videoShareNotice && (
                <div role="status" className="mb-6 max-w-xl rounded-xl border border-amber-400/40 bg-amber-500/10 px-5 py-4 text-sm text-amber-100">
                  {videoShareNotice}
                </div>
              )}
              <div className="mb-6 flex min-h-20 items-center justify-center rounded-xl border border-cyan-500/30 bg-black/50 px-8 py-4 font-mono text-4xl font-bold text-cyan-400 shadow-[0_0_30px_rgba(34,211,238,0.2)] sm:text-5xl">
                {roomId || '…'}
              </div>

              {inviteIsLocal ? (
                <div role="status" className="mb-7 max-w-xl rounded-xl border border-amber-400/40 bg-amber-500/10 px-5 py-4 text-sm text-amber-100">
                  This page is running on localhost. Deploy it to a public address before sending an invite to a remote friend.
                </div>
              ) : inviteUrl ? (
                <div className="mb-7 w-full max-w-xl rounded-xl border border-white/10 bg-black/30 p-3">
                  <label htmlFor="invite-url" className="sr-only">Room invite link</label>
                  <input
                    id="invite-url"
                    readOnly
                    value={inviteUrl}
                    onFocus={event => event.currentTarget.select()}
                    className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 outline-none focus:border-cyan-400"
                  />
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopyInvite()}
                      className="flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-black uppercase tracking-wider text-gray-950 transition hover:bg-cyan-300"
                    >
                      {inviteCopyState === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {inviteCopyState === 'copied' ? 'Copied' : 'Copy invite'}
                    </button>
                    {nativeShare && (
                      <button
                        type="button"
                        onClick={() => void handleShareInvite()}
                        className="flex items-center gap-2 rounded-lg border border-purple-400/40 bg-purple-500/10 px-4 py-2 text-xs font-black uppercase tracking-wider text-purple-100 transition hover:bg-purple-500/20"
                      >
                        <Share2 className="h-4 w-4" /> Share
                      </button>
                    )}
                  </div>
                </div>
              ) : null}

              <div aria-live="polite" className="flex items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
                <span className="text-sm font-bold uppercase tracking-widest text-purple-300">
                  {playerCount >= 2 ? 'Friend joined—synchronizing…' : `Waiting for friend… ${Math.max(1, playerCount)}/2`}
                </span>
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-3 text-4xl font-black text-white">TRACK READY</h2>
              <p className="mb-6 max-w-xl text-lg text-gray-300">
                The host&apos;s {videoUrl ? 'video and audio are' : 'audio is'} already downloaded. You do not need to select a file.
              </p>
              <div className="mb-7 rounded-xl border border-cyan-500/30 bg-black/40 px-6 py-3 font-mono text-2xl font-bold text-cyan-300">
                {roomId || '…'}
              </div>
              <div aria-live="polite" className="flex items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
                <span className="text-sm font-bold uppercase tracking-widest text-purple-300">Synchronizing the start…</span>
              </div>
            </>
          )}
          <button type="button" onClick={() => resetSession(true)} className="mt-12 rounded border border-red-500/50 px-6 py-2 text-xs font-bold uppercase tracking-widest text-red-400 hover:bg-red-500/10">Cancel</button>
        </div>
      ) : (
        <Game
          audioBuffer={audioBuffer}
          audioContext={playbackContext}
          videoUrl={videoUrl}
          initialBeatmap={beatmap}
          energyData={energyData}
          onBack={() => resetSession(true)}
          isMultiplayer={isMultiplayer}
          serverStartTime={serverStartTime}
          opponentScore={opponentScore}
          onScoreUpdate={handleScoreUpdate}
          onHit={handleHit}
        />
      )}
    </div>
  );
}
