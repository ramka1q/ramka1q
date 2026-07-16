import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Note, GameState, EnergyData } from '../types';
import { formatTime } from '../utils/audio';
import { distanceAtTime, energyAtTime, timeAtDistance } from '../utils/beatmap';
import {
  cumulativeHoldScore,
  estimateAudibleContextTime,
  findClosestHittableNote,
} from '../utils/gameplay';
import type { HitReport } from '../protocol';
import { Play, Pause, ArrowLeft, Edit3, Save } from 'lucide-react';

const KEY_CODES = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
const COLORS = ['#c084fc', '#22d3ee', '#4ade80', '#f87171']; // Purple, Cyan, Green, Red
const RECEPTOR_Y = 100;
const SCROLL_SPEED = 700;
const HIT_WINDOWS = { sick: 0.045, good: 0.090, bad: 0.135 };

interface GameProps {
  audioBuffer: AudioBuffer;
  audioContext: AudioContext;
  videoUrl?: string | null;
  initialBeatmap: Note[];
  energyData: EnergyData[];
  onBack: () => void;
  isMultiplayer?: boolean;
  serverStartTime?: number | null;
  opponentScore?: { score: number; combo: number; misses: number };
  onScoreUpdate?: (score: number, combo: number, misses: number) => void;
  onHit?: (report: HitReport) => void;
}

export default function Game({ audioBuffer, audioContext, videoUrl, initialBeatmap, energyData, onBack, isMultiplayer, serverStartTime, opponentScore, onScoreUpdate, onHit }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const mobileVideoPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pointerLanesRef = useRef(new Map<number, number>());
  
  // A single Web Audio clock drives playback, rendering, and hit judgement.
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackRef = useRef({ contextStartTime: 0, offset: 0 });
  const playbackGenerationRef = useRef(0);
  const videoStartTimerRef = useRef<number | null>(null);
  const playbackEndTimerRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  const hasFinishedRef = useRef(false);
  
  // React UI state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEditor, setIsEditor] = useState(false);
  const [timeline, setTimeline] = useState(0); // for editor timeline slider
  const timelineRef = useRef(0);
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  const [countdown, setCountdown] = useState<number | null>(3);
  const [isGameOver, setIsGameOver] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  
  // Mutable Game State (avoids React re-renders for 60fps canvas)
  const state = useRef({
    pauseTime: 0,
    currentTime: 0,
    smoothedEnergy: 0,
    beatmap: JSON.parse(JSON.stringify(initialBeatmap)) as Note[],
    gameState: { score: 0, combo: 0, maxCombo: 0, health: 50, hits: 0, misses: 0, totalNotes: initialBeatmap.length } as GameState,
    keys: [false, false, false, false],
    keyEffects: [0, 0, 0, 0],
    popups: [] as {text: string, color: string, x: number, y: number, life: number}[],
    particles: [] as {x: number, y: number, vx: number, vy: number, life: number, color: string}[],
    holdAwardedPoints: {} as Record<string, number>,
    holdScoreBaselines: {} as Record<string, number>,
  });
  
  const animFrameRef = useRef<number>(0);

  const setPlaybackState = useCallback((playing: boolean) => {
    isPlayingRef.current = playing;
    setIsPlaying(playing);
  }, []);

  const clearVideoStartTimer = useCallback(() => {
    if (videoStartTimerRef.current !== null) {
      window.clearTimeout(videoStartTimerRef.current);
      videoStartTimerRef.current = null;
    }
  }, []);

  const clearPlaybackEndTimer = useCallback(() => {
    if (playbackEndTimerRef.current !== null) {
      window.clearTimeout(playbackEndTimerRef.current);
      playbackEndTimerRef.current = null;
    }
  }, []);

  const settleHoldScore = useCallback((note: Note, throughTime: number) => {
    if (!note.duration || note.duration <= 0) return 0;
    const heldSeconds = Math.min(note.duration, Math.max(0, throughTime - note.time));
    const totalAtTime = cumulativeHoldScore(heldSeconds);
    const baseline = state.current.holdScoreBaselines[note.id] ?? 0;
    const earnableAtTime = Math.max(0, totalAtTime - baseline);
    const previouslyAwarded = state.current.holdAwardedPoints[note.id] ?? 0;
    const pointsToAward = Math.max(0, earnableAtTime - previouslyAwarded);
    state.current.holdAwardedPoints[note.id] = earnableAtTime;
    state.current.gameState.score += pointsToAward;
    state.current.gameState.health = Math.min(
      100,
      state.current.gameState.health + pointsToAward / 240,
    );
    return pointsToAward;
  }, []);

  const finishGame = useCallback((finishTime = audioBuffer.duration, markRemainingMissed = true) => {
    if (hasFinishedRef.current) return;
    hasFinishedRef.current = true;
    const currentState = state.current;

    for (const note of currentState.beatmap) {
      if (note.hit && !note.missed && note.duration && note.duration > 0) {
        settleHoldScore(note, Math.min(finishTime, note.time + note.duration));
      }
      if (markRemainingMissed && !note.hit && !note.missed) {
        note.missed = true;
        currentState.gameState.misses++;
        currentState.gameState.health = Math.max(0, currentState.gameState.health - 2.5);
      }
    }
    if (markRemainingMissed && currentState.gameState.misses > 0) {
      currentState.gameState.combo = 0;
    }

    currentState.currentTime = Math.min(audioBuffer.duration, finishTime);
    currentState.pauseTime = currentState.currentTime;
    clearPlaybackEndTimer();
    clearVideoStartTimer();
    videoRef.current?.pause();
    setPlaybackState(false);
    setIsGameOver(true);
  }, [audioBuffer.duration, clearPlaybackEndTimer, clearVideoStartTimer, setPlaybackState, settleHoldScore]);

  const getAudibleContextTime = useCallback(() => {
    const currentContextTime = audioContext.currentTime;
    let outputTimestamp: AudioTimestamp | undefined;
    try {
      outputTimestamp = audioContext.getOutputTimestamp?.();
    } catch {
      // Some browsers expose getOutputTimestamp but cannot use it yet.
    }
    return estimateAudibleContextTime({
      currentTime: currentContextTime,
      performanceNow: performance.now(),
      outputTimestamp,
      outputLatency: audioContext.outputLatency,
      baseLatency: audioContext.baseLatency,
    });
  }, [audioContext]);

  const getPlaybackTime = useCallback(() => {
    if (!isPlayingRef.current) return state.current.pauseTime;
    const elapsed = Math.max(0, getAudibleContextTime() - playbackRef.current.contextStartTime);
    return Math.min(audioBuffer.duration, playbackRef.current.offset + elapsed);
  }, [audioBuffer.duration, getAudibleContextTime]);

  const scheduleVideoPlayback = useCallback((startAt: number, delaySeconds: number) => {
    clearVideoStartTimer();
    const video = videoRef.current;
    if (!video || !videoUrl) return;
    video.pause();
    const seekVideo = (time: number) => {
      try {
        video.currentTime = time;
      } catch {
        // Metadata may still be loading; startVideo will try again.
      }
    };

    const startVideo = () => {
      videoStartTimerRef.current = null;
      if (!isPlayingRef.current) return;
      const targetTime = Math.min(getPlaybackTime(), Math.max(0, audioBuffer.duration - 0.001));
      if (Math.abs(video.currentTime - targetTime) > 0.03) seekVideo(targetTime);
      void video.play().catch(() => undefined);
    };

    const delayMs = Math.max(0, delaySeconds * 1000);
    if (delayMs > 0) {
      seekVideo(Math.max(0, startAt));
      videoStartTimerRef.current = window.setTimeout(startVideo, delayMs);
    } else {
      startVideo();
    }
  }, [audioBuffer.duration, clearVideoStartTimer, getPlaybackTime, videoUrl]);

  const disposeSource = useCallback(() => {
    clearPlaybackEndTimer();
    const source = sourceRef.current;
    sourceRef.current = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // A source that already ended cannot be stopped again.
    }
    source.disconnect();
  }, [clearPlaybackEndTimer]);

  const stopAudio = useCallback((rememberPosition = true) => {
    playbackGenerationRef.current += 1;
    if (rememberPosition && isPlayingRef.current) {
      state.current.pauseTime = getPlaybackTime();
      state.current.currentTime = state.current.pauseTime;
    }
    clearVideoStartTimer();
    if (videoRef.current) {
      videoRef.current.pause();
      if (rememberPosition) {
        try {
          videoRef.current.currentTime = state.current.pauseTime;
        } catch {
          // Ignore a seek attempted before video metadata is ready.
        }
      }
    }
    disposeSource();
    setPlaybackState(false);
  }, [clearVideoStartTimer, disposeSource, getPlaybackTime, setPlaybackState]);

  const playAudio = useCallback(async (startAt = 0, startEpoch?: number) => {
    const generation = playbackGenerationRef.current + 1;
    playbackGenerationRef.current = generation;
    disposeSource();

    try {
      await audioContext.resume();
      if (generation !== playbackGenerationRef.current) return;

      const source = audioContext.createBufferSource();
      const remainingDelay = startEpoch === undefined ? 0 : (startEpoch - Date.now()) / 1000;
      const lateBy = Math.max(0, -remainingDelay);
      const safeOffset = Math.min(
        Math.max(startAt + lateBy, 0),
        Math.max(0, audioBuffer.duration - 0.001),
      );
      const contextStartTime = audioContext.currentTime + Math.max(0, remainingDelay);
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      sourceRef.current = source;
      playbackRef.current = { contextStartTime, offset: safeOffset };
      state.current.pauseTime = safeOffset;
      state.current.currentTime = safeOffset;
      source.onended = () => {
        if (sourceRef.current !== source || generation !== playbackGenerationRef.current) return;
        sourceRef.current = null;
        source.disconnect();
        const remainingAudibleSeconds = Math.max(0, audioBuffer.duration - getPlaybackTime());
        if (remainingAudibleSeconds > 0.005) {
          playbackEndTimerRef.current = window.setTimeout(() => {
            playbackEndTimerRef.current = null;
            if (generation === playbackGenerationRef.current) {
              finishGame(audioBuffer.duration, true);
            }
          }, remainingAudibleSeconds * 1000);
        } else {
          finishGame(audioBuffer.duration, true);
        }
      };
      source.start(contextStartTime, safeOffset);
      setPlaybackError(null);
      setPlaybackState(true);
      const delayUntilAudibleStart = Math.max(0, contextStartTime - getAudibleContextTime());
      scheduleVideoPlayback(safeOffset, delayUntilAudibleStart);
    } catch (error) {
      console.error('Audio playback error:', error);
      setPlaybackState(false);
      setCountdown(null);
      setPlaybackError('Audio playback was blocked. Click to start.');
    }
  }, [audioBuffer, audioContext, disposeSource, finishGame, getAudibleContextTime, getPlaybackTime, scheduleVideoPlayback, setPlaybackState]);

  // Schedule both the countdown and the audio against the same high-resolution clock.
  useEffect(() => {
    if (isMultiplayer && !serverStartTime) return;

    const startTime = isMultiplayer ? serverStartTime! : Date.now() + 3000;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const updateCountdown = () => {
      if (cancelled) return;
      const remainingMs = startTime - Date.now();
      if (remainingMs <= 0) {
        setCountdown(null);
        return;
      }
      setCountdown(Math.ceil(remainingMs / 1000));
      timeoutId = setTimeout(updateCountdown, Math.min(100, remainingMs));
    };

    updateCountdown();
    void playAudio(0, startTime);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      stopAudio(false);
    };
  }, [isMultiplayer, playAudio, serverStartTime, stopAudio]);

  // Notify parent of score changes
  useEffect(() => {
    if (onScoreUpdate && isPlaying) {
      const interval = setInterval(() => {
        onScoreUpdate(state.current.gameState.score, state.current.gameState.combo, state.current.gameState.misses);
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isPlaying, onScoreUpdate]);

  useEffect(() => {
    if (isGameOver && onScoreUpdate) {
      const { score, combo, misses } = state.current.gameState;
      onScoreUpdate(score, combo, misses);
    }
  }, [isGameOver, onScoreUpdate]);

  const togglePlayPause = () => {
    if (isPlaying) {
      stopAudio();
    } else {
      setCountdown(null);
      void playAudio(state.current.pauseTime);
    }
  };

  const toggleEditor = () => {
    setIsEditor(prev => {
      const next = !prev;
      if (next) {
        if (isPlaying) togglePlayPause();
        setTimeline(state.current.currentTime);
      } else {
        state.current.pauseTime = 0;
        state.current.currentTime = 0;
        state.current.gameState = {
          score: 0,
          combo: 0,
          maxCombo: 0,
          health: 50,
          hits: 0,
          misses: 0,
          totalNotes: state.current.beatmap.length,
        };
        state.current.holdAwardedPoints = {};
        state.current.holdScoreBaselines = {};
        state.current.popups = [];
        state.current.particles = [];
        state.current.beatmap.forEach(n => {
          n.hit = false;
          n.missed = false;
        });
        setTimeline(0);
      }
      return next;
    });
  };

  // Particles & Visuals
  const addPopup = (text: string, color: string, x: number, y: number) => {
    state.current.popups.push({ text, color, x, y, life: 1.0 });
  };

  const spawnParticles = (x: number, y: number, color: string) => {
    const availableSlots = Math.max(0, 600 - state.current.particles.length);
    const particleCount = Math.min(15, availableSlots);
    for (let i = 0; i < particleCount; i++) {
      state.current.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 8,
        vy: (Math.random() - 0.5) * 8,
        life: 1.0,
        color
      });
    }
  };

  const drawArrow = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, dir: number, color: string, style: 'normal' | 'pressed' | 'ghost') => {
    ctx.save();
    ctx.translate(x, y);
    const rot = [-Math.PI/2, Math.PI, 0, Math.PI/2][dir];
    ctx.rotate(rot);

    ctx.beginPath();
    ctx.moveTo(0, -size/2); 
    ctx.lineTo(size/2, size/6); 
    ctx.lineTo(size/4, size/6); 
    ctx.lineTo(size/4, size/2); 
    ctx.lineTo(-size/4, size/2); 
    ctx.lineTo(-size/4, size/6); 
    ctx.lineTo(-size/2, size/6); 
    ctx.closePath();

    if (style === 'ghost') {
      ctx.strokeStyle = '#374151'; // gray-700
      ctx.lineWidth = 4;
      ctx.stroke();
    } else if (style === 'pressed') {
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.shadowColor = color;
      ctx.shadowBlur = 15;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.stroke();
    } else {
      const grad = ctx.createLinearGradient(0, -size/2, 0, size/2);
      grad.addColorStop(0, '#fff');
      grad.addColorStop(1, color);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  };

  // Main Game Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    let lastUIUpdate = 0;
    let lastVideoSync = 0;
    let lastTimestamp = performance.now();

    const loop = (timestamp: number) => {
      const { current: s } = state;
      const deltaSeconds = Math.max(0, Math.min((timestamp - lastTimestamp) / 1000, 0.1));
      lastTimestamp = timestamp;

      if (isPlaying) {
        s.currentTime = getPlaybackTime();

        const video = videoRef.current;
        const playbackHasReachedOutput = getAudibleContextTime() >= playbackRef.current.contextStartTime;
        if (video && videoUrl && playbackHasReachedOutput && timestamp - lastVideoSync > 500) {
          const drift = video.currentTime - s.currentTime;
          if (Math.abs(drift) > 0.12) {
            try {
              video.currentTime = s.currentTime;
            } catch {
              // Ignore a seek attempted before video metadata is ready.
            }
          }
          if (video.paused && s.currentTime < audioBuffer.duration - 0.05) {
            void video.play().catch(() => undefined);
          }
          lastVideoSync = timestamp;
        }

        if (s.currentTime >= audioBuffer.duration) {
          finishGame(audioBuffer.duration, true);
        }
      } else if (isEditor) {
        // When paused in editor, sync canvas to the slider timeline
        s.currentTime = timelineRef.current;
      }

      // Update UI slider smoothly if playing (throttle React updates to save CPU)
      if (isPlaying && timestamp - lastUIUpdate > 100) {
        setTimeline(s.currentTime);
        lastUIUpdate = timestamp;
      }

      // Calculate current energy and distance
      const targetEnergy = energyData.length > 0 ? energyAtTime(energyData, s.currentTime) : 0;
      const currentDistance = energyData.length > 0
        ? distanceAtTime(energyData, s.currentTime)
        : s.currentTime * SCROLL_SPEED;
      
      // Smooth the energy strictly for visual effects (shake/glow), speed is already baked into currentDistance
      const energySmoothing = 1 - Math.exp(-deltaSeconds * 8);
      s.smoothedEnergy += (targetEnergy - s.smoothedEnergy) * energySmoothing;

      const width = canvas.width;
      const height = canvas.height;
      const laneWidth = width / 4;
      const arrowSize = 64;

      // Clear Canvas
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      
      let tier = 2;
      if (targetEnergy > 0.8) tier = 4;
      else if (targetEnergy > 0.6) tier = 3;
      else if (targetEnergy > 0.4) tier = 2;
      else if (targetEnergy > 0.2) tier = 1;
      else tier = 0;

      const getLaneColor = (lane: number) => {
        if (tier === 0) return '#6b7280'; // gray-500
        if (tier === 1) return ['#7e22ce', '#0e7490', '#15803d', '#b91c1c'][lane];
        if (tier === 2) return COLORS[lane];
        if (tier === 3) return ['#e9d5ff', '#a5f3fc', '#bbf7d0', '#fecaca'][lane];
        if (tier === 4) {
          const hue = ((s.currentTime * 400) + lane * 90) % 360;
          return `hsl(${hue}, 100%, 65%)`;
        }
        return COLORS[lane];
      };

      if (isPlaying) {
         if (tier === 0) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(0, 0, width, height);
         } else if (tier === 3) {
            const pulse = (Math.sin(s.currentTime * Math.PI * 2 * 2.5) * 0.5 + 0.5) * 0.15;
            ctx.fillStyle = `rgba(168, 85, 247, ${pulse})`;
            ctx.fillRect(0, 0, width, height);
         } else if (tier === 4) {
            const intensity = (targetEnergy - 0.8) * 5;
            const shakeX = (Math.random() - 0.5) * 15 * intensity;
            const shakeY = (Math.random() - 0.5) * 15 * intensity;
            ctx.translate(shakeX, shakeY);
            
            ctx.fillStyle = `rgba(168, 85, 247, ${intensity * 0.2})`;
            ctx.fillRect(-20, -20, width + 40, height + 40);
            
            if (intensity > 0.3 && Math.random() < 1 - Math.exp(-deltaSeconds * 12)) {
              spawnParticles(Math.random() * width, height, getLaneColor(Math.floor(Math.random() * 4)));
            }
         }
      }

      // Editor Grid
      if (isEditor) {
        ctx.strokeStyle = '#1f2937';
        ctx.lineWidth = 1;
        for(let i=1; i<4; i++) {
          ctx.beginPath();
          ctx.moveTo(i*laneWidth, -20);
          ctx.lineTo(i*laneWidth, height + 20);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.5)'; // Yellow line for current time
        ctx.beginPath();
        ctx.moveTo(-20, RECEPTOR_Y);
        ctx.lineTo(width + 20, RECEPTOR_Y);
        ctx.stroke();
      }

      // Receptors
      for (let i = 0; i < 4; i++) {
        const x = i * laneWidth + laneWidth / 2;
        const laneColor = isPlaying ? getLaneColor(i) : COLORS[i];
        if (s.keyEffects[i] > 0) {
          s.keyEffects[i] = Math.max(0, s.keyEffects[i] - deltaSeconds * 3);
          const glow = s.keyEffects[i];
          
          ctx.globalAlpha = 0.1;
          ctx.fillStyle = laneColor; 
          ctx.fillRect(i * laneWidth, -20, laneWidth, height + 40); // Lane highlight
          ctx.globalAlpha = 1.0;

          ctx.globalAlpha = 0.5 + glow * 0.5;
          drawArrow(ctx, x, RECEPTOR_Y, arrowSize * (1 - glow * 0.1), i, laneColor, 'pressed');
          ctx.globalAlpha = 1.0;
        } else {
          drawArrow(ctx, x, RECEPTOR_Y, arrowSize, i, tier === 0 && isPlaying ? '#374151' : '#4a5568', 'ghost');
        }
      }

      // Notes
      s.beatmap.forEach(note => {
        let noteDist = note.cumulativeDistance;
        if (noteDist === undefined) {
           noteDist = energyData.length > 0
             ? distanceAtTime(energyData, note.time)
             : note.time * SCROLL_SPEED;
           note.cumulativeDistance = noteDist;
        }

        const distanceDiff = noteDist - currentDistance;
        const timeDiff = note.time - s.currentTime;
        const y = RECEPTOR_Y + distanceDiff;

        const x = note.lane * laneWidth + laneWidth / 2;

        // Draw Tail for long notes
        if (note.duration && note.duration > 0 && note.cumulativeDistanceEnd !== undefined) {
           const endDist = note.cumulativeDistanceEnd;
           const yEnd = RECEPTOR_Y + (endDist - currentDistance);
           
           if (yEnd > -100 && y < height + 100) {
             const drawYStart = (note.hit && !note.missed && s.currentTime > note.time) ? Math.min(yEnd, RECEPTOR_Y) : y;
             
             if (drawYStart < yEnd) {
                const laneColor = isPlaying ? getLaneColor(note.lane) : COLORS[note.lane];
                ctx.save();
                ctx.globalAlpha = note.hit ? 0.8 : 0.6;
                ctx.fillStyle = laneColor;
                ctx.shadowColor = laneColor;
                ctx.shadowBlur = note.hit ? 15 : 5;
                
                const tailWidth = 24;
                ctx.beginPath();
                ctx.roundRect(x - tailWidth/2, drawYStart, tailWidth, Math.max(1, yEnd - drawYStart), tailWidth/2);
                ctx.fill();
                ctx.restore();
             }
           }
        }

        if (y > -100 && y < height + 100) {
          if (!note.hit && !note.missed) {
            drawArrow(ctx, x, y, arrowSize, note.lane, isPlaying ? getLaneColor(note.lane) : COLORS[note.lane], 'normal');
          } else if (isEditor) {
            ctx.globalAlpha = 0.3;
            drawArrow(ctx, x, y, arrowSize, note.lane, COLORS[note.lane], 'normal');
            ctx.globalAlpha = 1.0;
          }
        }

        // Miss logic
        if (isPlaying && !note.hit && !note.missed && timeDiff < -HIT_WINDOWS.bad) {
          note.missed = true;
          s.gameState.combo = 0;
          s.gameState.health = Math.max(0, s.gameState.health - 2.5);
          s.gameState.misses++;
          addPopup('MISS', '#ef4444', x, RECEPTOR_Y);
        }

        // Hold logic
        if (isPlaying && note.duration && note.duration > 0 && note.hit && !note.missed) {
          const endTime = note.time + note.duration;
          if (s.currentTime >= note.time) {
            if (s.keys[note.lane] || s.currentTime >= endTime) {
               settleHoldScore(note, Math.min(s.currentTime, endTime));
               s.keyEffects[note.lane] = 1.0;
               if (Math.random() < 1 - Math.exp(-deltaSeconds * 9)) spawnParticles(x, RECEPTOR_Y, getLaneColor(note.lane));
            } else if (s.currentTime < endTime - 0.15) {
               note.missed = true;
               addPopup('DROP', '#ef4444', x, RECEPTOR_Y);
               s.gameState.combo = 0;
               s.gameState.misses++;
               s.gameState.health = Math.max(0, s.gameState.health - 2);
            }
          }
        }
      });

      // Popups
      for (let i = s.popups.length - 1; i >= 0; i--) {
        const p = s.popups[i];
        p.life -= deltaSeconds * 1.8;
        p.y -= deltaSeconds * 90;
        if (p.life <= 0) {
          s.popups.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.font = '900 40px sans-serif';
        ctx.fillStyle = p.color;
        ctx.textAlign = 'center';
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.fillText(p.text, p.x, p.y);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeText(p.text, p.x, p.y);
        ctx.restore();
      }

      // Particles
      for (let i = s.particles.length - 1; i >= 0; i--) {
        const p = s.particles[i];
        p.life -= deltaSeconds * 1.2;
        p.x += p.vx * deltaSeconds * 60;
        p.y += p.vy * deltaSeconds * 60;
        if (p.life <= 0) {
          s.particles.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.restore(); // Restore shake/translate

      if (isMultiplayer) {
        const previewCanvases = [videoPreviewCanvasRef.current, mobileVideoPreviewCanvasRef.current]
          .filter((candidate): candidate is HTMLCanvasElement => candidate !== null);
        previewCanvases.forEach(previewCanvas => {
          const previewContext = previewCanvas.getContext('2d')!;
          const previewWidth = previewCanvas.width;
          const previewHeight = previewCanvas.height;
          const video = videoRef.current;

          previewContext.clearRect(0, 0, previewWidth, previewHeight);
          previewContext.fillStyle = '#030712';
          previewContext.fillRect(0, 0, previewWidth, previewHeight);

          if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            && video.videoWidth > 0 && video.videoHeight > 0) {
            const scale = Math.min(
              previewWidth / video.videoWidth,
              previewHeight / video.videoHeight,
            );
            const drawWidth = video.videoWidth * scale;
            const drawHeight = video.videoHeight * scale;
            previewContext.drawImage(
              video,
              (previewWidth - drawWidth) / 2,
              (previewHeight - drawHeight) / 2,
              drawWidth,
              drawHeight,
            );
          } else {
            previewContext.fillStyle = '#67e8f9';
            previewContext.font = `700 ${Math.max(12, previewWidth / 18)}px sans-serif`;
            previewContext.textAlign = 'center';
            previewContext.textBaseline = 'middle';
            previewContext.fillText(
              videoUrl ? 'LOADING VIDEO…' : 'AUDIO TRACK — NO VIDEO',
              previewWidth / 2,
              previewHeight / 2,
              previewWidth * 0.9,
            );
          }
        });
      }

      // Update DOM UI elements directly for 60fps performance without React overhead
      const scoreEl = document.getElementById('ui-score');
      if (scoreEl) scoreEl.innerText = s.gameState.score.toString();
      const mobileScoreEl = document.getElementById('ui-score-mobile');
      if (mobileScoreEl) mobileScoreEl.innerText = s.gameState.score.toString();

      const comboEl = document.getElementById('ui-combo');
      if (comboEl) comboEl.innerText = s.gameState.combo.toString();

      const maxComboEl = document.getElementById('ui-maxcombo');
      if (maxComboEl) maxComboEl.innerText = s.gameState.maxCombo.toString();

      const hitsEl = document.getElementById('ui-hits');
      if (hitsEl) hitsEl.innerText = s.gameState.hits.toString();

      const healthEl = document.getElementById('ui-health');
      if (healthEl) healthEl.style.width = `${s.gameState.health}%`;

      const progressEl = document.getElementById('ui-progress');
      if (progressEl && audioBuffer.duration > 0) {
         progressEl.style.width = `${(s.currentTime / audioBuffer.duration) * 100}%`;
      }

      if (s.gameState.health <= 0 && isPlaying) {
          s.gameState.health = 0;
          if (!isMultiplayer) {
            stopAudio();
            finishGame(s.currentTime, false);
          }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [audioBuffer, energyData, finishGame, getAudibleContextTime, getPlaybackTime, isEditor, isMultiplayer, isPlaying, settleHoldScore, stopAudio, videoUrl]);

  // Input Handling
  useEffect(() => {
    const markDroppedHold = (lane: number, releaseTime: number) => {
      const playbackStarted = isPlayingRef.current
        && getAudibleContextTime() >= playbackRef.current.contextStartTime;
      if (!playbackStarted) return;
      const droppedNote = state.current.beatmap.find(note =>
        note.lane === lane
        && note.hit
        && !note.missed
        && Boolean(note.duration && note.duration > 0)
        && releaseTime >= note.time
        && releaseTime < note.time + (note.duration ?? 0) - 0.15,
      );
      if (!droppedNote) return;

      settleHoldScore(droppedNote, releaseTime);
      droppedNote.missed = true;
      state.current.gameState.combo = 0;
      state.current.gameState.misses++;
      state.current.gameState.health = Math.max(0, state.current.gameState.health - 2);
      const canvasWidth = canvasRef.current?.width ?? 400;
      const x = droppedNote.lane * (canvasWidth / 4) + (canvasWidth / 8);
      addPopup('DROP', '#ef4444', x, RECEPTOR_Y);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const { current: s } = state;
      const playbackStarted = isPlayingRef.current
        && getAudibleContextTime() >= playbackRef.current.contextStartTime;
      if (!playbackStarted || isEditor || (s.gameState.health <= 0 && !isMultiplayer)) return;
      
      const keyIndex = KEY_CODES.indexOf(e.code);
      if (keyIndex !== -1) {
        e.preventDefault();
        if (e.repeat) return;

        // A fresh physical keydown is authoritative even if the browser lost
        // the previous keyup while focus was moving between elements.
        s.keys[keyIndex] = true;
        s.keyEffects[keyIndex] = 1.0;

        const judgementTime = getPlaybackTime();
        const match = findClosestHittableNote(s.beatmap, keyIndex, judgementTime, HIT_WINDOWS.bad);

        if (match) {
          const closestNote = match.note;
          const closestTimeDiff = Math.abs(match.offset);
          closestNote.hit = true;
          s.holdAwardedPoints[closestNote.id] = 0;
          s.holdScoreBaselines[closestNote.id] = closestNote.duration && closestNote.duration > 0
            ? cumulativeHoldScore(Math.min(closestNote.duration, Math.max(0, judgementTime - closestNote.time)))
            : 0;

          let points = 0, rating = '', color = '', healthGain = 0;
          if (closestTimeDiff <= HIT_WINDOWS.sick) {
            points = 350; rating = 'SICK!'; color = '#38bdf8'; healthGain = 2;
          } else if (closestTimeDiff <= HIT_WINDOWS.good) {
            points = 200; rating = 'GOOD'; color = '#4ade80'; healthGain = 1;
          } else {
            points = 50; rating = 'BAD'; color = '#fbbf24'; healthGain = 0;
          }

          s.gameState.score += points;
          s.gameState.combo++;
          if (s.gameState.combo > s.gameState.maxCombo) s.gameState.maxCombo = s.gameState.combo;
          s.gameState.health = Math.min(100, s.gameState.health + healthGain);
          s.gameState.hits++;
          onHit?.({ noteId: closestNote.id, hitTime: judgementTime });

          const canvasWidth = canvasRef.current?.width ?? 400;
          const x = closestNote.lane * (canvasWidth / 4) + (canvasWidth / 8);
          addPopup(rating, color, x, RECEPTOR_Y - 40);
          spawnParticles(x, RECEPTOR_Y, COLORS[closestNote.lane]);
        } else {
          s.gameState.health = Math.max(0, s.gameState.health - 1);
          s.gameState.combo = 0;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const keyIndex = KEY_CODES.indexOf(e.code);
      if (keyIndex !== -1) {
        e.preventDefault();
        const releaseTime = getPlaybackTime();
        markDroppedHold(keyIndex, releaseTime);
        state.current.keys[keyIndex] = false;
      }
    };

    const releaseAllKeys = () => {
      const releaseTime = getPlaybackTime();
      state.current.keys.forEach((pressed, lane) => {
        if (pressed) markDroppedHold(lane, releaseTime);
      });
      state.current.keys.fill(false);
      if (!isMultiplayer && isPlayingRef.current) stopAudio();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseAllKeys);
    const handleVisibilityChange = () => {
      if (document.hidden) releaseAllKeys();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseAllKeys);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [getAudibleContextTime, getPlaybackTime, isEditor, isMultiplayer, onHit, settleHoldScore, stopAudio]);

  // Editor Mouse Handling
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isEditor) return;
    
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const laneWidth = canvas.width / 4;
    const clickedLane = Math.min(3, Math.max(0, Math.floor(mouseX / laneWidth)));
    
    const pixelsFromReceptor = mouseY - RECEPTOR_Y;
    
    // Find current distance at timeline
    const currentDist = energyData.length > 0
      ? distanceAtTime(energyData, timeline)
      : timeline * SCROLL_SPEED;
    
    const targetDist = currentDist + pixelsFromReceptor;
    
    const clickedTime = energyData.length > 0
      ? timeAtDistance(energyData, targetDist)
      : targetDist / SCROLL_SPEED;

    let clickedExisting = false;
    for (let i = 0; i < state.current.beatmap.length; i++) {
      const note = state.current.beatmap[i];
      if (note.lane === clickedLane && Math.abs(note.time - clickedTime) < 0.1) {
        state.current.beatmap.splice(i, 1);
        clickedExisting = true;
        break;
      }
    }

    if (!clickedExisting) {
      const snappedTime = Math.round(clickedTime * 20) / 20; 
      if (snappedTime >= 0 && snappedTime <= audioBuffer.duration) {
        // Find cumulativeDistance for snapped time
        const snappedDist = energyData.length > 0
          ? distanceAtTime(energyData, snappedTime)
          : snappedTime * SCROLL_SPEED;

        state.current.beatmap.push({
          id: `editor-${Math.round(snappedTime * 1000).toString(36)}-${clickedLane}`,
          time: snappedTime,
          lane: clickedLane,
          hit: false,
          missed: false,
          cumulativeDistance: snappedDist
        });
        state.current.beatmap.sort((a, b) => a.time - b.time);
      }
    }
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (isEditor) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const lane = Math.min(3, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * 4)));
    pointerLanesRef.current.set(event.pointerId, lane);
    event.currentTarget.setPointerCapture(event.pointerId);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: KEY_CODES[lane] }));
  };

  const handleCanvasPointerRelease = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const lane = pointerLanesRef.current.get(event.pointerId);
    if (lane === undefined) return;
    pointerLanesRef.current.delete(event.pointerId);
    if (![...pointerLanesRef.current.values()].includes(lane)) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: KEY_CODES[lane] }));
    }
  };

  if (isGameOver) {
    const myScore = state.current.gameState.score;
    const oppScore = opponentScore?.score || 0;
    const isWinner = isMultiplayer && opponentScore && myScore > oppScore;
    const isDraw = isMultiplayer && opponentScore && myScore === oppScore;
    const didFail = !isMultiplayer && state.current.gameState.health <= 0;
    
    return (
      <div className="flex flex-col items-center justify-center w-full h-screen text-white text-center font-sans" style={{ background: 'radial-gradient(circle at 0% 0%, #2a1b3d 0%, #1a1a2e 50%, #0f3460 100%)' }}>
        <h1 className={`text-7xl font-black italic uppercase tracking-tighter mb-8 ${isWinner ? 'text-green-400 drop-shadow-[0_0_20px_#4ade80]' : isDraw ? 'text-yellow-400 drop-shadow-[0_0_20px_#facc15]' : isMultiplayer || didFail ? 'text-red-500 drop-shadow-[0_0_20px_#ef4444]' : 'text-pink-500 drop-shadow-[0_0_20px_#ec4899]'}`}>
          {isMultiplayer ? (isWinner ? "VICTORY" : isDraw ? "DRAW" : "DEFEAT") : didFail ? "SONG FAILED" : "SONG CLEARED!"}
        </h1>
        <div className="flex gap-16 mb-16 bg-black/40 p-12 rounded-3xl border border-white/10 backdrop-blur-md">
           <div className="flex flex-col items-center">
             <span className="text-sm font-bold uppercase tracking-widest text-purple-400 mb-2">Your Score</span>
             <span className="text-6xl font-black font-mono text-white mb-2">{myScore}</span>
             <span className="text-gray-400 font-bold uppercase tracking-widest">Misses: <span className="text-red-400 font-black">{state.current.gameState.misses}</span></span>
           </div>
           {isMultiplayer && opponentScore && (
             <>
               <div className="w-px bg-white/10"></div>
               <div className="flex flex-col items-center opacity-80">
                 <span className="text-sm font-bold uppercase tracking-widest text-cyan-400 mb-2">Opponent Score</span>
                 <span className="text-6xl font-black font-mono text-white mb-2">{oppScore}</span>
                 <span className="text-gray-400 font-bold uppercase tracking-widest">Misses: <span className="text-red-400 font-black">{opponentScore.misses}</span></span>
               </div>
             </>
           )}
        </div>
        <button 
           onClick={onBack}
           className="px-12 py-5 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-black uppercase tracking-widest rounded-xl transition-all shadow-[0_0_30px_rgba(236,72,153,0.4)] hover:shadow-[0_0_50px_rgba(236,72,153,0.6)]"
        >
          Return to Menu
        </button>
      </div>
    );
  }

  return (
    <div className="relative w-full min-h-[100dvh] overflow-hidden font-sans text-white select-none" style={{ background: 'radial-gradient(circle at 0% 0%, #2a1b3d 0%, #1a1a2e 50%, #0f3460 100%)' }}>
      {videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-35"
        />
      )}
      <div className="absolute top-0 left-0 w-full h-full opacity-30 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

      <div className="relative z-10 grid min-h-[100dvh] grid-cols-12 gap-3 p-3 xl:gap-6 xl:p-8">
        {/* Left Sidebar */}
        <div className="col-span-3 hidden flex-col gap-6 xl:flex">
          <div className="glass p-6 flex flex-col gap-2">
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-pink-500 animate-pulse"></div>
                <h1 className="text-xl font-black uppercase tracking-tighter italic neon-text-pink">FNF X-CREATOR</h1>
              </div>
              <button onClick={() => { stopAudio(); onBack(); }} className="text-gray-400 hover:text-white transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
            </div>
            <p className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Adaptive Rhythm Analysis Engine</p>
          </div>

          <div className="glass p-6 flex-1 flex flex-col gap-6">
            {!isMultiplayer && (
              <div className="space-y-4">
                <label className="block text-[10px] font-black uppercase tracking-widest text-purple-400">Controls</label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    onClick={togglePlayPause}
                    className={`flex items-center justify-center gap-2 py-3 rounded-xl font-bold transition-all ${
                      isPlaying 
                        ? 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20' 
                        : 'bg-green-500/10 text-green-500 hover:bg-green-500/20'
                    }`}
                  >
                    {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    {isPlaying ? 'PAUSE' : 'PLAY'}
                  </button>
                  
                  <button
                    onClick={toggleEditor}
                    className={`flex items-center justify-center gap-2 py-3 rounded-xl font-bold transition-all ${
                      isEditor 
                        ? 'bg-purple-500 text-white shadow-[0_0_15px_rgba(168,85,247,0.4)]' 
                        : 'bg-purple-500/5 text-purple-400 border border-purple-500/20 hover:bg-purple-500/10'
                    }`}
                  >
                    <Edit3 className="w-5 h-5" />
                    EDITOR
                  </button>
                </div>
              </div>
            )}

            {isEditor && !isMultiplayer && (
              <div className="space-y-4 mt-4">
                <p className="text-xs text-gray-400 font-medium leading-relaxed">
                  Click the lanes on the canvas to place or remove notes. Scroll the timeline below.
                </p>
                <div className="space-y-2">
                  <input 
                    type="range" 
                    min="0" 
                    max={audioBuffer.duration} 
                    step="0.05"
                    value={timeline} 
                    onChange={(e) => setTimeline(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer custom-slider"
                  />
                  <div className="text-center font-mono text-xs text-purple-400 font-bold">
                    {formatTime(timeline)} / {formatTime(audioBuffer.duration)}
                  </div>
                </div>
                <button 
                  onClick={() => {
                    const exportedBeatmap = state.current.beatmap.map(({ id, time, lane, duration }) => ({
                      id,
                      time,
                      lane,
                      ...(duration && duration > 0 ? { duration } : {}),
                    }));
                    const data = JSON.stringify(exportedBeatmap, null, 2);
                    const blob = new Blob([data], {type: 'application/json'});
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'vibe_beatmap.json';
                    a.click();
                    a.remove();
                    window.setTimeout(() => URL.revokeObjectURL(url), 0);
                  }}
                  className="w-full py-3 glass bg-purple-600/20 hover:bg-purple-600/40 text-[10px] font-bold uppercase tracking-widest transition-all neon-border-purple text-white mt-4"
                >
                  <Save className="w-4 h-4 inline mr-2" /> Export Beatmap .json
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Game Canvas Area */}
        <div className="col-span-12 flex min-h-[100dvh] flex-col items-center justify-center relative xl:col-span-6 xl:min-h-0">
          <div className="absolute left-2 top-2 z-40 flex gap-2 xl:hidden">
            <button
              type="button"
              aria-label="Return to menu"
              onClick={() => { stopAudio(); onBack(); }}
              className="rounded-lg border border-white/15 bg-black/70 p-3 text-white backdrop-blur"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            {!isMultiplayer && (
              <button
                type="button"
                aria-label={isPlaying ? 'Pause' : 'Play'}
                onClick={togglePlayPause}
                className="rounded-lg border border-white/15 bg-black/70 p-3 text-white backdrop-blur"
              >
                {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </button>
            )}
          </div>
          <div className="absolute right-2 top-2 z-40 rounded-lg border border-white/15 bg-black/70 px-4 py-2 font-mono text-xl font-black text-purple-200 backdrop-blur xl:hidden">
            <span id="ui-score-mobile">{state.current.gameState.score}</span>
          </div>
          {isMultiplayer && opponentScore && (
            <div className="pointer-events-none absolute bottom-4 left-2 z-40 w-[180px] overflow-hidden rounded-xl border border-cyan-400/30 bg-black/75 p-2 shadow-xl backdrop-blur xl:hidden">
              <div className="mb-1 flex items-center justify-between px-1 text-[8px] font-black uppercase tracking-wider text-cyan-300">
                <span>Opponent</span>
                <span className="font-mono text-white">{opponentScore.score}</span>
              </div>
              <canvas ref={mobileVideoPreviewCanvasRef} width={328} height={184} className="aspect-video w-full rounded bg-black" />
            </div>
          )}
          <div className="aspect-[1/2] w-full max-w-[400px] glass relative overflow-hidden flex items-center justify-center neon-border-purple bg-black/40">
            <canvas 
              ref={canvasRef} 
              width={400} 
              height={800} 
              onClick={handleCanvasClick}
              onPointerDown={handleCanvasPointerDown}
              onPointerUp={handleCanvasPointerRelease}
              onPointerCancel={handleCanvasPointerRelease}
              className={`h-full w-full touch-none ${isEditor ? 'cursor-crosshair' : ''}`}
            />
            {playbackError && (
              <button
                type="button"
                onClick={() => {
                  setPlaybackError(null);
                  setCountdown(null);
                  if (isMultiplayer && serverStartTime) {
                    void playAudio(0, serverStartTime);
                  } else {
                    void playAudio(state.current.pauseTime);
                  }
                }}
                className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/80 p-8 text-center backdrop-blur-sm"
              >
                <span className="text-xl font-black uppercase tracking-widest text-red-300">{playbackError}</span>
                <span className="rounded-xl bg-purple-600 px-6 py-3 text-sm font-black uppercase tracking-widest text-white">Start audio</span>
              </button>
            )}
            {countdown !== null && !playbackError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-50">
                <span className="text-9xl font-black italic text-white drop-shadow-[0_0_30px_#ec4899] animate-pulse">
                  {countdown > 0 ? countdown : "GO!"}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="col-span-3 hidden flex-col gap-6 xl:flex">
          <div className="glass p-6 space-y-4 relative overflow-hidden">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Score</span>
            </div>
            <div className="flex items-baseline justify-between relative z-10">
              <span id="ui-score" className="text-4xl font-black italic font-mono tracking-tighter text-purple-300 drop-shadow-[0_0_10px_#c084fc]">{state.current.gameState.score}</span>
            </div>
            <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden relative z-10">
              <div id="ui-health" className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300" style={{ width: `${state.current.gameState.health}%` }}></div>
            </div>
            <div className="text-[10px] text-gray-500 font-bold uppercase mt-1 text-center tracking-widest relative z-10">Health</div>
          </div>

          {isMultiplayer && opponentScore && (
            <div className="glass p-6 space-y-4 relative overflow-hidden border border-cyan-500/30 bg-cyan-900/10">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-cyan-500/10 blur-2xl rounded-full"></div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-black uppercase tracking-widest text-cyan-400">Opponent</span>
              </div>
              
              <div className="my-4 flex justify-center">
                <div className="aspect-video w-full overflow-hidden rounded-lg border border-cyan-500/20 bg-black/60">
                  <canvas ref={videoPreviewCanvasRef} width={640} height={360} className="h-full w-full" />
                </div>
              </div>

              <div className="flex items-baseline justify-between relative z-10">
                <span className="text-4xl font-black italic font-mono tracking-tighter text-cyan-300 drop-shadow-[0_0_10px_#22d3ee]">{opponentScore.score}</span>
              </div>
              <div className="flex justify-between items-center mt-2 relative z-10">
                <span className="text-xs text-gray-400 font-bold uppercase tracking-widest">Combo</span>
                <span className="text-xl font-black text-white font-mono">{opponentScore.combo}</span>
              </div>
            </div>
          )}

          <div className="glass p-6 flex-1 flex flex-col">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-purple-400 mb-6">Live Playback Data</h3>
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400 font-bold uppercase tracking-widest">Combo</span>
                <span id="ui-combo" className="text-2xl font-black text-cyan-400 font-mono">{state.current.gameState.combo}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400 font-bold uppercase tracking-widest">Max Combo</span>
                <span id="ui-maxcombo" className="text-xl font-black text-white font-mono">{state.current.gameState.maxCombo}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400 font-bold uppercase tracking-widest">Notes Hit</span>
                <span id="ui-hits" className="text-xl font-black text-white font-mono">{state.current.gameState.hits}</span>
              </div>
            </div>

            <div className="mt-auto pt-6 border-t border-white/10 text-center">
              <p className="text-[10px] text-gray-400 uppercase tracking-widest leading-relaxed italic">
                Press <span className="text-white font-bold">[D] [F] [J] [K]</span> to interact
              </p>
            </div>
          </div>
        </div>
      </div>
      
      <div className="absolute bottom-0 left-0 w-full h-1 bg-gray-800">
        <div id="ui-progress" className="h-full bg-pink-500 shadow-[0_0_10px_#ec4899] transition-all duration-500" style={{ width: `${(state.current.currentTime / audioBuffer.duration) * 100}%` }}></div>
      </div>
    </div>
  );
}
