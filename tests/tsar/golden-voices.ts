/**
 * TSAR T0 - GOLDEN VOICES: deterministic synthetic sources with EXACT ground
 * truth, the measuring stick for every TSAR wave (T1 engine, T2 Forge,
 * T3 presets, T5 offline parity) - docs/TSAR-ROADMAP.md.
 *
 * Why a dedicated generator instead of real WAVs:
 *  - bit-deterministic across machines and runs (AGENTS invariant #4),
 *  - runnable inside vitest (jsdom has no WebAudio),
 *  - ground truth exact BY CONSTRUCTION - the root frequency, the harmonic
 *    stack, the one-shot vs sustained character are values WE placed, not
 *    values we hope the analyzer found.
 *
 * The models are deliberately simple but band-correct: a harmonically rich
 * saw, a pure sine (root-detection floor), an 808-style sine with a pitch
 * envelope, a noise burst (unpitched floor), and a formant pair (vowel-like
 * partials). A Forge plan that passes here says something about the DSP
 * recipe; real-material validation stays an owner ear-pass.
 *
 * PURE: same seed + source -> bit-identical Float32Array. No imports from
 * src/ - this file is the fixture, the code under test is the engine.
 */

export const TSAR_GOLDEN_SAMPLE_RATE = 44100;
/** Deterministic PRNG (mulberry32) - noise floor and jitter only. */
export const TSAR_GOLDEN_SEED = 20261006;

export type GoldenVoiceId = "sine-a1" | "saw-c3" | "808-f1" | "noise-burst" | "formant-e3" | "sustained-pad";

export interface GoldenVoice {
  id: GoldenVoiceId;
  /** Ground-truth root MIDI note (null = unpitched, Forge must say "unknown"). */
  rootMidi: number | null;
  /** Ground-truth character. */
  kind: "sustained" | "one-shot" | "unpitched";
  /** Seconds of rendered material. */
  durationSec: number;
  /** Expected Forge routing (T2 contract). */
  expectedEngine: "sampler" | "wavetable" | "granular";
}

export const GOLDEN_VOICES: GoldenVoice[] = [
  { id: "sine-a1", rootMidi: 33, kind: "sustained", durationSec: 2, expectedEngine: "wavetable" },
  { id: "saw-c3", rootMidi: 48, kind: "sustained", durationSec: 2, expectedEngine: "wavetable" },
  { id: "808-f1", rootMidi: 29, kind: "one-shot", durationSec: 1.5, expectedEngine: "sampler" },
  { id: "noise-burst", rootMidi: null, kind: "unpitched", durationSec: 0.5, expectedEngine: "sampler" },
  { id: "formant-e3", rootMidi: 52, kind: "sustained", durationSec: 2, expectedEngine: "wavetable" },
  { id: "sustained-pad", rootMidi: 45, kind: "sustained", durationSec: 6, expectedEngine: "granular" },
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 3 ms raised-cosine attack (avoids a DC click that f0 detection could read). */
function attackGain(index: number, attackSamples: number): number {
  return index < attackSamples ? 0.5 - 0.5 * Math.cos((Math.PI * index) / attackSamples) : 1;
}

/**
 * Render one golden voice, deterministically. `seed` only shifts the noise
 * floor (and the noise burst); pitched content is seed-independent so root
 * detection is not a lottery.
 */
export function renderGoldenVoice(voice: GoldenVoice, seed = TSAR_GOLDEN_SEED): Float32Array {
  const sr = TSAR_GOLDEN_SAMPLE_RATE;
  const rng = mulberry32(seed);
  const length = Math.round(voice.durationSec * sr);
  const out = new Float32Array(length);
  const attack = Math.round(0.003 * sr);

  switch (voice.id) {
    case "sine-a1": {
      // Pure sine - the root-detection floor case (one partial, stable f0).
      const f0 = midiToHz(voice.rootMidi!);
      for (let i = 0; i < length; i++) {
        out[i] = 0.6 * attackGain(i, attack) * Math.sin((2 * Math.PI * f0 * i) / sr);
      }
      break;
    }
    case "saw-c3": {
      // Band-limited-ish saw (12 partials) - the wavetable extraction case.
      const f0 = midiToHz(voice.rootMidi!);
      const partials = 12;
      for (let i = 0; i < length; i++) {
        let sample = 0;
        for (let h = 1; h <= partials; h++) {
          if (f0 * h >= sr * 0.45) break;
          sample += Math.sin((2 * Math.PI * f0 * h * i) / sr) / h;
        }
        out[i] = 0.5 * attackGain(i, attack) * sample;
      }
      break;
    }
    case "808-f1": {
      // 808-style one-shot: sine with a ~60 ms pitch drop + exponential decay.
      const base = midiToHz(voice.rootMidi!);
      let phase = 0;
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        const f = base * (1 + 0.6 * Math.exp(-t / 0.02));
        phase += (2 * Math.PI * f) / sr;
        out[i] = 0.8 * Math.exp(-t / 0.35) * Math.sin(phase);
      }
      break;
    }
    case "noise-burst": {
      // Decaying noise - unpitched; Forge must return rootMidi null honestly.
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        out[i] = 0.5 * Math.exp(-t / 0.08) * (rng() * 2 - 1);
      }
      break;
    }
    case "formant-e3": {
      // Vowel-like: f0 plus two strong formant partials (harmonics 4 and 7).
      // Levels sum to 0.9 so the voice cannot clip (a clipped fixture would
      // poison peak-normalization checks in T2).
      const f0 = midiToHz(voice.rootMidi!);
      for (let i = 0; i < length; i++) {
        const w = attackGain(i, attack);
        out[i] =
          0.35 * w * Math.sin((2 * Math.PI * f0 * i) / sr) +
          0.32 * w * Math.sin((2 * Math.PI * f0 * 4 * i) / sr) +
          0.23 * w * Math.sin((2 * Math.PI * f0 * 7 * i) / sr);
      }
      break;
    }
    case "sustained-pad": {
      // Long evolving pad: detuned partial stack + slow AM - Forge should see
      // a stable f0 with a long, non-instant envelope -> granular territory.
      const f0 = midiToHz(voice.rootMidi!);
      const f2 = f0 * Math.pow(2, 7 / 1200); // +7 cents
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        const am = 0.8 + 0.2 * Math.sin(2 * Math.PI * 0.4 * t);
        out[i] =
          0.4 *
          attackGain(i, attack) *
          am *
          (Math.sin((2 * Math.PI * f0 * i) / sr) + Math.sin((2 * Math.PI * f2 * i) / sr));
      }
      break;
    }
  }

  // A tiny noise floor everywhere so a "perfect zero" silence test is never
  // confused with digital black (mirrors the UN-SUNO golden synth).
  for (let i = 0; i < length; i++) out[i] += (rng() * 2 - 1) * 0.0015;
  return out;
}

/** Convenience: all voices rendered once (fixture reuse across tests). */
export function renderAllGoldenVoices(seed = TSAR_GOLDEN_SEED): Map<GoldenVoiceId, Float32Array> {
  return new Map(GOLDEN_VOICES.map((voice) => [voice.id, renderGoldenVoice(voice, seed)]));
}
