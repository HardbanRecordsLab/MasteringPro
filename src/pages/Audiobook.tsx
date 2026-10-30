import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import JSZip from 'jszip';
import { AlertTriangle, BookOpen, Check, Download, Loader2, Trash2, Upload, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BrandMark, Wordmark } from '@/components/Brand';
import { Seo } from '@/components/Seo';
import HrlLangSwitch from '@/lib/hrl/HrlLangSwitch';
import { decodeNative } from '@/lib/audioDecode';
import { FORMAT_MAP, decodeInBrowser, downloadBlob, encodeFormat, resampleBuffer } from '@/lib/audioExport';
import { ACX, PODCAST, acxChecks, fixForAcx, fixForPodcast, measureAcx, type AcxCheck, type AcxFixReport } from '@/lib/acx';
import { measureIntegratedLoudness, measureTruePeak } from '@/lib/loudness';
import { MAX_ALBUM_TRACKS, trackKeyOf, useExportGate } from '@/lib/exportGate';

type Preset = 'acx' | 'podcast';

interface Chapter {
  id: string;
  file: File;
  name: string;
  status: 'queued' | 'analysing' | 'ready' | 'error' | 'fixing' | 'done';
  seconds?: number;
  sampleRate?: number;
  channels?: number;
  checks?: AcxCheck[];
  loudness?: { lufs: number; truePeak: number };
  fix?: AcxFixReport;
  steps?: string[];
  finalChecks?: AcxCheck[];
  finalLoudness?: { lufs: number; truePeak: number };
  note?: string;
  output?: { name: string; blob: Blob };
  error?: string;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

function toBuffer(channels: Float32Array[], sr: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate: sr });
  channels.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return out;
}

const Mark = ({ level }: { level: AcxCheck['level'] }) =>
  level === 'pass' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : level === 'warn' ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> : <X className="w-3.5 h-3.5 text-red-500" />;

const CheckTable = ({ checks, title }: { checks: AcxCheck[]; title: string }) => (
  <div className="min-w-[260px] flex-1">
    <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground mb-1">{title}</p>
    <table className="w-full text-[11px]">
      <tbody>
        {checks.map((c) => (
          <tr key={c.id} className="border-b border-border/60" title={c.fix}>
            <td className="py-1 pr-1 w-5"><Mark level={c.level} /></td>
            <td className="py-1 text-foreground">{c.label}</td>
            <td className="py-1 text-right font-mono text-foreground">{c.value}</td>
            <td className="py-1 pl-2 text-muted-foreground hidden sm:table-cell">{c.requirement}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Audiobook = () => {
  const [preset, setPreset] = useState<Preset>('acx');
  const [mono, setMono] = useState(true);
  const [items, setItems] = useState<Chapter[]>([]);
  const [busy, setBusy] = useState(false);
  const settleExport = useExportGate();
  const ctxRef = useRef<OfflineAudioContext | null>(null);
  const update = useCallback((id: string, patch: Partial<Chapter>) => setItems((cur) => cur.map((c) => (c.id === id ? { ...c, ...patch } : c))), []);

  const decode = async (file: File) => {
    ctxRef.current ??= new OfflineAudioContext(2, 1, 48000);
    return decodeNative(await file.arrayBuffer(), ctxRef.current);
  };

  const analyse = useCallback(async (item: Chapter) => {
    update(item.id, { status: 'analysing' });
    try {
      const buf = await decode(item.file);
      const ch = channelsOf(buf);
      const m = measureAcx(ch, buf.sampleRate);
      update(item.id, {
        status: 'ready', seconds: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels,
        checks: acxChecks(m, { sampleRate: buf.sampleRate, channels: buf.numberOfChannels }),
        loudness: { lufs: measureIntegratedLoudness(buf), truePeak: measureTruePeak(buf).truePeak },
      });
    } catch (e) {
      update(item.id, { status: 'error', error: e instanceof Error ? e.message : 'Could not read this file' });
    }
  }, [update]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const fresh: Chapter[] = Array.from(files).map((file, i) => ({ id: `${Date.now()}-${i}-${file.name}`, file, name: file.name, status: 'queued' }));
    setItems((cur) => [...cur, ...fresh]);
    for (const it of fresh) await analyse(it);          // one at a time: a chapter can be an hour of audio
  };

  const process = async (item: Chapter): Promise<Chapter | null> => {
    update(item.id, { status: 'fixing', error: undefined });
    try {
      const src = await decode(item.file);
      let master: AudioBuffer, fix: AcxFixReport | undefined, steps: string[] | undefined, ceiling: number;
      if (preset === 'acx') {
        const r = fixForAcx(channelsOf(src), src.sampleRate, { mono });
        fix = r.report;
        steps = r.report.steps;
        master = toBuffer(r.channels, src.sampleRate);
        ceiling = ACX.peakMaxDb - 0.1;
      } else {
        const r = fixForPodcast(channelsOf(src), src.sampleRate, { mono });
        master = toBuffer(r.channels, src.sampleRate);
        steps = r.report.steps;
        ceiling = PODCAST.ceilingDb;
      }
      if (master.sampleRate !== ACX.sampleRate) master = await resampleBuffer(master, ACX.sampleRate);
      const fmt = FORMAT_MAP[preset === 'acx' ? 'mp3-192' : mono ? 'mp3-128' : 'mp3-192'];
      const enc = await encodeFormat(master, fmt, 'tpdf', undefined, ceiling);     // the MP3 itself is kept under the peak limit
      const blob = new Blob([enc.data as BlobPart], { type: 'audio/mpeg' });
      // what we promise is about the DELIVERED file: decode the MP3 again and measure that
      const back = await decodeInBrowser(new Uint8Array(await blob.arrayBuffer()), master);
      const done: Partial<Chapter> = {
        status: 'done', fix, steps, output: { name: `${item.name.replace(/\.[^.]+$/, '')}_${preset === 'acx' ? 'ACX' : 'podcast'}.mp3`, blob },
        finalChecks: acxChecks(measureAcx(channelsOf(back), back.sampleRate), { sampleRate: back.sampleRate, channels: back.numberOfChannels }),
        finalLoudness: { lufs: measureIntegratedLoudness(back), truePeak: measureTruePeak(back).truePeak },
      };
      update(item.id, done);
      return { ...item, ...done } as Chapter;
    } catch (e) {
      update(item.id, { status: 'error', error: e instanceof Error ? e.message : 'Processing failed' });
      return null;
    }
  };

  const run = async (list: Chapter[], asZip: boolean) => {
    if (!list.length || busy) return;
    setBusy(true);
    try {
      const outputs: Chapter[] = [];
      for (let i = 0; i < list.length; i += MAX_ALBUM_TRACKS) {          // one credit per chapter, settled in batches the server accepts
        const batch = list.slice(i, i + MAX_ALBUM_TRACKS);
        if (!(await settleExport(batch.map((c) => ({ key: trackKeyOf(c.file), label: c.name }))))) break;
        for (const c of batch) { const r = await process(c); if (r?.output) outputs.push(r); }
      }
      if (!outputs.length) return;
      if (!asZip && outputs.length === 1) { downloadBlob(outputs[0].output!.blob, outputs[0].output!.name); }
      else {
        const zip = new JSZip();
        const lines = [`MasteringPro — ${preset === 'acx' ? 'audiobook (ACX) check' : 'podcast'} report`, new Date().toISOString(), ''];
        for (const o of outputs) {
          zip.file(o.output!.name, o.output!.blob);
          lines.push(`${o.output!.name}`, ...(o.finalChecks ?? []).map((c) => `  [${c.level}] ${c.label}: ${c.value} (${c.requirement})`), ...(o.steps ?? []).map((st) => `  - ${st}`), '');
        }
        zip.file('_REPORT.txt', lines.join('\n'));
        downloadBlob(await zip.generateAsync({ type: 'blob' }), `${preset === 'acx' ? 'audiobook-acx' : 'podcast'}.zip`);
      }
      toast.success(`${outputs.length} file${outputs.length === 1 ? '' : 's'} ready`);
    } finally { setBusy(false); }
  };

  const failing = (c: Chapter) => (c.checks ?? []).filter((x) => x.level === 'fail').length;
  const stillFailing = (c: Chapter) => (c.finalChecks ?? []).filter((x) => x.level === 'fail');

  return (
    <div className="min-h-screen bg-background noise-texture flex flex-col">
      <Seo title="Audiobook (ACX) and podcast mode" path="/audiobook" description="Check narration against ACX audiobook requirements and fix it in your browser; loudness-normalise podcast episodes. Files never leave your computer." />
      <header className="px-2 sm:px-4 pt-3 pb-2">
        <div className="panel flex items-center justify-between gap-3 px-3 sm:px-5 py-2.5">
          <Link to="/" className="flex items-center gap-2.5" aria-label="MasteringPro">
            <BrandMark className="w-7 h-7" /><Wordmark className="text-base sm:text-lg font-extrabold" />
          </Link>
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-primary"><BookOpen className="w-4 h-4" /> Audiobook &amp; podcast</div>
          <div className="flex items-center gap-3"><HrlLangSwitch /><Link to="/app" className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">← Console</Link></div>
        </div>
      </header>

      <main className="flex-1 px-2 sm:px-4 pb-6">
        <div className="max-w-5xl mx-auto w-full space-y-4">
          <section className="panel p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex rounded-md overflow-hidden border border-border text-[11px] font-mono uppercase tracking-wider">
                {(['acx', 'podcast'] as Preset[]).map((p) => (
                  <button key={p} onClick={() => setPreset(p)} className={`px-3 py-1.5 ${preset === p ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>{p === 'acx' ? 'Audiobook (ACX)' : 'Podcast'}</button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={mono} onChange={(e) => setMono(e.target.checked)} /> Mono (usual for narration, half the size)
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {preset === 'acx'
                ? `Checks each chapter against the audio rules ACX applies to audiobook submissions (${ACX.rmsMinDb} to ${ACX.rmsMaxDb} dB RMS, peaks under ${ACX.peakMaxDb} dB, noise floor under ${ACX.noiseFloorMaxDb} dB, room tone at both ends, ${ACX.mp3Kbps} kbps MP3 at 44.1 kHz). Fixing adjusts level, limits peaks, reduces noise and sets the room tone; the delivered MP3 is measured again. Verify the limits against acx.com before submitting: ACX can change them.`
                : `Normalises each episode to ${PODCAST.lufs} LUFS (BS.1770-4) with a look-ahead limiter holding the peaks under ${PODCAST.ceilingDb} dB, then writes an MP3 (${mono ? '128' : '192'} kbps) with the peaks kept under the ceiling after encoding.`}
              {' '}Everything runs in your browser; your files are not uploaded.
            </p>
            <label className="flex flex-col items-center justify-center gap-2 border border-dashed border-border rounded-md p-6 cursor-pointer hover:border-primary/60">
              <Upload className="w-6 h-6 text-muted-foreground" />
              <span className="text-sm text-foreground">Add chapters or episodes</span>
              <span className="text-[11px] text-muted-foreground">WAV, MP3, FLAC, M4A · analysed one at a time</span>
              <input type="file" multiple accept="audio/*" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
          </section>

          {items.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={busy || items.every((c) => c.status === 'queued' || c.status === 'analysing')} onClick={() => run(items.filter((c) => c.status === 'ready' || c.status === 'done'), true)} className="gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Working…</> : <><Wand2 className="w-4 h-4" /> Fix all and download ZIP</>}
              </Button>
              <span className="text-[11px] text-muted-foreground">One credit per chapter. Analysis is free.</span>
            </div>
          )}

          {items.map((c) => (
            <section key={c.id} className="panel p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate" title={c.name}>{c.name}</p>
                  <p className="text-[11px] text-muted-foreground font-mono">
                    {c.seconds ? `${fmtTime(c.seconds)} · ` : ''}{c.sampleRate ? `${c.sampleRate} Hz · ${c.channels === 1 ? 'mono' : 'stereo'}` : ''}
                    {c.status === 'analysing' && ' · analysing…'}{c.status === 'fixing' && ' · working…'}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {c.output && <Button size="sm" variant="secondary" className="gap-1" onClick={() => downloadBlob(c.output!.blob, c.output!.name)}><Download className="w-3.5 h-3.5" /> MP3</Button>}
                  {(c.status === 'ready' || c.status === 'done') && <Button size="sm" disabled={busy} onClick={() => run([c], false)} className="gap-1"><Wand2 className="w-3.5 h-3.5" /> Fix{c.status === 'done' ? ' again' : ''}</Button>}
                  <button aria-label="Remove" disabled={busy} onClick={() => setItems((cur) => cur.filter((x) => x.id !== c.id))} className="text-muted-foreground hover:text-foreground"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
              {c.error && <p className="text-xs text-red-500">{c.error}</p>}
              {c.checks && (
                <div className="flex flex-wrap gap-6">
                  <CheckTable checks={c.checks} title={`Your file${failing(c) ? ` · ${failing(c)} to fix` : ' · meets every limit'}`} />
                  {c.finalChecks && <CheckTable checks={c.finalChecks} title="Delivered MP3, measured again" />}
                </div>
              )}
              {preset === 'podcast' && c.loudness && (
                <p className="text-[11px] font-mono text-muted-foreground">
                  Now {c.loudness.lufs.toFixed(1)} LUFS / {c.loudness.truePeak.toFixed(1)} dBTP{c.finalLoudness ? ` → ${c.finalLoudness.lufs.toFixed(1)} LUFS / ${c.finalLoudness.truePeak.toFixed(1)} dBTP` : ''}
                </p>
              )}
              {c.steps && <ul className="text-[11px] text-muted-foreground list-disc pl-4">{c.steps.map((st, i) => <li key={i}>{st}</li>)}</ul>}
              {c.status === 'done' && preset === 'acx' && stillFailing(c).length > 0 && (
                <p className="text-xs text-amber-500">Could not meet: {stillFailing(c).map((x) => `${x.label} (${x.value})`).join(', ')}. {stillFailing(c).some((x) => x.id === 'noise') ? 'A noise floor this high needs a quieter recording; noise reduction alone cannot reach it without damaging the voice.' : ''}</p>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
};

export default Audiobook;
