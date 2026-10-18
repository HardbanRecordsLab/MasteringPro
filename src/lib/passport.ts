/** Master Passport — client side: hash the exported file and ask the server to sign what was measured. */
import type { MasterReport } from '@/lib/audioExport';
import type { ReleaseMeta } from '@/lib/tags';
import { normaliseIsrc } from '@/lib/tags';

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PassportFile {
  name: string;
  data: ArrayBuffer | Uint8Array;
  format: string;
  sampleRate: number;
  bitDepth: number | null;
  channels: number;
  durationSec: number;
}

export async function passportInput(f: PassportFile, report: MasterReport, meta?: ReleaseMeta) {
  return {
    sha256: await sha256Hex(f.data),
    file: { name: f.name, format: f.format, sampleRate: f.sampleRate, bitDepth: f.bitDepth, channels: f.channels,
      durationSec: f.durationSec, bytes: f.data.byteLength },
    measurements: { integratedLufs: report.integratedLufs, truePeakDbtp: report.truePeakDb, targetLufs: report.targetLufs,
      targetPeakDbtp: report.targetPeakDb },
    release: meta ? { title: meta.title, artist: meta.artist, album: meta.album, isrc: normaliseIsrc(meta.isrc) ?? undefined } : undefined,
  };
}

/** Signs a passport, or returns null (signed out / server unreachable) — exports never fail because of it. */
export type PassportSigner = (input: Awaited<ReturnType<typeof passportInput>>) => Promise<object | null>;
