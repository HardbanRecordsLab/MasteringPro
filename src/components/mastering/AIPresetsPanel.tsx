import { useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, ChevronDown, AlertCircle, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAudio } from '@/contexts/AudioContext';
import { analyzeAudio, type AudioMetrics } from '@/lib/audioAnalysis';
import { invokeAI } from '@/lib/aiApi';
import { toast } from 'sonner';
import { loadAIPresets, saveAIPresets, loadLastAISettings, saveLastAISettings, type AIMasteringPreset } from '@/lib/aiMasteringPresets';
import AIABCompare from './AIABCompare';

const PRESETS = [
  { name: 'Transparent Master', genre: 'POP', description: 'Clean and balanced for modern pop' },
  { name: 'Warm Analog', genre: 'ROCK', description: 'Warm harmonic saturation feel' },
  { name: 'EDM Slam', genre: 'EDM', description: 'Maximum loudness for electronic' },
  { name: 'Hip-Hop Punch', genre: 'HIP-HOP', description: 'Deep bass, crisp highs' },
  { name: 'Jazz Delicate', genre: 'JAZZ', description: 'Preserve dynamics and air' },
  { name: 'Classical Purist', genre: 'CLASSICAL', description: 'Minimal processing, max dynamic range' },
  { name: 'Lo-Fi Vinyl', genre: 'LO-FI', description: 'Warm, compressed, nostalgic' },
  { name: 'Metal Crusher', genre: 'METAL', description: 'Aggressive limiting, scooped mids' },
  { name: 'Podcast Clarity', genre: 'PODCAST', description: 'Voice-optimized loudness' },
  { name: 'Streaming Ready', genre: 'STREAMING', description: '-14 LUFS for Spotify/YouTube' },
  { name: 'R&B Smooth', genre: 'R&B', description: 'Silky vocals, warm low end' },
  { name: 'Ambient Space', genre: 'AMBIENT', description: 'Wide stereo, gentle dynamics' },
];

const GENRE_TAGS = ['ALL', 'POP', 'EDM', 'HIP-HOP', 'ROCK', 'METAL', 'JAZZ', 'CLASSICAL', 'R&B', 'LO-FI', 'AMBIENT', 'STREAMING', 'PODCAST'];

export interface AIConfig {
  presetName: string;
  genre: string;
  confidence: number;
  analysisNotes: string;
  recommendations: string[];
  [key: string]: unknown;
}

const PLATFORMS = [
  { id: 'spotify',   label: 'Spotify',    lufs: -14 },
  { id: 'apple',     label: 'Apple',      lufs: -16 },
  { id: 'youtube',   label: 'YouTube',    lufs: -14 },
  { id: 'tidal',     label: 'Tidal',      lufs: -14 },
  { id: 'club',      label: 'Club/DJ',    lufs: -8  },
  { id: 'cd',        label: 'CD/Loud',    lufs: -9  },
  { id: 'broadcast', label: 'Broadcast',  lufs: -23 },
  { id: 'podcast',   label: 'Podcast',    lufs: -16 },
];

const STYLES = [
  { id: 'transparent', label: 'Transparent' },
  { id: 'warm',        label: 'Warm' },
  { id: 'punchy',      label: 'Punchy' },
  { id: 'loud',        label: 'Loud' },
  { id: 'vintage',     label: 'Vintage' },
  { id: 'vocal',       label: 'Vocal' },
];

const INTENSITIES = [
  { id: 'subtle',     label: 'Subtle' },
  { id: 'standard',   label: 'Standard' },
  { id: 'aggressive', label: 'Aggressive' },
];

const AIPresetsPanel = () => {
  const { state, processing, setProcessing } = useAudio();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState('ALL');
  const [showReport, setShowReport] = useState(false);
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [metrics, setMetrics] = useState<AudioMetrics | null>(null);
  const [platform, setPlatform] = useState('spotify');
  const [style, setStyle] = useState('transparent');
  const [intensity, setIntensity] = useState('standard');
  const [validation, setValidation] = useState<any>(null);
  const [showAB, setShowAB] = useState(false);
  const [aiPresets, setAiPresets] = useState<AIMasteringPreset[]>([]);
  const [newPresetName, setNewPresetName] = useState('');

  const hydratedRef = useRef(false);

  useEffect(() => {
    setAiPresets(loadAIPresets());
    const last = loadLastAISettings();
    if (last) {
      if (last.platform) setPlatform(last.platform);
      if (last.style) setStyle(last.style);
      if (last.intensity) setIntensity(last.intensity);
      if (last.aiConfig) { setAiConfig(last.aiConfig); setShowReport(true); setActivePreset('Last Session'); }
      if (last.validation) setValidation(last.validation);
      if (last.processing) setProcessing(last.processing);
    }
    // Mark hydrated next tick so the auto-save effect doesn't overwrite with defaults
    queueMicrotask(() => { hydratedRef.current = true; });
  }, [setProcessing]);

  // Auto-save last-used AI settings on any change (after hydration)
  useEffect(() => {
    if (!hydratedRef.current) return;
    saveLastAISettings({ platform, style, intensity, aiConfig, validation, processing });
  }, [platform, style, intensity, aiConfig, validation, processing]);

  const persistPresets = (next: AIMasteringPreset[]) => {
    setAiPresets(next);
    saveAIPresets(next);
  };

  const handleSaveAIPreset = () => {
    const name = newPresetName.trim() || `${platform} · ${style} · ${intensity}`;
    const preset: AIMasteringPreset = {
      id: crypto.randomUUID(),
      name,
      timestamp: Date.now(),
      platform, style, intensity,
      aiConfig, validation,
      processing,
    };
    persistPresets([preset, ...aiPresets].slice(0, 30));
    setNewPresetName('');
    toast.success(`Saved AI preset "${name}"`);
  };

  const handleLoadAIPreset = (preset: AIMasteringPreset) => {
    setPlatform(preset.platform);
    setStyle(preset.style);
    setIntensity(preset.intensity);
    setAiConfig(preset.aiConfig);
    setValidation(preset.validation);
    setProcessing(preset.processing);
    setShowReport(!!preset.aiConfig);
    setActivePreset(preset.name);
    toast.success(`Loaded "${preset.name}"`);
  };

  const handleDeleteAIPreset = (id: string) => {
    persistPresets(aiPresets.filter(p => p.id !== id));
  };

  const applyAIConfig = (config: any) => {
    setProcessing(prev => ({
      ...prev,
      inputGain: config.inputGain ?? prev.inputGain,
      eqBands: config.parametricEQ?.map((eq: any, i: number) => ({
        freq: eq.freq ?? prev.eqBands[i]?.freq ?? 1000,
        gain: eq.gain ?? 0,
        q: eq.q ?? 1,
        type: (eq.type === 'lowShelf' ? 'lowshelf' : eq.type === 'highShelf' ? 'highshelf' : 'peaking') as BiquadFilterType,
      })) ?? prev.eqBands,
      compThreshold: config.compressor?.threshold ?? prev.compThreshold,
      compRatio: config.compressor?.ratio ?? prev.compRatio,
      compAttack: config.compressor?.attack ?? prev.compAttack,
      compRelease: config.compressor?.release ?? prev.compRelease,
      compKnee: config.compressor?.knee ?? prev.compKnee,
      compMakeup: config.compressor?.makeupGain ?? prev.compMakeup,
      stereoWidth: config.stereoWidth ?? prev.stereoWidth,
      limiterCeiling: config.limiter?.ceiling ?? prev.limiterCeiling,
      limiterRelease: config.limiter?.release ?? prev.limiterRelease,
      saturation: typeof config.saturation === 'number' ? config.saturation : prev.saturation,
      saturationEnabled: typeof config.saturation === 'number' && config.saturation > 0 ? true : prev.saturationEnabled,
      eqEnabled: true,
      compEnabled: true,
      limiterEnabled: true,
      widthEnabled: true,
    }));
  };

  const handleAIAnalyze = async () => {
    if (!state.audioBuffer) return;
    setIsAnalyzing(true);
    setValidation(null);

    try {
      setAnalysisStep('Deep analysis...');
      const audioMetrics = analyzeAudio(state.audioBuffer);
      setMetrics(audioMetrics);

      setAnalysisStep('AI mastering chain...');
      const { data, error } = await invokeAI('ai-mastering', {
        metrics: audioMetrics, platform, style, intensity, validate: true,
      });

      if (error) throw new Error(error.message || 'AI analysis failed');
      if (data?.error) throw new Error(data.error);

      if (data?.config) {
        setAiConfig(data.config);
        setValidation(data.validation || null);
        setShowReport(true);
        setActivePreset('AI Generated');
        applyAIConfig(data.config);
        const violations = data.validation?.violations?.length || 0;
        if (violations > 0) {
          toast.warning(`AI master applied with ${violations} safety note(s)`);
        } else {
          toast.success(`AI master: "${data.config.presetName}" → ${data.platform?.label || platform}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`AI Analysis failed: ${message}`);
    } finally {
      setIsAnalyzing(false);
      setAnalysisStep('');
    }
  };

  const filteredPresets = activeTag === 'ALL' ? PRESETS : PRESETS.filter(p => p.genre === activeTag);

  return (
    <div className="panel p-3 space-y-4 overflow-y-auto max-h-[calc(100vh-120px)]">
      {/* AI Mastering */}
      <div className="space-y-2">
        <span className="text-section-header">AI Mastering</span>

        {/* Target platform */}
        <div className="space-y-1">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Target Platform</span>
          <div className="flex flex-wrap gap-1">
            {PLATFORMS.map(p => (
              <button
                key={p.id}
                onClick={() => setPlatform(p.id)}
                className={`text-[8px] px-1.5 py-0.5 rounded transition-colors ${
                  platform === p.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
                title={`${p.lufs} LUFS`}
              >
                {p.label} <span className="opacity-60">{p.lufs}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Mastering style */}
        <div className="space-y-1">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Style</span>
          <div className="flex flex-wrap gap-1">
            {STYLES.map(s => (
              <button
                key={s.id}
                onClick={() => setStyle(s.id)}
                className={`text-[8px] px-1.5 py-0.5 rounded transition-colors ${
                  style === s.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Intensity */}
        <div className="space-y-1">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Intensity</span>
          <div className="flex gap-1">
            {INTENSITIES.map(i => (
              <button
                key={i.id}
                onClick={() => setIntensity(i.id)}
                className={`flex-1 text-[8px] px-1.5 py-0.5 rounded transition-colors ${
                  intensity === i.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
              >
                {i.label}
              </button>
            ))}
          </div>
        </div>

        <Button
          className={`w-full gap-2 ${isAnalyzing ? 'animate-pulse-glow' : ''}`}
          onClick={handleAIAnalyze}
          disabled={!state.audioBuffer || isAnalyzing}
        >
          {isAnalyzing ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> {analysisStep}</>
          ) : (
            <><Sparkles className="w-4 h-4" /> AI Analyze & Master</>
          )}
        </Button>

        {metrics && !showReport && (
          <div className="p-2 bg-background rounded-sm border border-border text-[9px] font-mono text-muted-foreground space-y-0.5">
            <div>LUFS {metrics.lufs} | TP {metrics.truePeak} | DR {metrics.dynamicRange} | LRA {metrics.lra}</div>
            <div>Centroid {metrics.spectralCentroid}Hz | Tilt {metrics.spectralTilt}dB/oct | Punch {metrics.punchScore}</div>
            <div>Mud {metrics.mudIndex} | Harsh {metrics.harshnessIndex} | MonoBass {metrics.lowEndMonoCompat}</div>
            <div>Genre: {metrics.estimatedGenre} | Tonal {metrics.tonalBalanceScore}/100</div>
          </div>
        )}

        {showReport && aiConfig && (
          <div className="mt-2 space-y-2 p-2 bg-background rounded-sm border border-primary/20">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-primary">
                AI Report — {aiConfig.presetName}
              </span>
              <button onClick={() => setShowReport(false)}>
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              </button>
            </div>

            <p className="text-[10px] text-muted-foreground leading-relaxed">
              {aiConfig.analysisNotes}
            </p>

            {aiConfig.recommendations?.length > 0 && (
              <div className="space-y-1">
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Recommendations</span>
                {aiConfig.recommendations.map((rec, i) => (
                  <div key={i} className="flex gap-1.5 text-[9px] text-muted-foreground">
                    <span className="text-primary">•</span>
                    <span>{rec}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-1">
              <span className="text-[8px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                Genre: {aiConfig.genre} ({aiConfig.confidence}%)
              </span>
              {metrics && (
                <>
                  <span className="text-[8px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    {metrics.lufs} LUFS
                  </span>
                  {metrics.issues[0] !== 'none' ? (
                    metrics.issues.map((issue, i) => (
                      <span key={i} className="text-[8px] bg-warning/10 text-warning px-1.5 py-0.5 rounded flex items-center gap-0.5">
                        <AlertCircle className="w-2.5 h-2.5" />{issue}
                      </span>
                    ))
                  ) : (
                    <span className="text-[8px] bg-meter-green/10 text-meter-green px-1.5 py-0.5 rounded">No Issues</span>
                  )}
                </>
              )}
            </div>

            {validation && (
              <div className="space-y-1 pt-1 border-t border-border/50">
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  QA Validation {typeof validation.qualityScore === 'number' && `— ${validation.qualityScore}/100`}
                </span>
                <div className="flex flex-wrap gap-1 text-[8px]">
                  {typeof validation.predictedLUFS === 'number' && (
                    <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                      → {validation.predictedLUFS} LUFS
                    </span>
                  )}
                  {typeof validation.predictedTruePeak === 'number' && (
                    <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                      TP {validation.predictedTruePeak}dB
                    </span>
                  )}
                  {typeof validation.predictedDR === 'number' && (
                    <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                      DR {validation.predictedDR}
                    </span>
                  )}
                </div>
                {validation.violations?.length > 0 && (
                  <div className="space-y-0.5">
                    {validation.violations.map((v: string, i: number) => (
                      <div key={i} className="flex gap-1 text-[8px] text-warning">
                        <AlertCircle className="w-2.5 h-2.5 shrink-0" />
                        <span>{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="mt-1 p-1.5 bg-card rounded-sm text-[8px] text-primary">
              ✓ AI settings applied to processing chain
            </div>
          </div>
        )}

        {/* A/B Compare toggle */}
        <Button
          variant="secondary"
          className="w-full h-7 text-[10px] gap-1"
          onClick={() => setShowAB(v => !v)}
          disabled={!state.audioBuffer}
        >
          {showAB ? 'Hide A/B Preview' : 'A/B Preview (Before vs After)'}
        </Button>
        {showAB && <AIABCompare />}

        {/* Save current AI settings as preset */}
        <div className="space-y-1 pt-1 border-t border-border/50">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            My AI Presets
          </span>
          <div className="flex gap-1">
            <Input
              value={newPresetName}
              onChange={e => setNewPresetName(e.target.value)}
              placeholder={`${platform} · ${style} · ${intensity}`}
              className="h-7 text-[10px] flex-1"
            />
            <Button
              size="sm"
              variant="secondary"
              className="h-7 px-2"
              onClick={handleSaveAIPreset}
              title="Save platform, style, intensity, safety & chain as preset"
            >
              <Save className="w-3 h-3" />
            </Button>
          </div>
          {aiPresets.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {aiPresets.map(p => (
                <div
                  key={p.id}
                  className="flex items-center gap-1 p-1.5 bg-background rounded-sm border border-border hover:border-primary/30"
                >
                  <button
                    onClick={() => handleLoadAIPreset(p)}
                    className="flex-1 text-left"
                  >
                    <div className="text-[10px] font-medium text-foreground truncate">{p.name}</div>
                    <div className="text-[8px] text-muted-foreground">
                      {p.platform} · {p.style} · {p.intensity}
                      {p.validation?.predictedLUFS != null && ` · ${p.validation.predictedLUFS} LUFS`}
                    </div>
                  </button>
                  <button
                    onClick={() => handleDeleteAIPreset(p.id)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>


      {/* Presets */}
      <div className="space-y-2">
        <span className="text-section-header">Presets</span>
        <div className="flex flex-wrap gap-1">
          {GENRE_TAGS.map(tag => (
            <button
              key={tag}
              onClick={() => setActiveTag(tag)}
              className={`text-[8px] px-1.5 py-0.5 rounded transition-colors ${
                activeTag === tag
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          {filteredPresets.map(preset => (
            <button
              key={preset.name}
              onClick={() => setActivePreset(preset.name)}
              className={`w-full text-left p-2 rounded-sm transition-colors ${
                activePreset === preset.name
                  ? 'bg-primary/10 border border-primary/30'
                  : 'bg-background hover:bg-secondary'
              }`}
            >
              <div className="text-xs font-medium text-foreground">{preset.name}</div>
              <div className="text-[9px] text-muted-foreground">{preset.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AIPresetsPanel;
