/// <reference lib="webworker" />
/**
 * Restoration worker — keeps the heavy DSP (AR repair, STFT denoise) off the UI thread.
 * Protocol:
 *   in : { id, kind: 'diagnose' | 'restore', channels: Float32Array[], sampleRate, opts? }
 *   out: { id, type: 'progress', stage, fraction } … then { id, type: 'done', result } | { id, type: 'error', message }
 */
import { diagnose, restoreChannels, type RestoreOptions } from '@/lib/dsp/restore';

interface Msg {
  id: number;
  kind: 'diagnose' | 'restore';
  channels: Float32Array[];
  sampleRate: number;
  opts?: RestoreOptions;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<Msg>) => {
  const { id, kind, channels, sampleRate, opts } = e.data;
  try {
    if (kind === 'diagnose') {
      const result = diagnose(channels, sampleRate, (f) => ctx.postMessage({ id, type: 'progress', stage: 'diagnose', fraction: f }));
      ctx.postMessage({ id, type: 'done', result });
    } else {
      const { channels: out, report } = restoreChannels(channels, sampleRate, opts ?? {}, (stage, fraction) =>
        ctx.postMessage({ id, type: 'progress', stage, fraction }),
      );
      ctx.postMessage({ id, type: 'done', result: { channels: out, report } }, out.map((c) => c.buffer));
    }
  } catch (err) {
    ctx.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
