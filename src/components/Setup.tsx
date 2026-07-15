import React, { useState, useRef } from 'react';
import { UploadCloud, Music, FileJson, Users, Key } from 'lucide-react';

interface SetupProps {
  onStart: (file: File, sensitivity: number, beatmapFile?: File) => void;
  onCreate: (file: File, sensitivity: number, beatmapFile?: File) => void;
  onJoin: (roomId: string) => void;
}

export default function Setup({ onStart, onCreate, onJoin }: SetupProps) {
  const [file, setFile] = useState<File | null>(null);
  const [beatmapFile, setBeatmapFile] = useState<File | null>(null);
  const [sensitivity, setSensitivity] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [joinId, setJoinId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    Array.from(e.dataTransfer.files).forEach(f => {
      if (f.type.startsWith('audio/') || f.type.startsWith('video/') || f.name.endsWith('.mp3') || f.name.endsWith('.wav') || f.name.endsWith('.ogg') || f.name.endsWith('.mp4') || f.name.endsWith('.webm')) {
        setFile(f);
      } else if (f.type === 'application/json' || f.name.endsWith('.json')) {
        setBeatmapFile(f);
      }
    });
  };

  return (
    <div 
      className="flex items-center justify-center h-full min-h-screen p-4 overflow-y-auto"
      onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      <div className={`max-w-md w-full glass p-8 relative overflow-hidden transition-all duration-300 ${isDragging ? 'neon-border-purple scale-[1.02] bg-purple-900/20' : 'neon-border-purple'}`}>
        <div className="text-center mb-8 relative z-10 flex flex-col items-center">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-3 h-3 rounded-full bg-pink-500 animate-pulse"></div>
            <h1 className="text-2xl font-black uppercase tracking-tighter italic neon-text-pink">FNF X-CREATOR</h1>
          </div>
          <p className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">AI Rhythm Synthesis Engine</p>
        </div>

        <div 
          className={`relative z-10 flex flex-col items-center justify-center h-48 border-2 border-dashed rounded-xl transition-all duration-300 cursor-pointer ${
            file ? 'border-green-500/50 bg-green-500/10' : 'border-purple-500/30 bg-purple-500/5 hover:bg-purple-500/10'
          }`}
          onClick={() => fileInputRef.current?.click()}
        >
          <input 
            type="file" 
            accept="audio/*,video/*,.mp4,.webm" 
            className="hidden" 
            ref={fileInputRef}
            onChange={(e) => {
              if (e.target.files?.[0]) setFile(e.target.files[0]);
            }}
          />
          
          {file ? (
            <div className="flex flex-col items-center text-purple-200">
              <Music className="w-10 h-10 mb-2" />
              <span className="text-xs font-medium px-4 text-center truncate w-full max-w-[250px]">{file.name}</span>
            </div>
          ) : (
            <div className="flex flex-col items-center text-gray-400">
              <UploadCloud className="w-10 h-10 mb-2" />
              <span className="font-medium text-white text-sm uppercase tracking-widest">Drop audio/video file here</span>
            </div>
          )}
        </div>

        <div 
          className={`mt-4 relative z-10 flex flex-col items-center justify-center h-16 border border-dashed rounded-xl transition-all duration-300 cursor-pointer ${
            beatmapFile ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200' : 'border-cyan-500/30 bg-cyan-500/5 hover:bg-cyan-500/10 text-gray-400'
          }`}
          onClick={() => jsonInputRef.current?.click()}
        >
          <input 
            type="file" 
            accept=".json,application/json" 
            className="hidden" 
            ref={jsonInputRef}
            onChange={(e) => {
              if (e.target.files?.[0]) setBeatmapFile(e.target.files[0]);
            }}
          />
          <div className="flex items-center gap-2">
            <FileJson className="w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-widest">
              {beatmapFile ? beatmapFile.name : 'Upload .json beatmap (optional)'}
            </span>
          </div>
        </div>

        {!beatmapFile && (
          <div className="mt-8 space-y-4 relative z-10">
            <div className="flex justify-between items-end">
              <label className="text-[10px] font-black uppercase tracking-widest text-purple-400">Generation Density</label>
              <span className="text-xs font-mono text-white bg-purple-500/20 px-2 py-0.5 rounded">{sensitivity}%</span>
            </div>
            <input 
              type="range" 
              min="1" max="100" 
              value={sensitivity} 
              onChange={(e) => setSensitivity(parseInt(e.target.value))}
              className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer custom-slider"
            />
            <div className="flex justify-between text-[9px] text-gray-500 font-bold uppercase">
              <span>Chill</span>
              <span>Expert</span>
            </div>
          </div>
        )}

        <div className="mt-8 space-y-3 relative z-10">
          <button 
            onClick={() => file && onStart(file, sensitivity, beatmapFile || undefined)}
            disabled={!file}
            className="w-full py-3 glass bg-purple-600/20 hover:bg-purple-600/40 text-sm font-black uppercase tracking-widest transition-all neon-border-purple disabled:opacity-50 disabled:cursor-not-allowed text-white flex items-center justify-center gap-2"
          >
            Play Singleplayer
          </button>
          
          <button 
            onClick={() => file && onCreate(file, sensitivity, beatmapFile || undefined)}
            disabled={!file}
            className="w-full py-3 glass bg-cyan-600/20 hover:bg-cyan-600/40 text-sm font-black uppercase tracking-widest transition-all neon-border-cyan disabled:opacity-50 disabled:cursor-not-allowed text-white flex items-center justify-center gap-2"
          >
            <Users className="w-4 h-4" /> Host Multiplayer
          </button>
        </div>

        <div className="mt-8 pt-6 border-t border-gray-800 relative z-10">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 h-px bg-gray-800"></div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">OR JOIN ROOM</span>
            <div className="flex-1 h-px bg-gray-800"></div>
          </div>
          
          <div className="flex gap-2">
            <input 
              type="text" 
              placeholder="ROOM CODE" 
              value={joinId}
              onChange={e => setJoinId(e.target.value)}
              className="flex-1 bg-black/50 border border-gray-700 rounded px-4 py-2 font-mono text-sm uppercase text-white focus:outline-none focus:border-cyan-500 transition-colors"
            />
            <button 
              onClick={() => joinId && onJoin(joinId)}
              disabled={!joinId}
              className="px-6 py-2 glass bg-gray-800 hover:bg-gray-700 text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white"
            >
              Join
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
