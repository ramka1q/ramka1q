import React, { useEffect, useRef, useState } from 'react';
import { Note, GameState, EnergyData } from '../types';
import { formatTime } from '../utils/audio';
import { Play, Pause, ArrowLeft, Edit3, Save } from 'lucide-react';

const KEYS = ['d', 'f', 'j', 'k'];
const COLORS = ['#c084fc', '#22d3ee', '#4ade80', '#f87171']; // Purple, Cyan, Green, Red
const RECEPTOR_Y = 100;
const SCROLL_SPEED = 700;
const HIT_WINDOWS = { sick: 0.045, good: 0.090, bad: 0.135 };

interface GameProps {
  audioUrl: string;
  audioBuffer: AudioBuffer;
  initialBeatmap: Note[];
  energyData: EnergyData[];
  onBack: () => void;
  isMultiplayer?: boolean;
  serverStartTime?: number | null;
  opponentScore?: { score: number; combo: number; misses: number };
  onScoreUpdate?: (score: number, combo: number, misses: number) => void;
  onHit?: (lane: number) => void;
  opponentLastHit?: number | null;
}

export default function Game({ audioUrl, audioBuffer, initialBeatmap, energyData, onBack, isMultiplayer, serverStartTime, opponentScore, onScoreUpdate, onHit, opponentLastHit }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opponentCanvasRef = useRef<HTMLCanvasElement>(null);
  
  // Audio state
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  
  // React UI state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEditor, setIsEditor] = useState(false);
  const [timeline, setTimeline] = useState(0); // for editor timeline slider
  const timelineRef = useRef(0);
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  const [, setForceRender] = useState(0); // to occasionally update React UI outside canvas
  const [countdown, setCountdown] = useState<number | null>(3);
  const [isGameOver, setIsGameOver] = useState(false);
  
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
  });
  
  const oppState = useRef({
    keyEffects: [0, 0, 0, 0],
  });

  const animFrameRef = useRef<number>(0);

  // Opponent hits
  useEffect(() => {
    if (opponentLastHit !== null && opponentLastHit !== undefined) {
      oppState.current.keyEffects[opponentLastHit] = 1.0;
    }
  }, [opponentLastHit]);

  // Initialize Audio
  useEffect(() => {
    audioElRef.current = new Audio(audioUrl);
    return () => {
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.src = "";
      }
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [audioUrl]);

  // Multiplayer Countdown logic
  useEffect(() => {
    let timeoutId: any;
    let started = false;
    
    if (isMultiplayer && serverStartTime) {
      const checkTime = () => {
        const remainingMs = serverStartTime - Date.now();
        if (remainingMs <= 0) {
          if (!started) {
            started = true;
            setCountdown(null);
            playAudio(0);
          }
        } else {
          setCountdown(Math.ceil(remainingMs / 1000));
          timeoutId = setTimeout(checkTime, 50);
        }
      };
      checkTime();
    }
    return () => clearTimeout(timeoutId);
  }, [serverStartTime, isMultiplayer]);

  // Singleplayer Countdown logic
  useEffect(() => {
    let timeoutId: any;
    if (!isMultiplayer) {
      if (countdown === null) return;
      
      if (countdown > 0) {
        timeoutId = setTimeout(() => setCountdown(countdown - 1), 1000);
      } else {
        timeoutId = setTimeout(() => setCountdown(null), 1000);
        playAudio(0);
      }
    }
    return () => clearTimeout(timeoutId);
  }, [countdown, isMultiplayer]);

  // Notify parent of score changes
  useEffect(() => {
    if (onScoreUpdate && isPlaying) {
      const interval = setInterval(() => {
        onScoreUpdate(state.current.gameState.score, state.current.gameState.combo, state.current.gameState.misses);
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isPlaying, onScoreUpdate]);

  // Play/Stop functions
  const playAudio = async (startAt = 0) => {
    if (!audioElRef.current || !audioBuffer) return;
    audioElRef.current.currentTime = startAt;
    audioElRef.current.play().catch(e => console.error("Audio play error:", e));
    setIsPlaying(true);
  };

  const stopAudio = () => {
    if (audioElRef.current && isPlaying) {
      audioElRef.current.pause();
    }
    setIsPlaying(false);
  };

  const togglePlayPause = () => {
    if (isPlaying) {
      state.current.pauseTime = state.current.currentTime;
      stopAudio();
    } else {
      playAudio(state.current.pauseTime);
    }
  };

  const toggleEditor = () => {
    setIsEditor(prev => {
      const next = !prev;
      if (next) {
        if (isPlaying) togglePlayPause();
        setTimeline(state.current.currentTime);
      } else {
        state.current.pauseTime = timeline;
        state.current.beatmap.forEach(n => {
          if (n.time >= state.current.pauseTime) { n.hit = false; n.missed = false; }
        });
      }
      return next;
    });
  };

  // Particles & Visuals
  const addPopup = (text: string, color: string, x: number, y: number) => {
    state.current.popups.push({ text, color, x, y, life: 1.0 });
  };

  const spawnParticles = (x: number, y: number, color: string) => {
    for (let i = 0; i < 15; i++) {
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
    let lastAudioTime = 0;
    let lastTimestamp = performance.now();

    const loop = (timestamp: number) => {
      const { current: s } = state;

      if (isPlaying) {
        if (!audioElRef.current) return;
        
        const currentAudioTime = audioElRef.current.currentTime;
        
        // Browsers update HTMLAudioElement.currentTime in steps (e.g., 250ms),
        // so we interpolate it smoothly using requestAnimationFrame timestamps
        if (currentAudioTime !== lastAudioTime) {
          s.currentTime = currentAudioTime;
          lastAudioTime = currentAudioTime;
        } else {
          const deltaMs = timestamp - lastTimestamp;
          s.currentTime += Math.max(0, Math.min(deltaMs, 100)) / 1000;
        }
        lastTimestamp = timestamp;

        if (s.currentTime >= audioBuffer.duration) {
          stopAudio();
          setIsGameOver(true);
          setForceRender(Date.now()); // trigger ending screen if we wanted
        }
      } else if (isEditor) {
        // When paused in editor, sync canvas to the slider timeline
        s.currentTime = timelineRef.current;
        lastTimestamp = timestamp;
      } else {
        lastTimestamp = timestamp;
      }

      // Update UI slider smoothly if playing (throttle React updates to save CPU)
      if (isPlaying && timestamp - lastUIUpdate > 100) {
        setTimeline(s.currentTime);
        lastUIUpdate = timestamp;
      }

      // Calculate current energy and distance
      let targetEnergy = 0;
      let currentDistance = s.currentTime * SCROLL_SPEED;
      if (energyData && energyData.length > 1) {
        const chunkDuration = energyData[1].time - energyData[0].time;
        const exactIdx = s.currentTime / chunkDuration;
        const idx1 = Math.floor(exactIdx);
        const idx2 = Math.min(idx1 + 1, energyData.length - 1);
        const t = exactIdx - idx1;
        
        const dp1 = energyData[Math.min(Math.max(idx1, 0), energyData.length - 1)];
        const dp2 = energyData[Math.min(Math.max(idx2, 0), energyData.length - 1)];
        
        targetEnergy = dp1.energy + (dp2.energy - dp1.energy) * t;
        currentDistance = dp1.cumulativeDistance + (dp2.cumulativeDistance - dp1.cumulativeDistance) * t;
      }
      
      // Smooth the energy strictly for visual effects (shake/glow), speed is already baked into currentDistance
      s.smoothedEnergy += (targetEnergy - s.smoothedEnergy) * 0.1;

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
            
            if (intensity > 0.3 && Math.random() < 0.4) {
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
          s.keyEffects[i] -= 0.05;
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
           // Fallback for notes without cumulativeDistance (e.g. created in editor before update)
           if (energyData && energyData.length > 1) {
              const chunkDuration = energyData[1].time - energyData[0].time;
              const exactIdx = note.time / chunkDuration;
              const idx1 = Math.floor(exactIdx);
              const idx2 = Math.min(idx1 + 1, energyData.length - 1);
              const t = exactIdx - idx1;
              
              const dp1 = energyData[Math.min(Math.max(idx1, 0), energyData.length - 1)];
              const dp2 = energyData[Math.min(Math.max(idx2, 0), energyData.length - 1)];
              noteDist = dp1.cumulativeDistance + (dp2.cumulativeDistance - dp1.cumulativeDistance) * t;
           } else {
              noteDist = note.time * SCROLL_SPEED;
           }
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
          if (s.currentTime >= note.time && s.currentTime <= endTime) {
            if (s.keys[note.lane]) {
               s.gameState.score += 2; 
               s.gameState.health = Math.min(100, s.gameState.health + 0.02);
               s.keyEffects[note.lane] = 1.0;
               if (Math.random() < 0.15) spawnParticles(x, RECEPTOR_Y, getLaneColor(note.lane));
            } else {
               if (s.currentTime < endTime - 0.15) { // grace period
                  note.missed = true; 
                  addPopup('DROP', '#ef4444', x, RECEPTOR_Y);
                  s.gameState.combo = 0;
                  s.gameState.health -= 2;
               }
            }
          }
        }
      });

      // Popups
      for (let i = s.popups.length - 1; i >= 0; i--) {
        const p = s.popups[i];
        p.life -= 0.03;
        p.y -= 1.5;
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
        p.life -= 0.02;
        p.x += p.vx;
        p.y += p.vy;
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

      if (opponentCanvasRef.current && isMultiplayer) {
         const octx = opponentCanvasRef.current.getContext('2d')!;
         const owidth = opponentCanvasRef.current.width;
         const oheight = opponentCanvasRef.current.height;
         const olaneWidth = owidth / 4;
         const scaleY = oheight / height;
         const oArrowSize = 48; // slightly scaled down but still visible
         const oReceptorY = RECEPTOR_Y * scaleY;

         octx.clearRect(0, 0, owidth, oheight);
         octx.save();

         // Receptors
         for (let i = 0; i < 4; i++) {
           const x = i * olaneWidth + olaneWidth / 2;
           if (oppState.current.keyEffects[i] > 0) {
              oppState.current.keyEffects[i] -= 0.1;
              octx.globalAlpha = 0.5 + oppState.current.keyEffects[i] * 0.5;
              drawArrow(octx, x, oReceptorY, oArrowSize * (1 - oppState.current.keyEffects[i] * 0.1), i, COLORS[i], 'pressed');
              octx.globalAlpha = 1.0;
           } else {
              drawArrow(octx, x, oReceptorY, oArrowSize, i, '#4a5568', 'ghost');
           }
         }

         // Notes
         s.beatmap.forEach(note => {
            const distanceDiff = note.cumulativeDistance! - currentDistance;
            const y = oReceptorY + distanceDiff * scaleY;
            const x = note.lane * olaneWidth + olaneWidth / 2;
            
            if (note.duration && note.duration > 0 && note.cumulativeDistanceEnd !== undefined) {
               const endDist = note.cumulativeDistanceEnd;
               const yEnd = oReceptorY + (endDist - currentDistance) * scaleY;
               if (yEnd > -50 && y < oheight + 50) {
                 const drawYStart = (s.currentTime > note.time) ? Math.min(yEnd, oReceptorY) : y;
                 if (drawYStart < yEnd) {
                    octx.save();
                    octx.globalAlpha = 0.6;
                    octx.fillStyle = COLORS[note.lane];
                    const tailWidth = 12;
                    octx.beginPath();
                    octx.roundRect(x - tailWidth/2, drawYStart, tailWidth, Math.max(1, yEnd - drawYStart), tailWidth/2);
                    octx.fill();
                    octx.restore();
                 }
               }
            }
            
            if (y > -50 && y < oheight + 50 && s.currentTime < note.time + 0.1) {
               drawArrow(octx, x, y, oArrowSize, note.lane, COLORS[note.lane], 'normal');
            }
         });
         octx.restore();
      }

      // Update DOM UI elements directly for 60fps performance without React overhead
      const scoreEl = document.getElementById('ui-score');
      if (scoreEl) scoreEl.innerText = s.gameState.score.toString();

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
           setIsGameOver(true);
           setForceRender(Date.now());
         }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, isEditor, audioBuffer]);

  // Input Handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const { current: s } = state;
      if (!isPlaying || isEditor || (s.gameState.health <= 0 && !isMultiplayer)) return;
      
      const keyIndex = KEYS.indexOf(e.key.toLowerCase());
      if (keyIndex !== -1 && !s.keys[keyIndex]) {
        s.keys[keyIndex] = true;
        s.keyEffects[keyIndex] = 1.0;

        let hit = false;
        for (let i = 0; i < s.beatmap.length; i++) {
          const note = s.beatmap[i];
          if (note.lane === keyIndex && !note.hit && !note.missed) {
            const timeDiff = Math.abs(note.time - s.currentTime);
            if (timeDiff <= HIT_WINDOWS.bad) {
              hit = true;
              note.hit = true;
              
              let points = 0, rating = '', color = '', healthGain = 0;
              if (timeDiff <= HIT_WINDOWS.sick) {
                points = 350; rating = 'SICK!'; color = '#38bdf8'; healthGain = 2;
              } else if (timeDiff <= HIT_WINDOWS.good) {
                points = 200; rating = 'GOOD'; color = '#4ade80'; healthGain = 1;
              } else {
                points = 50; rating = 'BAD'; color = '#fbbf24'; healthGain = 0;
              }

              s.gameState.score += points;
              s.gameState.combo++;
              if (s.gameState.combo > s.gameState.maxCombo) s.gameState.maxCombo = s.gameState.combo;
              s.gameState.health = Math.min(100, s.gameState.health + healthGain);
              s.gameState.hits++;
              if (onHit) onHit(note.lane);

              const x = note.lane * (canvasRef.current!.width / 4) + (canvasRef.current!.width / 8);
              addPopup(rating, color, x, RECEPTOR_Y - 40);
              spawnParticles(x, RECEPTOR_Y, COLORS[note.lane]);

              break;
            }
          }
        }

        if (!hit) {
          s.gameState.health = Math.max(0, s.gameState.health - 1);
          s.gameState.combo = 0;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const keyIndex = KEYS.indexOf(e.key.toLowerCase());
      if (keyIndex !== -1) {
        state.current.keys[keyIndex] = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isPlaying, isEditor]);

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
    const clickedLane = Math.floor(mouseX / laneWidth);
    
    const pixelsFromReceptor = mouseY - RECEPTOR_Y;
    
    // Find current distance at timeline
    let currentDist = timeline * SCROLL_SPEED;
    if (energyData && energyData.length > 0 && audioBuffer.duration > 0) {
      const exactIdx = (timeline / audioBuffer.duration) * energyData.length;
      const idx1 = Math.floor(exactIdx);
      const idx2 = Math.min(idx1 + 1, energyData.length - 1);
      const t = exactIdx - idx1;
      
      const dp1 = energyData[Math.min(Math.max(idx1, 0), energyData.length - 1)];
      const dp2 = energyData[Math.min(Math.max(idx2, 0), energyData.length - 1)];
      currentDist = dp1.cumulativeDistance + (dp2.cumulativeDistance - dp1.cumulativeDistance) * t;
    }
    
    const targetDist = currentDist + pixelsFromReceptor;
    
    let clickedTime = targetDist / SCROLL_SPEED;
    if (energyData && energyData.length > 0) {
      if (targetDist <= 0) {
        clickedTime = 0;
      } else if (targetDist >= energyData[energyData.length - 1].cumulativeDistance) {
        clickedTime = audioBuffer.duration;
      } else {
        // Find segment
        for (let i = 0; i < energyData.length - 1; i++) {
          const d1 = energyData[i].cumulativeDistance;
          const d2 = energyData[i+1].cumulativeDistance;
          if (targetDist >= d1 && targetDist <= d2) {
            const progress = (targetDist - d1) / (d2 - d1);
            clickedTime = energyData[i].time + progress * (energyData[i+1].time - energyData[i].time);
            break;
          }
        }
      }
    }

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
        let snappedDist = snappedTime * SCROLL_SPEED;
        if (energyData && energyData.length > 0 && audioBuffer.duration > 0) {
           const exactIdx = (snappedTime / audioBuffer.duration) * energyData.length;
           const idx1 = Math.floor(exactIdx);
           const idx2 = Math.min(idx1 + 1, energyData.length - 1);
           const t = exactIdx - idx1;
           
           const dp1 = energyData[Math.min(Math.max(idx1, 0), energyData.length - 1)];
           const dp2 = energyData[Math.min(Math.max(idx2, 0), energyData.length - 1)];
           snappedDist = dp1.cumulativeDistance + (dp2.cumulativeDistance - dp1.cumulativeDistance) * t;
        }

        state.current.beatmap.push({
          id: Math.random().toString(36).substring(2),
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

  if (isGameOver) {
    const myScore = state.current.gameState.score;
    const oppScore = opponentScore?.score || 0;
    const isWinner = isMultiplayer && opponentScore && myScore > oppScore;
    const isDraw = isMultiplayer && opponentScore && myScore === oppScore;
    
    return (
      <div className="flex flex-col items-center justify-center w-full h-screen text-white text-center font-sans" style={{ background: 'radial-gradient(circle at 0% 0%, #2a1b3d 0%, #1a1a2e 50%, #0f3460 100%)' }}>
        <h1 className={`text-7xl font-black italic uppercase tracking-tighter mb-8 ${isWinner ? 'text-green-400 drop-shadow-[0_0_20px_#4ade80]' : isDraw ? 'text-yellow-400 drop-shadow-[0_0_20px_#facc15]' : isMultiplayer ? 'text-red-500 drop-shadow-[0_0_20px_#ef4444]' : 'text-pink-500 drop-shadow-[0_0_20px_#ec4899]'}`}>
          {isMultiplayer ? (isWinner ? "VICTORY" : isDraw ? "DRAW" : "DEFEAT") : "SONG CLEARED!"}
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
    <div className="relative w-full h-screen overflow-hidden font-sans text-white select-none" style={{ background: 'radial-gradient(circle at 0% 0%, #2a1b3d 0%, #1a1a2e 50%, #0f3460 100%)' }}>
      <div className="absolute top-0 left-0 w-full h-full opacity-30 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

      <div className="relative z-10 grid grid-cols-12 gap-6 p-8 h-full">
        {/* Left Sidebar */}
        <div className="col-span-3 flex flex-col gap-6 h-full">
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
            <p className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">AI Rhythm Synthesis Engine</p>
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
                    const data = JSON.stringify(state.current.beatmap, null, 2);
                    const blob = new Blob([data], {type: 'application/json'});
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'vibe_beatmap.json';
                    a.click();
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
        <div className="col-span-6 flex flex-col items-center justify-center relative">
          <div className="w-[400px] h-full glass relative overflow-hidden flex items-center justify-center neon-border-purple bg-black/40">
            <canvas 
              ref={canvasRef} 
              width={400} 
              height={800} 
              onClick={handleCanvasClick}
              className={`w-full h-full ${isEditor ? 'cursor-crosshair' : ''}`}
            />
            {countdown !== null && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-50">
                <span className="text-9xl font-black italic text-white drop-shadow-[0_0_30px_#ec4899] animate-pulse">
                  {countdown > 0 ? countdown : "GO!"}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="col-span-3 flex flex-col gap-6 h-full">
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
              
              <div className="flex justify-center my-4">
                <div className="w-[133px] h-[266px] bg-black/60 rounded-lg overflow-hidden border border-cyan-500/20">
                  <canvas ref={opponentCanvasRef} width={133} height={266} className="w-full h-full opacity-80" />
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
