/**
 * Pitch Correct AudioWorkletProcessor — real-time scale-snap pitch correction.
 *
 * Three stages, all inside the render callback (NO port messages — the
 * OfflineAudioContext contract, checklist #5):
 *
 * 1. DETECT (control rate): YIN-style normalized difference function over the
 *    last ANALYSIS_W samples of the mono ring buffer, every HOP samples
 *    (~21 ms). Picks the SMALLEST lag whose difference is near the global
 *    minimum (YIN's absolute-threshold trick — avoids the octave-below pick),
 *    parabolic-refined for sub-sample pitch. Gated on RMS + clarity.
 *
 * 2. SNAP (pure math): the detected frequency maps to the nearest allowed
 *    tone of the selected scale (root pitch class + mask); the error in
 *    cents, scaled by `amount`, becomes the correction. Clamped to ±CORRECT_LIMIT
 *    cents so an octave-confused detection can never grab wild intervals.
 *
 * 3. SHIFT: the same COLA dual-voice granular engine as the pitch
 *    shifter, reading at the correction ratio (1.0 = in tune = bit-clean
 *    passthrough of the granular sum). The two taps' read offsets are
 *    PHASE-LOCKED to whole multiples of the detected period at every snap
 *    (inaudible, window-zero) — for periodic input the crossfade reads
 *    phase-aligned copies and adds transparently instead of combing. The
 *    ratio is smoothed with a per-sample
 *    one-pole whose coefficient is computed ONCE per block with the block-rate
 *    formula (checklist #4: `1 - exp(-blockLen / (tc * sr))`).
 *
 * Determinism: no randomness anywhere — identical inputs render identical
 * outputs (offline parity contract).
 *
 * CPU budget (measured, worst case = noise through every loop): one
 * detection pass costs ~0.87 ms direct-time (O(windowW·maxLag) ≈ 1.4M
 * MACs); at the HOP=1024 cadence that is ~4 % of one core @48 kHz, spent
 * inside the render block that triggers it (~33 % of one 128-sample
 * quantum every ~21 ms). The FFT-based difference function (≈2–3× less)
 * is the known follow-up if weak-hardware profiling ever demands it —
 * not taken now because float drift would perturb detection decisions,
 * and silence never reaches the hot loops (the RMS gate exits first).
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */

const ANALYSIS_W = 2048; // 42.7 ms @48k — several periods of a 70 Hz voice;
// the FLOOR — the constructor scales the window above 48 kHz so MIN_HZ stays
// reachable at high sample rates (96k/192k sessions)
const HOP = 1024; // detection update every ~21 ms
const MIN_HZ = 70;
const MAX_HZ = 800;
const CORRECT_LIMIT_CENTS = 200; // never grab further than a major second

/** Bitmasks for the supported scales (bit n = pitch class n allowed). */
const SCALE_MASKS = [
  null, // 0 = chromatic: every semitone is a target
  0b101010110101, // 1 = major: {0,2,4,5,7,9,11} (bit n = pitch class n, LSB = C)
  0b010110101101, // 2 = natural minor: {0,2,3,5,7,8,10}
];

/**
 * YIN-style pitch detection over the most recent `count` samples of `buf`
 * (a ring; `writePos` points past the last written sample). Returns
 * `{ hz, clarity }` — hz 0 means "no confident voice".
 *
 * `scratch` ({x, d, nd} Float32Arrays) lets the processor reuse one set of
 * work buffers per lifetime — detectPitch runs on the audio thread every
 * HOP samples and per-call allocation would churn the GC inside the render
 * callback (~640 KB/s at 48 kHz). Without scratch (the golden-vector unit
 * tests) the buffers are allocated per call; results are identical either
 * way — nothing below `minLag` is ever read, and every entry at or above it
 * is rewritten before use.
 *
 * Exposed for the golden-vector unit tests (run in a VM scope).
 */
function detectPitch(buf, bufLen, writePos, sampleRate, windowW, minHz, maxHz, scratch) {
  const maxLag = Math.min(Math.floor(sampleRate / minHz), windowW - 64);
  const minLag = Math.max(2, Math.ceil(sampleRate / maxHz));
  const m = windowW - maxLag; // correlation length
  if (m < 64) return { hz: 0, clarity: 0 };

  let x, d, nd;
  if (scratch && scratch.x.length >= windowW && scratch.d.length > maxLag && scratch.nd.length > maxLag) {
    x = scratch.x;
    d = scratch.d;
    nd = scratch.nd;
  } else {
    x = new Float32Array(windowW);
    d = new Float32Array(maxLag + 1);
    nd = new Float32Array(maxLag + 1);
  }
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

  // YIN step 3 — cumulative-mean-normalized difference: d'(lag) =
  // d(lag) · lag / Σ_{j ≤ lag} d(j). Without this, a perfectly periodic
  // tone has near-zero differences at EVERY period multiple (T, 2T, …) and
  // the picker landed on the octave BELOW the true fundamental (a pure
  // 330 Hz tone detected as 165 Hz — caught by the golden vectors).
  let cumulative = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    cumulative += d[lag];
    nd[lag] = cumulative > 0 ? (d[lag] * (lag - minLag + 1)) / cumulative : Infinity;
  }

  // YIN absolute-threshold pick: the SMALLEST lag with d' under the
  // threshold — the fundamental. Fall back to the global d' minimum.
  // 0.05: pure tones dip to ~0.005-0.02 at the true period, while the
  // descending shoulder toward it crosses 0.15 two-three samples early
  // (measured: a pure 311 Hz tone picked lag 138, nd 0.149 — 20 cents flat).
  // Noisy live vocals may abstain at this strictness — the safe failure is
  // passthrough, never a wrong correction.
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

  // Parabolic interpolation — fitted around the LOCAL d minimum, not the
  // threshold pick. The threshold lands systematically BEFORE the true
  // period (a pure 330 Hz tone picked 2 samples early = −1.4 % flat);
  // centring on the actual dip first removes that bias (caught by the
  // golden vectors + the block simulation).
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

  const hz = sampleRate / lagF;
  if (hz < minHz || hz > maxHz) return { hz: 0, clarity: 0 };
  return { hz, clarity };
}

/**
 * Cents error from `hz` to the nearest allowed tone. `rootPc` 0..11 (C..B),
 * `scaleMode` 0 = chromatic, 1 = major, 2 = natural minor. Exposed for tests.
 */
function snapCents(hz, rootPc, scaleMode) {
  const midi = 69 + 12 * Math.log2(hz / 440);
  if (scaleMode === 0) {
    return (Math.round(midi) - midi) * 100;
  }
  const mask = SCALE_MASKS[scaleMode] ?? null;
  if (mask === null) return 0;
  const floor = Math.floor(midi);
  let best = -1;
  let bestDist = Infinity;
  for (let candidate = floor - 2; candidate <= floor + 3; candidate++) {
    if (candidate < 0) continue;
    const pc = (((candidate - rootPc) % 12) + 12) % 12;
    if (!(mask & (1 << pc))) continue;
    const dist = Math.abs(candidate - midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  if (best < 0) return 0;
  return (best - midi) * 100;
}

class PitchCorrectProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sampleRate = sr;
    this.bufferLen = sr * 2;
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    // Detection scratch, sized with the same formula detectPitch derives
    // maxLag from — one allocation per processor lifetime, reused every
    // detection pass (no GC churn on the audio thread).
    // The window is the 2048 constant at shipping rates (≤ 48 kHz — the
    // exact original detector), but scales above 48 kHz: the lag ceiling is
    // windowW − 64, so a fixed 2048 window silently narrowed tracking to
    // ≥ ~97 Hz at 96 kHz and made the MIN_HZ=70 floor unreachable at 192 kHz.
    this.analysisW = sr <= 48000 ? ANALYSIS_W : Math.max(ANALYSIS_W, Math.ceil((sr * 43) / 1000));
    const maxLag = Math.min(Math.floor(sr / MIN_HZ), this.analysisW - 64);
    this.detectScratch = {
      x: new Float32Array(this.analysisW),
      d: new Float32Array(maxLag + 1),
      nd: new Float32Array(maxLag + 1),
    };
    // Grain half-size for fixed 30 ms grains — depends only on the sample
    // rate, so derive it once instead of per block.
    this.grainHalf = Math.max(4, Math.round((30 / 1000) * sr) / 2);
    // Two-tap granular read state (see the shift stage in process()): each
    // tap's delay evolves CONTINUOUSLY at (1 - ratio) per output sample, so
    // between snaps the tap reads at exactly `ratio` — a real transposition.
    // (v1 anchored every grain with an absolute formula whose anchors advance
    // at rate 1: no content was ever skipped or repeated, so near-unity
    // corrections rendered unshifted — the documented v1 gap, caught by the
    // block-sim and browser checks.) A tap snaps back into [2H, 4H] only at
    // ITS OWN grain start, where its Hann window is zero — snaps are inaudible.
    this.tapDelay = [2 * this.grainHalf, 4 * this.grainHalf];
    this.grainIndex = [-1, -1];
    // Detected input period in samples (0 = nothing tracked yet). Keeps the
    // two taps' read offsets locked to whole periods — see the snap logic.
    this.periodSamples = 0;
    this.writePos = 0;
    this.blocksSinceDetect = HOP; // detect on the very first block
    this.detectedHz = 0;
    this.clarity = 0;
    this.ratioSmooth = 1;
    this.untrackedPasses = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "amount", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "speed", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "root", defaultValue: 0, minValue: 0, maxValue: 11, automationRate: "k-rate" },
      { name: "scaleMode", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  /** Same COLA dual-voice granular read as the pitch shifter, at `ratio`. */
  readAt(absPos, channel) {
    let p = absPos % this.bufferLen;
    if (p < 0) p += this.bufferLen;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % this.bufferLen;
    const buf = channel === 1 ? this.bufR : this.bufL;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;
    const input = inputs[0];
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    const len = outL.length;
    const sr = this.sampleRate;

    const amount = parameters.amount[0];
    const speed = parameters.speed[0];
    const root = Math.round(parameters.root[0]);
    const scaleMode = Math.round(parameters.scaleMode[0]);
    const mix = parameters.mix[0];

    // ── write this block into the ring ──
    const first = this.writePos;
    for (let i = 0; i < len; i++) {
      this.bufL[(first + i) % this.bufferLen] = inL ? inL[i] : 0;
      this.bufR[(first + i) % this.bufferLen] = inR && inR.length > i ? inR[i] : inL ? inL[i] : 0;
    }
    this.writePos = first + len;

    // ── detect (control rate) ──
    this.blocksSinceDetect += len;
    if (this.blocksSinceDetect >= HOP) {
      this.blocksSinceDetect = 0;
      const result = detectPitch(
        this.bufL,
        this.bufferLen,
        this.writePos,
        sr,
        this.analysisW,
        MIN_HZ,
        MAX_HZ,
        this.detectScratch,
      );
      // Confidence gate: only a clear monophonic voice updates the target —
      // silence, breath and chord mush hold the previous detection.
      // 0.75: pure tones measure ~0.85, chord mush ~0.61, noise ~0.12 —
      // the gate sits between the voices it must track and the ones it
      // must refuse (measured, see tests/pitchcorrect-worklet.test.ts).
      if (result.clarity >= 0.75 && result.hz > 0) {
        this.detectedHz = result.hz;
        this.clarity = result.clarity;
        this.periodSamples = sr / result.hz;
        this.untrackedPasses = 0;
      } else {
        this.untrackedPasses += 1;
        // After ~0.5 s of untracked audio, release the correction to unity so
        // the tail of a phrase does not hold a stale ratio. Each failed pass
        // covers ~HOP samples (detection fires at most once per HOP) — scale
        // by HOP, NOT by the 128-sample render quantum: 0.5 s of failed
        // passes is only ~24 of them, and the old `* 128` form stretched the
        // hold to 188 passes ≈ 4 s of stale correction.
        if (this.untrackedPasses * HOP > sr * 0.5) this.detectedHz = 0;
      }
    }

    // ── snap + smooth (block rate) ──
    let targetRatio = 1;
    if (this.detectedHz > 0) {
      const cents = snapCents(this.detectedHz, root, scaleMode);
      const clamped = Math.max(-CORRECT_LIMIT_CENTS, Math.min(CORRECT_LIMIT_CENTS, cents * amount));
      // Positive cents = the target tone sits ABOVE the detected pitch —
      // raising the output needs ratio > 1 (the granular read advances
      // faster). A minus here corrects AWAY from the scale (caught by the
      // block simulation: an E4−30c input stayed at the off-key pitch).
      targetRatio = Math.pow(2, clamped / 1200);
    }
    // speed 0 → tc 150 ms (natural glide), speed 1 → tc 4 ms (hard tune).
    // Block-rate coefficient per checklist #4 — the per-sample one-pole
    // constant is derived FROM the block length, not applied raw per block.
    const tc = 0.004 + (1 - Math.min(1, Math.max(0, speed))) * 0.146;
    const coeff = 1 - Math.exp(-len / (tc * sr));
    this.ratioSmooth += (targetRatio - this.ratioSmooth) * coeff;

    // ── shift ──
    const ratio = this.ratioSmooth;
    const H = this.grainHalf; // half-grain hop for fixed 30 ms grains
    const ratioIsUnity = Math.abs(ratio - 1) < 1e-6;
    const dMin = 2 * H;
    const dMax = 4 * H;
    const dRate = 1 - ratio;

    for (let i = 0; i < len; i++) {
      const A = first + i;
      const live = inL ? inL[i] : 0;
      const liveR = inR && inR.length > i ? inR[i] : live;
      if (ratioIsUnity || A < H * 2) {
        outL[i] = live;
        if (outR) outR[i] = liveR;
        continue;
      }
      let wetL = 0;
      let wetR = 0;
      let windowSum = 0;
      const k = Math.floor(A / H);
      for (let g = k; g >= k - 1; g--) {
        const u = A / H - g; // 0..2 within this grain
        if (u < 0 || u > 2) continue;
        const v = g & 1;
        if (this.grainIndex[v] !== g) {
          // This tap's grain just started — its Hann window is at zero, the
          // only inaudible moment to snap. The delay is out of bounds, so
          // jump — but land on the integer multiple of the DETECTED PERIOD
          // nearest the other tap's delay (phase-locked crossfade, the PSOLA
          // trick): between snaps the inter-tap offset stays exactly m·T, so
          // for periodic input both windows read phase-aligned copies and
          // the crossfade is transparent instead of combing (an unquantized
          // offset wander put specific pitches into deep comb notches).
          // Falls back to the directional snap when no period is known.
          const d = this.tapDelay[v];
          if (d > dMax || d < dMin) {
            const T = this.periodSamples;
            let target = d > dMax ? dMin : dMax;
            if (T > 0) {
              const other = this.tapDelay[1 - v];
              const lo = Math.ceil((dMin - other) / T - 1e-9);
              const hi = Math.floor((dMax - other) / T + 1e-9);
              let bestErr = Infinity;
              for (let m = lo; m <= hi; m++) {
                const cand = other + m * T;
                if (cand < dMin || cand > dMax) continue;
                const err = Math.abs(cand - d);
                if (err < bestErr) {
                  bestErr = err;
                  target = cand;
                }
              }
            }
            this.tapDelay[v] = target;
          }
          this.grainIndex[v] = g;
        }
        const window = 0.5 * (1 - Math.cos(Math.PI * u));
        // L and R read the SAME position — correction carries no width.
        const read = A - this.tapDelay[v];
        if (read < 0 || read > this.writePos) continue;
        wetL += this.readAt(read, 0) * window;
        wetR += this.readAt(read, 1) * window;
        windowSum += window;
      }
      // Both taps' delays evolve every output sample.
      this.tapDelay[0] += dRate;
      this.tapDelay[1] += dRate;
      const norm = windowSum > 1e-6 ? 1 / windowSum : 0;
      outL[i] = live * (1 - mix) + wetL * norm * mix;
      if (outR) outR[i] = liveR * (1 - mix) + wetR * norm * mix;
    }
    return true;
  }
}

registerProcessor("pitchcorrect-processor", PitchCorrectProcessor);
