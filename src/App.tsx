import React, { useState, useEffect } from 'react';
import Setup from './components/Setup';
import Game from './components/Game';
import { Note, EnergyData } from './types';
import { analyzeAudio } from './utils/audio';
import { Loader2 } from 'lucide-react';
import { io, Socket } from 'socket.io-client';

export default function App() {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [beatmap, setBeatmap] = useState<Note[]>([]);
  const [energyData, setEnergyData] = useState<EnergyData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("Generating Beatmap...");
  
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [multiplayerState, setMultiplayerState] = useState<"waiting" | "playing" | null>(null);
  const [serverStartTime, setServerStartTime] = useState<number | null>(null);
  const [opponentScore, setOpponentScore] = useState({ score: 0, combo: 0, misses: 0 });
  const [opponentLastHit, setOpponentLastHit] = useState<number | null>(null);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);
    
    newSocket.on("roomCreated", (id) => {
      setRoomId(id);
      setIsLoading(false);
    });

    newSocket.on("roomJoined", async ({ roomId: id, beatmap: joinedBeatmap, energyData: serverEnergyData, audioBuffer: arrayBuffer, mimeType }) => {
      setRoomId(id);
      setIsMultiplayer(true);
      setMultiplayerState("waiting");
      setLoadingText("Processing Audio...");
      setIsLoading(true);
      
      try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const arrayBufferCopy = arrayBuffer.slice(0);
        const buffer = await audioContext.decodeAudioData(arrayBuffer);
        
        const blob = new Blob([arrayBufferCopy], { type: mimeType || "audio/mp3" });
        setAudioUrl(URL.createObjectURL(blob));
        setAudioBuffer(buffer);
        setBeatmap(joinedBeatmap);
        setEnergyData(serverEnergyData);
        newSocket.emit("playerReady", id);
      } catch(e) {
        alert("Error loading room audio.");
        setIsMultiplayer(false);
        setRoomId(null);
        setIsLoading(false);
      }
    });

    newSocket.on("playerJoined", (count) => {
      // Just waiting for them to be ready
    });

    newSocket.on("startGame", (startTime) => {
      setServerStartTime(startTime);
      setMultiplayerState("playing");
      setIsLoading(false);
    });

    newSocket.on("opponentScore", (data) => {
      setOpponentScore(data);
    });

    newSocket.on("opponentHit", ({ lane }) => {
      setOpponentLastHit(lane);
      // Reset after a tiny delay so the effect triggers again if the same lane is hit
      setTimeout(() => setOpponentLastHit(null), 50);
    });

    newSocket.on("roomError", (msg) => {
      alert(msg);
      setIsLoading(false);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const handleStart = async (file: File, sensitivity: number, beatmapFile?: File, mode?: 'single' | 'create') => {
    setIsLoading(true);
    setLoadingText("Generating Beatmap...");
    try {
      const { buffer, beatmap: generatedBeatmap, energyData } = await analyzeAudio(file, sensitivity);
      let finalBeatmap = generatedBeatmap;
      
      if (beatmapFile) {
        const text = await beatmapFile.text();
        finalBeatmap = JSON.parse(text);
        finalBeatmap = finalBeatmap.map((note: Note) => ({
          ...note,
          hit: false,
          missed: false
        }));
      }

      if (mode === 'create') {
        setLoadingText("Creating Room...");
        const arrayBuffer = await file.arrayBuffer();
        socket?.emit("createRoom", { beatmap: finalBeatmap, energyData, audioBuffer: arrayBuffer, mimeType: file.type });
        setIsMultiplayer(true);
        setMultiplayerState("waiting");
        setAudioUrl(URL.createObjectURL(file));
        setAudioBuffer(buffer);
        setBeatmap(finalBeatmap);
        setEnergyData(energyData);
      } else {
        setIsMultiplayer(false);
        setAudioUrl(URL.createObjectURL(file));
        setAudioBuffer(buffer);
        setBeatmap(finalBeatmap);
        setEnergyData(energyData);
        setIsLoading(false);
      }
    } catch (e) {
      alert("Error processing files. Please check the JSON format or audio file.");
      console.error(e);
      setIsLoading(false);
    }
  };

  const handleJoin = (id: string) => {
    setLoadingText("Joining Room...");
    setIsLoading(true);
    socket?.emit("joinRoom", id);
  };

  const handleScoreUpdate = (score: number, combo: number, misses: number) => {
    if (isMultiplayer && roomId && socket) {
      socket.emit("updateScore", { roomId, score, combo, misses });
    }
  };

  const handleHit = (lane: number) => {
    if (isMultiplayer && roomId && socket) {
      socket.emit("opponentHit", { roomId, lane });
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans selection:bg-purple-500/30">
      {isLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-12 h-12 text-cyan-400 animate-spin" />
            <h2 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent animate-pulse">{loadingText}</h2>
          </div>
        </div>
      )}
      
      {!audioBuffer ? (
        <Setup onStart={(f, s, b) => handleStart(f, s, b, 'single')} onCreate={(f, s, b) => handleStart(f, s, b, 'create')} onJoin={handleJoin} />
      ) : isMultiplayer && multiplayerState === "waiting" ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-900">
          <h2 className="text-4xl font-black text-white mb-4">ROOM CREATED</h2>
          <p className="text-xl text-gray-400 mb-8">Share this code with your opponent:</p>
          <div className="text-6xl font-mono text-cyan-400 font-bold bg-black/50 px-8 py-4 rounded-xl border border-cyan-500/30 shadow-[0_0_30px_rgba(34,211,238,0.2)] mb-8 select-all min-h-[96px] flex items-center justify-center">
            {roomId || "..."}
          </div>
          <div className="flex items-center gap-3">
            <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
            <span className="text-purple-400 animate-pulse font-bold tracking-widest uppercase text-sm">Waiting for opponent to join...</span>
          </div>
          <button onClick={() => { setAudioBuffer(null); setAudioUrl(null); setRoomId(null); setIsMultiplayer(false); }} className="mt-12 px-6 py-2 border border-red-500/50 text-red-400 hover:bg-red-500/10 rounded uppercase font-bold text-xs tracking-widest">Cancel</button>
        </div>
      ) : (
        <Game 
          audioUrl={audioUrl!}
          audioBuffer={audioBuffer} 
          initialBeatmap={beatmap} 
          energyData={energyData}
          onBack={() => { setAudioBuffer(null); setAudioUrl(null); setRoomId(null); setIsMultiplayer(false); }} 
          isMultiplayer={isMultiplayer}
          serverStartTime={serverStartTime}
          opponentScore={opponentScore}
          onScoreUpdate={handleScoreUpdate}
          onHit={handleHit}
          opponentLastHit={opponentLastHit}
        />
      )}
    </div>
  );
}

