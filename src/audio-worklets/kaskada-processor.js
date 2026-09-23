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
 * posted ~30×/s as one Float32Array(176) (dry 0–71, wet 72–143, dB;
 * unmask reduction profile 144–175, 0…12 dB positive).
 * The analysis shares the audio thread, so the gate must be enforced end
 * to end: the worklet also refuses messages after a disable. */
const FFT_SIZE = 2048;
const FFT_HALF = FFT_SIZE >> 1;
const METER_BANDS = 72;
const METER_F_MIN = 20;
const METER_F_MAX = 20000;
const METER_DB_FLOOR = -90;
const ANALYSIS_EVERY_BLOCKS = 11; // ≈33 ms at 44.1/48 kHz

/* ── Unmask solver (32-band adaptive spectral ducking) ──
 * Port of the VocalForge Kaskáda M3 solver (Ultina masking pattern,
 * inverted): reference = the DRY input (what must stay audible),
 * target = the DELAY bus output (what gets carved away).
 *
 *   analysis: 32 log-spaced bandpass biquads + envelope followers on the
 *             MONO-SUMMED dry and delay signals, every sample (ms-scale
 *             attack needs fresh envelopes)
 *   masking:  dryDb − wetDb over the sensitivity threshold → proportional
 *             gain reduction capped at 12 dB, scaled by AMOUNT
 *   apply:    per-sample attack (deepening) / release (recovering)
 *             smoothing, applied through ACTIVE peaking bells only
 *             (Q 2.5, coefficients refreshed every 64 samples)
 *   safety:   wet-activity guard (gains never linger on a silent delay
 *             band — they would damage later echoes), psychoacoustic
 *             masker floor (a dry band below ≈ −60 dB never masks —
 *             echoes ring free in pauses), silence guard
 *
 * The bells act on the OUTPUT branch only (post spread, pre mix/level) —
 * the feedback loop stays untouched, so echo timing and per-repeat decay
 * are exactly as with the solver off. Power off bypasses 1:1 and decays
 * the smoothed gains so re-enabling never jumps. No added latency. */
const UM_BANDS = 32;
const UM_MAX_RED_DB = 12;
const UM_BELL_Q = 2.5;
const UM_ANALYSIS_Q = 3;
const UM_ANALYSIS_ENV_MS = 5;
const UM_CHUNK = 64; // bell coefficient refresh cadence (~1.4 ms @ 44.1k)
const UM_SILENCE = 1e-9;
const UM_WET_GUARD = 1e-6; // ≈ −120 dB — a silent delay band is never ducked
const UM_MASKER_FLOOR = 1e-3; // ≈ −60 dB — an inaudible masker masks nothing
const UM_FREQS = (() => {
  const logMin = Math.log(40);
  const logMax = Math.log(16000);
  const out = new Float32Array(UM_BANDS);
  for (let i = 0; i < UM_BANDS; i++) {
    out[i] = Math.exp(logMin + (i / (UM_BANDS - 1)) * (logMax - logMin));
  }
  return out;
})();

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
      { name: "bpm", defaultValue: 120, minValue: 20, maxValue: 300, automationRate: "k-rate" },
      { name: "pingPong", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "reverse", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0.35, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
      { name: "toneLp", defaultValue: 4500, minValue: 500, maxValue: 12000, automationRate: "k-rate" },
      { name: "toneHp", defaultValue: 150, minValue: 20, maxValue: 800, automationRate: "k-rate" },
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "modRate", defaultValue: 0.6, minValue: 0.1, maxValue: 8, automationRate: "k-rate" },
      { name: "modDepth", defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "spread", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "freeze", defaultValue: 0, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "unmaskOn", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "unmask", defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "unmaskSens", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "unmaskAtk", defaultValue: 5, minValue: 0.1, maxValue: 100, automationRate: "k-rate" },
      { name: "unmaskRel", defaultValue: 250, minValue: 10, maxValue: 2000, automationRate: "k-rate" },
      { name: "character", defaultValue: 1, minValue: 0, maxValue: 4, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "soloWet", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "deltaListen", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    // REVERSE mode: per-sample sweep phase over the echo window (newest
    // sample first, wrapping at the modulated delay time). The anchor is
    // the write head position captured at each period wrap — the read
    // then walks BACKWARD through the buffer.
    this.revPhase = 0;
    this.revAnchor = 0;

    // FREEZE HOLD (freeze 2): sample-and-hold capture of one echo period.
    // holdStart/holdLen delimit the captured window [start-len, start);
    // while active nothing is written and the loop states stay frozen.
    this.holdActive = false;
    this.holdAnchorL = 0;
    this.holdAnchorR = 0;
    this.holdLen = 64;
    this.holdPhase = 0;
    this._lastFreezeMode = -1;

    // Character 3 — magnetic drum: darker head loss, constant gentle
    // saturation, amplitude wobble at the rotation rate (~6.25 Hz).
    this.drumLpCoef = 1 - Math.exp((-2 * Math.PI * 2500) / this.sr);
    this.drumRateInc = (TWO_PI * 6.25) / this.sr;
    this.drumPhaseL = 0;
    this.drumPhaseR = Math.PI / 3;

    // Character 4 — diffusion network: two Schroeder allpasses per channel
    // (5 + 53 samples, g 0.55). Each pass through the feedback loop
    // smears the echo further — repeats blur into a wash.
    this.diff1L = new Float32Array(5);
    this.diff1R = new Float32Array(5);
    this.diff2L = new Float32Array(53);
    this.diff2R = new Float32Array(53);
    this.dfp1L = 0;
    this.dfp1R = 0;
    this.dfp2L = 0;
    this.dfp2R = 0;

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

    // ── Unmask solver state ──
    this.umPower = false;
    this.umAmount = 0.6;
    this.umThresholdDb = -15;
    this.umAtkCoef = 1;
    this.umRelCoef = 1;
    this.umChunk = 0;
    this.umOutL = 0;
    this.umOutR = 0;
    this.umSettled = true; // power off AND every smoothed gain already 0
    this.umApplyBells = false; // power-off fade still shaping the signal
    this.umAnalysisCoef = 1 - Math.exp(-1000 / (UM_ANALYSIS_ENV_MS * this.sr));
    this.umDryEnv = new Float32Array(UM_BANDS);
    this.umWetEnv = new Float32Array(UM_BANDS);
    this.umGainDb = new Float32Array(UM_BANDS); // smoothed reduction, negative dB
    this.umRedOut = new Float32Array(UM_BANDS); // positive dB, meters copy
    this.umActiveList = [];
    this.umDryA = [];
    this.umWetA = [];
    this.umBells = [];
    for (let b = 0; b < UM_BANDS; b++) {
      const dryBq = this.makeUmBiquad(1);
      const wetBq = this.makeUmBiquad(1);
      const bell = this.makeUmBiquad(2);
      this.umBandpass(dryBq, UM_FREQS[b], UM_ANALYSIS_Q);
      this.umBandpass(wetBq, UM_FREQS[b], UM_ANALYSIS_Q);
      this.umBell(bell, UM_FREQS[b], 0, UM_BELL_Q);
      this.umDryA.push(dryBq);
      this.umWetA.push(wetBq);
      this.umBells.push(bell);
    }

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
    this.bandsOut = new Float32Array(METER_BANDS * 2 + UM_BANDS);
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
    // Unmask reduction profile (positive dB) rides at the tail of the frame.
    const gainDb = this.umGainDb;
    const redOut = this.umRedOut;
    for (let b = 0; b < UM_BANDS; b++) redOut[b] = -gainDb[b] || 0; // `|| 0` normalises -0
    out.set(redOut, 2 * METER_BANDS);
    this.port.postMessage({ type: "meters", bands: out }, [out.buffer]);
    this.bandsOut = new Float32Array(METER_BANDS * 2 + UM_BANDS); // previous buffer was transferred
  }

  /* ── Unmask solver ── */

  /** Transposed direct-form II biquad (reference dsp/biquad.ts pattern):
   *  two states per channel, coefficient set held outside the hot path. */
  makeUmBiquad(channels) {
    return {
      b0: 1,
      b1: 0,
      b2: 0,
      a1: 0,
      a2: 0,
      z1: new Float32Array(channels),
      z2: new Float32Array(channels),
    };
  }

  /** RBJ bandpass, constant 0 dB peak gain. */
  umBandpass(bq, freq, q) {
    const w = (TWO_PI * Math.min(freq, this.sr / 2 - 1)) / this.sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    bq.b0 = alpha / a0;
    bq.b1 = 0;
    bq.b2 = -alpha / a0;
    bq.a1 = (-2 * cw) / a0;
    bq.a2 = (1 - alpha) / a0;
  }

  /** RBJ peaking EQ (the carving bell). */
  umBell(bq, freq, gainDb, q) {
    const w = (TWO_PI * Math.min(freq, this.sr / 2 - 1)) / this.sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a = Math.pow(10, gainDb / 40);
    const a0 = 1 + alpha / a;
    bq.b0 = (1 + alpha * a) / a0;
    bq.b1 = (-2 * cw) / a0;
    bq.b2 = (1 - alpha * a) / a0;
    bq.a1 = (-2 * cw) / a0;
    bq.a2 = (1 - alpha / a) / a0;
  }

  umSample(bq, ch, x) {
    const y = bq.b0 * x + bq.z1[ch];
    bq.z1[ch] = bq.b1 * x - bq.a1 * y + bq.z2[ch];
    bq.z2[ch] = bq.b2 * x - bq.a2 * y;
    return y < 1e-20 && y > -1e-20 ? 0 : y; // denormal flush
  }

  /** Refresh the active-band list + bell gains (chunk cadence) — only
   *  bands with meaningful reduction carry a bell in the hot path. */
  umRefreshBells() {
    this.umActiveList.length = 0;
    for (let b = 0; b < UM_BANDS; b++) {
      const g = this.umGainDb[b];
      if (g < -0.01) {
        this.umBell(this.umBells[b], UM_FREQS[b], g, UM_BELL_Q);
        this.umActiveList.push(b);
      }
    }
  }

  /** One sample of the solver: mono-summed analysis → per-band masking →
   *  smoothed gains → series bells on the wet stereo pair. Results land
   *  in umOutL/umOutR (identical to the wet inputs when nothing is
   *  reduced). */
  umProcessSample(refL, refR, wetL, wetR) {
    const refMono = (refL + refR) * 0.5;
    const wetMono = (wetL + wetR) * 0.5;

    // Analysis: bandpass banks + envelope followers (every sample)
    const envCoef = this.umAnalysisCoef;
    const dryA = this.umDryA;
    const wetA = this.umWetA;
    const dryEnv = this.umDryEnv;
    const wetEnv = this.umWetEnv;
    for (let b = 0; b < UM_BANDS; b++) {
      const dryY = this.umSample(dryA[b], 0, refMono);
      const absDry = dryY < 0 ? -dryY : dryY;
      dryEnv[b] += envCoef * (absDry - dryEnv[b]);

      const wetY = this.umSample(wetA[b], 0, wetMono);
      const absWet = wetY < 0 ? -wetY : wetY;
      wetEnv[b] += envCoef * (absWet - wetEnv[b]);

      // A poisoned recursion must not persist.
      if (!Number.isFinite(dryEnv[b]) || !Number.isFinite(wetEnv[b])) {
        dryEnv[b] = 0;
        wetEnv[b] = 0;
      }
    }

    // Per-band masking → target gains → attack (deepen) / release (recover)
    const threshold = this.umThresholdDb;
    const amount = this.umAmount;
    const gainDb = this.umGainDb;
    let maxRed = 0;
    for (let b = 0; b < UM_BANDS; b++) {
      const dryAmp = dryEnv[b];
      const wetAmp = wetEnv[b];
      const dryDb = dryAmp < 1e-10 ? -200 : 20 * Math.log10(dryAmp);
      const wetDb = wetAmp < 1e-10 ? -200 : 20 * Math.log10(wetAmp);
      const maskingDb = dryAmp < UM_SILENCE && wetAmp < UM_SILENCE ? -200 : dryDb - wetDb;

      let target = 0;
      if (
        wetAmp > UM_WET_GUARD && // nothing to duck in a silent delay band
        dryAmp > UM_MASKER_FLOOR && // a quiet masker masks nothing
        maskingDb > threshold
      ) {
        target = -Math.min((maskingDb - threshold) * amount, UM_MAX_RED_DB);
      }

      const cur = gainDb[b];
      const coef = target < cur ? this.umAtkCoef : this.umRelCoef;
      const next = cur + coef * (target - cur);
      gainDb[b] = next;

      const red = -next;
      if (red > maxRed) maxRed = red;
    }
    this.umMaxRedDb = maxRed;

    // Application: chunked bell refresh + series chain on L/R
    this.umApplyBells = maxRed > 0.01;
    this.umApplyBellsTo(wetL, wetR);
  }

  /** Power-off path: bypass 1:1 while the smoothed gains decay to zero so
   *  re-enabling never jumps. Fully settled → the flag skips the loop.
   *
   *  The old clamp `next > -1e-6 || next < 1e-6 ? 0 : next` was always
   *  true (any number is either > -1e-6 or < 1e-6), so the very first
   *  power-off block zeroed every gain — a full-amplitude step (audible
   *  click on the UNMASK toggle). The correct near-zero test is a
   *  magnitude check. */
  /** Power-off as a per-sample step: the old power-off bypassed the bell
   *  chain instantly (a hard amplitude step wherever the solver was
   *  reducing), and separately zeroed every gain in one block. Both are
   *  audible clicks. Here the gains keep decaying through the SAME
   *  attack/release smoother the powered path uses, and the bells keep
   *  shaping the signal while any gain is non-negligible — so the
   *  reduction fades out smoothly, then the chain is skipped entirely. */
  umPowerOffSample() {
    if (this.umSettled) {
      this.umMaxRedDb = 0;
      return;
    }
    const gainDb = this.umGainDb;
    const coef = this.umRelCoef;
    let settled = true;
    let maxRed = 0;
    for (let b = 0; b < UM_BANDS; b++) {
      const cur = gainDb[b];
      if (cur !== 0) {
        const next = cur + coef * (0 - cur);
        gainDb[b] = Math.abs(next) < 1e-4 ? 0 : next;
        if (gainDb[b] !== 0) settled = false;
        const red = -gainDb[b];
        if (red > maxRed) maxRed = red;
      }
    }
    this.umMaxRedDb = maxRed;
    this.umSettled = settled;
    this.umApplyBells = maxRed > 0.01;
  }

  /** Apply the current bell chain to one wet sample (shared by the
   *  powered and power-off paths so the fade-out is phase-continuous). */
  umApplyBellsTo(wetL, wetR) {
    let yL = wetL;
    let yR = wetR;
    if (this.umApplyBells) {
      if (this.umChunk === 0) this.umRefreshBells();
      this.umChunk = (this.umChunk + 1) % UM_CHUNK;
      const active = this.umActiveList;
      const bells = this.umBells;
      for (let i = 0; i < active.length; i++) {
        const bq = bells[active[i]];
        yL = this.umSample(bq, 0, yL);
        yR = this.umSample(bq, 1, yR);
      }
    }
    if (!Number.isFinite(yL) || !Number.isFinite(yR)) {
      yL = 0;
      yR = 0;
    }
    this.umOutL = yL;
    this.umOutR = yR;
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
    this.character = Math.round(params.character[0]);
    this.modDepthMs = params.modDepth[0] * this.delaySamples * 0.25;
    // FREEZE modes: 0 off · 1 loop (write-back at 0.99) · 2 hold (sample-
    // and-hold of one captured echo period). Entering 2 snapshots the
    // current tail window; while held, nothing is written at all.
    const freezeMode = Math.round(params.freeze[0]);
    if (freezeMode === 2 && this._lastFreezeMode !== 2) {
      // HOLD captures ONE full echo period. The old `bufSize >> 1` cap
      // truncated every TIME above 1 s (bufSize ≈ 2 s + 1) to a
      // non-periodic fragment — the loop then clicked and the repeat
      // rhythm was wrong. The ring always holds a full period
      // (delaySamples is clamped to bufSize-1), so clamp only against
      // the buffer, not against half of it.
      this.holdLen = Math.min(this.bufSize - 1, Math.max(64, this.delaySamples));
      // Anchor the captured window at the CURRENT modulated tap instead
      // of the unmodulated period start: entering HOLD mid-modulation no
      // longer jumps the read pointer by the full LFO/wow offset (the
      // old raw read also ignored the wow, so character 1 clicked on
      // every freeze). The window is [anchor - holdLen, anchor), so
      // playback walks chronologically and the live tap resumes exactly
      // at the anchor on unfreeze.
      const captureWobble = this.character === 1 ? 0.0005 * this.sr : 0;
      const captureWobRate = (TWO_PI * 0.7) / this.sr;
      // The live path advances the wow phases before its first read this
      // block; mirror that so the anchor is the exact position the live
      // tap would have used.
      if (captureWobble > 0) {
        this.wobPhaseL += captureWobRate;
        this.wobPhaseR += captureWobRate;
      }
      const lfoNow = Math.sin(this.lfoPhase) * this.modDepthMs;
      const wobNowL = captureWobble > 0 ? Math.sin(this.wobPhaseL) * captureWobble : 0;
      const wobNowR = captureWobble > 0 ? Math.sin(this.wobPhaseR) * captureWobble : 0;
      this.holdAnchorL = this.writePos - this.delaySamples - lfoNow - wobNowL;
      this.holdAnchorR = this.writePos - this.delaySamples - lfoNow - wobNowR;
      this.holdPhase = 0;
    }
    this._lastFreezeMode = freezeMode;
    this.holdActive = freezeMode === 2;
    this.freeze = freezeMode === 1;
    this.mix = params.mix[0];
    this.soloWet = params.soloWet[0] > 0.5;
    this.deltaListen = params.deltaListen[0] > 0.5;
    this.outGain = Math.pow(10, params.level[0] / 20);

    // ── Unmask targets (k-rate; sensitivity → threshold: 0→+6 dB, 0.5→−15, 1→−36) ──
    this.umPower = params.unmaskOn[0] > 0.5;
    if (this.umPower) this.umSettled = false;
    this.umAmount = params.unmask[0];
    this.umThresholdDb = 6 - 42 * params.unmaskSens[0];
    this.umAtkCoef = 1 - Math.exp(-1000 / (Math.max(0.01, params.unmaskAtk[0]) * this.sr));
    this.umRelCoef = 1 - Math.exp(-1000 / (Math.max(0.01, params.unmaskRel[0]) * this.sr));

    const pingPong = this.pingPong;
    const fbGain = this.fbGain;
    const drive = this.drive;
    const driveGain = 1 + drive * 2; // unity small-signal: tanh(x·g)/g
    const mix = this.mix;
    const spread = this.spread;
    const modDepthMs = this.modDepthMs;
    const modRateInc = (TWO_PI * params.modRate[0]) / this.sr;
    const character = this.character;
    const reverse = params.reverse[0] > 0.5;
    const dryGain = this.soloWet ? 0 : 1 - mix;
    const hSideGain = spread * 0.5;
    const drumRateInc = this.drumRateInc;

    // Tape wow (character 1): fixed slow LFOs, ±0.5 ms ≈ ±2 cents — subtle
    // pitch shimmer per repeat, independent of the MOD knob.
    const wobbleAmp = character === 1 ? 0.0005 * this.sr : 0;
    const wobRateInc = (TWO_PI * 0.7) / this.sr;

    const L = this.bufL,
      R = this.bufR;
    const size = this.bufSize;

    for (let i = 0; i < outL.length; i++) {
      const writeIdx = this.writePos;
      // A single non-finite sample used to poison the ring buffer forever:
      // readBuffer pulls it back, the loop EQ/drive/DC blocker all latch
      // NaN, and the plugin goes silent for the rest of its life. Sanitize
      // at the boundary — one branch per sample is far cheaper than an
      // unrecoverable track.
      let inL = hasInput ? input[0][i] : 0;
      let inR = hasInput && input[1] ? input[1][i] : inL;
      if (!Number.isFinite(inL)) inL = 0;
      if (!Number.isFinite(inR)) inR = 0;

      // ── FREEZE HOLD: loop the captured window, pristine (sample-and-hold)
      // Raw buffer reads — no loop EQ/character/drive, no DC block, no
      // write-back, loop states frozen. Unmask still shapes the output.
      if (this.holdActive) {
        const hp = this.holdPhase;
        this.holdPhase = hp + 1 >= this.holdLen ? 0 : hp + 1;
        // Chronological walk from the exact capture anchor — the window
        // is [anchor - holdLen, anchor) at the modulated positions the
        // live tap occupied, so freeze entry/exit are click-free and the
        // captured period is the full echo time (not a truncated half).
        const rpos = this.holdAnchorL + hp;
        const rpos2 = this.holdAnchorR + hp;
        const hL = this.readBuffer(L, rpos);
        const hR = this.readBuffer(R, rpos2);
        let hoL = hL + hSideGain * (hL - hR);
        let hoR = hR + hSideGain * (hR - hL);
        const preHoL = hoL;
        const preHoR = hoR;
        if (this.umPower) {
          this.umProcessSample(inL, inR, hoL, hoR);
          hoL = this.umOutL;
          hoR = this.umOutR;
        } else {
          this.umPowerOffSample();
          this.umApplyBellsTo(hoL, hoR);
          hoL = this.umOutL;
          hoR = this.umOutR;
        }
        if (this.deltaListen) {
          outL[i] = (preHoL - hoL) * this.outGain;
          outR[i] = (preHoR - hoR) * this.outGain;
        } else {
          outL[i] = (inL * dryGain + hoL * mix) * this.outGain;
          outR[i] = (inR * dryGain + hoR * mix) * this.outGain;
        }
        continue;
      }

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

      // Fractional reads. REVERSE sweeps each echo window newest→oldest
      // (segment reverse — the classic tape-flip artifact at the wrap is
      // part of the sound): the anchor freezes the head position at each
      // period wrap, then the read walks BACKWARD through the buffer.
      let wetL;
      let wetR;
      if (reverse) {
        this.revPhase += 1;
        if (this.revPhase >= delayPos) {
          this.revPhase = 0;
          this.revAnchor = writeIdx - 1;
        }
        const rpos = this.revAnchor - this.revPhase;
        wetL = this.readBuffer(L, rpos - wobL);
        wetR = this.readBuffer(R, rpos - wobR);
      } else {
        wetL = this.readBuffer(L, writeIdx - delayPos - wobL);
        wetR = this.readBuffer(R, writeIdx - delayPos - wobR);
      }

      // One-pole DC block (dcCoef ≈ 0.9994 — denormal decay is the slowest
      // in the fleet, so flush the state as it hits the subnormal range).
      let dc = wetL - this.dcxL + this.dcCoef * this.dcyL;
      this.dcxL = wetL;
      this.dcyL = dc;
      if (this.dcyL > -1e-20 && this.dcyL < 1e-20) this.dcyL = 0;
      wetL = dc;
      dc = wetR - this.dcxR + this.dcCoef * this.dcyR;
      this.dcxR = wetR;
      this.dcyR = dc;
      if (this.dcyR > -1e-20 && this.dcyR < 1e-20) this.dcyR = 0;
      wetR = dc;

      // Character colour (per-repeat darkening in feedback)
      if (character === 1) {
        // Tape: one-pole LP + mild saturation
        this.charLpz += this.charLpCoef * (wetL - this.charLpz);
        this.charRpz += this.charLpCoef * (wetR - this.charRpz);
        if (this.charLpz > -1e-20 && this.charLpz < 1e-20) this.charLpz = 0;
        if (this.charRpz > -1e-20 && this.charRpz < 1e-20) this.charRpz = 0;
        wetL = this.charLpz;
        wetR = this.charRpz;
      } else if (character === 2) {
        // Analog: darker, more lossy
        this.charLpz += this.charLpCoef * (wetL - this.charLpz);
        this.charRpz += this.charLpCoef * (wetR - this.charRpz);
        wetL = this.charLpz * 0.9;
        wetR = this.charRpz * 0.9;
      } else if (character === 3) {
        // Magnetic drum (tape-head-drum machines): darker head loss,
        // constant gentle saturation, ±1.5 % amplitude wobble at the
        // rotation rate (~6.25 Hz) — the "motor" feel.
        this.charLpz += this.drumLpCoef * (wetL - this.charLpz);
        this.charRpz += this.drumLpCoef * (wetR - this.charRpz);
        this.drumPhaseL += drumRateInc;
        this.drumPhaseR += drumRateInc;
        if (this.drumPhaseL > TWO_PI) this.drumPhaseL -= TWO_PI;
        if (this.drumPhaseR > TWO_PI) this.drumPhaseR -= TWO_PI;
        wetL = (Math.tanh(this.charLpz * 1.3) / 1.3) * (1 - 0.015 + 0.015 * Math.sin(this.drumPhaseL));
        wetR = (Math.tanh(this.charRpz * 1.3) / 1.3) * (1 - 0.015 + 0.015 * Math.sin(this.drumPhaseR));
      } else if (character === 4) {
        // Diffusion network: two Schroeder allpasses (5 + 53 samples,
        // g 0.55) smear each pass through the loop — repeats blur into
        // a wash while the dry path stays untouched.
        let p = this.dfp1L;
        let y = this.diff1L[p];
        this.diff1L[p] = wetL + 0.55 * y;
        wetL = y - 0.55 * wetL;
        this.dfp1L = (p + 1) % 5;
        p = this.dfp1R;
        y = this.diff1R[p];
        this.diff1R[p] = wetR + 0.55 * y;
        wetR = y - 0.55 * wetR;
        this.dfp1R = (p + 1) % 5;
        p = this.dfp2L;
        y = this.diff2L[p];
        this.diff2L[p] = wetL + 0.55 * y;
        wetL = y - 0.55 * wetL;
        this.dfp2L = (p + 1) % 53;
        p = this.dfp2R;
        y = this.diff2R[p];
        this.diff2R[p] = wetR + 0.55 * y;
        wetR = y - 0.55 * wetR;
        this.dfp2R = (p + 1) % 53;
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

      // Write to ring buffer: input + feedback. FREEZE LOOP seals the input
      // out and loops the processed wet back at 0.99 (self-limiting infinite
      // repeat — every loop element is contractive, so it decays, not grows).
      if (this.freeze) {
        L[writeIdx] = fbL * 0.99;
        R[writeIdx] = fbR * 0.99;
      } else {
        L[writeIdx] = inL + fbL * fbGain;
        R[writeIdx] = inR + fbR * fbGain;
      }

      // Stereo spread — M/S width on the wet bus.
      // Mid/side decode: M = (L+R)/2, S = (L-R)/2; widening applies a
      // side gain w > 1 → L' = M + w·S = L + (w-1)/2·(L-R), R' = R +
      // (w-1)/2·(R-L). The old code had the SIGN FLIPPED (it mixed
      // toward the mid signal), so the control *narrowed*: at spread 1
      // the output was pure mono, and the default 0.8 collapsed the
      // stereo image the ping-pong had just created. w = 1 + spread
      // maps 0 → neutral, 1 → 2× side. Correlated centre content stays
      // at unity gain (L' = L + g·(L-L) = L), so the knob doesn't jump
      // level as it widens.
      const sideGain = spread * 0.5;
      let outWL = wetL + sideGain * (wetL - wetR);
      let outWR = wetR + sideGain * (wetR - wetL);

      // Unmask: carve the delay bus where the dry masks it (output branch
      // only — the feedback loop above is untouched)
      const preWL = outWL;
      const preWR = outWR;
      if (this.umPower) {
        this.umProcessSample(inL, inR, outWL, outWR);
        outWL = this.umOutL;
        outWR = this.umOutR;
      } else {
        // Fade the reduction out through the same bell chain (no hard
        // bypass step) — see umPowerOffSample.
        this.umPowerOffSample();
        this.umApplyBellsTo(outWL, outWR);
        outWL = this.umOutL;
        outWR = this.umOutR;
      }

      if (this.deltaListen) {
        // DELTA monitor: output exactly what the solver removed
        // (pre-unmask wet − post-unmask wet), bypassing the mix law.
        outL[i] = (preWL - outWL) * this.outGain;
        outR[i] = (preWR - outWR) * this.outGain;
      } else {
        // Output: LEVEL scales the whole output (dry + wet), matching the
        // architecture diagram ("Output Gain → Output", §2) and every
        // sibling effect — the old wet-only gain made LEVEL silently
        // change the dry/wet balance instead of the output level (and go
        // fully inert at mix 0). SOLO W monitors the wet arm only.
        outL[i] = (inL * dryGain + outWL * mix) * this.outGain;
        outR[i] = (inR * dryGain + outWR * mix) * this.outGain;
      }

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
