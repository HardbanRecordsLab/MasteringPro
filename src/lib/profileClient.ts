/**
 * Main-thread client for the analysis worker. Results are cached per AudioBuffer, so asking for the same buffer's
 * profile twice (auto-tune, then reference match) costs one analysis. Falls back to the main thread without Workers.
 */
import { analyzeProfile, type TrackProfile } from '@/lib/dsp/profile';

let worker: Worker | null = null;
let nextId = 1;
const cache = new WeakMap<AudioBuffer, Promise<TrackProfile>>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    try { worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' }); } catch { worker = null; }
  }
  return worker;
}

export function profileAudio(buffer: AudioBuffer): Promise<TrackProfile> {
  const hit = cache.get(buffer);
  if (hit) return hit;
  const w = getWorker();
  let p: Promise<TrackProfile>;
  if (!w) {
    p = Promise.resolve().then(() => analyzeProfile(buffer));
  } else {
    const id = nextId++;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c)));
    p = new Promise<TrackProfile>((resolve, reject) => {
      const onMsg = (e: MessageEvent) => {
        if (e.data.id !== id) return;
        w.removeEventListener('message', onMsg);
        if (e.data.type === 'done') resolve(e.data.result as TrackProfile);
        else reject(new Error(e.data.message));
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ id, channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
    });
  }
  p.catch(() => cache.delete(buffer));
  cache.set(buffer, p);
  return p;
}
