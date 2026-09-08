/**
 * MasteringEngine — Real-time audio processing chain using Web Audio API
 *
 * Signal flow:
 * Source ──┬──→ preAnalyser (dry tap for spectral diff)
 *          └──→ inputGain → noiseGate (worklet) → EQ[0..4] → midSideEQ (worklet)
 *               → multiband comp (worklet) → compressor → makeupGain → waveShaper
 *               → [stereo width matrix] → true-peak limiter (worklet)
 *               → postAnalyser → destination  ·  → endSplitter → analyserL/R
 *
 * AudioWorklets:
 *   - noise-gate-processor        (envelope-follower gate, posts GR)
 *   - mid-side-eq-processor       (true M/S 3-band peaking EQ, coeff-slewed)
 *   - multiband-comp-processor    (LR4 3-band compressor, posts per-band GR)
 *   - lookahead-limiter-processor (4x oversampled true-peak limiter, posts GR/TP/latency)
 */

export interface MidSideEQParams {
  midLowGain: number; midMidGain: number; midHighGain: number;
  sideLowGain: number; sideMidGain: number; sideHighGain: number;
  midLowFreq?: number; midMidFreq?: number; midHighFreq?: number;
  sideLowFreq?: number; sideMidFreq?: number; sideHighFreq?: number;
  q?: number;
}

export interface NoiseGateParams {
  threshold: number; range: number; attack: number; hold: number; release: number;
}

export interface MultibandBand {
  threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number;
}
export interface MultibandParams {
  xover1: number; xover2: number; bands: MultibandBand[];
}

export interface DynamicsEqParams {
  deEss: { enabled: boolean; freq: number; threshold: number; range: number; attack: number; release: number };
  dyn: { enabled: boolean; freq: number; q: number; threshold: number; range: number; attack: number; release: number; mode: 'cut' | 'boost' };
}

export interface CompressorParams {
  threshold: number; ratio: number; attack: number; release: number; knee: number;
  makeup: number; mix: number;
  detect: 'peak' | 'rms'; mode: 'stereo' | 'ms' | 'dual';
  autoRelease: boolean; autoMakeup: boolean;
}

let _workletsLoaded: Promise<void> | null = null;
export function loadMasteringWorklets(ctx: AudioContext): Promise<void> {
  if (!_workletsLoaded) {
    _workletsLoaded = Promise.all([
      ctx.audioWorklet.addModule('/worklets/noise-gate-processor.js'),
      ctx.audioWorklet.addModule('/worklets/mid-side-eq-processor.js'),
      ctx.audioWorklet.addModule('/worklets/multiband-comp-processor.js'),
      ctx.audioWorklet.addModule('/worklets/dynamics-eq-processor.js'),
      ctx.audioWorklet.addModule('/worklets/compressor-processor.js'),
      ctx.audioWorklet.addModule('/worklets/bass-mono-processor.js'),
      ctx.audioWorklet.addModule('/worklets/lookahead-limiter-processor.js'),
    ]).then(() => undefined);
  }
  return _workletsLoaded;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function makeSaturationCurve(amount: number): Float32Array {
  const samples = 8192;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    if (amount <= 0) {
      curve[i] = x;
    } else {
      const k = amount / 100;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
  }
  return curve;
}

export class MasteringEngine {
  ctx: AudioContext;

  // Processing nodes
  inputGainNode: GainNode;
  lowCutNode: BiquadFilterNode;      // subsonic high-pass
  tiltLowNode: BiquadFilterNode;     // spectral-tilt low shelf
  tiltHighNode: BiquadFilterNode;    // spectral-tilt high shelf
  bassMonoNode: AudioWorkletNode | null = null;
  bassMonoWet: GainNode;
  bassMonoDry: GainNode;
  bassMonoInputBus: GainNode;
  bassMonoOutputBus: GainNode;
  private _bassMonoFreq = 120;
  eqNodes: BiquadFilterNode[];
  compressorNode: DynamicsCompressorNode;
  makeupGainNode: GainNode;
  waveShaperNode: WaveShaperNode;

  // Worklet nodes (created if worklets loaded)
  noiseGateNode: AudioWorkletNode | null = null;
  noiseGateWet: GainNode;       // 1 when enabled, 0 when bypassed
  noiseGateDry: GainNode;       // 0 when enabled, 1 when bypassed
  noiseGateInputBus: GainNode;  // splits to worklet + dry path
  noiseGateOutputBus: GainNode; // sums wet + dry

  midSideEQNode: AudioWorkletNode | null = null;
  midSideWet: GainNode;
  midSideDry: GainNode;
  midSideInputBus: GainNode;
  midSideOutputBus: GainNode;

  multibandNode: AudioWorkletNode | null = null;
  multibandWet: GainNode;
  multibandDry: GainNode;
  multibandInputBus: GainNode;
  multibandOutputBus: GainNode;
  private _mbGR: number[] = [0, 0, 0];
  private _mbParams: MultibandParams | null = null;

  dynEqNode: AudioWorkletNode | null = null;
  dynEqWet: GainNode;
  dynEqDry: GainNode;
  dynEqInputBus: GainNode;
  dynEqOutputBus: GainNode;
  private _deEssGR = 0;
  private _dynEqGR = 0;
  private _dynEqParams: DynamicsEqParams | null = null;

  compWorkletNode: AudioWorkletNode | null = null;
  compWet: GainNode;
  compDry: GainNode;
  compInputBus: GainNode;
  compOutputBus: GainNode;
  private _compGR = 0;
  private _compParams: CompressorParams | null = null;

  // Stereo width
  widthSplitter: ChannelSplitterNode;
  widthMerger: ChannelMergerNode;
  llGain: GainNode;
  lrGain: GainNode;
  rlGain: GainNode;
  rrGain: GainNode;

  // Limiter (fallback DynamicsCompressor + real lookahead worklet)
  limiterNode: DynamicsCompressorNode;
  limiterWorkletNode: AudioWorkletNode | null = null;
  limiterWet: GainNode;
  limiterDry: GainNode;
  limiterInputBus: GainNode;
  limiterOutputBus: GainNode;

  // Analysis
  preAnalyser: AnalyserNode;
  postAnalyser: AnalyserNode;
  endSplitter: ChannelSplitterNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;

  // Worklet metering state
  private _gateGR = 0;
  private _limiterGR = 0;
  private _limiterTP = -Infinity;
  private _limiterParams: { ceiling: number; release: number; bypass: boolean } = { ceiling: -1, release: 100, bypass: false };
  private _gateState: string = 'closed';

  // Playback
  source: AudioBufferSourceNode | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    // Pre-analyser (dry signal)
    this.preAnalyser = ctx.createAnalyser();
    this.preAnalyser.fftSize = 4096;
    this.preAnalyser.smoothingTimeConstant = 0.8;

    // Input gain
    this.inputGainNode = ctx.createGain();

    // Subsonic low-cut (transparent when disabled: freq → 10 Hz)
    this.lowCutNode = ctx.createBiquadFilter();
    this.lowCutNode.type = 'highpass';
    this.lowCutNode.frequency.value = 10;
    this.lowCutNode.Q.value = 0.707;

    // Spectral tilt = low shelf down + high shelf up (or vice-versa), 1 knob
    this.tiltLowNode = ctx.createBiquadFilter();
    this.tiltLowNode.type = 'lowshelf';
    this.tiltLowNode.frequency.value = 500;
    this.tiltHighNode = ctx.createBiquadFilter();
    this.tiltHighNode.type = 'highshelf';
    this.tiltHighNode.frequency.value = 500;

    // Bass mono-maker wet/dry buses
    this.bassMonoInputBus = ctx.createGain();
    this.bassMonoOutputBus = ctx.createGain();
    this.bassMonoWet = ctx.createGain();
    this.bassMonoDry = ctx.createGain();
    this.bassMonoWet.gain.value = 0;
    this.bassMonoDry.gain.value = 1;

    // Noise gate wet/dry buses (worklet inserted later in attachWorklets)
    this.noiseGateInputBus = ctx.createGain();
    this.noiseGateOutputBus = ctx.createGain();
    this.noiseGateWet = ctx.createGain();
    this.noiseGateDry = ctx.createGain();
    this.noiseGateWet.gain.value = 0; // worklet not loaded yet → all dry
    this.noiseGateDry.gain.value = 1;

    // 5-band parametric EQ
    this.eqNodes = [
      this.createEQ('lowshelf', 80, 0, 0.7),
      this.createEQ('peaking', 250, 0, 1.0),
      this.createEQ('peaking', 1000, 0, 1.0),
      this.createEQ('peaking', 4000, 0, 1.0),
      this.createEQ('highshelf', 12000, 0, 0.7),
    ];

    // Mid/Side EQ wet/dry buses
    this.midSideInputBus = ctx.createGain();
    this.midSideOutputBus = ctx.createGain();
    this.midSideWet = ctx.createGain();
    this.midSideDry = ctx.createGain();
    this.midSideWet.gain.value = 0;
    this.midSideDry.gain.value = 1;

    // Multiband compressor wet/dry buses
    this.multibandInputBus = ctx.createGain();
    this.multibandOutputBus = ctx.createGain();
    this.multibandWet = ctx.createGain();
    this.multibandDry = ctx.createGain();
    this.multibandWet.gain.value = 0;
    this.multibandDry.gain.value = 1;

    // De-esser / dynamic-EQ wet/dry buses
    this.dynEqInputBus = ctx.createGain();
    this.dynEqOutputBus = ctx.createGain();
    this.dynEqWet = ctx.createGain();
    this.dynEqDry = ctx.createGain();
    this.dynEqWet.gain.value = 0;
    this.dynEqDry.gain.value = 1;

    // Compressor wet/dry buses (worklet = wet, native DynamicsCompressor = fallback)
    this.compInputBus = ctx.createGain();
    this.compOutputBus = ctx.createGain();
    this.compWet = ctx.createGain();
    this.compDry = ctx.createGain();
    this.compWet.gain.value = 0;
    this.compDry.gain.value = 1;

    // Stereo compressor
    this.compressorNode = ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = -12;
    this.compressorNode.ratio.value = 3;
    this.compressorNode.attack.value = 0.01;
    this.compressorNode.release.value = 0.1;
    this.compressorNode.knee.value = 6;

    // Makeup gain
    this.makeupGainNode = ctx.createGain();

    // Wave shaper (saturation/warmth)
    this.waveShaperNode = ctx.createWaveShaper();
    this.waveShaperNode.curve = makeSaturationCurve(0);
    this.waveShaperNode.oversample = '2x';

    // Stereo width matrix
    this.widthSplitter = ctx.createChannelSplitter(2);
    this.widthMerger = ctx.createChannelMerger(2);
    this.llGain = ctx.createGain();
    this.lrGain = ctx.createGain();
    this.rlGain = ctx.createGain();
    this.rrGain = ctx.createGain();
    this.setStereoWidth(100);

    // Limiter (high-ratio compressor)
    this.limiterNode = ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -1;
    this.limiterNode.ratio.value = 20;
    this.limiterNode.attack.value = 0.001;
    this.limiterNode.release.value = 0.1;
    this.limiterNode.knee.value = 0;

    // Limiter wet/dry buses (worklet inserted in attachWorklets)
    this.limiterInputBus = ctx.createGain();
    this.limiterOutputBus = ctx.createGain();
    this.limiterWet = ctx.createGain();
    this.limiterDry = ctx.createGain();
    this.limiterWet.gain.value = 0; // worklet not loaded yet → fallback path
    this.limiterDry.gain.value = 1;

    // Post-analyser (processed signal)
    this.postAnalyser = ctx.createAnalyser();
    this.postAnalyser.fftSize = 4096;
    this.postAnalyser.smoothingTimeConstant = 0.8;

    // Per-channel analysers
    this.endSplitter = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserL.fftSize = 2048;
    this.analyserR = ctx.createAnalyser();
    this.analyserR.fftSize = 2048;

    this.buildChain();
  }

  /** Attach worklet nodes once `loadMasteringWorklets` has resolved. Idempotent. */
  attachWorklets() {
    if (!this.noiseGateNode) {
      try {
        this.noiseGateNode = new AudioWorkletNode(this.ctx, 'noise-gate-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        this.noiseGateNode.port.onmessage = (e) => {
          if (e.data && typeof e.data.gr === 'number') {
            this._gateGR = e.data.gr;
            this._gateState = e.data.state || this._gateState;
          }
        };
        // Insert into wet path: inputBus → worklet → wetGain → outputBus
        this.noiseGateInputBus.connect(this.noiseGateNode);
        this.noiseGateNode.connect(this.noiseGateWet);
        this.noiseGateWet.connect(this.noiseGateOutputBus);
      } catch (err) {
        console.warn('[engine] noise gate worklet not available', err);
      }
    }
    if (!this.midSideEQNode) {
      try {
        this.midSideEQNode = new AudioWorkletNode(this.ctx, 'mid-side-eq-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        this.midSideInputBus.connect(this.midSideEQNode);
        this.midSideEQNode.connect(this.midSideWet);
        this.midSideWet.connect(this.midSideOutputBus);
      } catch (err) {
        console.warn('[engine] mid/side EQ worklet not available', err);
      }
    }
    if (!this.multibandNode) {
      try {
        this.multibandNode = new AudioWorkletNode(this.ctx, 'multiband-comp-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        this.multibandNode.port.onmessage = (e) => {
          if (Array.isArray(e.data?.gr)) this._mbGR = e.data.gr;
        };
        this.multibandInputBus.connect(this.multibandNode);
        this.multibandNode.connect(this.multibandWet);
        this.multibandWet.connect(this.multibandOutputBus);
        if (this._mbParams) this.setMultiband(this._mbParams);
      } catch (err) {
        console.warn('[engine] multiband worklet not available', err);
      }
    }
    if (!this.dynEqNode) {
      try {
        this.dynEqNode = new AudioWorkletNode(this.ctx, 'dynamics-eq-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        this.dynEqNode.port.onmessage = (e) => {
          if (typeof e.data?.deEssGR === 'number') this._deEssGR = e.data.deEssGR;
          if (typeof e.data?.dynGR === 'number') this._dynEqGR = e.data.dynGR;
        };
        this.dynEqInputBus.connect(this.dynEqNode);
        this.dynEqNode.connect(this.dynEqWet);
        this.dynEqWet.connect(this.dynEqOutputBus);
        if (this._dynEqParams) this.setDynamicsEq(this._dynEqParams);
      } catch (err) {
        console.warn('[engine] dynamics-eq worklet not available', err);
      }
    }
    if (!this.compWorkletNode) {
      try {
        this.compWorkletNode = new AudioWorkletNode(this.ctx, 'compressor-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        this.compWorkletNode.port.onmessage = (e) => {
          if (typeof e.data?.gr === 'number') this._compGR = e.data.gr;
        };
        this.compInputBus.connect(this.compWorkletNode);
        this.compWorkletNode.connect(this.compWet);
        this.compWet.connect(this.compOutputBus);
        if (this._compParams) this.setCompressorFull(this._compParams);
      } catch (err) {
        console.warn('[engine] compressor worklet not available', err);
      }
    }
    if (!this.limiterWorkletNode) {
      try {
        this.limiterWorkletNode = new AudioWorkletNode(this.ctx, 'lookahead-limiter-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        this.limiterWorkletNode.port.onmessage = (e) => {
          if (e.data && typeof e.data.gr === 'number') {
            this._limiterGR = e.data.gr;
            this._limiterTP = e.data.tp;
          }
        };
        this.limiterInputBus.connect(this.limiterWorkletNode);
        this.limiterWorkletNode.connect(this.limiterWet);
        this.limiterWet.connect(this.limiterOutputBus);
        // Worklet available → make it the active limiter, neutralise fallback
        this.setLimiter(this._limiterParams);
        this.bypassLimiter(this._limiterParams.bypass);
      } catch (err) {
        console.warn('[engine] lookahead limiter worklet not available', err);
      }
    }
    if (!this.bassMonoNode) {
      try {
        this.bassMonoNode = new AudioWorkletNode(this.ctx, 'bass-mono-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          processorOptions: { freq: this._bassMonoFreq },
        });
        this.bassMonoInputBus.connect(this.bassMonoNode);
        this.bassMonoNode.connect(this.bassMonoWet);
        this.bassMonoWet.connect(this.bassMonoOutputBus);
      } catch (err) {
        console.warn('[engine] bass-mono worklet not available', err);
      }
    }
  }

  private createEQ(type: BiquadFilterType, freq: number, gain: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.gain.value = gain;
    f.Q.value = q;
    return f;
  }

  private buildChain() {
    // inputGain → low-cut → noiseGate bus
    this.inputGainNode.connect(this.lowCutNode);
    this.lowCutNode.connect(this.noiseGateInputBus);
    this.noiseGateInputBus.connect(this.noiseGateDry);
    this.noiseGateDry.connect(this.noiseGateOutputBus);

    // noiseGate output → EQ chain
    this.noiseGateOutputBus.connect(this.eqNodes[0]);
    for (let i = 0; i < this.eqNodes.length - 1; i++) {
      this.eqNodes[i].connect(this.eqNodes[i + 1]);
    }

    // EQ → tilt → bass-mono bus → midSide bus
    this.eqNodes[this.eqNodes.length - 1].connect(this.tiltLowNode);
    this.tiltLowNode.connect(this.tiltHighNode);
    this.tiltHighNode.connect(this.bassMonoInputBus);
    this.bassMonoInputBus.connect(this.bassMonoDry);
    this.bassMonoDry.connect(this.bassMonoOutputBus);

    this.bassMonoOutputBus.connect(this.midSideInputBus);
    this.midSideInputBus.connect(this.midSideDry);
    this.midSideDry.connect(this.midSideOutputBus);

    // midSide → multiband bus (worklet wired in attachWorklets, dry path always on)
    this.midSideOutputBus.connect(this.multibandInputBus);
    this.multibandInputBus.connect(this.multibandDry);
    this.multibandDry.connect(this.multibandOutputBus);

    // multiband → de-esser / dynamic-EQ bus
    this.multibandOutputBus.connect(this.dynEqInputBus);
    this.dynEqInputBus.connect(this.dynEqDry);
    this.dynEqDry.connect(this.dynEqOutputBus);

    // dynEq → compressor bus. Native DynamicsCompressor + makeup is the dry
    // (fallback) path; the worklet compressor is wired as wet in attachWorklets.
    this.dynEqOutputBus.connect(this.compInputBus);
    this.compInputBus.connect(this.compressorNode);
    this.compressorNode.connect(this.makeupGainNode);
    this.makeupGainNode.connect(this.compDry);
    this.compDry.connect(this.compOutputBus);

    // compressor → waveshaper
    this.compOutputBus.connect(this.waveShaperNode);

    // Waveshaper → stereo width matrix
    this.waveShaperNode.connect(this.widthSplitter);
    this.widthSplitter.connect(this.llGain, 0);
    this.widthSplitter.connect(this.lrGain, 1);
    this.widthSplitter.connect(this.rlGain, 0);
    this.widthSplitter.connect(this.rrGain, 1);
    this.llGain.connect(this.widthMerger, 0, 0);
    this.lrGain.connect(this.widthMerger, 0, 0);
    this.rlGain.connect(this.widthMerger, 0, 1);
    this.rrGain.connect(this.widthMerger, 0, 1);

    // Width → limiter bus. Dry path uses the DynamicsCompressor fallback,
    // wet path uses the lookahead limiter worklet (wired in attachWorklets).
    this.widthMerger.connect(this.limiterInputBus);
    this.limiterInputBus.connect(this.limiterNode);
    this.limiterNode.connect(this.limiterDry);
    this.limiterDry.connect(this.limiterOutputBus);

    this.limiterOutputBus.connect(this.postAnalyser);
    this.postAnalyser.connect(this.ctx.destination);

    // Per-channel metering (dead-end taps)
    this.limiterOutputBus.connect(this.endSplitter);
    this.endSplitter.connect(this.analyserL, 0);
    this.endSplitter.connect(this.analyserR, 1);
  }

  connectSource(source: AudioBufferSourceNode) {
    source.connect(this.preAnalyser); // dry tap
    source.connect(this.inputGainNode); // main chain
    this.source = source;
  }

  disconnectSource() {
    if (this.source) {
      try { this.source.stop(); } catch { /* not started */ }
      try { this.source.disconnect(); } catch { /* already disconnected */ }
      this.source = null;
    }
  }

  // --- Parameter setters ---

  /** Glide an AudioParam to `value` (prevents zipper noise on slider drags). */
  private ramp(param: AudioParam, value: number, tau = 0.02) {
    param.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  setInputGain(db: number) {
    this.ramp(this.inputGainNode.gain, dbToGain(db));
  }

  setEQBand(index: number, params: { freq?: number; gain?: number; q?: number; type?: BiquadFilterType }) {
    const node = this.eqNodes[index];
    if (!node) return;
    if (params.freq !== undefined) this.ramp(node.frequency, params.freq);
    if (params.gain !== undefined) this.ramp(node.gain, params.gain);
    if (params.q !== undefined) this.ramp(node.Q, params.q);
    if (params.type !== undefined) node.type = params.type;
  }

  /** Subsonic low-cut. Disabled → highpass parks at 10 Hz (transparent). */
  setLowCut(enabled: boolean, freq: number) {
    this.ramp(this.lowCutNode.frequency, enabled ? Math.max(10, freq) : 10);
  }

  /** Spectral tilt: +amount = brighter (low shelf down, high shelf up). */
  setTilt(enabled: boolean, amount: number) {
    const a = enabled ? amount : 0;
    this.ramp(this.tiltLowNode.gain, -a);
    this.ramp(this.tiltHighNode.gain, a);
  }

  setBassMono(enabled: boolean, freq: number) {
    this._bassMonoFreq = freq;
    this.bassMonoNode?.port.postMessage({ freq });
    const t = this.ctx.currentTime;
    const wet = enabled && this.bassMonoNode ? 1 : 0;
    this.bassMonoWet.gain.setTargetAtTime(wet, t, 0.005);
    this.bassMonoDry.gain.setTargetAtTime(1 - wet, t, 0.005);
  }

  bypassEQ(bypass: boolean) {
    // When bypassed, set all gains to 0 (transparent). Values are restored by the context.
    if (bypass) {
      for (const node of this.eqNodes) node.gain.setValueAtTime(0, this.ctx.currentTime);
    }
  }

  setCompressor(params: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number }) {
    if (params.threshold !== undefined) this.ramp(this.compressorNode.threshold, params.threshold);
    if (params.ratio !== undefined) this.ramp(this.compressorNode.ratio, Math.max(1, params.ratio));
    if (params.attack !== undefined) this.ramp(this.compressorNode.attack, params.attack / 1000);
    if (params.release !== undefined) this.ramp(this.compressorNode.release, params.release / 1000);
    if (params.knee !== undefined) this.ramp(this.compressorNode.knee, params.knee);
  }

  /** Full worklet-compressor config (deterministic, M/S, parallel, auto). */
  setCompressorFull(p: CompressorParams) {
    this._compParams = p;
    this.setCompressor(p); // keep the native fallback in sync
    this.compWorkletNode?.port.postMessage(p);
  }

  bypassCompressor(bypass: boolean) {
    const t = this.ctx.currentTime;
    const hasWorklet = !!this.compWorkletNode;
    const useWorklet = !bypass && hasWorklet;
    this.compWet.gain.setTargetAtTime(useWorklet ? 1 : 0, t, 0.005);
    this.compDry.gain.setTargetAtTime(useWorklet ? 0 : 1, t, 0.005);
    // the native DynamicsCompressor sits in the dry path — neutralise it unless
    // it is the active processor (no worklet, not bypassed)
    const nativeActive = !bypass && !hasWorklet;
    this.compressorNode.threshold.setValueAtTime(nativeActive ? (this._compParams?.threshold ?? -12) : 0, t);
    this.compressorNode.ratio.setValueAtTime(nativeActive ? Math.max(1, this._compParams?.ratio ?? 3) : 1, t);
    if (!nativeActive) this.makeupGainNode.gain.setTargetAtTime(1, t, 0.005);
  }

  setMakeupGain(db: number) {
    // only used by the native fallback path — the worklet has its own makeup
    this.ramp(this.makeupGainNode.gain, dbToGain(db));
  }

  setSaturation(amount: number) {
    this.waveShaperNode.curve = makeSaturationCurve(amount);
  }

  setStereoWidth(widthPercent: number) {
    const w = widthPercent / 100;
    this.ramp(this.llGain.gain, (1 + w) / 2);
    this.ramp(this.lrGain.gain, (1 - w) / 2);
    this.ramp(this.rlGain.gain, (1 - w) / 2);
    this.ramp(this.rrGain.gain, (1 + w) / 2);
  }

  setLimiter(params: { ceiling?: number; release?: number; bypass?: boolean }) {
    const t = this.ctx.currentTime;
    if (params.ceiling !== undefined) this._limiterParams.ceiling = params.ceiling;
    if (params.release !== undefined) this._limiterParams.release = params.release;
    if (params.bypass !== undefined) this._limiterParams.bypass = params.bypass;

    const { ceiling, release } = this._limiterParams;

    if (this.limiterWorkletNode) {
      this.limiterWorkletNode.parameters.get('ceiling')?.setValueAtTime(ceiling, t);
      this.limiterWorkletNode.parameters.get('release')?.setValueAtTime(release, t);
      this.limiterWorkletNode.parameters.get('lookahead')?.setValueAtTime(5, t);
    }
    // Fallback compressor mirrors the settings when the worklet is unavailable
    this.limiterNode.threshold.setValueAtTime(ceiling, t);
    this.limiterNode.release.setValueAtTime(release / 1000, t);
  }

  bypassLimiter(bypass: boolean) {
    const t = this.ctx.currentTime;
    this._limiterParams.bypass = bypass;
    const hasWorklet = !!this.limiterWorkletNode;

    // Route: worklet when available, fallback compressor otherwise
    this.limiterWet.gain.setTargetAtTime(hasWorklet ? 1 : 0, t, 0.005);
    this.limiterDry.gain.setTargetAtTime(hasWorklet ? 0 : 1, t, 0.005);

    if (hasWorklet) {
      this.limiterWorkletNode!.parameters.get('bypass')?.setValueAtTime(bypass ? 1 : 0, t);
      // fallback is out of circuit; keep it neutral
      this.limiterNode.ratio.setValueAtTime(1, t);
    } else if (bypass) {
      this.limiterNode.threshold.setValueAtTime(0, t);
      this.limiterNode.ratio.setValueAtTime(1, t);
    } else {
      this.limiterNode.threshold.setValueAtTime(this._limiterParams.ceiling, t);
      this.limiterNode.ratio.setValueAtTime(20, t);
    }
  }

  /** Gain reduction of the lookahead limiter in dB (<= 0). */
  getLimiterGR(): number {
    if (this.limiterWorkletNode) return this._limiterGR;
    return this.limiterNode.reduction;
  }

  /** Detected inter-sample (true) peak in dBTP at the limiter input. */
  getLimiterTruePeak(): number { return this._limiterTP; }

  // --- Noise Gate (AudioWorklet) ---

  setNoiseGate(params: Partial<NoiseGateParams>) {
    if (!this.noiseGateNode) return;
    const t = this.ctx.currentTime;
    const setP = (name: string, v: number | undefined) => {
      if (v === undefined) return;
      const p = this.noiseGateNode!.parameters.get(name);
      if (p) p.setValueAtTime(v, t);
    };
    setP('threshold', params.threshold);
    setP('range', params.range);
    setP('attack', params.attack);
    setP('hold', params.hold);
    setP('release', params.release);
  }

  bypassNoiseGate(bypass: boolean) {
    const t = this.ctx.currentTime;
    // Worklet may not have loaded; in that case wet stays 0 / dry stays 1.
    const hasNode = !!this.noiseGateNode;
    this.noiseGateWet.gain.setTargetAtTime(bypass || !hasNode ? 0 : 1, t, 0.005);
    this.noiseGateDry.gain.setTargetAtTime(bypass || !hasNode ? 1 : 0, t, 0.005);
  }

  getNoiseGateGR(): number { return this._gateGR; }
  getNoiseGateState(): string { return this._gateState; }

  // --- Mid/Side EQ (AudioWorklet) ---

  setMidSideEQ(params: Partial<MidSideEQParams>) {
    if (!this.midSideEQNode) return;
    const t = this.ctx.currentTime;
    const setP = (name: string, v: number | undefined) => {
      if (v === undefined) return;
      const p = this.midSideEQNode!.parameters.get(name);
      if (p) p.setValueAtTime(v, t);
    };
    setP('midLowGain', params.midLowGain);
    setP('midMidGain', params.midMidGain);
    setP('midHighGain', params.midHighGain);
    setP('sideLowGain', params.sideLowGain);
    setP('sideMidGain', params.sideMidGain);
    setP('sideHighGain', params.sideHighGain);
    setP('midLowFreq', params.midLowFreq);
    setP('midMidFreq', params.midMidFreq);
    setP('midHighFreq', params.midHighFreq);
    setP('sideLowFreq', params.sideLowFreq);
    setP('sideMidFreq', params.sideMidFreq);
    setP('sideHighFreq', params.sideHighFreq);
    setP('q', params.q);
  }

  bypassMidSideEQ(bypass: boolean) {
    const t = this.ctx.currentTime;
    const hasNode = !!this.midSideEQNode;
    this.midSideWet.gain.setTargetAtTime(bypass || !hasNode ? 0 : 1, t, 0.005);
    this.midSideDry.gain.setTargetAtTime(bypass || !hasNode ? 1 : 0, t, 0.005);
  }

  // --- Multiband compressor (AudioWorklet) ---

  setMultiband(params: MultibandParams) {
    this._mbParams = params;
    this.multibandNode?.port.postMessage({
      xover1: params.xover1,
      xover2: params.xover2,
      bands: params.bands,
    });
  }

  bypassMultiband(bypass: boolean) {
    const t = this.ctx.currentTime;
    const hasNode = !!this.multibandNode;
    this.multibandWet.gain.setTargetAtTime(bypass || !hasNode ? 0 : 1, t, 0.005);
    this.multibandDry.gain.setTargetAtTime(bypass || !hasNode ? 1 : 0, t, 0.005);
  }

  /** Per-band gain reduction [low, mid, high] in dB. */
  getMultibandGR(): number[] { return this._mbGR; }

  // --- De-esser / Dynamic EQ (AudioWorklet) ---

  setDynamicsEq(params: DynamicsEqParams) {
    this._dynEqParams = params;
    this.dynEqNode?.port.postMessage({ deEss: params.deEss, dyn: params.dyn });
  }

  bypassDynamicsEq(bypass: boolean) {
    const t = this.ctx.currentTime;
    const has = !!this.dynEqNode;
    // "active" when the node exists and at least one sub-processor is on
    const anyOn = !!(this._dynEqParams && (this._dynEqParams.deEss.enabled || this._dynEqParams.dyn.enabled));
    const wet = bypass || !has || !anyOn ? 0 : 1;
    this.dynEqWet.gain.setTargetAtTime(wet, t, 0.005);
    this.dynEqDry.gain.setTargetAtTime(1 - wet, t, 0.005);
  }

  getDeEsserGR(): number { return this._deEssGR; }
  getDynEqGR(): number { return this._dynEqGR; }


  getCompressorGR(): number {
    return this.compWorkletNode ? this._compGR : this.compressorNode.reduction;
  }


  getPreFrequencyData(): Float32Array {
    const data = new Float32Array(this.preAnalyser.frequencyBinCount);
    this.preAnalyser.getFloatFrequencyData(data);
    return data;
  }

  getPostFrequencyData(): Float32Array {
    const data = new Float32Array(this.postAnalyser.frequencyBinCount);
    this.postAnalyser.getFloatFrequencyData(data);
    return data;
  }

  getChannelLevels(): { left: number; right: number } {
    const bufL = new Float32Array(this.analyserL.fftSize);
    const bufR = new Float32Array(this.analyserR.fftSize);
    this.analyserL.getFloatTimeDomainData(bufL);
    this.analyserR.getFloatTimeDomainData(bufR);

    let sumL = 0, sumR = 0, peakL = 0, peakR = 0;
    for (let i = 0; i < bufL.length; i++) {
      sumL += bufL[i] * bufL[i];
      sumR += bufR[i] * bufR[i];
      const aL = Math.abs(bufL[i]), aR = Math.abs(bufR[i]);
      if (aL > peakL) peakL = aL;
      if (aR > peakR) peakR = aR;
    }

    return {
      left: 20 * Math.log10(Math.sqrt(sumL / bufL.length) || 0.0001),
      right: 20 * Math.log10(Math.sqrt(sumR / bufR.length) || 0.0001),
    };
  }

  getGoniometerData(): { l: Float32Array; r: Float32Array } {
    const l = new Float32Array(this.analyserL.fftSize);
    const r = new Float32Array(this.analyserR.fftSize);
    this.analyserL.getFloatTimeDomainData(l);
    this.analyserR.getFloatTimeDomainData(r);
    return { l, r };
  }
}
