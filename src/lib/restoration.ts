/**
 * Main-thread client for the restoration worker. Falls back to running on the main thread when Workers are
 * unavailable (very old browsers, test environments) so the feature degrades instead of disappearing.
 */
import type { Diagnosis, RestoreOptions, RestoreReport } from '@/lib/dsp/restore';
import { diagnose, restoreChannels } from '@/lib/dsp/restore';

export type { Diagnosis, RestoreOptions, RestoreReport };

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('../workers/restoration.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
  }
  return worker;
}

function copyChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c)));
}

function call<T>(
  kind: 'diagnose' | 'restore',
  channels: Float32Array[],
  sampleRate: number,
  opts: RestoreOptions | undefined,
  onProgress?: (stage: string, fraction: number) => void,
): Promise<T> {
  const w = getWorker();
  if (!w) {
    // main-thread fallback
    return Promise.resolve().then(() => {
      if (kind === 'diagnose') return diagnose(channels, sampleRate) as unknown as T;
      return restoreChannels(channels, sampleRate, opts ?? {}, onProgress) as unknown as T;
    });
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') onProgress?.(e.data.stage, e.data.fraction);
      else {
        w.removeEventListener('message', onMsg);
        if (e.data.type === 'done') resolve(e.data.result as T);
        else reject(new Error(e.data.message));
      }
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ id, kind, channels, sampleRate, opts }, channels.map((c) => c.buffer));
  });
}

export function diagnoseAudio(buffer: AudioBuffer): Promise<Diagnosis> {
  return call<Diagnosis>('diagnose', copyChannels(buffer), buffer.sampleRate, undefined);
}

export async function restoreAudio(
  buffer: AudioBuffer,
  opts: RestoreOptions,
  onProgress?: (stage: string, fraction: number) => void,
): Promise<{ buffer: AudioBuffer; report: RestoreReport }> {
  const res = await call<{ channels: Float32Array[]; report: RestoreReport }>(
    'restore', copyChannels(buffer), buffer.sampleRate, opts, onProgress,
  );
  const out = new AudioBuffer({ numberOfChannels: res.channels.length, length: buffer.length, sampleRate: buffer.sampleRate });
  res.channels.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return { buffer: out, report: res.report };
}
