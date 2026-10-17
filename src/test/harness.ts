/**
 * Shared Node harness for AudioWorklet processors: runs the real source from public/worklets with a minimal shim,
 * block by block (128 frames), exactly as the browser would call it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SR = 48000;
export const BLOCK = 128;

export function fakeBuffer(channels: Float32Array[], sr = SR): AudioBuffer {
  return {
    sampleRate: sr,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / sr,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

export interface LoadedWorklet {
  Cls: any;
  /** messages the processor posted to its port during the last run */
  posted: any[];
}

export function loadWorklet(file: string, sr = SR): any {
  const src = readFileSync(join(process.cwd(), 'public', 'worklets', file), 'utf8');
  let Cls: any = null;
  const Shim = class {
    port = { postMessage: (_m: unknown) => {}, onmessage: null as unknown };
  };
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(Shim, (_n: string, c: any) => { Cls = c; }, sr);
  if (!Cls) throw new Error(`no processor registered by ${file}`);
  return Cls;
}

export interface RunOptions {
  processorOptions?: Record<string, unknown>;
  params?: Record<string, number>;
  /** messages to deliver to the processor's port before running (after construction) */
  messages?: unknown[];
  /** called after every block with the processor (to read state) */
  onBlock?: (proc: any, offset: number) => void;
}

export function run(Cls: any, L: Float32Array, R: Float32Array, opts: RunOptions = {}): { L: Float32Array; R: Float32Array; proc: any; posted: any[] } {
  const posted: any[] = [];
  const proc = new Cls({ processorOptions: opts.processorOptions ?? {} });
  proc.port.postMessage = (m: unknown) => posted.push(m);
  for (const m of opts.messages ?? []) proc.port.onmessage?.({ data: m });
  const params: Record<string, Float32Array> = {};
  for (const d of Cls.parameterDescriptors || []) params[d.name] = new Float32Array([d.defaultValue]);
  for (const [k, v] of Object.entries(opts.params ?? {})) params[k] = new Float32Array([v]);

  const n = L.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let off = 0; off + BLOCK <= n; off += BLOCK) {
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    proc.process([[L.subarray(off, off + BLOCK), R.subarray(off, off + BLOCK)]], [[oL, oR]], params);
    outL.set(oL, off);
    outR.set(oR, off);
    opts.onBlock?.(proc, off);
  }
  return { L: outL, R: outR, proc, posted };
}

export function tone(freq: number, dbfs: number, seconds: number, sr = SR, phase = 0): Float32Array {
  const n = Math.round(seconds * sr);
  const a = Math.pow(10, dbfs / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin(2 * Math.PI * freq * (i / sr) + phase);
  return out;
}

export function noise(seconds: number, sigma: number, seed = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(1e-12, rnd()), v = rnd();
    const m = Math.sqrt(-2 * Math.log(u));
    out[i] = sigma * m * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = sigma * m * Math.sin(2 * Math.PI * v);
  }
  return out;
}

export function rmsDb(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-20);
}

export const peak = (x: Float32Array, from = 0, to = x.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};
