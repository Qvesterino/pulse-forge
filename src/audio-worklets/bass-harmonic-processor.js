/**
 * KOREŇ (bassHarmonic) AudioWorkletProcessor — missing-fundamental bass
 * exciter.
 *
 * Takes a bass signal, tracks its fundamental with a control-rate YIN
 * detector, and synthesizes a harmonic stack (2nd/3rd-leaning, octave
 * `range`) driven by the low band's envelope. The wet path keeps the
 * original (high-passed at `lowCut`, scaled by `subAnchor`) and adds the
 * generated harmonics ON TOP — not a classic dry/wet, but "keep the sub,
 * add the harmonics" so a 55 Hz 808 reads on phone speakers.
 *
 * Detection runs on a DECIM=4 decimated copy of the 300 Hz one-pole
 * detection band (native control rate would pay 4× the YIN cost for no
 * useful resolution below ~440 Hz):
 *
 * 1. YIN tracker — the wave-1 zero-crossing-rate estimator octave-confused
 *    harmonic-rich basses (a 55 + 110 Hz signal read as 110 Hz and
 *    generated harmonics on the wrong root). The YIN cumulative-difference
 *    absolute-threshold pick with parabolic refinement (ported from
 *    pitchcorrect-processor.js) stays on the true fundamental; clarity
 *    gate 0.85. Search range is the focus window × [0.5, 2], floored at
 *    20 Hz — pitches outside it can never be tracked, so no invented
 *    harmonics.
 * 2. Phase coherence — on each accepted rising zero crossing of the
 *    detection band (spacing ≥ 0.45 × the tracked period; that rejects the
 *    extra edges of harmonic-rich waveforms) every active harmonic
 *    accumulator is nudged toward 0 phase (gain 0.5, clamped ±0.35 rad),
 *    so the generated layer stays phase-locked to the dry fundamental and
 *    reinforces it instead of beating against it.
 * 3. Deficit generation — Hann-windowed Goertzel magnitudes at f0/2f0/3f0
 *    over the decimated ring (LP-compensated) measure how much 2nd/3rd
 *    harmonic the input ALREADY carries; the generated 2nd/3rd — and, as
 *    an even-partial proxy, the higher stack — scale with the deficit
 *    against targets 0.35/0.30. An already-fat bass is not doubled, a pure
 *    sine gets the full stack.
 * 4. `character` (0 CLEAN / 1 SAT / 2 FOLD) shapes the GENERATED layer only
 *    (the sub anchor and dry stay untouched) — soft tanh saturation
 *    (≈unity small-signal gain) or a sine wavefolder for growl timbres.
 *
 * Parameter surface: plain AudioParams (M2 pattern, zenit-m2-nodes.ts) —
 * no port messages, so offline automation works natively via
 * setValueAtTime. All per-sample smoothing uses per-sample coefficients
 * (NEW-EFFECT-CHECKLIST §4). No RNG — deterministic.
 *
 * `mix = 0` is a bit-exact dry passthrough (`dry * 1 + wet * 0`).
 *
 * Served as its own lazy bundle: public/bass-harmonic-worklet.js
 * (scripts/build-bass-harmonic-worklet.mjs). Plain JavaScript only.
 */

const LP_HZ = 300; // detection-band one-pole corner
const DECIM = 4; // decimation factor for the YIN/Goertzel domain
const DETECT_HOP = 1024; // native samples between detector updates (~21 ms @48k)
const CLARITY_GATE = 0.85; // YIN confidence floor: monophonic bass only
const TRACK_MIN_HZ = 20; // absolute search floor
const DEFICIT_WIN = 2048; // Hann window for the deficit read (decimated samples)
const DEFICIT_TARGET2 = 0.35; // input 2nd-harmonic ratio that tapers generation to 0
const DEFICIT_TARGET3 = 0.3;
const DEFICIT_SMOOTH = 0.35; // per-update one-pole over the detection cadence
const PLL_GAIN = 0.5; // phase nudge per accepted crossing
const PLL_MAX_RAD = 0.35; // clamp on that nudge
const EDGE_MIN_FRAC = 0.45; // accepted rising-edge spacing vs the tracked period

/**
 * YIN-style pitch detection over the whole decimated ring (`bufLen` samples;
 * `writePos` points past the last written sample). Returns `{ hz, clarity }`
 * — hz 0 means "nothing confident". Same detector as pitchcorrect except the
 * search bounds come from the focus window; `scratch` ({x, d, nd}
 * Float32Arrays) is preallocated once per processor lifetime (no GC churn on
 * the audio thread).
 */
function yinDetect(buf, bufLen, writePos, rate, minHz, maxHz, scratch) {
  const windowW = bufLen;
  const maxLag = Math.min(Math.floor(rate / minHz), windowW - 64);
  const minLag = Math.max(2, Math.ceil(rate / maxHz));
  const m = windowW - maxLag; // correlation length
  if (m < 64) return { hz: 0, clarity: 0 };
  const x = scratch.x;
  const d = scratch.d;
  const nd = scratch.nd;

  let rms = 0;
  const start = writePos - windowW;
  for (let i = 0; i < windowW; i++) {
    let p = (start + i) % bufLen;
    if (p < 0) p += bufLen;
    const v = buf[p];
    x[i] = v;
    rms += v * v;
  }
  rms = Math.sqrt(rms / windowW);
  if (rms < 1e-4) return { hz: 0, clarity: 0 }; // silence — nothing to track

  // YIN difference function d(lag) = Σ (x[i] - x[i+lag])², i < m.
  let runningSum = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < m; i++) {
      const diff = x[i] - x[i + lag];
      sum += diff * diff;
    }
    d[lag] = sum;
    runningSum += sum;
  }
  if (runningSum <= 0) return { hz: 0, clarity: 0 };

  // Cumulative-mean-normalized difference (YIN step 3) — without it every
  // period multiple dips to zero and the pick lands an octave low.
  let cumulative = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    cumulative += d[lag];
    nd[lag] = cumulative > 0 ? (d[lag] * (lag - minLag + 1)) / cumulative : Infinity;
  }

  // Absolute-threshold pick: the SMALLEST lag under threshold = fundamental;
  // fall back to the global minimum. 0.05 measured on pure tones (see
  // pitchcorrect's detector notes).
  const THRESHOLD = 0.05;
  let picked = -1;
  let pickedValue = Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (nd[lag] < THRESHOLD) {
      picked = lag;
      pickedValue = nd[lag];
      break;
    }
    if (nd[lag] < pickedValue) pickedValue = nd[lag];
  }
  if (picked < 0) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (nd[lag] === pickedValue) {
        picked = lag;
        break;
      }
    }
  }
  if (picked < 0) return { hz: 0, clarity: 0 };
  const clarity = Math.max(0, Math.min(1, 1 - nd[picked]));

  // Parabolic interpolation centred on the LOCAL d minimum (the threshold
  // pick lands systematically before the true period).
  let center = picked;
  if (picked > minLag && d[picked - 1] < d[picked]) center = picked - 1;
  else if (picked < maxLag && d[picked + 1] < d[picked]) center = picked + 1;
  let lagF = center;
  if (center > minLag && center < maxLag) {
    const a = d[center - 1];
    const b = d[center];
    const c = d[center + 1];
    const denom = 2 * (2 * b - a - c);
    if (Math.abs(denom) > 1e-12) lagF = center + (c - a) / denom;
  }

  const hz = rate / lagF;
  if (hz < minHz || hz > maxHz) return { hz: 0, clarity: 0 };
  return { hz, clarity };
}

/** Goertzel magnitude at `hz` over the first `n` samples of `win`. */
function goertzelMag(win, n, hz, rate) {
  const w = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = win[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

class BassHarmonicProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "drive", minValue: 0, maxValue: 1, defaultValue: 0.45 },
      { name: "focusHz", minValue: 40, maxValue: 220, defaultValue: 90 },
      { name: "harmonics", minValue: 0, maxValue: 1, defaultValue: 0.5 },
      { name: "subAnchor", minValue: 0, maxValue: 1, defaultValue: 0.7 },
      { name: "lowCut", minValue: 20, maxValue: 200, defaultValue: 45 },
      { name: "range", minValue: 1, maxValue: 4, defaultValue: 2 },
      { name: "attack", minValue: 0.001, maxValue: 0.1, defaultValue: 0.008 },
      { name: "release", minValue: 0.01, maxValue: 1, defaultValue: 0.12 },
      { name: "character", minValue: 0, maxValue: 2, defaultValue: 0 },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 0.6 },
      { name: "output", minValue: -18, maxValue: 12, defaultValue: 0 },
    ];
  }

  constructor() {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sampleRate = sr;
    // Detection state (mono sum).
    this.lp = 0; // 300 Hz one-pole low band used for detection
    this.lastSign = 0;
    this.sinceCross = 0; // native samples since the last rising edge
    this.sincePll = 0; // native samples since the last ACCEPTED (locked) edge
    this.f0 = 0; // YIN-tracked fundamental (Hz); 0 = none
    this.untrackedPasses = 0; // consecutive failed detection passes
    this.envLow = 0; // fast low-band amplitude follower
    this.envGen = 0; // generator gain envelope
    // Decimated detection domain (YIN + deficit share one ring/window).
    this.decRate = sr / DECIM;
    this.decBufLen = Math.min(8192, Math.max(1024, Math.ceil((this.decRate / TRACK_MIN_HZ) * 2.5)));
    this.decBuf = new Float32Array(this.decBufLen);
    this.decWrite = 0;
    this.decCount = 0;
    this.detectSince = DETECT_HOP; // detect on the very first block end
    const maxLagWide = Math.min(Math.floor(this.decRate / TRACK_MIN_HZ), this.decBufLen - 64);
    this.yin = {
      x: new Float32Array(this.decBufLen),
      d: new Float32Array(maxLagWide + 1),
      nd: new Float32Array(maxLagWide + 1),
    };
    this.defWin = new Float32Array(Math.min(DEFICIT_WIN, this.decBufLen));
    this.deficit2 = 1; // generated 2nd-harmonic scale (1 = input has none)
    this.deficit3 = 1;
    // Per-channel one-pole HP state for the sub-anchor branch.
    this.hpY = [0, 0];
    this.hpX = [0, 0];
    // Phase accumulators for harmonics 2..N (index n, 0/1 unused).
    this.phase = new Float64Array(11);
    // Per-block harmonic weights (preallocated — no allocations in process()).
    this.weights = new Float64Array(11);
  }

  /** YIN + deficit update, control rate (once per DETECT_HOP native samples). */
  detect(focus) {
    const minHz = Math.max(TRACK_MIN_HZ, focus * 0.5);
    const maxHz = focus * 2;
    const result = yinDetect(this.decBuf, this.decBufLen, this.decWrite, this.decRate, minHz, maxHz, this.yin);
    if (result.hz > 0 && result.clarity >= CLARITY_GATE) {
      // One-pole smoothing: YIN re-locks at ~21 ms cadence; the generator's
      // PLL nudge absorbs the small residual frequency error per period.
      this.f0 = this.f0 > 0 ? this.f0 + 0.5 * (result.hz - this.f0) : result.hz;
      this.untrackedPasses = 0;
      this.updateDeficit(this.f0);
    } else {
      this.untrackedPasses++;
      // ~0.25 s of untracked audio releases the estimate (the generator's own
      // release envelope is the fast mute; this stops stale harmonics).
      if (this.untrackedPasses * DETECT_HOP > this.sampleRate * 0.25) this.f0 = 0;
    }
  }

  /** Harmonic-deficit read at the tracked fundamental (control rate). */
  updateDeficit(f0) {
    const n = this.defWin.length;
    const buf = this.decBuf;
    const bufLen = this.decBufLen;
    const start = this.decWrite - n;
    for (let i = 0; i < n; i++) {
      let p = (start + i) % bufLen;
      if (p < 0) p += bufLen;
      this.defWin[i] = buf[p] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
    }
    const win = this.defWin;
    const rate = this.decRate;
    // Undo the 300 Hz one-pole attenuation so the ratio compares pre-filter
    // amplitudes |H(f)| = 1/sqrt(1+(f/300)²).
    const c1 = Math.sqrt(1 + Math.pow(f0 / LP_HZ, 2));
    const mag1 = goertzelMag(win, n, f0, rate) * c1;
    if (mag1 < 1e-4) return; // nothing pitched in the band — keep current deficits
    const c2 = Math.sqrt(1 + Math.pow((f0 * 2) / LP_HZ, 2));
    const c3 = Math.sqrt(1 + Math.pow((f0 * 3) / LP_HZ, 2));
    const ratio2 = (goertzelMag(win, n, f0 * 2, rate) * c2) / mag1;
    const ratio3 = (goertzelMag(win, n, f0 * 3, rate) * c3) / mag1;
    const d2 = Math.max(0, Math.min(1, (DEFICIT_TARGET2 - ratio2) / DEFICIT_TARGET2));
    const d3 = Math.max(0, Math.min(1, (DEFICIT_TARGET3 - ratio3) / DEFICIT_TARGET3));
    this.deficit2 += DEFICIT_SMOOTH * (d2 - this.deficit2);
    this.deficit3 += DEFICIT_SMOOTH * (d3 - this.deficit3);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;
    const len = outL.length;
    const sr = globalThis.sampleRate || 44100;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const drive = clamp(parameters.drive[0], 0, 1);
    const focus = clamp(parameters.focusHz[0], 40, 220);
    const harmonics = clamp(parameters.harmonics[0], 0, 1);
    const subAnchor = clamp(parameters.subAnchor[0], 0, 1);
    const lowCut = clamp(parameters.lowCut[0], 20, 200);
    const range = clamp(parameters.range[0], 1, 4);
    const attack = clamp(parameters.attack[0], 0.001, 0.1);
    const release = clamp(parameters.release[0], 0.01, 1);
    const character = Math.round(clamp(parameters.character[0], 0, 2));
    const mix = clamp(parameters.mix[0], 0, 1);
    const outGain = Math.pow(10, clamp(parameters.output[0], -18, 12) / 20);

    // Per-sample coefficients (checklist §4: never a per-block blend of a
    // per-sample constant).
    const detLpCoef = 1 - Math.exp((-2 * Math.PI * LP_HZ) / sr);
    const envAtkCoef = 1 - Math.exp(-1 / (sr * 0.005));
    const envRelCoef = 1 - Math.exp(-1 / (sr * 0.03));
    const genAtkCoef = 1 - Math.exp(-1 / (sr * attack));
    const genRelCoef = 1 - Math.exp(-1 / (sr * release));
    const hpA = Math.exp((-2 * Math.PI * lowCut) / sr);

    // Harmonic stack: n = 2..N (N = 2^range capped at 10). Weight blend:
    // `harmonics` 0 → 2nd dominant, 1 → 3rd-lean; n ≥ 4 sit low.
    const count = Math.min(10, Math.max(2, Math.round(Math.pow(2, range))));
    const weights = this.weights;
    for (let n = 0; n <= 10; n++) weights[n] = 0;
    let norm = 0;
    for (let n = 2; n <= count; n++) {
      const w = n === 2 ? 1 - harmonics : n === 3 ? harmonics : 0.25 / (n - 1);
      weights[n] = w;
      norm += w;
    }
    const normScale = norm > 1e-9 ? 0.9 / norm : 0;
    // Deficit: the input's own partials taper the generated ones (normScale
    // stays on the raw stack — the leftover is headroom, not gain).
    for (let n = 2; n <= count; n++) {
      weights[n] *= n === 2 ? this.deficit2 : n === 3 ? this.deficit3 : this.deficit2;
    }
    const fMin = focus * 0.5;
    const fMax = focus * 2;
    const twoPi = 2 * Math.PI;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      const mono = (l + r) * 0.5;

      // --- fundamental detection (mono, ≤300 Hz band) -------------------
      this.lp += detLpCoef * (mono - this.lp);
      if (Math.abs(this.lp) < 1e-20) this.lp = 0;
      const absLp = Math.abs(this.lp);
      this.envLow += (absLp > this.envLow ? envAtkCoef : envRelCoef) * (absLp - this.envLow);
      if (this.envLow < 1e-20) this.envLow = 0;

      // Decimated write for the YIN ring.
      this.decCount++;
      if (this.decCount >= DECIM) {
        this.decCount = 0;
        this.decBuf[this.decWrite % this.decBufLen] = this.lp;
        this.decWrite++;
      }

      // --- rising-edge PLL (phase coherence with the dry fundamental) ---
      const sign = this.lp > 0.005 ? 1 : this.lp < -0.005 ? -1 : this.lastSign;
      this.sinceCross++;
      if (this.lastSign < 0 && sign > 0 && this.sinceCross >= 16) {
        if (this.f0 > 0 && this.sincePll >= (sr / this.f0) * EDGE_MIN_FRAC) {
          this.sincePll = 0;
          for (let n = 2; n <= count; n++) {
            let err = this.phase[n];
            if (err > Math.PI) err -= twoPi; // phase is kept in [0, 2π)
            if (err > PLL_MAX_RAD) err = PLL_MAX_RAD;
            else if (err < -PLL_MAX_RAD) err = -PLL_MAX_RAD;
            this.phase[n] -= err * PLL_GAIN;
            if (this.phase[n] < 0) this.phase[n] += twoPi;
          }
        }
        this.sinceCross = 0;
      } else if (this.sinceCross > sr / 20) {
        // Edge bookkeeping is bounded; pitch validity is YIN's job now.
        this.sinceCross = sr / 20;
      }
      this.sincePll++;
      this.lastSign = sign;

      const inWindow = this.f0 >= fMin && this.f0 <= fMax;

      // --- generator gain envelope --------------------------------------
      const genTarget = inWindow ? drive * this.envLow : 0;
      this.envGen += (genTarget > this.envGen ? genAtkCoef : genRelCoef) * (genTarget - this.envGen);
      if (this.envGen < 1e-20) this.envGen = 0;

      // --- phase-locked harmonic stack ----------------------------------
      let gen = 0;
      if (this.envGen > 1e-6 && this.f0 > 0) {
        for (let n = 2; n <= count; n++) {
          let p = this.phase[n] + (twoPi * n * this.f0) / sr;
          if (p >= twoPi) p -= twoPi * Math.floor(p / twoPi);
          this.phase[n] = p;
          gen += weights[n] * Math.sin(p);
        }
        gen *= normScale * this.envGen;
        // CHARACTER shapes the generated layer only.
        if (character === 1) gen = Math.tanh(gen * 2.2) / Math.tanh(2.2);
        else if (character === 2) gen = Math.sin(gen * 4.5) / 4.5;
      }
      if (!Number.isFinite(gen)) gen = 0;

      // --- sub-anchor branch: one-pole HP at lowCut per channel ---------
      const hpL = hpA * (this.hpY[0] + l - this.hpX[0]);
      const hpR = hpA * (this.hpY[1] + r - this.hpX[1]);
      this.hpX[0] = l;
      this.hpY[0] = Math.abs(hpL) < 1e-20 ? 0 : hpL;
      this.hpX[1] = r;
      this.hpY[1] = Math.abs(hpR) < 1e-20 ? 0 : hpR;

      const wetL = hpL * subAnchor + gen;
      const wetR = hpR * subAnchor + gen;
      let oL = (l * (1 - mix) + wetL * mix) * outGain;
      let oR = (r * (1 - mix) + wetR * mix) * outGain;
      // mix = 0 must stay bit-exact dry: dry * 1 + wet * 0. outGain at the
      // default 0 dB is exactly 1, so the sum reproduces the input sample.
      if (!Number.isFinite(oL)) oL = 0;
      if (!Number.isFinite(oR)) oR = 0;
      outL[i] = oL;
      if (outR) outR[i] = oR;
    }

    // Control-rate detector update (block end — the next block generates from
    // the fresh estimate).
    this.detectSince += len;
    if (this.detectSince >= DETECT_HOP) {
      this.detectSince = 0;
      this.detect(focus);
    }
    return true;
  }
}

registerProcessor("bass-harmonic-processor", BassHarmonicProcessor);
