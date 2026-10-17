import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Disc3, Download, Loader2, Trash2, Upload, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { BrandMark, Wordmark } from '@/components/Brand';
import { Seo } from '@/components/Seo';
import { DEFAULT_PROCESSING } from '@/contexts/AudioContext';
import { FACTORY_PRESETS } from '@/lib/factoryPresets';
import { decodeNative } from '@/lib/audioDecode';
import { downloadBlob } from '@/lib/audioExport';
import { analyzeMusicalContent } from '@/lib/musicAnalysis';
import { profileAudio } from '@/lib/profileClient';
import {
  DEFAULT_ALBUM_SETTINGS, brightnessOct, planTrack, sequenceCost, suggestOrder,
  type AlbumSettings, type AlbumTrack, type OrderMode,
} from '@/lib/album/plan';
import { masterAlbum, type AlbumReport } from '@/lib/album/master';
import { MAX_ALBUM_TRACKS, trackKeyOf, useExportGate } from '@/lib/exportGate';
import { useAuth } from '@/contexts/AuthContext';

interface Item {
  id: string;
  file: File;
  name: string;
  status: 'queued' | 'analysing' | 'ready' | 'error';
  info?: AlbumTrack;
  error?: string;
  gapBeforeSec: number;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const TARGETS = [
  { v: -16, label: '−16 LUFS · Apple Music / podcasts' },
  { v: -14, label: '−14 LUFS · Spotify, YouTube, Tidal' },
  { v: -12, label: '−12 LUFS · dynamic pop / rock' },
  { v: -11, label: '−11 LUFS · loud streaming' },
  { v: -9, label: '−9 LUFS · club / CD' },
];
const FORMATS = [
  { id: 'wav24', label: 'WAV 24-bit' },
  { id: 'wav16', label: 'WAV 16-bit (CD)' },
  { id: 'flac', label: 'FLAC 24-bit' },
  { id: 'mp3-320', label: 'MP3 320 kbps' },
];

const field = 'bg-background border border-border rounded-sm text-xs px-2 py-1 text-foreground';
const label = 'text-[9px] uppercase tracking-[0.16em] text-muted-foreground';

const Album = () => {
  const [items, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<AlbumSettings>(DEFAULT_ALBUM_SETTINGS);
  const [presetId, setPresetId] = useState('transparent');
  const [formatId, setFormatId] = useState('wav24');
  const [gapSec, setGapSec] = useState(2);
  const [title, setTitle] = useState('My Album');
  const [performer, setPerformer] = useState('Artist');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ i: number; label: string; pct: number } | null>(null);
  const [result, setResult] = useState<{ blob: Blob; report: AlbumReport } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const settleExport = useExportGate();
  const { user, enabled: accountsOn } = useAuth();
  const abortRef = useRef<AbortController | null>(null);

  // ── analysis queue: one track at a time (decode → profile → key / tempo), then the buffer is released ──
  const analysing = items.some((i) => i.status === 'analysing');
  useEffect(() => {
    if (analysing) return;
    const next = items.find((i) => i.status === 'queued');
    if (!next) return;
    setItems((cur) => cur.map((i) => (i.id === next.id ? { ...i, status: 'analysing' } : i)));
    (async () => {
      try {
        const buf = await decodeNative(await next.file.arrayBuffer(), new OfflineAudioContext(2, 1, 48000));
        const profile = await profileAudio(buf);
        let key: string | undefined;
        let bpm: number | undefined;
        try {
          const m = await analyzeMusicalContent(buf);
          key = m.key !== '—' ? m.key : undefined;
          bpm = m.bpm > 0 ? m.bpm : undefined;
        } catch { /* optional */ }
        const info: AlbumTrack = {
          id: next.id, name: next.name, durationSec: buf.duration, lufs: profile.lufs, lra: profile.lra,
          truePeakDb: profile.truePeakDb, profile, key, bpm,
        };
        setItems((cur) => cur.map((i) => (i.id === next.id ? { ...i, status: 'ready', info } : i)));
      } catch (e) {
        console.error(e);
        setItems((cur) => cur.map((i) => (i.id === next.id ? { ...i, status: 'error', error: 'Could not read this file' } : i)));
      }
    })();
  }, [items, analysing]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('audio/') || /\.(wav|aiff?|flac|mp3|m4a|ogg)$/i.test(f.name));
    if (!list.length) { toast.error('No audio files found'); return; }
    setResult(null);
    setItems((cur) => {
      const room = Math.max(0, MAX_ALBUM_TRACKS - cur.length);
      if (list.length > room) toast.error(`An album holds up to ${MAX_ALBUM_TRACKS} tracks — ${list.length - room} file(s) were left out.`);
      return [
      ...cur,
      ...list.slice(0, room).map((file) => ({
        id: crypto.randomUUID(), file, name: file.name.replace(/\.[^.]+$/, ''), status: 'queued' as const, gapBeforeSec: gapSec,
      })),
      ];
    });
  }, [gapSec]);

  const ready = items.filter((i) => i.status === 'ready' && i.info);
  const infos = ready.map((i) => i.info!);

  const summary = useMemo(() => {
    if (infos.length === 0) return null;
    const l = infos.map((t) => t.lufs);
    const plans = infos.map((t) => planTrack(t, infos, settings));
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    return {
      spread: Math.round((Math.max(...l) - Math.min(...l)) * 10) / 10,
      toneBefore: Math.round(mean(plans.map((p) => p.toneBeforeDb)) * 10) / 10,
      toneAfter: Math.round(mean(plans.map((p) => p.toneAfterDb)) * 10) / 10,
      cost: Math.round(sequenceCost(infos) * 10) / 10,
    };
  }, [infos, settings]);

  const move = (idx: number, dir: -1 | 1) => setItems((cur) => {
    const j = idx + dir;
    if (j < 0 || j >= cur.length) return cur;
    const next = cur.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });

  const reorder = (mode: OrderMode) => {
    if (ready.length < 3) return;
    const order = suggestOrder(infos, mode).map((t) => t.id);
    setItems((cur) => {
      const readyById = new Map(cur.filter((i) => i.info).map((i) => [i.id, i]));
      const others = cur.filter((i) => !i.info);
      return [...order.map((id) => readyById.get(id)!), ...others];
    });
    setResult(null);
  };

  const run = async () => {
    if (!ready.length || busy) return;
    if (accountsOn && user && !window.confirm(
      `Wyeksportować ${ready.length} utworów? Pobierze do ${ready.length} kredytów (masz ${user.credits}). Utwory opłacone w ciągu ostatnich 3 dni są bezpłatne.`,
    )) return;
    if (!(await settleExport(ready.map((it) => ({ key: trackKeyOf(it.file), label: it.name }))))) return;
    const preset = FACTORY_PRESETS.find((p) => p.id === presetId);
    const baseChain = { ...DEFAULT_PROCESSING, ...(preset?.chain ?? {}) };
    abortRef.current = new AbortController();
    setBusy(true);
    setResult(null);
    try {
      const { zip, report } = await masterAlbum({
        tracks: ready.map((it, i) => ({
          info: { ...it.info!, name: it.name },
          file: it.file,
          gapBeforeSec: it.gapBeforeSec,
          fadeInMs: i === 0 ? 40 : 10,
          fadeOutMs: i === ready.length - 1 ? 3000 : 30,
        })),
        settings,
        baseChain,
        formatId,
        dither: 'tpdf',
        targetPeakDb: -1,
        album: { title, performer },
        onProgress: (i, lbl, pct) => setProgress({ i, label: lbl, pct }),
        signal: abortRef.current.signal,
      });
      setResult({ blob: zip, report });
      toast.success('Album mastered');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { toast.error('Album mastering failed'); console.error(e); }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const set = (patch: Partial<AlbumSettings>) => { setSettings((s) => ({ ...s, ...patch })); setResult(null); };

  return (
    <div className="min-h-screen bg-background noise-texture flex flex-col">
      <Seo title="Tryb albumu" path="/album" description="Zmasteruj cały album naraz: spójna głośność i brzmienie, kolejność, przerwy, plik CUE i raport." noIndex />
      <header className="px-2 sm:px-4 pt-3 pb-2">
        <div className="panel flex items-center justify-between gap-3 px-3 sm:px-5 py-2.5">
          <Link to="/" className="flex items-center gap-2.5" aria-label="MasteringPro — strona główna">
            <BrandMark className="w-7 h-7" /><Wordmark className="text-base sm:text-lg font-extrabold" />
          </Link>
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-primary"><Disc3 className="w-4 h-4" /> Album mode</div>
          <Link to="/app" className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">← Single-track console</Link>
        </div>
      </header>

      <main className="flex-1 px-2 sm:px-4 pb-6">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* ───────── tracks ───────── */}
          <section className="lg:col-span-8 space-y-4">
            <div
              className="panel p-4 border-dashed text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            >
              <input ref={fileRef} type="file" accept="audio/*,.wav,.aif,.aiff,.flac,.mp3" multiple className="hidden"
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
              <Upload className="w-5 h-5 mx-auto text-primary mb-1" />
              <div className="text-sm text-foreground">Drop all the tracks of the album here</div>
              <div className="text-[11px] text-muted-foreground">WAV · AIFF · FLAC · MP3 — each file is read at its own sample rate</div>
            </div>

            {items.length > 0 && (
              <div className="panel p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-section-header">Tracklist · {items.length}</span>
                  <div className="flex items-center gap-1.5">
                    <span className={label}>Suggest order</span>
                    {([['flow', 'Smooth flow'], ['rising', 'Rising'], ['arc', 'Arc']] as [OrderMode, string][]).map(([m, l]) => (
                      <button key={m} onClick={() => reorder(m)} disabled={ready.length < 3 || busy}
                        className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-40">{l}</button>
                    ))}
                  </div>
                </div>

                <div className="divide-y divide-border">
                  {items.map((it, idx) => (
                    <div key={it.id} className="py-2 grid grid-cols-12 items-center gap-2">
                      <span className="col-span-1 text-xs font-mono text-muted-foreground">{String(idx + 1).padStart(2, '0')}</span>
                      <div className="col-span-5 min-w-0">
                        <input value={it.name} onChange={(e) => setItems((c) => c.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))}
                          className={`${field} w-full`} aria-label={`Title of track ${idx + 1}`} />
                        {it.info && (
                          <div className="text-[9px] font-mono text-muted-foreground mt-0.5">
                            {fmtTime(it.info.durationSec)} · {it.info.lufs.toFixed(1)} LUFS · {it.info.truePeakDb.toFixed(1)} dBTP
                            {it.info.key ? ` · ${it.info.key}` : ''}{it.info.bpm ? ` · ${it.info.bpm} BPM` : ''}
                            {` · tone ${brightnessOct(it.info.profile) >= 0 ? '+' : ''}${brightnessOct(it.info.profile).toFixed(1)} oct`}
                          </div>
                        )}
                        {it.status === 'analysing' && <div className="text-[9px] font-mono text-primary mt-0.5 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> analysing…</div>}
                        {it.status === 'queued' && <div className="text-[9px] font-mono text-muted-foreground mt-0.5">waiting…</div>}
                        {it.status === 'error' && <div className="text-[9px] font-mono text-destructive mt-0.5">{it.error}</div>}
                      </div>
                      <div className="col-span-3">
                        {idx > 0 && (
                          <label className="flex items-center gap-1 text-[9px] font-mono text-muted-foreground">
                            gap
                            <input type="number" min={0} max={10} step={0.5} value={it.gapBeforeSec}
                              onChange={(e) => setItems((c) => c.map((x) => (x.id === it.id ? { ...x, gapBeforeSec: Math.max(0, Math.min(10, Number(e.target.value))) } : x)))}
                              className={`${field} w-14`} aria-label={`Gap before track ${idx + 1}, seconds`} />
                            s
                          </label>
                        )}
                      </div>
                      <div className="col-span-3 flex justify-end gap-1">
                        <button onClick={() => move(idx, -1)} disabled={idx === 0 || busy} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
                        <button onClick={() => move(idx, 1)} disabled={idx === items.length - 1 || busy} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
                        <button onClick={() => { setItems((c) => c.filter((x) => x.id !== it.id)); setResult(null); }} disabled={busy} className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-30" aria-label="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>

                {summary && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
                    {[
                      ['Loudness spread', `${summary.spread} LU`],
                      ['Tonal distance', `${summary.toneBefore} → ${summary.toneAfter} dB`],
                      ['Transition cost', `${summary.cost}`],
                      ['Tracks ready', `${ready.length} / ${items.length}`],
                    ].map(([k, v]) => (
                      <div key={k} className="p-2 bg-background rounded-sm border border-border">
                        <div className={label}>{k}</div>
                        <div className="text-sm font-mono text-primary">{v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {result && (
              <div className="panel-active p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-section-header">Result</span>
                  <Button size="sm" className="gap-2" onClick={() => downloadBlob(result.blob, `${title.replace(/[^\w\- ]+/g, '').trim() || 'album'}_masters.zip`)}>
                    <Download className="w-3.5 h-3.5" /> Download album (ZIP)
                  </Button>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground">
                  Spread {result.report.spreadBefore} → {result.report.spreadAfter} LU · tonal distance {result.report.toneBeforeMean} → {result.report.toneAfterMean} dB · ZIP contains the tracks, album.cue (pregaps) and the report
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px] font-mono">
                    <thead className="text-muted-foreground"><tr><th className="text-left py-1">Track</th><th>Before</th><th>After</th><th>Target</th><th>True peak</th><th>Tone Δ</th></tr></thead>
                    <tbody>
                      {result.report.tracks.map((t, i) => (
                        <tr key={t.id} className="border-t border-border">
                          <td className="py-1 pr-2 text-left text-foreground">{String(i + 1).padStart(2, '0')} {t.name}</td>
                          <td className="text-center">{t.lufsBefore}</td>
                          <td className={`text-center ${t.onTarget ? 'text-primary' : 'text-destructive'}`}>{t.lufsAfter}</td>
                          <td className="text-center">{t.targetLufs}</td>
                          <td className="text-center">{t.truePeakAfter}</td>
                          <td className="text-center">{t.toneBeforeDb} → {t.toneAfterDb}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>

          {/* ───────── settings ───────── */}
          <aside className="lg:col-span-4 space-y-4">
            <div className="panel p-3 space-y-3">
              <span className="text-section-header">Album</span>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1"><span className={label}>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} className={`${field} w-full`} /></label>
                <label className="space-y-1"><span className={label}>Artist</span><input value={performer} onChange={(e) => setPerformer(e.target.value)} className={`${field} w-full`} /></label>
              </div>

              <label className="block space-y-1">
                <span className={label}>Loudness target</span>
                <select value={settings.targetLufs} onChange={(e) => set({ targetLufs: Number(e.target.value) })} className={`${field} w-full`}>
                  {TARGETS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                </select>
              </label>

              <div className="space-y-1">
                <div className="flex justify-between"><span className={label}>Keep original loudness differences</span><span className="text-[11px] font-mono text-primary">{Math.round(settings.loudnessBalance * 100)} %</span></div>
                <Slider value={[settings.loudnessBalance * 100]} min={0} max={100} step={5} onValueChange={(v) => set({ loudnessBalance: v[0] / 100 })} />
                <div className="text-[9px] text-muted-foreground">0 % = every track on the target · higher = a ballad may stay quieter than the single</div>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between"><span className={label}>Tonal consistency</span><span className="text-[11px] font-mono text-primary">{Math.round(settings.toneStrength * 100)} %</span></div>
                <Slider value={[settings.toneStrength * 100]} min={0} max={100} step={5} onValueChange={(v) => set({ toneStrength: v[0] / 100 })} />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between"><span className={label}>Largest correction</span><span className="text-[11px] font-mono text-primary">±{settings.maxToneDb} dB</span></div>
                <Slider value={[settings.maxToneDb]} min={1} max={6} step={0.5} onValueChange={(v) => set({ maxToneDb: v[0] })} />
              </div>
              <label className="block space-y-1">
                <span className={label}>Tonal reference</span>
                <select value={settings.anchorId ?? ''} onChange={(e) => set({ anchorId: e.target.value || null })} className={`${field} w-full`}>
                  <option value="">Median of the album</option>
                  {ready.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </label>

              <label className="block space-y-1">
                <span className={label}>Mastering chain</span>
                <select value={presetId} onChange={(e) => setPresetId(e.target.value)} className={`${field} w-full`}>
                  {FACTORY_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.genre}</option>)}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className={label}>Format</span>
                  <select value={formatId} onChange={(e) => setFormatId(e.target.value)} className={`${field} w-full`}>
                    {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className={label}>Default gap</span>
                  <input type="number" min={0} max={10} step={0.5} value={gapSec} onChange={(e) => setGapSec(Math.max(0, Math.min(10, Number(e.target.value))))} className={`${field} w-full`} />
                </label>
              </div>
            </div>

            <div className="panel p-3 space-y-2">
              <Button className="w-full gap-2" disabled={busy || ready.length === 0 || analysing} onClick={run}>
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Mastering…</> : <><Wand2 className="w-4 h-4" /> Master the album</>}
              </Button>
              {accountsOn && (
                <p className="text-[10px] text-muted-foreground leading-snug">
                  {user
                    ? `1 kredyt = 1 utwór. Masz ${user.credits}. Utwory opłacone w ciągu ostatnich 3 dni są bezpłatne.`
                    : <>Aby wyeksportować album, <Link to="/app" className="underline">zaloguj się w aplikacji</Link> — pierwsze utwory są gratis.</>}
                </p>
              )}
              {busy && progress && (
                <div className="space-y-1">
                  <div className="text-[10px] font-mono text-muted-foreground">Track {progress.i + 1} / {ready.length} · {progress.label}</div>
                  <div className="h-1.5 bg-secondary rounded-full overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${((progress.i + progress.pct / 100) / ready.length) * 100}%` }} /></div>
                  <Button variant="secondary" size="sm" className="w-full" onClick={() => abortRef.current?.abort()}>Cancel</Button>
                </div>
              )}
              <p className="text-[9px] text-muted-foreground leading-relaxed">
                Each track is decoded, processed and encoded one at a time, so even long albums fit in browser memory. Nothing leaves your computer.
              </p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default Album;
