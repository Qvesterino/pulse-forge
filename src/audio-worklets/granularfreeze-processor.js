/**
 * Granular Freeze AudioWorkletProcessor — a send-effect texture freeze.
 *
 * The "freeze a moment" gesture (Ableton's Resonators/Paulstretch family,
 * CLOUD-style texture holds): the input is recorded into a ring buffer at all
 * times; a 0→1 `freeze` latch LOCKS a window of that recording and a granular
 * cloud plays it forever while the latch is up. Releasing resumes normal
 * passthrough, so the send bus becomes a live texture pad.
 *
 * Signal flow per sample:
 *   1. write the dry input into the ring buffer (always)
 *   2. on the freeze edge, capture `anchor = writePos` — the locked window is
 *      the `window` seconds ending there
 *   3. while frozen, spawn overlapping grains that read that window at
 *      `position` (0..1 of the window) with a random-ish scatter, an optional
 *      `drift` that slowly walks the read head, and a `pitch` shift
 *   4. grains are Hann-windowed and summed → wet; `tone` trims the cloud and
 *      `mix` blends it against the (ducked) dry signal
 *
 * Grain scheduling: a fixed grid (one grain per `grainMs`/4 samples, 4×
 * overlap) with deterministic per-grain scatter from a seeded RNG — no
 * Math.random, so two renders of the same document are bit-identical.
 *
 * Freeze ducking: while frozen the dry path is ducked by the same smoothed
 * envelope that raises the cloud (a real crossfade), which is what makes it
 * usable on a send bus instead of layering dry + frozen mush.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
const GF_MAX_GRAINS = 64;
const GF_OVERLAP = 4;

function gfRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Read a k-rate parameter defensively (missing → fallback). */
function gfPv(parameters, name, fallback) {
  const p = parameters[name];
  if (!p || p.length === 0) return fallback;
  const v = p[0];
  return Number.isFinite(v) ? v : fallback;
}

function gfClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class GranularFreezeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 1;
    this.rng = gfRng(seed);
    // 12 s stereo ring buffer: the longest window (8 s) plus headroom so a
    // freshly frozen processor always has a full window available.
    this.bufferLen = Math.ceil(sr * 12);
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    this.writePos = 0;
    this.frozen = false;
    /** Write head captured at the freeze edge — the window's end. */
    this.anchor = 0;
    /** Smooth frozen envelope 0..1 (drives the dry/wet crossfade). */
    this.env = 0;
    /** Grain spawn countdown (samples). */
    this.spawnCountdown = 0;
    /** Active grains: fixed-capacity ring of small records. */
    this.grainAge = new Float32Array(GF_MAX_GRAINS);
    this.grainLen = new Float32Array(GF_MAX_GRAINS);
    // Float64 — these hold ABSOLUTE writePos positions that grow for the
    // whole session; Float32's 24-bit mantissa quantizes them past 2^24
    // samples (~6 min @48k) and frozen clouds developed stepping artifacts.
    this.grainStart = new Float64Array(GF_MAX_GRAINS);
    this.grainRate = new Float32Array(GF_MAX_GRAINS);
    this.grainGain = new Float32Array(GF_MAX_GRAINS);
    this.grainCh = new Uint8Array(GF_MAX_GRAINS);
    this.grainActive = new Uint8Array(GF_MAX_GRAINS);
    this.grainCursor = 0;
    /** Deterministic slow drift walk (frozen read position offset). */
    this.driftPhase = 0;
    // Wet tone one-pole (per channel).
    this.toneLpL = 0;
    this.toneLpR = 0;
    this.lastToneHz = -1;
    this.toneCoef = 1;
  }

  static get parameterDescriptors() {
    return [
      { name: "freeze", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "window", defaultValue: 2, minValue: 0.2, maxValue: 8, automationRate: "k-rate" },
      { name: "position", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "drift", defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "grainMs", defaultValue: 90, minValue: 20, maxValue: 400, automationRate: "k-rate" },
      { name: "scatter", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "pitch", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" },
      { name: "tone", defaultValue: 10000, minValue: 500, maxValue: 16000, automationRate: "k-rate" },
      { name: "level", defaultValue: 0, minValue: -24, maxValue: 12, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  readAt(pos, ch) {
    const buf = ch === 1 ? this.bufR : this.bufL;
    const len = this.bufferLen;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % len;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  spawnGrain(startPos, lenSamples, rate, gain, ch) {
    const i = this.grainCursor;
    this.grainCursor = (this.grainCursor + 1) % GF_MAX_GRAINS;
    this.grainAge[i] = 0;
    this.grainLen[i] = lenSamples;
    this.grainStart[i] = startPos;
    this.grainRate[i] = rate;
    this.grainGain[i] = gain;
    this.grainCh[i] = ch;
    this.grainActive[i] = 1;
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
    const sr = this.sr;

    const freeze = gfPv(parameters, "freeze", 0) >= 0.5;
    const windowSec = gfClamp(gfPv(parameters, "window", 2), 0.2, 8);
    const position = gfClamp(gfPv(parameters, "position", 0.5), 0, 1);
    const drift = gfClamp(gfPv(parameters, "drift", 0.2), 0, 1);
    const grainMs = gfClamp(gfPv(parameters, "grainMs", 90), 20, 400);
    const scatter = gfClamp(gfPv(parameters, "scatter", 0.3), 0, 1);
    const pitch = gfClamp(gfPv(parameters, "pitch", 0), -24, 24);
    const toneHz = gfClamp(gfPv(parameters, "tone", 10000), 500, 16000);
    const levelLin = Math.pow(10, gfClamp(gfPv(parameters, "level", 0), -24, 12) / 20);
    const mix = gfClamp(gfPv(parameters, "mix", 1), 0, 1);

    // Freeze edge: lock the window ending at the current write head.
    if (freeze && !this.frozen) {
      this.anchor = this.writePos;
      this.frozen = true;
      this.spawnCountdown = 0;
      this.driftPhase = 0;
    } else if (!freeze && this.frozen) {
      this.frozen = false;
    }

    if (toneHz !== this.lastToneHz) {
      this.lastToneHz = toneHz;
      this.toneCoef = 1 - Math.exp((-2 * Math.PI * toneHz) / sr);
    }

    const windowSamples = windowSec * sr;
    const grainSamples = Math.max(32, (grainMs / 1000) * sr);
    const spawnInterval = Math.max(1, Math.floor(grainSamples / GF_OVERLAP));
    const rate = Math.pow(2, pitch / 12);
    // Cloud gain: 4× overlap of Hann grains sums to ~2, plus level trim.
    const grainGain = 0.55 * levelLin;
    const smoothCoef = 1 - Math.exp(-1 / (sr * 0.01));

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Record always — a freeze must always find fresh material.
      this.bufL[this.writePos % this.bufferLen] = l;
      this.bufR[this.writePos % this.bufferLen] = r;
      this.writePos += 1;

      // Frozen envelope (drives the dry duck + wet raise).
      const envTarget = this.frozen ? 1 : 0;
      this.env += (envTarget - this.env) * smoothCoef;
      if (this.env < 1e-20) this.env = 0;

      // Grain spawn grid while frozen.
      let sumL = 0;
      let sumR = 0;
      if (this.frozen || this.env > 0) {
        this.spawnCountdown -= 1;
        if (this.frozen && this.spawnCountdown <= 0) {
          this.spawnCountdown = spawnInterval;
          // Slow drift walks the read head inside the window.
          this.driftPhase += (2 * Math.PI * 0.05) / sr;
          if (this.driftPhase > 2 * Math.PI) this.driftPhase -= 2 * Math.PI;
          const driftOffset = Math.sin(this.driftPhase) * drift * windowSamples * 0.35;
          // Position 0..1 selects within the window; scatter jitters each grain.
          const baseOffset = position * (windowSamples - grainSamples);
          const jitter = (this.rng() * 2 - 1) * scatter * windowSamples * 0.25;
          const start = this.anchor - windowSamples + baseOffset + driftOffset + jitter;
          this.spawnGrain(start, grainSamples, rate, grainGain, 0);
          // A decorrelated second grain on the right channel (stereo cloud).
          const jitterR = (this.rng() * 2 - 1) * scatter * windowSamples * 0.25;
          this.spawnGrain(start + jitterR, grainSamples, rate, grainGain, 1);
        }

        // Render active grains (Hann window).
        for (let g = 0; g < GF_MAX_GRAINS; g++) {
          if (!this.grainActive[g]) continue;
          const age = this.grainAge[g];
          const glen = this.grainLen[g];
          if (age >= glen) {
            this.grainActive[g] = 0;
            continue;
          }
          const w = 0.5 * (1 - Math.cos((2 * Math.PI * age) / glen));
          const readPos = this.grainStart[g] + age * this.grainRate[g];
          const s = this.readAt(readPos, this.grainCh[g]);
          if (this.grainCh[g] === 1) sumR += s * w * this.grainGain[g];
          else sumL += s * w * this.grainGain[g];
          this.grainAge[g] = age + 1;
        }
      }

      // Wet tone trim (one-pole LP per channel) before the crossfade.
      this.toneLpL += (sumL - this.toneLpL) * this.toneCoef;
      this.toneLpR += (sumR - this.toneLpR) * this.toneCoef;

      // Real crossfade: the frozen envelope ducks the dry while raising the
      // cloud (idle passes the bus through untouched).
      const dryGain = 1 - mix * this.env;
      const wetGain = mix * this.env;
      outL[i] = l * dryGain + this.toneLpL * wetGain;
      if (outR) outR[i] = r * dryGain + this.toneLpR * wetGain;
    }
    return true;
  }
}

registerProcessor("granularfreeze-processor", GranularFreezeProcessor);
