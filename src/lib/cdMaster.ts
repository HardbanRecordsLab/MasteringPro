/**
 * CD master: a Red Book audio image (BIN) with a CUE sheet that carries the track starts, the pre-gaps, the ISRC of every track and the
 * album's UPC/EAN, plus the CD-TEXT titles. Pressing plants and burning programs read BIN + CUE; it is NOT a DDP image (the DDP format is
 * proprietary and its audio layout could not be verified, so we do not write one).
 *
 * The image is plain CD-DA as stored in a raw rip: 2352-byte sectors of 16-bit little-endian stereo at 44.1 kHz, 588 sample frames per
 * sector, 75 sectors per second. Every track starts on a sector boundary (the last sector of a track is padded with silence), and a gap
 * before a track is real silence stored in the image and announced by INDEX 00. Track 1 starts at 00:00:00; the 2-second lead-in pause is
 * added by the burner and is not stored.
 */
import { quantizeChannels, type DitherMode } from '@/lib/quantize';

export const SAMPLE_RATE = 44100;
export const SECTOR_FRAMES = 588;
export const SECTOR_BYTES = SECTOR_FRAMES * 4;
export const SECTORS_PER_SECOND = 75;
export const MAX_TRACKS = 99;
export const MIN_TRACK_SECONDS = 4;
/** 79:57 is the longest programme an 80-minute disc takes; older 74-minute / 650 MB media stop at 74:00 */
export const MAX_DISC_SECONDS = 79 * 60 + 57;
export const WARN_DISC_SECONDS = 74 * 60;

export interface CdTrackIn {
  title: string;
  performer?: string;
  songwriter?: string;
  /** 12 characters, e.g. PLABC2600001 (hyphens and spaces are accepted) */
  isrc?: string;
  /** silence stored BEFORE this track, seconds (ignored for track 1) */
  gapBeforeSec: number;
  /** interleaved L,R, 16-bit, 44.1 kHz */
  pcm: Int16Array;
}

export interface CdDiscIn {
  title: string;
  performer: string;
  /** 12-digit UPC-A or 13-digit EAN-13 */
  upc?: string;
  tracks: CdTrackIn[];
}

export interface CdLayoutTrack {
  number: number;
  /** first sector of the gap (null for track 1 and for tracks without a gap) */
  index00: number | null;
  index01: number;
  /** sectors of audio, padding included */
  sectors: number;
  /** real audio frames before the padding */
  frames: number;
}

export interface CdLayout { tracks: CdLayoutTrack[]; totalSectors: number }

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// ───────────────────────────── identifiers ─────────────────────────────
export function normaliseIsrc(code: string | undefined): string | null {
  if (!code) return null;
  const v = code.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : null;
}

/** UPC-A (12) or EAN-13 (13) with its check digit; returns the 13-digit form the CUE CATALOG command wants, or null. */
export function normaliseUpc(code: string | undefined): string | null {
  const d = (code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12,13}$/.test(d)) return null;
  const ean = d.length === 12 ? '0' + d : d;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(ean[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(ean[12]) ? ean : null;
}

// ───────────────────────────── layout and image ─────────────────────────────
export const gapSectors = (seconds: number) => Math.max(0, Math.round(seconds * SECTORS_PER_SECOND));
export const framesOf = (pcm: Int16Array) => Math.floor(pcm.length / 2);
export const sectorsOf = (frames: number) => Math.ceil(frames / SECTOR_FRAMES);

/** Layout from frame counts and gaps alone, so a disc can be planned (and refused) before a single track is rendered. */
export function layoutFrames(frames: number[], gapsBeforeSec: number[]): CdLayout {
  let cursor = 0;
  const tracks: CdLayoutTrack[] = frames.map((f, i) => {
    const gap = i === 0 ? 0 : gapSectors(gapsBeforeSec[i] ?? 0);
    const index00 = gap > 0 ? cursor : null;
    cursor += gap;
    const sectors = sectorsOf(f);
    const entry = { number: i + 1, index00, index01: cursor, sectors, frames: f };
    cursor += sectors;
    return entry;
  });
  return { tracks, totalSectors: cursor };
}

export const layoutDisc = (disc: CdDiscIn): CdLayout =>
  layoutFrames(disc.tracks.map((t) => framesOf(t.pcm)), disc.tracks.map((t) => t.gapBeforeSec));

/** The raw image as byte chunks (so a 700 MB disc is never one allocation): audio padded to whole sectors, gaps as silence. */
export function binParts(disc: CdDiscIn, layout: CdLayout): Uint8Array[] {
  const parts: Uint8Array[] = [];
  disc.tracks.forEach((t, i) => {
    const lt = layout.tracks[i];
    if (lt.index00 !== null) parts.push(new Uint8Array((lt.index01 - lt.index00) * SECTOR_BYTES));
    const want = lt.sectors * SECTOR_FRAMES * 2;
    let padded = t.pcm;
    if (padded.length !== want) { padded = new Int16Array(want); padded.set(t.pcm.subarray(0, lt.frames * 2)); }
    if (LITTLE_ENDIAN) {
      parts.push(new Uint8Array(padded.buffer));
    } else {
      const bytes = new Uint8Array(padded.length * 2);
      const dv = new DataView(bytes.buffer);
      for (let k = 0; k < padded.length; k++) dv.setInt16(k * 2, padded[k], true);
      parts.push(bytes);
    }
  });
  return parts;
}

/**
 * Float stereo at 44.1 kHz (a mono buffer is used for both channels) to the interleaved 16-bit samples of the image, dithered.
 * The result is already padded with silence to a whole sector, so the image can be assembled without copying it again.
 */
export function pcmFromChannels(channels: Float32Array[], dither: DitherMode): Int16Array {
  const left = channels[0], right = channels[1] ?? channels[0];
  const q = quantizeChannels([left, right], 16, dither);
  const out = new Int16Array(sectorsOf(left.length) * SECTOR_FRAMES * 2);
  for (let i = 0; i < left.length; i++) { out[2 * i] = q[0][i]; out[2 * i + 1] = q[1][i]; }
  return out;
}

// ───────────────────────────── CUE sheet ─────────────────────────────
export function msf(sector: number): string {
  const f = sector % SECTORS_PER_SECOND;
  const s = Math.floor(sector / SECTORS_PER_SECOND) % 60;
  const m = Math.floor(sector / (SECTORS_PER_SECOND * 60));
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

const SPECIAL: Record<string, string> = { 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ø': 'o', 'Ø': 'O', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', '’': "'", '‘': "'", '“': "'", '”': "'", '–': '-', '—': '-' };

/** CD-TEXT is ISO 8859-1: keep what that can hold, transliterate the rest (Polish letters included), never leave a quote or a line break inside a string. */
export function cdText(value: string | undefined, max = 80): string {
  let out = '';
  for (const ch of (value ?? '').normalize('NFC')) {
    if (SPECIAL[ch] !== undefined) { out += SPECIAL[ch]; continue; }
    if (ch.charCodeAt(0) > 255) {
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      out += base.charCodeAt(0) <= 255 && base ? base : '?';
    } else out += ch;
  }
  return out.replace(/["\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildCueSheet(disc: CdDiscIn, layout: CdLayout, binName: string): string {
  const L: string[] = ['REM COMMENT "Built by MasteringPro: CD-DA image, 16-bit little-endian stereo 44.1 kHz"'];
  const upc = normaliseUpc(disc.upc);
  if (upc) L.push(`CATALOG ${upc}`);
  if (cdText(disc.performer)) L.push(`PERFORMER "${cdText(disc.performer)}"`);
  L.push(`TITLE "${cdText(disc.title)}"`);
  L.push(`FILE "${cdText(binName, 120).replace(/[\\/]/g, '_')}" BINARY`);
  disc.tracks.forEach((t, i) => {
    const lt = layout.tracks[i];
    L.push(`  TRACK ${String(lt.number).padStart(2, '0')} AUDIO`);
    L.push(`    TITLE "${cdText(t.title)}"`);
    const performer = cdText(t.performer ?? disc.performer);
    if (performer) L.push(`    PERFORMER "${performer}"`);
    if (cdText(t.songwriter)) L.push(`    SONGWRITER "${cdText(t.songwriter)}"`);
    const isrc = normaliseIsrc(t.isrc);
    if (isrc) L.push(`    ISRC ${isrc}`);
    if (lt.index00 !== null) L.push(`    INDEX 00 ${msf(lt.index00)}`);
    L.push(`    INDEX 01 ${msf(lt.index01)}`);
  });
  return L.join('\r\n') + '\r\n';
}

/** The CUE as bytes in ISO 8859-1 (what burning programs expect), after cdText() everything is <= 255. */
export const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// ───────────────────────────── checks and report ─────────────────────────────
export interface CdTrackStats { peakDb: number; fullScaleSamples: number }

export function trackStats(pcm: Int16Array): CdTrackStats {
  let peak = 0, full = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (a > peak) peak = a;
    if (pcm[i] === 32767 || pcm[i] === -32768) full++;
  }
  return { peakDb: peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768), fullScaleSamples: full };
}

export interface CdCheck { errors: string[]; warnings: string[]; totalSeconds: number }

export interface CdPlanTrack { title: string; isrc?: string; gapBeforeSec: number; seconds: number }

/** Everything that can be known before rendering: counts, identifiers, lengths, gaps, the total programme time. */
export function checkPlan(upc: string | undefined, tracks: CdPlanTrack[]): CdCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const n = tracks.length;
  if (n === 0) errors.push('A disc needs at least one track.');
  if (n > MAX_TRACKS) errors.push(`A CD holds at most ${MAX_TRACKS} tracks; there are ${n}.`);
  if (upc && !normaliseUpc(upc)) errors.push(`The UPC/EAN “${upc}” has the wrong length or a wrong check digit (12 or 13 digits).`);
  if (!upc) warnings.push('No UPC/EAN: pressing plants usually want one on the master (the distributor or the plant can assign it).');
  const seen = new Map<string, number>();
  tracks.forEach((t, i) => {
    const label = `Track ${i + 1} “${t.title}”`;
    if (t.seconds < MIN_TRACK_SECONDS) errors.push(`${label} is ${t.seconds.toFixed(1)} s; Red Book allows no track shorter than ${MIN_TRACK_SECONDS} s.`);
    if (t.isrc) {
      const isrc = normaliseIsrc(t.isrc);
      if (!isrc) errors.push(`${label}: “${t.isrc}” is not a valid ISRC (CC-XXX-YY-NNNNN).`);
      else if (seen.has(isrc)) errors.push(`${label} repeats the ISRC of track ${seen.get(isrc)}; every track needs its own.`);
      else seen.set(isrc, i + 1);
    } else warnings.push(`${label} has no ISRC.`);
    if (i > 0 && !(t.gapBeforeSec >= 0 && t.gapBeforeSec <= 10)) errors.push(`${label}: the gap before it must be between 0 and 10 s.`);
    if (!t.title.trim()) warnings.push(`Track ${i + 1} has no title (CD-TEXT will be empty).`);
  });
  const layout = layoutFrames(tracks.map((t) => Math.round(t.seconds * SAMPLE_RATE)), tracks.map((t) => t.gapBeforeSec));
  const totalSeconds = layout.totalSectors / SECTORS_PER_SECOND;
  if (totalSeconds > MAX_DISC_SECONDS) errors.push(`The programme is ${msf(layout.totalSectors)} long; an 80-minute disc holds at most 79:57.`);
  else if (totalSeconds > WARN_DISC_SECONDS) warnings.push(`The programme is ${msf(layout.totalSectors)}: longer than 74:00, which older 650 MB media cannot hold.`);
  return { errors, warnings, totalSeconds };
}

/** The plan check on the real samples, plus the one thing only the samples show: clipping. */
export function validateDisc(disc: CdDiscIn): CdCheck {
  const check = checkPlan(disc.upc, disc.tracks.map((t) => ({ title: t.title, isrc: t.isrc, gapBeforeSec: t.gapBeforeSec, seconds: framesOf(t.pcm) / SAMPLE_RATE })));
  disc.tracks.forEach((t, i) => {
    const st = trackStats(t.pcm);
    if (st.fullScaleSamples >= 3) check.warnings.push(`Track ${i + 1} “${t.title}” has ${st.fullScaleSamples} samples at digital full scale: check for clipping before pressing.`);
  });
  return check;
}

export function pqList(disc: CdDiscIn, layout: CdLayout): string {
  const rows = disc.tracks.map((t, i) => {
    const lt = layout.tracks[i];
    const st = trackStats(t.pcm);
    return `${String(lt.number).padStart(2, '0')}  ${(lt.index00 !== null ? msf(lt.index00) : '--:--:--')}  ${msf(lt.index01)}  ${msf(lt.sectors)}  ${normaliseIsrc(t.isrc) ?? '------------'}  ${Number.isFinite(st.peakDb) ? st.peakDb.toFixed(1).padStart(6) : '  -inf'}  ${cdText(t.title, 60)}`;
  });
  return ['No  Index00    Index01    Length    ISRC          Peak    Title', ...rows,
    '', `Total programme: ${msf(layout.totalSectors)} (${layout.totalSectors} sectors of 2352 bytes), BIN size ${layout.totalSectors * SECTOR_BYTES} bytes`].join('\r\n') + '\r\n';
}
