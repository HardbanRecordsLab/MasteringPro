import { useState } from 'react';
import { Download, FileArchive, Loader2, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useAudio } from '@/contexts/AudioContext';
import { exportAudio, exportAllTargets, downloadBlob, type MasterReport } from '@/lib/audioExport';
import { toast } from 'sonner';
import { trackKeyOf, useExportGate } from '@/lib/exportGate';
import { normaliseIsrc, type ReleaseMeta } from '@/lib/tags';
import { useAuth } from '@/contexts/AuthContext';
import { passportApi } from '@/lib/accountApi';
import type { PassportSigner } from '@/lib/passport';

const META_FIELDS: Array<{ key: keyof ReleaseMeta; label: string; placeholder: string }> = [
  { key: 'title', label: 'Title', placeholder: 'Track title' },
  { key: 'artist', label: 'Artist', placeholder: 'Artist' },
  { key: 'album', label: 'Album', placeholder: 'Album / EP' },
  { key: 'year', label: 'Year', placeholder: '2026' },
  { key: 'genre', label: 'Genre', placeholder: 'Genre' },
  { key: 'isrc', label: 'ISRC', placeholder: 'CC-XXX-YY-NNNNN' },
];
const ARTIST_KEY = 'mp-export-artist';
const readArtist = () => { try { return localStorage.getItem(ARTIST_KEY) ?? ''; } catch { return ''; } };

const FORMATS = [
  { id: 'wav24', label: 'WAV 24-bit', desc: 'Lossless master / distribution' },
  { id: 'wav16', label: 'WAV 16-bit', desc: 'CD standard' },
  { id: 'wav32', label: 'WAV 32-bit float', desc: 'Archival' },
  { id: 'aiff24', label: 'AIFF 24-bit', desc: 'Apple / Pro Tools' },
  { id: 'aiff16', label: 'AIFF 16-bit', desc: 'Apple / CD' },
  { id: 'flac', label: 'FLAC 24-bit', desc: 'Lossless, compressed' },
  { id: 'mp3-320', label: 'MP3 320 kbps', desc: 'Universal reference' },
  { id: 'mp3-256', label: 'MP3 256 kbps', desc: 'Smaller reference' },
];

const SAMPLE_RATES = [
  { v: 0, label: 'Source' },
  { v: 44100, label: '44.1 kHz' },
  { v: 48000, label: '48 kHz' },
  { v: 88200, label: '88.2 kHz' },
  { v: 96000, label: '96 kHz' },
];

const PLATFORMS = [
  { name: 'Spotify', lufs: -14, peak: -1.0 },
  { name: 'Apple Music', lufs: -16, peak: -1.0 },
  { name: 'YouTube', lufs: -14, peak: -1.0 },
  { name: 'Tidal HiFi', lufs: -14, peak: -1.0 },
  { name: 'Beatport (DJ)', lufs: -6, peak: -0.1 },
  { name: 'Podcast/Radio', lufs: -16, peak: -1.0 },
  { name: 'CD Master', lufs: -9, peak: -0.3 },
];

const ExportPanel = () => {
  const { state, processing } = useAudio();
  const settleExport = useExportGate();
  const { user } = useAuth();
  const [passport, setPassport] = useState<{ data: object; name: string } | null>(null);
  // signed master passports need an account; without one exports simply carry none
  const signer: PassportSigner | undefined = user ? (input) => passportApi.sign(input).catch(() => null) : undefined;
  const exportTrack = () => state.file
    ? [{ key: trackKeyOf(state.file), label: state.fileInfo?.name }]
    : [{ key: `${state.fileInfo?.name}|${state.fileInfo?.duration}`, label: state.fileInfo?.name }];
  const [selectedFormats, setSelectedFormats] = useState<string[]>(['wav24']);
  const [selectedPlatform, setSelectedPlatform] = useState('Spotify');
  const [sampleRate, setSampleRate] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<MasterReport | null>(null);
  const [meta, setMeta] = useState<ReleaseMeta>(() => ({ artist: readArtist() }));
  const isrcBad = !!meta.isrc && !normaliseIsrc(meta.isrc);
  // title defaults to the file name until the user types one
  const metaOut = (): ReleaseMeta => ({ ...meta, title: meta.title || state.fileInfo?.name.replace(/\.[^.]+$/, '') });
  const setField = (k: keyof ReleaseMeta, v: string) => {
    setMeta((m) => ({ ...m, [k]: v }));
    if (k === 'artist') { try { localStorage.setItem(ARTIST_KEY, v); } catch { /* private mode */ } }
  };

  const toggleFormat = (id: string) => {
    setSelectedFormats(prev =>
      prev.includes(id) ? prev.filter(f => f !== id) : [...prev, id]
    );
  };

  const platform = PLATFORMS.find(p => p.name === selectedPlatform);

  const handleExportAllTargets = async () => {
    if (!state.audioBuffer || !state.fileInfo) return;
    if (!(await settleExport(exportTrack()))) return;
    setIsExporting(true);
    try {
      const result = await exportAllTargets(state.audioBuffer, {
        targets: PLATFORMS.map(p => ({ name: p.name, lufs: p.lufs, peak: p.peak })),
        formatId: selectedFormats[0] || 'wav24',
        filename: state.fileInfo.name,
        processing,
        dither: 'shaped',
        sampleRate: sampleRate || undefined,
        meta: metaOut(),
        sign: signer,
        onProgress: (label, pct) => setProgress(`${label}: ${pct}%`),
      });
      downloadBlob(result.blob, result.filename);
      setReport(result.reports.find(r => r.name === 'Spotify')?.report ?? result.reports[0]?.report ?? null);
      const missed = result.reports.filter(r => !r.report.onTarget).map(r => r.name);
      toast.success(
        `${result.reports.length} platform masters exported` +
          (missed.length ? ` · ${missed.join(', ')} loudness-limited` : ''),
      );
    } catch (err) {
      console.error('All-targets export error:', err);
      toast.error('All-targets export failed');
    } finally {
      setIsExporting(false);
      setProgress('');
    }
  };

  const handleExport = async (asZip: boolean) => {
    if (!state.audioBuffer || !state.fileInfo) return;
    if (!(await settleExport(exportTrack()))) return;

    setIsExporting(true);
    try {
      const formats = asZip ? selectedFormats : [selectedFormats[0] || 'wav24'];
      const result = await exportAudio(state.audioBuffer, {
        formats,
        filename: state.fileInfo.name,
        targetPeakDb: platform?.peak ?? -1.0,
        targetLufs: platform?.lufs,
        processing,
        dither: 'shaped',
        sampleRate: sampleRate || undefined,
        meta: metaOut(),
        sign: signer,
        onProgress: (format, pct) => {
          setProgress(`${format}: ${pct}%`);
        },
      });

      downloadBlob(result.blob, result.filename);
      setReport(result.report);
      setPassport(result.passport ? { data: result.passport, name: `${result.filename}.passport.json` } : null);
      const r = result.report;
      toast.success(
        `Exported: ${result.filename} — ${r.integratedLufs.toFixed(1)} LUFS / ${r.truePeakDb.toFixed(1)} dBTP` +
          (r.onTarget ? '' : ' · target not reached'),
      );
    } catch (err) {
      console.error('Export error:', err);
      toast.error('Export failed');
    } finally {
      setIsExporting(false);
      setProgress('');
    }
  };

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-section-header">Export</span>
        {progress && (
          <span className="text-[9px] font-mono text-primary">{progress}</span>
        )}
      </div>

      <div className="flex gap-6 flex-wrap">
        {/* Formats */}
        <div className="space-y-2 min-w-[200px]">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Format</span>
          {FORMATS.map(fmt => (
            <label key={fmt.id} className="flex items-center gap-2 cursor-pointer group">
              <Checkbox
                checked={selectedFormats.includes(fmt.id)}
                onCheckedChange={() => toggleFormat(fmt.id)}
              />
              <div>
                <span className="text-xs text-foreground group-hover:text-primary transition-colors">{fmt.label}</span>
                <span className="text-[9px] text-muted-foreground ml-2">{fmt.desc}</span>
              </div>
            </label>
          ))}

          <div className="pt-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Sample rate</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {SAMPLE_RATES.map(sr => (
                <button
                  key={sr.v}
                  onClick={() => setSampleRate(sr.v)}
                  className={`px-2 py-0.5 rounded-sm text-[10px] font-mono transition-colors ${
                    sampleRate === sr.v ? 'bg-primary/15 text-primary border border-primary/30' : 'text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  {sr.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Platform targeting */}
        <div className="space-y-2 min-w-[180px]">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Platform Target</span>
          <div className="space-y-1">
            {PLATFORMS.map(p => (
              <button
                key={p.name}
                onClick={() => setSelectedPlatform(p.name)}
                className={`w-full text-left px-2 py-1 rounded-sm text-xs transition-colors ${
                  selectedPlatform === p.name
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'text-foreground hover:bg-secondary'
                }`}
              >
                <div className="flex justify-between">
                  <span>{p.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{p.lufs} LUFS</span>
                </div>
              </button>
            ))}
          </div>
          {platform && (
            <div className="mt-2 p-2 bg-background rounded-sm text-[9px] font-mono text-muted-foreground">
              Target: {platform.lufs} LUFS / {platform.peak} dBFS TP
            </div>
          )}
        </div>

        {/* Metadata */}
        <div className="space-y-2 flex-1 min-w-[200px]">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Release info (written into the files)</span>
          <div className="grid grid-cols-2 gap-2">
            {META_FIELDS.map(f => (
              <div key={f.key}>
                <label className="text-[9px] uppercase text-muted-foreground">{f.label}</label>
                <input
                  value={meta[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className={`w-full mt-0.5 px-2 py-1 bg-background border rounded-sm text-xs text-foreground focus:outline-none ${
                    f.key === 'isrc' && isrcBad ? 'border-destructive' : 'border-border focus:border-primary/50'
                  }`}
                  placeholder={f.key === 'title' ? state.fileInfo?.name.replace(/\.[^.]+$/, '') || f.placeholder : f.placeholder}
                />
              </div>
            ))}
          </div>
          {isrcBad && <p className="text-[9px] text-destructive">ISRC needs 12 characters: country (2 letters) · registrant (3) · year (2 digits) · 5 digits — it will be left out.</p>}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-4 pt-3 border-t border-border">
        <Button
          disabled={!state.audioBuffer || isExporting || selectedFormats.length === 0}
          className="gap-2"
          onClick={() => handleExport(false)}
        >
          {isExporting ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Exporting...</>
          ) : (
            <><Download className="w-4 h-4" /> Export Master</>
          )}
        </Button>
        <Button
          variant="secondary"
          disabled={!state.audioBuffer || isExporting || selectedFormats.length < 2}
          className="gap-2"
          onClick={() => handleExport(true)}
        >
          <FileArchive className="w-4 h-4" /> Export All as ZIP
        </Button>
        <Button
          variant="secondary"
          disabled={!state.audioBuffer || isExporting}
          className="gap-2"
          onClick={handleExportAllTargets}
          title="Render one master per platform, each loudness-matched, bundled in a ZIP"
        >
          <Layers className="w-4 h-4" /> All Platform Masters
        </Button>
      </div>

      {report && !isExporting && (
        <div className="mt-3 pt-3 border-t border-border text-[10px] font-mono flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-muted-foreground">Last render:</span>
          <span className={report.onTarget ? 'text-meter-green' : 'text-warning'}>
            {report.integratedLufs.toFixed(1)} LUFS
          </span>
          <span className="text-foreground">{report.truePeakDb.toFixed(1)} dBTP</span>
          {report.targetLufs !== null && (
            <span className="text-muted-foreground">
              target {report.targetLufs.toFixed(1)} · {report.iterations} pass{report.iterations > 1 ? 'es' : ''} · drive {report.driveDb >= 0 ? '+' : ''}{report.driveDb.toFixed(1)} dB
            </span>
          )}
          {report.note && <span className="w-full text-warning normal-case">{report.note}</span>}
          {passport && (
            <button
              onClick={() => downloadBlob(new Blob([JSON.stringify(passport.data, null, 2)], { type: 'application/json' }), passport.name)}
              className="underline text-primary"
              title="Signed statement of the measured loudness and true peak of this exact file — check it at /verify"
            >
              Download master passport
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ExportPanel;
