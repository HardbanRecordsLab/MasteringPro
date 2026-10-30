/**
 * Album mastering pipeline.
 *
 * Tracks are decoded one at a time (an album of ten 4-minute tracks is ~1 GB as float32 stereo — holding it all would
 * exhaust the tab), rendered through the shared chain with the track's own loudness target and tonal correction,
 * faded, encoded, and released before the next one starts.
 */
import JSZip from 'jszip';
import type { ProcessingParams } from '@/contexts/AudioContext';
import { decodeNative } from '@/lib/audioDecode';
import { FORMAT_MAP, encodeFormat, renderMaster, type DitherMode } from '@/lib/audioExport';
import { measureIntegratedLoudness, measureTruePeak } from '@/lib/loudness';
import {
  applyFadesToChannel, buildCue, planTrack, sanitizeFileName, sequenceCost,
  type AlbumSettings, type AlbumTrack, type TrackPlan,
} from '@/lib/album/plan';

export interface AlbumJobTrack {
  info: AlbumTrack;
  file: File;
  /** silence BEFORE this track, seconds (CUE pregap) */
  gapBeforeSec: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface AlbumJob {
  tracks: AlbumJobTrack[];
  settings: AlbumSettings;
  baseChain: ProcessingParams;
  formatId: string;
  dither: DitherMode;
  targetPeakDb: number;
  album: { title: string; performer: string; year?: string; genre?: string };
  onProgress?: (trackIndex: number, label: string, pct: number) => void;
  signal?: AbortSignal;
}

export interface AlbumTrackResult {
  id: string;
  name: string;
  file: string;
  lufsBefore: number;
  lufsAfter: number;
  targetLufs: number;
  truePeakAfter: number;
  toneBeforeDb: number;
  toneAfterDb: number;
  onTarget: boolean;
  note?: string;
}

export interface AlbumReport {
  tracks: AlbumTrackResult[];
  spreadBefore: number;
  spreadAfter: number;
  transitionCost: number;
  toneBeforeMean: number;
  toneAfterMean: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** copy of the buffer with edge fades applied (the render output is not mutated) */
function withFades(buf: AudioBuffer, fadeInMs: number, fadeOutMs: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: buf.length, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = Float32Array.from(buf.getChannelData(c));
    applyFadesToChannel(d, buf.sampleRate, Math.max(2, fadeInMs), Math.max(2, fadeOutMs)); // ≥ 2 ms: never a click at an edge
    out.copyToChannel(d, c);
  }
  return out;
}

export function formatAlbumReport(r: AlbumReport, album: { title: string; performer: string }, settings: AlbumSettings): string {
  const L: string[] = [];
  L.push(`${album.title} — ${album.performer}`, 'MasteringPro album report', '');
  L.push(`Target loudness: ${settings.targetLufs} LUFS-I · balance ${Math.round(settings.loudnessBalance * 100)} % · tonal strength ${Math.round(settings.toneStrength * 100)} % (±${settings.maxToneDb} dB)`);
  L.push(`Loudness spread (loudest − quietest): ${r.spreadBefore} LU before → ${r.spreadAfter} LU after`);
  L.push(`Tonal distance from the album anchor (mean): ${r.toneBeforeMean} dB → ${r.toneAfterMean} dB rms`, '');
  L.push('#  Track                              Before    After   Target   TP     Tone before→after');
  r.tracks.forEach((t, i) => {
    L.push(`${pad2(i + 1)} ${t.name.slice(0, 34).padEnd(34)} ${String(t.lufsBefore).padStart(6)}  ${String(t.lufsAfter).padStart(6)}  ${String(t.targetLufs).padStart(6)}  ${String(t.truePeakAfter).padStart(5)}  ${t.toneBeforeDb} → ${t.toneAfterDb}${t.onTarget ? '' : '  (off target)'}`);
    if (t.note) L.push(`   ${t.note}`);
  });
  return L.join('\r\n') + '\r\n';
}

export async function masterAlbum(job: AlbumJob): Promise<{ zip: Blob; report: AlbumReport }> {
  const { tracks, settings, baseChain, formatId, dither, targetPeakDb, album, onProgress, signal } = job;
  const fmt = FORMAT_MAP[formatId] ?? FORMAT_MAP.wav24;
  const infos = tracks.map((t) => t.info);
  const zip = new JSZip();
  const results: AlbumTrackResult[] = [];
  const plans: TrackPlan[] = infos.map((t) => planTrack(t, infos, settings));
  const files: string[] = [];
  const decodeCtx = new OfflineAudioContext(2, 1, 48000);

  for (let i = 0; i < tracks.length; i++) {
    if (signal?.aborted) throw new DOMException('Album mastering cancelled', 'AbortError');
    const jt = tracks[i];
    const plan = plans[i];
    onProgress?.(i, 'Decoding', 2);
    const src = await decodeNative(await jt.file.arrayBuffer(), decodeCtx);

    const processing: ProcessingParams = {
      ...baseChain,
      matchEnabled: !!plan.curve,
      matchCurve: plan.curve,
      matchAmount: Math.round(settings.toneStrength * 100),
    };
    const { buffer: rendered, report } = await renderMaster(src, {
      processing,
      targetPeakDb,
      targetLufs: plan.targetLufs,
      onProgress: (label, pct) => onProgress?.(i, label, pct),
    });
    const finished = withFades(rendered, jt.fadeInMs, jt.fadeOutMs);

    onProgress?.(i, 'Encoding', 95);
    const { data, check } = await encodeFormat(finished, fmt, dither, {
      title: jt.info.name, artist: album.performer, album: album.title, year: album.year, genre: album.genre,
      comment: `Track ${i + 1} of ${tracks.length}`,
    }, targetPeakDb);
    const name = `${pad2(i + 1)} - ${sanitizeFileName(jt.info.name)}.${fmt.extension}`;
    zip.file(name, data);
    files.push(name);

    results.push({
      id: jt.info.id,
      name: jt.info.name,
      file: name,
      lufsBefore: round1(jt.info.lufs),
      lufsAfter: round1(measureIntegratedLoudness(finished)),
      targetLufs: round1(plan.targetLufs),
      truePeakAfter: round1(check?.truePeakDb ?? measureTruePeak(finished).truePeak),     // lossy: the decoded file, not the buffer before encoding
      toneBeforeDb: plan.toneBeforeDb,
      toneAfterDb: plan.toneAfterDb,
      onTarget: report.onTarget,
      note: report.note,
    });
    onProgress?.(i, 'Done', 100);
  }

  const mean = (a: number[]) => (a.length ? round1(a.reduce((s, v) => s + v, 0) / a.length) : 0);
  const spread = (a: number[]) => (a.length ? round1(Math.max(...a) - Math.min(...a)) : 0);
  const report: AlbumReport = {
    tracks: results,
    spreadBefore: spread(results.map((r) => r.lufsBefore)),
    spreadAfter: spread(results.map((r) => r.lufsAfter)),
    transitionCost: round1(sequenceCost(infos)),
    toneBeforeMean: mean(results.map((r) => r.toneBeforeDb)),
    toneAfterMean: mean(results.map((r) => r.toneAfterDb)),
  };

  zip.file('album.cue', buildCue(album, tracks.map((t, i) => ({
    title: t.info.name,
    file: files[i],
    gapBeforeSec: i === 0 ? 0 : t.gapBeforeSec,
  }))));
  zip.file('ALBUM_REPORT.txt', formatAlbumReport(report, album, settings));
  zip.file('album-report.json', JSON.stringify({ album, settings, format: fmt.id, report }, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  return { zip: blob, report };
}
