/**
 * KYX Kaskáda — character stereo delay with ping-pong, modulation,
 * loop EQ (LP+HP), drive and freeze.
 *
 * Dual ring buffer (L,R) with cubic-hermite interpolation for the
 * fractional read position (click-free under delay-time modulation).
 * Per-channel biquad cascade in the wet path (LP 24 dB/oct + HP 24 dB/oct),
 * one-pole DC blocker, tape-character wow (fixed slow LFO per channel).
 * Ping-pong crossfeeds L→R→L.
 *
 * All params are k-rate — updated once per block, no per-sample reads.
 * Drive is unity-small-signal tanh (tanh(x·g)/g): every element of the
 * loop chain is contractive, so the loop gain never exceeds FEEDBK at any
 * amplitude — no self-oscillation, and freeze (wet written back at 0.99)
 * always decays, never grows. Denormal flush on the feedback path
 * prevents CPU spikes on silent tails.
 */

const MAX_DELAY_MS = 2000;
const SYNC_RATIO = [0, 1, 0.5, 1 / 3, 0.25, 1 / 6]; // off, 1/4, 1/8, 1/8T, 1/16, 1/16T
const TWO_PI = Math.PI * 2;

/* ── Dual-spectrum metering (Inspector panel) ──
 * Analysis runs ONLY while a consumer is attached (node posts setMeters).
 * Taps: dry = mono input, wet = the delay bus after loop EQ/drive/spread,
 * pre-mix and pre-level — the display shows what the echoes contain, not
 * the output blend. 2048-pt Hann FFT folded into 72 log-spaced bands
 * (20 Hz–20 kHz, identical geometry on the UI side for the EQ overlay),
 * posted ~30×/s as one Float32Array(144) (dry 0–71, wet 72–143, dB).
 * The analysis shares the audio thread, so the gate must be enforced end
 * to end: the worklet also refuses messages after a disable. */
const FFT_SIZE = 2048;
const FFT_HALF = FFT_SIZE >> 1;
const METER_BANDS = 72;
const METER_F_MIN = 20;
const METER_F_MAX = 20000;
const METER_DB_FLOOR = -90;
const ANALYSIS_EVERY_BLOCKS = 11; // ≈33 ms at 44.1/48 kHz

/**
 * Test/entry factory — mirrors the createOzvenaProcessor pattern so the
 * vitest battery can instantiate the processor under a stubbed
 * AudioWorkletGlobalScope. `sampleRate` stays a global read (as in the real
 * worklet scope), so tests select the rate before constructing.
 */
export function createKaskadaProcessor() {
  return new KaskadaProcessor();
}

class KaskadaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "time", defaultValue: 375, minValue: 30, maxValue: 2000, automationRate: "k-rate" },
      { name: "sync", defaultValue: 0, minValue: 0, maxValue: 5, automationRate: "k-rate" },
      { name: "bpm", defaultValue: 120, minValue: 40, maxValue: 240, automationRate: "k-rate" },
      { name: "pingPong", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0.35, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
      { name: "toneLp", defaultValue: 4500, minValue: 500, maxValue: 12000, automationRate: "k-rate" },
      { name: "toneHp", defaultValue: 150, minValue: 20, maxValue: 800, automationRate: "k-rate" },
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "modRate", defaultValue: 0.6, minValue: 0.1, maxValue: 8, automationRate: "k-rate" },
      { name: "modDepth", defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "spread", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "freeze", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "character", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "level", defaultValue: -6, minValue: -24, maxValue: 6, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.sr = sampleRate;
    this.bufSize = Math.ceil((MAX_DELAY_MS / 1000) * this.sr) + 1;
    this.bufL = new Float32Array(this.bufSize);
    this.bufR = new Float32Array(this.bufSize);
    this.writePos = 0;
    this.lfoPhase = 0;

    // Cached state (avoids reading params per-sample)
    this.delaySamples = 1;
    this.fbGain = 0.35;
    this.mix = 0.25;
    this.outGain = Math.pow(10, -6 / 20);
    this.pingPong = false;
    this.freeze = false;
    this.drive = 0;
    this.spread = 0.8;
    this.modDepthMs = 0;
    this.character = 1;

    // Loop EQ biquads (2× LP cascade + 2× HP cascade = 24 dB/oct per side)
    this.lp1L = this.makeBiquad();
    this.lp1R = this.makeBiquad();
    this.lp2L = this.makeBiquad();
    this.lp2R = this.makeBiquad();
    this.hp1L = this.makeBiquad();
    this.hp1R = this.makeBiquad();
    this.hp2L = this.makeBiquad();
    this.hp2R = this.makeBiquad();
    this.lpL1c = this.lpCoeffs(4500, this.sr);
    this.lpR1c = this.lpCoeffs(4500, this.sr);
    this.hpL1c = this.hpCoeffs(150, this.sr);
    this.hpR1c = this.hpCoeffs(150, this.sr);

    // Character LP (one-pole per channel for tape/analog darkening)
    this.charLpz = 0;
    this.charRpz = 0;
    this.charLpCoef = 1 - Math.exp((-2 * Math.PI * 3500) / this.sr);

    // LFO state (MOD drift) + tape-wow phases (character 1, per channel)
    this.lfoPhase = 0;
    this.wobPhaseL = 0;
    this.wobPhaseR = Math.PI / 3;

    // One-pole DC blocker on the wet path (~5 Hz). The loop HP already
    // nulls DC; this is defence in depth so freeze's write-back loop can
    // never accumulate offset even if the toneHp range ever widens.
    this.dcxL = 0;
    this.dcyL = 0;
    this.dcxR = 0;
    this.dcyR = 0;
    this.dcCoef = 1 - (TWO_PI * 5) / this.sr;

    // Param change detection
    this._lastTimeMs = -1;
    this._lastSync = -1;
    this._lastBpm = -1;
    this._lastToneLp = -1;
    this._lastToneHp = -1;

    // Dual-spectrum metering — ring taps are always written (2 adds/sample),
    // but FFT/memory only materialise on first enable and nothing is posted
    // while gated, so a closed panel costs no analysis work.
    this.metersOn = false;
    this.dryWin = new Float32Array(FFT_SIZE);
    this.wetWin = new Float32Array(FFT_SIZE);
    this.anPos = 0;
    this.anSamples = 0;
    this.anBlocks = 0;
    this.hann = null;
    this.fftRe = null;
    this.fftIm = null;
    this.bandBins = null;
    this.bandsOut = null;
    if (this.port) {
      this.port.onmessage = (event) => {
        const msg = event && event.data;
        if (msg && msg.type === "setMeters") {
          const on = !!msg.enabled;
          if (on && !this.hann) this.initAnalysis();
          this.metersOn = on;
        }
      };
    }
  }

  /** Lazily materialise analysis tables (called on first meters enable). */
  initAnalysis() {
    this.hann = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / FFT_SIZE);
    }
    this.fftRe = new Float32Array(FFT_SIZE);
    this.fftIm = new Float32Array(FFT_SIZE);
    // Band → FFT-bin ranges at this context's rate. Bands are geometric
    // (20 Hz × 10^(b/72·3)). Below ~1 kHz a band is narrower than one FFT
    // bin: those bands SHARE that bin (monotonic floor/ceil edges keep the
    // mapping correct) — a "no bin reuse" clamp here would walk the low
    // bands onto progressively higher bins and wreck the geometry.
    this.bandBins = [];
    for (let b = 0; b < METER_BANDS; b++) {
      const lo = METER_F_MIN * Math.pow(METER_F_MAX / METER_F_MIN, b / METER_BANDS);
      const hi = METER_F_MIN * Math.pow(METER_F_MAX / METER_F_MIN, (b + 1) / METER_BANDS);
      let b0 = Math.max(1, Math.floor((lo * FFT_SIZE) / this.sr));
      let b1 = Math.min(FFT_HALF - 1, Math.ceil((hi * FFT_SIZE) / this.sr) - 1);
      if (b1 < b0) b1 = b0;
      this.bandBins.push([b0, b1]);
    }
    this.bandsOut = new Float32Array(METER_BANDS * 2);
  }

  /** In-place iterative radix-2 FFT (n a power of two). */
  runFft(re, im, n) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -TWO_PI / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const half = len >> 1;
      for (let base = 0; base < n; base += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < half; k++) {
          const ar = re[base + k];
          const ai = im[base + k];
          const br = re[base + k + half] * cr - im[base + k + half] * ci;
          const bi = re[base + k + half] * ci + im[base + k + half] * cr;
          re[base + k] = ar + br;
          im[base + k] = ai + bi;
          re[base + k + half] = ar - br;
          im[base + k + half] = ai - bi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  /** Fold a spectrum into log bands (dB) at `off` in `out`. Hann coherent
   *  gain is n/2, so a full-scale tone lands ≈ 0 dB (±1.4 dB scallop). */
  foldToBands(re, im, out, off) {
    for (let b = 0; b < METER_BANDS; b++) {
      const range = this.bandBins[b];
      let energy = 0;
      let count = 0;
      for (let k = range[0]; k <= range[1]; k++) {
        energy += re[k] * re[k] + im[k] * im[k];
        count++;
      }
      const amp = count > 0 ? (4 * Math.sqrt(energy / count)) / FFT_SIZE : 0;
      const db = 20 * Math.log10(amp + 1e-9);
      out[off + b] = db < METER_DB_FLOOR ? METER_DB_FLOOR : db > 0 ? 0 : db;
    }
  }

  analyze() {
    if (!this.hann || !this.port) return;
    const out = this.bandsOut;
    const re = this.fftRe;
    const im = this.fftIm;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this.anPos + i) & (FFT_SIZE - 1);
      re[i] = this.dryWin[idx] * this.hann[i];
      im[i] = 0;
    }
    this.runFft(re, im, FFT_SIZE);
    this.foldToBands(re, im, out, 0);
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this.anPos + i) & (FFT_SIZE - 1);
      re[i] = this.wetWin[idx] * this.hann[i];
      im[i] = 0;
    }
    this.runFft(re, im, FFT_SIZE);
    this.foldToBands(re, im, out, METER_BANDS);
    this.port.postMessage({ type: "meters", bands: out }, [out.buffer]);
    this.bandsOut = new Float32Array(METER_BANDS * 2); // previous buffer was transferred
  }

  makeBiquad() {
    return { x1: 0, x2: 0, y1: 0, y2: 0 };
  }

  lpCoeffs(freq, sr) {
    const w0 = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 / Math.SQRT2);
    const a0 = 1 + alpha;
    return {
      b0: (1 - cos) / 2 / a0,
      b1: (1 - cos) / 1 / a0,
      b2: (1 - cos) / 2 / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  hpCoeffs(freq, sr) {
    const w0 = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 / Math.SQRT2);
    const a0 = 1 + alpha;
    return {
      b0: (1 + cos) / 2 / a0,
      b1: -(1 + cos) / a0,
      b2: (1 + cos) / 2 / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  applyBiquad(state, coeffs, x) {
    const y = coeffs.b0 * x + coeffs.b1 * state.x1 + coeffs.b2 * state.x2 - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
    state.x2 = state.x1;
    state.x1 = x;
    state.y2 = state.y1;
    const clean = Math.abs(y) < 1e-20 ? 0 : y;
    state.y1 = clean;
    return clean;
  }

  /** Cubic-hermite read from a ring buffer at a fractional position
   *  (4-point, 3rd order — clean under fast delay-time modulation). */
  readBuffer(buf, pos) {
    const size = this.bufSize;
    let p = pos % size;
    if (p < 0) p += size;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const im1 = (i0 + size - 1) % size;
    const i1 = (i0 + 1) % size;
    const i2 = (i0 + 2) % size;
    const xm1 = buf[im1],
      x0 = buf[i0],
      x1 = buf[i1],
      x2 = buf[i2];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * frac + c2) * frac + c1) * frac + x0;
  }

  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const input = inputs[0];
    const hasInput = input && input[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];

    // ── Resolve delay time (sync or free) ──
    const timeMs = params.time[0];
    const sync = Math.round(params.sync[0]);
    const bpm = params.bpm[0];
    if (sync !== this._lastSync || bpm !== this._lastBpm || timeMs !== this._lastTimeMs) {
      this._lastSync = sync;
      this._lastBpm = bpm;
      this._lastTimeMs = timeMs;
      if (sync > 0 && sync < SYNC_RATIO.length) {
        this.delaySamples = Math.min(this.bufSize - 1, Math.max(1, SYNC_RATIO[sync] * (60 / bpm) * this.sr));
      } else {
        this.delaySamples = Math.min(this.bufSize - 1, Math.max(1, (timeMs / 1000) * this.sr));
      }
    }

    // ── Update biquads when tone freq changes ──
    const toneLpHz = params.toneLp[0];
    const toneHpHz = params.toneHp[0];
    if (toneLpHz !== this._lastToneLp) {
      this._lastToneLp = toneLpHz;
      this.lpL1c = this.lpCoeffs(toneLpHz, this.sr);
      this.lpR1c = this.lpCoeffs(toneLpHz, this.sr);
    }
    if (toneHpHz !== this._lastToneHp) {
      this._lastToneHp = toneHpHz;
      this.hpL1c = this.hpCoeffs(toneHpHz, this.sr);
      this.hpR1c = this.hpCoeffs(toneHpHz, this.sr);
    }

    // ── Cache scalar params ──
    this.pingPong = params.pingPong[0] > 0.5;
    this.fbGain = params.feedback[0];
    this.drive = params.drive[0];
    this.spread = params.spread[0];
    this.freeze = params.freeze[0] > 0.5;
    this.character = Math.round(params.character[0]);
    this.mix = params.mix[0];
    this.outGain = Math.pow(10, params.level[0] / 20);
    this.modDepthMs = params.modDepth[0] * this.delaySamples * 0.25;

    const pingPong = this.pingPong;
    const fbGain = this.fbGain;
    const drive = this.drive;
    const driveGain = 1 + drive * 2; // unity small-signal: tanh(x·g)/g
    const mix = this.mix;
    const spread = this.spread;
    const modDepthMs = this.modDepthMs;
    const modRateInc = (TWO_PI * params.modRate[0]) / this.sr;
    const character = this.character;

    // Tape wow (character 1): fixed slow LFOs, ±0.5 ms ≈ ±2 cents — subtle
    // pitch shimmer per repeat, independent of the MOD knob.
    const wobbleAmp = character === 1 ? 0.0005 * this.sr : 0;
    const wobRateInc = (TWO_PI * 0.7) / this.sr;

    const L = this.bufL,
      R = this.bufR;
    const size = this.bufSize;

    for (let i = 0; i < outL.length; i++) {
      const writeIdx = this.writePos;

      // LFO modulated delay time (pitch drift, click-free fractional read)
      const lfo = Math.sin(this.lfoPhase);
      this.lfoPhase += modRateInc;
      if (this.lfoPhase > TWO_PI) this.lfoPhase -= TWO_PI;
      const delayPos = this.delaySamples + lfo * modDepthMs;

      // Tape wow: independent slow LFOs per channel
      let wobL = 0;
      let wobR = 0;
      if (wobbleAmp > 0) {
        this.wobPhaseL += wobRateInc;
        this.wobPhaseR += wobRateInc;
        if (this.wobPhaseL > TWO_PI) this.wobPhaseL -= TWO_PI;
        if (this.wobPhaseR > TWO_PI) this.wobPhaseR -= TWO_PI;
        wobL = Math.sin(this.wobPhaseL) * wobbleAmp;
        wobR = Math.sin(this.wobPhaseR) * wobbleAmp;
      }

      // Fractional reads (cubic hermite)
      let wetL = this.readBuffer(L, writeIdx - delayPos - wobL);
      let wetR = this.readBuffer(R, writeIdx - delayPos - wobR);

      // One-pole DC block
      let dc = wetL - this.dcxL + this.dcCoef * this.dcyL;
      this.dcxL = wetL;
      this.dcyL = dc;
      wetL = dc;
      dc = wetR - this.dcxR + this.dcCoef * this.dcyR;
      this.dcxR = wetR;
      this.dcyR = dc;
      wetR = dc;

      // Character colour (per-repeat darkening in feedback)
      if (character === 1) {
        // Tape: one-pole LP + mild saturation
        this.charLpz += this.charLpCoef * (wetL - this.charLpz);
        this.charRpz += this.charLpCoef * (wetR - this.charRpz);
        wetL = this.charLpz;
        wetR = this.charRpz;
      } else if (character === 2) {
        // Analog: darker, more lossy
        this.charLpz += this.charLpCoef * (wetL - this.charLpz);
        this.charRpz += this.charLpCoef * (wetR - this.charRpz);
        wetL = this.charLpz * 0.9;
        wetR = this.charRpz * 0.9;
      }

      // Loop EQ: LP 24 dB/oct then HP 24 dB/oct (per channel)
      wetL = this.applyBiquad(this.lp1L, this.lpL1c, wetL);
      wetL = this.applyBiquad(this.lp2L, this.lpL1c, wetL);
      wetL = this.applyBiquad(this.hp1L, this.hpL1c, wetL);
      wetL = this.applyBiquad(this.hp2L, this.hpL1c, wetL);
      wetR = this.applyBiquad(this.lp1R, this.lpR1c, wetR);
      wetR = this.applyBiquad(this.lp2R, this.lpR1c, wetR);
      wetR = this.applyBiquad(this.hp1R, this.hpR1c, wetR);
      wetR = this.applyBiquad(this.hp2R, this.hpR1c, wetR);

      // Drive in feedback (tanh saturation, unity small-signal gain —
      // loop gain stays ≤ FEEDBK at every amplitude, no self-oscillation)
      if (drive > 0) {
        wetL = Math.tanh(wetL * driveGain) / driveGain;
        wetR = Math.tanh(wetR * driveGain) / driveGain;
      }

      // Ping-pong crossfeed
      const fbL = pingPong ? wetR : wetL;
      const fbR = pingPong ? wetL : wetR;

      // Write to ring buffer: input + feedback. Freeze seals the input out
      // and loops the processed wet back at 0.99 (self-limiting infinite
      // repeat — every loop element is contractive, so it decays, not grows).
      const inL = hasInput ? input[0][i] : 0;
      const inR = hasInput && input[1] ? input[1][i] : inL;
      if (this.freeze) {
        L[writeIdx] = fbL * 0.99;
        R[writeIdx] = fbR * 0.99;
      } else {
        L[writeIdx] = inL + fbL * fbGain;
        R[writeIdx] = inR + fbR * fbGain;
      }

      // Stereo spread (cross-mix for width)
      const outWL = wetL + spread * 0.5 * (wetR - wetL);
      const outWR = wetR + spread * 0.5 * (wetL - wetR);

      // Output: dry + wet (mix)
      outL[i] = inL * (1 - mix) + outWL * mix * this.outGain;
      outR[i] = inR * (1 - mix) + outWR * mix * this.outGain;

      // Spectrum taps (dry = mono input, wet = delay bus pre-mix/pre-level)
      this.dryWin[this.anPos] = (inL + inR) * 0.5;
      this.wetWin[this.anPos] = (outWL + outWR) * 0.5;
      this.anPos = (this.anPos + 1) & (FFT_SIZE - 1);

      this.writePos = (writeIdx + 1) % size;
    }

    // ── Dual-spectrum analysis (~30 Hz while a panel is attached) ──
    if (this.metersOn) {
      this.anSamples += outL.length;
      if (this.anSamples >= FFT_SIZE) {
        this.anBlocks++;
        if (this.anBlocks >= ANALYSIS_EVERY_BLOCKS) {
          this.anBlocks = 0;
          this.analyze();
        }
      }
    }

    return true;
  }
}

registerProcessor("kaskada", KaskadaProcessor);
