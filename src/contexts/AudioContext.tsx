import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { MasteringEngine, loadMasteringWorklets } from '@/lib/audioEngine';
import { analyzeAudio, type AudioMetrics } from '@/lib/audioAnalysis';
import { analyzeMusicalContent, type MusicalContent } from '@/lib/musicAnalysis';

export interface AudioFileInfo {
  name: string;
  duration: number;
  sampleRate: number;
  bitDepth: number;
  peakLevel: number;
  channels: number;
}

export interface EQBandParams {
  freq: number;
  gain: number;
  q: number;
  type: BiquadFilterType;
}

export interface ProcessingParams {
  inputGain: number;
  lowCutEnabled: boolean;
  lowCutFreq: number;
  tiltEnabled: boolean;
  tiltAmount: number;
  bassMonoEnabled: boolean;
  bassMonoFreq: number;
  eqEnabled: boolean;
  eqBands: EQBandParams[];
  compEnabled: boolean;
  compThreshold: number;
  compRatio: number;
  compAttack: number;
  compRelease: number;
  compKnee: number;
  compMakeup: number;
  compMix: number;
  compDetect: 'peak' | 'rms';
  compMode: 'stereo' | 'ms' | 'dual';
  compAutoRelease: boolean;
  compAutoMakeup: boolean;
  // Multiband compressor (AudioWorklet) — [low, mid, high]
  mbEnabled: boolean;
  mbXover1: number;
  mbXover2: number;
  mbBands: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }[];
  // De-esser + dynamic EQ band (AudioWorklet)
  deEssEnabled: boolean;
  deEssFreq: number;
  deEssThreshold: number;
  deEssRange: number;
  dynEqEnabled: boolean;
  dynEqFreq: number;
  dynEqQ: number;
  dynEqThreshold: number;
  dynEqRange: number;
  dynEqMode: 'cut' | 'boost';
  resoEnabled: boolean;
  resoAmount: number;
  resoStrength: number;
  resoDepth: number;
  resoThreshold: number;
  resoLowHz: number;
  resoHighHz: number;
  saturation: number;
  saturationEnabled: boolean;
  widthEnabled: boolean;
  stereoWidth: number;
  limiterEnabled: boolean;
  limiterCeiling: number;
  limiterRelease: number;
  // Noise gate (AudioWorklet)
  gateEnabled: boolean;
  gateThreshold: number;
  gateRange: number;
  gateAttack: number;
  gateHold: number;
  gateRelease: number;
  // Mid/Side EQ (AudioWorklet)
  msEnabled: boolean;
  msMidLow: number; msMidMid: number; msMidHigh: number;
  msSideLow: number; msSideMid: number; msSideHigh: number;
  msMidLowFreq: number; msMidMidFreq: number; msMidHighFreq: number;
  msSideLowFreq: number; msSideMidFreq: number; msSideHighFreq: number;
}

const DEFAULT_PROCESSING: ProcessingParams = {
  inputGain: 0,
  lowCutEnabled: false,
  lowCutFreq: 30,
  tiltEnabled: false,
  tiltAmount: 0,
  bassMonoEnabled: false,
  bassMonoFreq: 120,
  eqEnabled: true,
  eqBands: [
    { freq: 80, gain: 0, q: 0.7, type: 'lowshelf' },
    { freq: 250, gain: 0, q: 1.0, type: 'peaking' },
    { freq: 1000, gain: 0, q: 1.0, type: 'peaking' },
    { freq: 4000, gain: 0, q: 1.0, type: 'peaking' },
    { freq: 12000, gain: 0, q: 0.7, type: 'highshelf' },
  ],
  compEnabled: true,
  compThreshold: -12,
  compRatio: 3,
  compAttack: 10,
  compRelease: 100,
  compKnee: 6,
  compMakeup: 0,
  compMix: 100,
  compDetect: 'peak',
  compMode: 'stereo',
  compAutoRelease: false,
  compAutoMakeup: false,
  mbEnabled: false,
  mbXover1: 120,
  mbXover2: 2500,
  mbBands: [
    { threshold: -24, ratio: 2, attack: 20, release: 200, knee: 6, makeup: 0 },
    { threshold: -20, ratio: 2, attack: 15, release: 150, knee: 6, makeup: 0 },
    { threshold: -18, ratio: 2, attack: 10, release: 120, knee: 6, makeup: 0 },
  ],
  deEssEnabled: false,
  deEssFreq: 6500,
  deEssThreshold: -28,
  deEssRange: 6,
  dynEqEnabled: false,
  dynEqFreq: 300,
  dynEqQ: 2,
  dynEqThreshold: -24,
  dynEqRange: 6,
  dynEqMode: 'cut',
  resoEnabled: false,
  resoAmount: 50,
  resoStrength: 0.7,
  resoDepth: 12,
  resoThreshold: 6,
  resoLowHz: 120,
  resoHighHz: 16000,
  saturation: 0,
  saturationEnabled: false,
  widthEnabled: true,
  stereoWidth: 100,
  limiterEnabled: true,
  limiterCeiling: -1.0,
  limiterRelease: 100,
  gateEnabled: false,
  gateThreshold: -40,
  gateRange: -40,
  gateAttack: 5,
  gateHold: 10,
  gateRelease: 100,
  msEnabled: false,
  msMidLow: 0, msMidMid: 0, msMidHigh: 0,
  msSideLow: 0, msSideMid: 0, msSideHigh: 0,
  msMidLowFreq: 120, msMidMidFreq: 1000, msMidHighFreq: 8000,
  msSideLowFreq: 120, msSideMidFreq: 1000, msSideHighFreq: 8000,
};

export interface AudioState {
  file: File | null;
  fileInfo: AudioFileInfo | null;
  audioBuffer: AudioBuffer | null;
  isPlaying: boolean;
  isLooping: boolean;
  currentTime: number;
  duration: number;
  referenceBuffer: AudioBuffer | null;
  referenceMetrics: AudioMetrics | null;
  referenceName: string | null;
  /** key + tempo, detected async after load */
  musical: MusicalContent | null;
}

export type SnapshotSlot = 'A' | 'B' | 'C' | 'D';

interface AudioContextType {
  state: AudioState;
  processing: ProcessingParams;
  engine: MasteringEngine | null;
  loadFile: (file: File) => Promise<void>;
  loadReference: (file: File) => Promise<void>;
  play: () => void;
  stop: () => void;
  toggleLoop: () => void;
  seek: (time: number) => void;
  setProcessing: React.Dispatch<React.SetStateAction<ProcessingParams>>;
  applyProcessingToEngine: (params: ProcessingParams) => void;
  // history + snapshots
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  snapshots: Record<SnapshotSlot, ProcessingParams | null>;
  saveSnapshot: (slot: SnapshotSlot) => void;
  recallSnapshot: (slot: SnapshotSlot) => void;
  resetProcessing: () => void;
}

const AudioCtx = createContext<AudioContextType | null>(null);

export const useAudio = () => {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error('useAudio must be within AudioProvider');
  return ctx;
};

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AudioState>({
    file: null, fileInfo: null, audioBuffer: null,
    isPlaying: false, isLooping: false, currentTime: 0, duration: 0,
    referenceBuffer: null, referenceMetrics: null, referenceName: null, musical: null,
  });

  const [processing, setProcessing] = useState<ProcessingParams>(DEFAULT_PROCESSING);

  // --- undo/redo history (debounced) + A/B/C/D snapshots ---
  const historyRef = useRef<ProcessingParams[]>([DEFAULT_PROCESSING]);
  const histPtrRef = useRef(0);
  const skipHistoryRef = useRef(false);
  const histTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [histVersion, setHistVersion] = useState(0);
  const [snapshots, setSnapshots] = useState<Record<SnapshotSlot, ProcessingParams | null>>({
    A: null, B: null, C: null, D: null,
  });

  useEffect(() => {
    if (skipHistoryRef.current) { skipHistoryRef.current = false; return; }
    if (histTimerRef.current) clearTimeout(histTimerRef.current);
    histTimerRef.current = setTimeout(() => {
      const h = historyRef.current.slice(0, histPtrRef.current + 1);
      h.push(processing);
      if (h.length > 60) h.shift();
      historyRef.current = h;
      histPtrRef.current = h.length - 1;
      setHistVersion((v) => v + 1);
    }, 500);
    return () => { if (histTimerRef.current) clearTimeout(histTimerRef.current); };
  }, [processing]);

  const applyFromHistory = useCallback(() => {
    skipHistoryRef.current = true;
    setProcessing(historyRef.current[histPtrRef.current]);
    setHistVersion((v) => v + 1);
  }, []);
  const undo = useCallback(() => {
    if (histPtrRef.current > 0) { histPtrRef.current -= 1; applyFromHistory(); }
  }, [applyFromHistory]);
  const redo = useCallback(() => {
    if (histPtrRef.current < historyRef.current.length - 1) { histPtrRef.current += 1; applyFromHistory(); }
  }, [applyFromHistory]);
  void histVersion;
  const canUndo = histPtrRef.current > 0;
  const canRedo = histPtrRef.current < historyRef.current.length - 1;

  const saveSnapshot = useCallback((slot: SnapshotSlot) => {
    setSnapshots((s) => ({ ...s, [slot]: processing }));
  }, [processing]);
  const recallSnapshot = useCallback((slot: SnapshotSlot) => {
    setSnapshots((s) => {
      if (s[slot]) setProcessing(s[slot]!);
      return s;
    });
  }, []);
  const resetProcessing = useCallback(() => setProcessing(DEFAULT_PROCESSING), []);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<MasteringEngine | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef(0);

  const getCtxAndEngine = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
      engineRef.current = new MasteringEngine(audioCtxRef.current);
      // Load AudioWorklets asynchronously, then attach (idempotent)
      loadMasteringWorklets(audioCtxRef.current)
        .then(() => {
          engineRef.current?.attachWorklets();
          // Re-apply current processing so worklet bypass/params sync
          applyProcessingToEngineRef.current?.(processingRef.current);
        })
        .catch((e) => console.warn('[audio] worklet load failed', e));
    }
    return { ctx: audioCtxRef.current, engine: engineRef.current! };
  }, []);

  // Sync processing params to engine
  const applyProcessingToEngine = useCallback((p: ProcessingParams) => {
    const engine = engineRef.current;
    if (!engine) return;

    engine.setInputGain(p.inputGain);
    engine.setLowCut(p.lowCutEnabled, p.lowCutFreq);
    engine.setTilt(p.tiltEnabled, p.tiltAmount);
    engine.setBassMono(p.bassMonoEnabled, p.bassMonoFreq);

    // Noise gate (worklet)
    engine.setNoiseGate({
      threshold: p.gateThreshold,
      range: p.gateRange,
      attack: p.gateAttack,
      hold: p.gateHold,
      release: p.gateRelease,
    });
    engine.bypassNoiseGate(!p.gateEnabled);

    if (p.eqEnabled) {
      p.eqBands.forEach((band, i) => engine.setEQBand(i, band));
    } else {
      engine.bypassEQ(true);
    }

    // Mid/Side EQ (worklet)
    engine.setMidSideEQ({
      midLowGain: p.msMidLow, midMidGain: p.msMidMid, midHighGain: p.msMidHigh,
      sideLowGain: p.msSideLow, sideMidGain: p.msSideMid, sideHighGain: p.msSideHigh,
      midLowFreq: p.msMidLowFreq, midMidFreq: p.msMidMidFreq, midHighFreq: p.msMidHighFreq,
      sideLowFreq: p.msSideLowFreq, sideMidFreq: p.msSideMidFreq, sideHighFreq: p.msSideHighFreq,
    });
    engine.bypassMidSideEQ(!p.msEnabled);

    engine.setCompressorFull({
      threshold: p.compThreshold,
      ratio: p.compRatio,
      attack: p.compAttack,
      release: p.compRelease,
      knee: p.compKnee,
      makeup: p.compMakeup,
      mix: p.compMix,
      detect: p.compDetect,
      mode: p.compMode,
      autoRelease: p.compAutoRelease,
      autoMakeup: p.compAutoMakeup,
    });
    engine.setMakeupGain(p.compEnabled ? p.compMakeup : 0);
    engine.bypassCompressor(!p.compEnabled);

    // Multiband compressor (worklet)
    engine.setMultiband({ xover1: p.mbXover1, xover2: p.mbXover2, bands: p.mbBands });
    engine.bypassMultiband(!p.mbEnabled);

    // De-esser / dynamic EQ (worklet)
    engine.setDynamicsEq({
      deEss: {
        enabled: p.deEssEnabled, freq: p.deEssFreq, threshold: p.deEssThreshold,
        range: p.deEssRange, attack: 1, release: 60,
      },
      dyn: {
        enabled: p.dynEqEnabled, freq: p.dynEqFreq, q: p.dynEqQ, threshold: p.dynEqThreshold,
        range: p.dynEqRange, attack: 10, release: 120, mode: p.dynEqMode,
      },
    });
    engine.bypassDynamicsEq(!p.deEssEnabled && !p.dynEqEnabled);

    engine.setResonance({
      enabled: p.resoEnabled,
      amount: p.resoAmount,
      strength: p.resoStrength,
      depth: p.resoDepth,
      threshold: p.resoThreshold,
      attack: 12,
      release: 120,
      lowHz: p.resoLowHz,
      highHz: p.resoHighHz,
    });

    engine.setSaturation(p.saturationEnabled ? p.saturation : 0);

    if (p.widthEnabled) {
      engine.setStereoWidth(p.stereoWidth);
    } else {
      engine.setStereoWidth(100);
    }

    if (p.limiterEnabled) {
      engine.setLimiter({ ceiling: p.limiterCeiling, release: p.limiterRelease });
      engine.bypassLimiter(false);
    } else {
      engine.bypassLimiter(true);
    }
  }, []);

  // Refs so getCtxAndEngine can re-apply current state once worklets load
  const processingRef = useRef(processing);
  const applyProcessingToEngineRef = useRef(applyProcessingToEngine);
  useEffect(() => { processingRef.current = processing; }, [processing]);
  useEffect(() => { applyProcessingToEngineRef.current = applyProcessingToEngine; }, [applyProcessingToEngine]);

  // Apply processing changes to engine immediately
  useEffect(() => {
    applyProcessingToEngine(processing);
  }, [processing, applyProcessingToEngine]);

  const loadFile = useCallback(async (file: File) => {
    const { ctx } = getCtxAndEngine();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    let peak = 0;
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }

    setState(prev => ({
      ...prev,
      file, audioBuffer, musical: null,
      isPlaying: false, isLooping: false, currentTime: 0,
      duration: audioBuffer.duration,
      fileInfo: {
        name: file.name,
        duration: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate,
        bitDepth: 16,
        peakLevel: 20 * Math.log10(peak || 0.0001),
        channels: audioBuffer.numberOfChannels,
      },
    }));

    // key + tempo detection (async, non-blocking)
    analyzeMusicalContent(audioBuffer)
      .then((musical) => setState(prev => (prev.audioBuffer === audioBuffer ? { ...prev, musical } : prev)))
      .catch(() => {});
  }, [getCtxAndEngine]);

  const loadReference = useCallback(async (file: File) => {
    const { ctx } = getCtxAndEngine();
    const arrayBuffer = await file.arrayBuffer();
    const referenceBuffer = await ctx.decodeAudioData(arrayBuffer);
    const referenceMetrics = analyzeAudio(referenceBuffer);

    setState(prev => ({
      ...prev,
      referenceBuffer,
      referenceMetrics,
      referenceName: file.name,
    }));
  }, [getCtxAndEngine]);

  const play = useCallback(() => {
    const { ctx, engine } = getCtxAndEngine();
    if (!state.audioBuffer) return;

    // Stop existing source
    engine.disconnectSource();
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* ignore */ }
      sourceRef.current = null;
    }
    cancelAnimationFrame(rafRef.current);

    const source = ctx.createBufferSource();
    source.buffer = state.audioBuffer;
    source.loop = state.isLooping;
    sourceRef.current = source;

    engine.connectSource(source);
    engine.resetLoudness();
    startTimeRef.current = ctx.currentTime;
    source.start(0, offsetRef.current);

    source.onended = () => {
      if (!state.isLooping) {
        setState(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));
        offsetRef.current = 0;
        cancelAnimationFrame(rafRef.current);
      }
    };

    setState(prev => ({ ...prev, isPlaying: true }));

    const tick = () => {
      if (audioCtxRef.current) {
        const elapsed = audioCtxRef.current.currentTime - startTimeRef.current + offsetRef.current;
        setState(prev => {
          if (!prev.isPlaying) return prev;
          return { ...prev, currentTime: Math.min(elapsed, prev.duration) };
        });
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [state.audioBuffer, state.isLooping, getCtxAndEngine]);

  const stop = useCallback(() => {
    const engine = engineRef.current;
    if (engine) engine.disconnectSource();
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* ignore */ }
      sourceRef.current = null;
    }
    cancelAnimationFrame(rafRef.current);
    offsetRef.current = 0;
    setState(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));
  }, []);

  const toggleLoop = useCallback(() => {
    setState(prev => ({ ...prev, isLooping: !prev.isLooping }));
  }, []);

  const seek = useCallback((time: number) => {
    offsetRef.current = time;
    setState(prev => ({ ...prev, currentTime: time }));
    if (state.isPlaying) play();
  }, [state.isPlaying, play]);

  return (
    <AudioCtx.Provider value={{
      state, processing, engine: engineRef.current,
      loadFile, loadReference, play, stop, toggleLoop, seek,
      setProcessing, applyProcessingToEngine,
      undo, redo, canUndo, canRedo,
      snapshots, saveSnapshot, recallSnapshot, resetProcessing,
    }}>
      {children}
    </AudioCtx.Provider>
  );
};
