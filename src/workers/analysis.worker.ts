/// <reference lib="webworker" />
/** Track-profile analysis off the UI thread. in: { id, channels, sampleRate, edges? }  out: { id, type: 'done', result } | { id, type: 'error', message } */
import { analyzeProfile } from '@/lib/dsp/profile';

interface Msg { id: number; channels: Float32Array[]; sampleRate: number; edges?: number[] }

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<Msg>) => {
  const { id, channels, sampleRate, edges } = e.data;
  try {
    const buf = {
      sampleRate,
      length: channels[0].length,
      numberOfChannels: channels.length,
      duration: channels[0].length / sampleRate,
      getChannelData: (c: number) => channels[c],
    } as unknown as AudioBuffer;
    ctx.postMessage({ id, type: 'done', result: analyzeProfile(buf, edges) });
  } catch (err) {
    ctx.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
