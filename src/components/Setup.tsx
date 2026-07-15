import React, { useRef, useState } from 'react';
import { FileJson, Music, UploadCloud, Users } from 'lucide-react';
import {
  normalizeRoomCode,
  ROOM_CODE_PATTERN,
  roomCodeFromSearch,
} from '../utils/invite';

const MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BEATMAP_FILE_BYTES = 5 * 1024 * 1024;

const isAudioLikeFile = (file: File) => {
  const name = file.name.toLowerCase();
  return file.type.startsWith('audio/')
    || file.type.startsWith('video/')
    || ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mp4', '.webm'].some(extension => name.endsWith(extension));
};

const isJsonFile = (file: File) => file.type === 'application/json' || file.name.toLowerCase().endsWith('.json');

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
  const [invitedRoomId] = useState(() =>
    typeof window === 'undefined' ? null : roomCodeFromSearch(window.location.search));
  const [joinId, setJoinId] = useState(invitedRoomId ?? '');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const selectAudioFile = (nextFile: File) => {
    if (!isAudioLikeFile(nextFile)) {
      setFileError('Choose a supported audio or video file.');
      return;
    }
    if (nextFile.size > MAX_LOCAL_FILE_BYTES) {
      setFileError('The file is too large. The local limit is 100 MiB.');
      return;
    }
    setFile(nextFile);
    setFileError(null);
  };

  const selectBeatmapFile = (nextFile: File) => {
    if (!isJsonFile(nextFile)) {
      setFileError('Choose a JSON beatmap file.');
      return;
    }
    if (nextFile.size > MAX_BEATMAP_FILE_BYTES) {
      setFileError('The beatmap is too large. The limit is 5 MiB.');
      return;
    }
    setBeatmapFile(nextFile);
    setFileError(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    Array.from<File>(e.dataTransfer.files).forEach(droppedFile => {
      if (isAudioLikeFile(droppedFile)) {
        selectAudioFile(droppedFile);
      } else if (isJsonFile(droppedFile)) {
        selectBeatmapFile(droppedFile);
      }
    });
  };

  const normalizedJoinId = normalizeRoomCode(joinId);

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
          <p className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Adaptive Rhythm Analysis Engine</p>
        </div>

        {invitedRoomId && (
          <div className="relative z-10 mb-6 rounded-xl border border-cyan-400/40 bg-cyan-500/10 p-4 text-center">
            <p className="text-xs font-black uppercase tracking-widest text-cyan-200">
              Friend invite detected
            </p>
            <p className="mt-2 text-sm text-gray-200">
              Room <span className="font-mono font-bold text-white">{invitedRoomId}</span>. No file is needed—the host&apos;s track downloads automatically.
            </p>
            <button
              type="button"
              onClick={() => onJoin(invitedRoomId)}
              className="mt-4 w-full rounded-lg bg-cyan-500 px-4 py-3 text-sm font-black uppercase tracking-widest text-gray-950 transition hover:bg-cyan-300"
            >
              Join &amp; enable sound
            </button>
          </div>
        )}

        <input
          type="file"
          accept="audio/*,video/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.mp4,.webm"
          className="hidden"
          ref={fileInputRef}
          onChange={(event) => {
            const selectedFile = event.target.files?.[0];
            if (selectedFile) selectAudioFile(selectedFile);
          }}
        />
        <button
          type="button"
          className={`relative z-10 flex h-48 w-full flex-col items-center justify-center border-2 border-dashed rounded-xl transition-all duration-300 cursor-pointer ${
            file ? 'border-green-500/50 bg-green-500/10' : 'border-purple-500/30 bg-purple-500/5 hover:bg-purple-500/10'
          }`}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Choose an audio or video file"
        >
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
        </button>

        {fileError && (
          <p role="alert" className="mt-3 text-xs font-medium text-red-300">
            {fileError}
          </p>
        )}

        <input
          type="file"
          accept=".json,application/json"
          className="hidden"
          ref={jsonInputRef}
          onChange={(event) => {
            const selectedFile = event.target.files?.[0];
            if (selectedFile) selectBeatmapFile(selectedFile);
          }}
        />
        <button
          type="button"
          className={`mt-4 relative z-10 flex h-16 w-full flex-col items-center justify-center border border-dashed rounded-xl transition-all duration-300 cursor-pointer ${
            beatmapFile ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200' : 'border-cyan-500/30 bg-cyan-500/5 hover:bg-cyan-500/10 text-gray-400'
          }`}
          onClick={() => jsonInputRef.current?.click()}
          aria-label="Choose an optional JSON beatmap"
        >
          <div className="flex items-center gap-2">
            <FileJson className="w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-widest">
              {beatmapFile ? beatmapFile.name : 'Upload .json beatmap (optional)'}
            </span>
          </div>
        </button>

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
              aria-label="Generation density"
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
            type="button"
            onClick={() => file && onStart(file, sensitivity, beatmapFile || undefined)}
            disabled={!file}
            className="w-full py-3 glass bg-purple-600/20 hover:bg-purple-600/40 text-sm font-black uppercase tracking-widest transition-all neon-border-purple disabled:opacity-50 disabled:cursor-not-allowed text-white flex items-center justify-center gap-2"
          >
            Play Singleplayer
          </button>
          
          <button
            type="button"
            onClick={() => file && onCreate(file, sensitivity, beatmapFile || undefined)}
            disabled={!file}
            className="w-full py-3 glass bg-cyan-600/20 hover:bg-cyan-600/40 text-sm font-black uppercase tracking-widest transition-all neon-border-cyan disabled:opacity-50 disabled:cursor-not-allowed text-white flex items-center justify-center gap-2"
          >
            <Users className="w-4 h-4" /> Host Multiplayer
          </button>
          {file && (
            <p className="text-center text-[10px] font-bold uppercase tracking-wide text-gray-400">
              Only an optimized audio track is shared—not the video file
            </p>
          )}
        </div>

        <div className="mt-8 pt-6 border-t border-gray-800 relative z-10">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 h-px bg-gray-800"></div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">OR JOIN ROOM</span>
            <div className="flex-1 h-px bg-gray-800"></div>
          </div>

          <p className="mb-3 text-center text-[11px] text-gray-400">
            Guests do not need the audio or video file—the host sends the track automatically.
          </p>
          
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (ROOM_CODE_PATTERN.test(normalizedJoinId)) onJoin(normalizedJoinId);
            }}
          >
            <input 
              type="text" 
              placeholder="ROOM CODE" 
              value={joinId}
              maxLength={6}
              autoComplete="off"
              spellCheck={false}
              aria-label="Six-character room code"
              onChange={e => setJoinId(normalizeRoomCode(e.target.value))}
              className="flex-1 bg-black/50 border border-gray-700 rounded px-4 py-2 font-mono text-sm uppercase text-white focus:outline-none focus:border-cyan-500 transition-colors"
            />
            <button 
              type="submit"
              disabled={!ROOM_CODE_PATTERN.test(normalizedJoinId)}
              className="px-6 py-2 glass bg-gray-800 hover:bg-gray-700 text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white"
            >
              Join &amp; sound
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
