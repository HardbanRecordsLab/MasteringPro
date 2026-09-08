/**
 * Noise Gate AudioWorklet Processor with Envelope Follower
 *
 * Classic four-stage gate: Closed → Attack → Open(Hold) → Release.
 * Detector uses peak envelope follower with separate attack/release ballistics.
 * Sidechain key: max(|L|, |R|) of the input signal.
 *
 * Parameters (k-rate):
 *   threshold (dB, -80..0)   — open level
 *   range     (dB, -80..0)   — attenuation when closed (e.g. -40dB = full close to -40dB)
 *   attack    (ms, 0.1..50)
 *   hold      (ms, 0..500)
 *   release   (ms, 5..1000)
 *
 * Posts current gain reduction (dB) to main thread ~30Hz for metering.
 */

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -40, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range',     defaultValue: -40, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 5,   minValue: 0.1, maxValue: 50, automationRate: 'k-rate' },
      { name: 'hold',      defaultValue: 10,  minValue: 0,   maxValue: 500, automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 100, minValue: 5,   maxValue: 1000, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.env = 0;            // detector envelope (linear)
    this.gain = 0;           // current applied gain (linear, 0..1)
    this.state = 'closed';   // closed | attack | open | release
    this.holdSamples = 0;
    this._meterCounter = 0;
    this._meterInterval = Math.floor(sampleRate / 30); // ~30Hz updates
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const sr = sampleRate;
    const thrDb = params.threshold[0];
    const rangeDb = params.range[0];
    const attackMs = params.attack[0];
    const holdMs = params.hold[0];
    const releaseMs = params.release[0];

    const thrLin = Math.pow(10, thrDb / 20);
    const closedGain = Math.pow(10, rangeDb / 20); // attenuation floor (e.g. -40dB → 0.01)

    // Envelope follower coefficients (peak detector)
    const envAttackCoef = Math.exp(-1 / (sr * 0.001));   // 1ms detector attack
    const envReleaseCoef = Math.exp(-1 / (sr * 0.050));  // 50ms detector release

    // Gain ramp coefficients
    const attackCoef = Math.exp(-1 / (sr * (attackMs * 0.001)));
    const releaseCoef = Math.exp(-1 / (sr * (releaseMs * 0.001)));
    const holdSamplesTarget = Math.floor((holdMs * 0.001) * sr);

    const inL = input[0];
    const inR = input[1] || input[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const N = inL.length;

    for (let i = 0; i < N; i++) {
      const l = inL[i];
      const r = inR[i];
      const key = Math.max(Math.abs(l), Math.abs(r));

      // Envelope follower (peak)
      if (key > this.env) {
        this.env = envAttackCoef * (this.env - key) + key;
      } else {
        this.env = envReleaseCoef * (this.env - key) + key;
      }

      // State machine
      if (this.env >= thrLin) {
        if (this.state === 'closed' || this.state === 'release') {
          this.state = 'attack';
        } else if (this.state === 'open' || this.state === 'attack') {
          this.holdSamples = holdSamplesTarget;
          if (this.env >= thrLin) this.state = this.state === 'attack' && this.gain >= 0.999 ? 'open' : this.state;
        }
      } else {
        if (this.state === 'open') {
          if (this.holdSamples > 0) {
            this.holdSamples--;
          } else {
            this.state = 'release';
          }
        } else if (this.state === 'attack') {
          // signal dropped during attack → fall back to release
          this.state = 'release';
        }
      }

      // Update gain based on state
      let target;
      if (this.state === 'attack') {
        target = 1.0;
        this.gain = attackCoef * (this.gain - target) + target;
        if (this.gain >= 0.999) {
          this.gain = 1.0;
          this.state = 'open';
          this.holdSamples = holdSamplesTarget;
        }
      } else if (this.state === 'open') {
        this.gain = 1.0;
      } else if (this.state === 'release') {
        target = closedGain;
        this.gain = releaseCoef * (this.gain - target) + target;
        if (Math.abs(this.gain - closedGain) < 1e-4) {
          this.gain = closedGain;
          this.state = 'closed';
        }
      } else {
        this.gain = closedGain;
      }

      outL[i] = l * this.gain;
      outR[i] = r * this.gain;
    }

    // Metering: post current GR every ~33ms
    this._meterCounter += N;
    if (this._meterCounter >= this._meterInterval) {
      this._meterCounter = 0;
      const grDb = 20 * Math.log10(Math.max(this.gain, 1e-6));
      this.port.postMessage({ gr: grDb, state: this.state });
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
