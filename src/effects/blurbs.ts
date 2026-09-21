import type { EffectType } from "../project-model/types";

/**
 * One-line device descriptions for the FX add surface (FX-ADD-REWORK-ROADMAP
 * A1): the goal-first popover says what a device DOES TO A BEAT before the
 * user has to know its name. Written in beatmaker language, kept short —
 * the popover grid truncates to one line. Flagships get their own fuller
 * lines (their panels carry the detail).
 */
export const EFFECT_BLURBS: Partial<Record<EffectType, string>> = {
  // ── character ──────────────────────────────────────────────────────────
  pitchShift: "Moves a sound down or up in pitch — classic 808 depth and glide glue",
  tapeSat: "Warm tape drive — glues a track and softens harsh tops",
  vinyl: "Age and dust — crackle, wobble and 1950s tone in one knob",
  distortion: "Hard drive — grit and aggression from edge to full shred",
  saturation: "Analog-style push — louder, denser, pleasantly rougher",
  bitcrusher: "Digital decay — quantize and crush into lo-fi artifacts",
  clipper: "Brick-wall shave — tames peaks and adds forward punch",
  drumBuss: "One strip for the whole drum bus — drive, glue and sub boom",
  bassBuss: "Bass bus glue — drive, sub enhance and controlled low end",
  shimmer: "Octave-up glow — turns a sound into a pad behind itself",
  vocoder: "Robot voice — imposes one sound's syllables onto another",
  fxeq: "Vendored PRISM EQ — paintable 8-band tone surgery with M/S",

  // ── dynamics ───────────────────────────────────────────────────────────
  compressor: "Levels the jumps — denser, steadier, more professional",
  limiter: "Safety ceiling — louder without clipping on the way out",
  gate: "Silence below threshold — cleans bleed and tightens tails",
  transient: "Shapes hits — more snap or more body, hit by hit",
  sidechain: "One sound ducks another — the classic kick-vs-bass move",
  morphdynamics: "Flagship MORPH — dynamics that morph between pressure curves",
  ultina: "Flagship VLYX Mix Assist — learns the mix and suggests moves",

  // ── movement ───────────────────────────────────────────────────────────
  beatMangler: "Chops the beat live — stutters, reverses and pitch jumps",
  tremolo: "Volume wobble — pulsing amplitude at a set rate",
  autowah: "Opens a filter by how hard you hit — funky talking sweeps",
  phaser: "Jet-plane swoosh — moving comb filtering through the sound",
  flanger: "Metallic whoosh — a detuned twin chasing the original",
  chorus: "Widens and doubles — one sound becomes a small ensemble",
  pump: "Sidechain-style breathing — ducks on every beat without routing",
  stepGate: "Chops volume in steps — rhythmic gating locked to the grid",
  stutter: "Repeats a slice — instant build-up stutters",
  tapeStop: "Tape-stop slowdown — the classic turntable wind-down",
  reverseSwell: "Reverse riser — a swell that launches into the next hit",
  ringMod: "Metallic robot ring — inharmonic clang and science-fiction edges",
  freqShifter: "Shifts spectrum sideways — alien, detuned-from-physics character",
  comb: "Hollow resonant buzz — metallic comb-filter tone coloring",
  vowel: "Talks through formants — wah-like vowels without a filter sweep",
  haasWidener: "Instant width — one small delay makes mono sound stereo",

  // ── space ──────────────────────────────────────────────────────────────
  reverb: "Places the sound in a room — from tight booth to endless hall",
  delay: "Echoes the phrase — from slapback to endless dub tails",
  duckDelay: "Delay that ducks under the hit — echoes only in the gaps",
  multiTapDelay: "Several echoes at once — rhythmic delay patterns",
  granularFreeze: "Freezes audio into a pad — infinite sustain from a moment",
  kaskada: "Flagship Kaskáda — reverse sweeps, freeze and spectral ducking",
  ozvena: "Flagship VØID — per-frequency decay reverb network",

  // ── tone ───────────────────────────────────────────────────────────────
  eq: "4-band paint — boost highs, cut mud, shape the whole tone",
  svFilter: "Resonant sweep — the filter that makes builds build",
  msEq: "Mid/side EQ — tune the center and the edges separately",
  multiband: "3-band split — tone control per low, mid and high",
  utility: "Gain, pan and width — the honest plumbing of a channel",
};
