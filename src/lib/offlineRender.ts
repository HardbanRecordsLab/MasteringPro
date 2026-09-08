/**
 * Offline render of the mastering chain — unified with the realtime engine.
 *
 * The same AudioWorklets used in realtime (noise gate, mid/side EQ, lookahead
 * limiter) are registered on the OfflineAudioContext, so preview, A/B and
 * export all go through an identical signal path. If a worklet fails to load
 * (old browser), the render gracefully falls back to native nodes.
 */
import type { ProcessingParams } from '@/contexts/AudioContext';
import { limiterLatencySamples, compressorLatencySamples } from '@/lib/limiterConfig';

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

function dbToGain(db: number) {
  return Math.pow(10, db / 20);
}

const WORKLET_URLS = [
  '/worklets/noise-gate-processor.js',
  '/worklets/mid-side-eq-processor.js',
  '/worklets/multiband-comp-processor.js',
  '/worklets/dynamics-eq-processor.js',
  '/worklets/compressor-processor.js',
  '/worklets/bass-mono-processor.js',
  '/worklets/lookahead-limiter-processor.js',
];

async function registerWorklets(ctx: OfflineAudioContext): Promise<boolean> {
  try {
    await Promise.all(WORKLET_URLS.map((u) => ctx.audioWorklet.addModule(u)));
    return true;
  } catch (e) {
    console.warn('[offlineRender] worklets unavailable, using native fallback', e);
    return false;
  }
}

export async function renderProcessed(
  buffer: AudioBuffer,
  p: ProcessingParams,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(
    Math.max(2, buffer.numberOfChannels),
    buffer.length,
    buffer.sampleRate,
  );

  const hasWorklets = await registerWorklets(ctx);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // Input gain
  const input = ctx.createGain();
  input.gain.value = dbToGain(p.inputGain);
  source.connect(input);
  let node: AudioNode = input;

  // Subsonic low-cut
  if (p.lowCutEnabled) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = Math.max(10, p.lowCutFreq);
    hp.Q.value = 0.707;
    node.connect(hp);
    node = hp;
  }

  // Noise gate (worklet)
  if (hasWorklets && p.gateEnabled) {
    try {
      const gate = new AudioWorkletNode(ctx, 'noise-gate-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      gate.parameters.get('threshold')?.setValueAtTime(p.gateThreshold, 0);
      gate.parameters.get('range')?.setValueAtTime(p.gateRange, 0);
      gate.parameters.get('attack')?.setValueAtTime(p.gateAttack, 0);
      gate.parameters.get('hold')?.setValueAtTime(p.gateHold, 0);
      gate.parameters.get('release')?.setValueAtTime(p.gateRelease, 0);
      node.connect(gate);
      node = gate;
    } catch (e) {
      console.warn('[offlineRender] gate skipped', e);
    }
  }

  // EQ
  if (p.eqEnabled) {
    for (const band of p.eqBands) {
      const f = ctx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      f.gain.value = band.gain;
      f.Q.value = band.q;
      node.connect(f);
      node = f;
    }
  }

  // Spectral tilt (low shelf down + high shelf up, both at 500 Hz)
  if (p.tiltEnabled && p.tiltAmount !== 0) {
    const lo = ctx.createBiquadFilter();
    lo.type = 'lowshelf'; lo.frequency.value = 500; lo.gain.value = -p.tiltAmount;
    const hi = ctx.createBiquadFilter();
    hi.type = 'highshelf'; hi.frequency.value = 500; hi.gain.value = p.tiltAmount;
    node.connect(lo); lo.connect(hi); node = hi;
  }

  // Bass mono-maker (worklet)
  if (hasWorklets && p.bassMonoEnabled) {
    try {
      const bm = new AudioWorkletNode(ctx, 'bass-mono-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { freq: p.bassMonoFreq },
      });
      node.connect(bm);
      node = bm;
    } catch (e) {
      console.warn('[offlineRender] bass-mono skipped', e);
    }
  }

  // Mid/Side EQ (worklet)
  if (hasWorklets && p.msEnabled) {
    try {
      const ms = new AudioWorkletNode(ctx, 'mid-side-eq-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      const set = (n: string, v: number) => ms.parameters.get(n)?.setValueAtTime(v, 0);
      set('midLowGain', p.msMidLow); set('midMidGain', p.msMidMid); set('midHighGain', p.msMidHigh);
      set('sideLowGain', p.msSideLow); set('sideMidGain', p.msSideMid); set('sideHighGain', p.msSideHigh);
      set('midLowFreq', p.msMidLowFreq); set('midMidFreq', p.msMidMidFreq); set('midHighFreq', p.msMidHighFreq);
      set('sideLowFreq', p.msSideLowFreq); set('sideMidFreq', p.msSideMidFreq); set('sideHighFreq', p.msSideHighFreq);
      node.connect(ms);
      node = ms;
    } catch (e) {
      console.warn('[offlineRender] mid/side EQ skipped', e);
    }
  }

  // Multiband compressor (worklet)
  if (hasWorklets && p.mbEnabled) {
    try {
      const mb = new AudioWorkletNode(ctx, 'multiband-comp-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { xover1: p.mbXover1, xover2: p.mbXover2, bands: p.mbBands },
      });
      node.connect(mb);
      node = mb;
    } catch (e) {
      console.warn('[offlineRender] multiband skipped', e);
    }
  }

  // De-esser / dynamic EQ (worklet)
  if (hasWorklets && (p.deEssEnabled || p.dynEqEnabled)) {
    try {
      const de = new AudioWorkletNode(ctx, 'dynamics-eq-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: {
          deEss: { enabled: p.deEssEnabled, freq: p.deEssFreq, threshold: p.deEssThreshold, range: p.deEssRange, attack: 1, release: 60 },
          dyn: { enabled: p.dynEqEnabled, freq: p.dynEqFreq, q: p.dynEqQ, threshold: p.dynEqThreshold, range: p.dynEqRange, attack: 10, release: 120, mode: p.dynEqMode },
        },
      });
      node.connect(de);
      node = de;
    } catch (e) {
      console.warn('[offlineRender] dynamics-eq skipped', e);
    }
  }

  // Compressor — deterministic worklet, native DynamicsCompressor as fallback
  if (p.compEnabled) {
    let done = false;
    if (hasWorklets) {
      try {
        const comp = new AudioWorkletNode(ctx, 'compressor-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          processorOptions: {
            threshold: p.compThreshold, ratio: p.compRatio, attack: p.compAttack,
            release: p.compRelease, knee: p.compKnee, makeup: p.compMakeup,
            mix: p.compMix, detect: p.compDetect, mode: p.compMode,
            autoRelease: p.compAutoRelease, autoMakeup: p.compAutoMakeup,
          },
        });
        node.connect(comp);
        node = comp;
        done = true;
      } catch (e) {
        console.warn('[offlineRender] compressor worklet skipped', e);
      }
    }
    if (!done) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = p.compThreshold;
      comp.ratio.value = p.compRatio;
      comp.attack.value = p.compAttack / 1000;
      comp.release.value = p.compRelease / 1000;
      comp.knee.value = p.compKnee;
      node.connect(comp);
      const makeup = ctx.createGain();
      makeup.gain.value = dbToGain(p.compMakeup);
      comp.connect(makeup);
      node = makeup;
    }
  }

  // Saturation
  if (p.saturationEnabled && p.saturation > 0) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSaturationCurve(p.saturation);
    shaper.oversample = '4x';
    node.connect(shaper);
    node = shaper;
  }

  // Stereo width (M/S matrix — matches the realtime engine coefficients)
  if (p.widthEnabled && p.stereoWidth !== 100) {
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const w = p.stereoWidth / 100;
    const ll = ctx.createGain(); ll.gain.value = (1 + w) / 2;
    const lr = ctx.createGain(); lr.gain.value = (1 - w) / 2;
    const rl = ctx.createGain(); rl.gain.value = (1 - w) / 2;
    const rr = ctx.createGain(); rr.gain.value = (1 + w) / 2;
    node.connect(splitter);
    splitter.connect(ll, 0); splitter.connect(lr, 1);
    splitter.connect(rl, 0); splitter.connect(rr, 1);
    ll.connect(merger, 0, 0); lr.connect(merger, 0, 0);
    rl.connect(merger, 0, 1); rr.connect(merger, 0, 1);
    node = merger;
  }

  // Limiter — real lookahead true-peak limiter when available
  let latencySamples = 0;
  // the worklet compressor is zero-latency; only the native fallback adds delay
  if (p.compEnabled && !hasWorklets) latencySamples += compressorLatencySamples(buffer.sampleRate);
  if (p.limiterEnabled) {
    let done = false;
    if (hasWorklets) {
      try {
        const lim = new AudioWorkletNode(ctx, 'lookahead-limiter-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        lim.parameters.get('ceiling')?.setValueAtTime(p.limiterCeiling, 0);
        lim.parameters.get('release')?.setValueAtTime(p.limiterRelease, 0);
        lim.parameters.get('lookahead')?.setValueAtTime(5, 0);
        node.connect(lim);
        node = lim;
        done = true;
        latencySamples += limiterLatencySamples(buffer.sampleRate);
      } catch (e) {
        console.warn('[offlineRender] limiter worklet skipped', e);
      }
    }
    if (!done) {
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = p.limiterCeiling;
      lim.ratio.value = 20;
      lim.attack.value = 0.001;
      lim.release.value = p.limiterRelease / 1000;
      lim.knee.value = 0;
      node.connect(lim);
      node = lim;
      latencySamples += compressorLatencySamples(buffer.sampleRate);
    }
  }

  node.connect(ctx.destination);
  source.start(0);
  const rendered = await ctx.startRendering();

  // Compensate processing latency so the master lines up with the source
  // (and so dry/wet A/B is sample-aligned).
  return latencySamples > 0 ? shiftEarlier(rendered, latencySamples) : rendered;
}

/** Drop the first `n` samples and zero-pad the tail, keeping length constant. */
function shiftEarlier(buf: AudioBuffer, n: number): AudioBuffer {
  if (n <= 0 || n >= buf.length) return buf;
  const out = new AudioBuffer({
    numberOfChannels: buf.numberOfChannels,
    length: buf.length,
    sampleRate: buf.sampleRate,
  });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(n), 0);
  }
  return out;
}
