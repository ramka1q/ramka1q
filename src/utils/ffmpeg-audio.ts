import coreUrl from '@ffmpeg/core?url';
import wasmUrl from '@ffmpeg/core/wasm?url';
import { FFmpeg } from '@ffmpeg/ffmpeg';

const OUTPUT_SAMPLE_RATE = 32_000;
const EXTRACTION_TIMEOUT_MS = 4 * 60 * 1_000;

const fileExtension = (media: Blob): string => {
  const fileName = 'name' in media && typeof media.name === 'string' ? media.name : '';
  const extension = /\.([a-z0-9]{1,8})$/i.exec(fileName)?.[1];
  if (extension) return extension.toLowerCase();

  const mimeType = media.type.toLowerCase();
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('quicktime')) return 'mov';
  if (mimeType.includes('matroska')) return 'mkv';
  if (mimeType.includes('avi')) return 'avi';
  if (mimeType.includes('mpeg')) return 'mpeg';
  if (mimeType.includes('3gpp')) return '3gp';
  return 'mp4';
};

export const extractVideoAudioPcm = async (media: Blob): Promise<Uint8Array> => {
  const ffmpeg = new FFmpeg();
  const inputName = `input.${fileExtension(media)}`;
  const outputName = 'audio.pcm';
  const logMessages: string[] = [];
  ffmpeg.on('log', ({ message }) => {
    logMessages.push(message);
    if (logMessages.length > 20) logMessages.shift();
  });

  try {
    await ffmpeg.load({ coreURL: coreUrl, wasmURL: wasmUrl });
    await ffmpeg.writeFile(inputName, new Uint8Array(await media.arrayBuffer()));
    const exitCode = await ffmpeg.exec([
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputName,
      '-map', '0:a:0',
      '-vn',
      '-af', 'aresample=async=1:first_pts=0',
      '-ac', '1',
      '-ar', String(OUTPUT_SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      '-f', 's16le',
      outputName,
    ], EXTRACTION_TIMEOUT_MS);
    if (exitCode !== 0) {
      throw new Error(logMessages.join('\n') || `FFmpeg exited with status ${exitCode}.`);
    }

    const output = await ffmpeg.readFile(outputName);
    if (typeof output === 'string' || output.byteLength === 0) {
      throw new Error('FFmpeg produced no decoded audio samples.');
    }
    return Uint8Array.from(output);
  } finally {
    if (ffmpeg.loaded) {
      await ffmpeg.deleteFile(inputName).catch(() => undefined);
      await ffmpeg.deleteFile(outputName).catch(() => undefined);
    }
    ffmpeg.terminate();
  }
};

export { OUTPUT_SAMPLE_RATE };
