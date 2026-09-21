/**
 * Instrument DEFINITIONS — pure parameter metadata for the 14 instrument
 * kinds, split verbatim from registry.ts (cross-platform campaign GOAL 02).
 *
 * This module is deliberately executable in bare Node: no React, no Web
 * Audio, no worklet loaders, no storage. The project model (schema, targets,
 * commands) and the export encoders consume it so that param metadata never
 * drags the audio runtime graph. The runtime `factory` implementations stay
 * in registry.ts; `INSTRUMENT_DEFS` there merges this metadata with the
 * factories and re-exports keep the historical import path stable.
 */
import type { InstrumentKind } from "../project-model/types";
import type { ParamDef } from "../effects/types";
import { ENV_SHAPE_OPTIONS } from "./envelope";
import { modMatrixParams } from "./modmatrix";
import { FACTORY_TABLE_OPTIONS, FACTORY_WAVETABLES } from "./wavetables";

export const WAVE_NAMES = ["sine", "triangle", "sawtooth", "square"] as const;

const WAVE_OPTIONS = [
  { value: 0, label: "Sine" },
  { value: 1, label: "Tri" },
  { value: 2, label: "Saw" },
  { value: 3, label: "Sqr" },
];

const formatDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const formatHz = (v: number) => `${Math.round(v)} Hz`;
const formatMs = (v: number) => `${Math.round(v * 1000)} ms`;
const formatPct = (v: number) => `${Math.round(v * 100)}%`;
const formatSec = (v: number) => `${v.toFixed(2)} s`;

/* ---------------- BPM sync helpers ---------------- */
// Shared division table for tempo-synced modulators. Selection 0 = OFF
// (free Hz rate as before); otherwise the modulation period locks to a
// note division derived from the track's bpm. Exported for math checks.
export const SYNC_BEATS = [0, 2, 1, 0.75, 0.5, 1 / 3, 0.25]; // OFF, 1/2, 1/4, 1/8D, 1/8, 1/8T, 1/16
export const SYNC_OPTIONS = [
  { value: 0, label: "OFF" },
  { value: 1, label: "1/2" },
  { value: 2, label: "1/4" },
  { value: 3, label: "1/8D" },
  { value: 4, label: "1/8" },
  { value: 5, label: "1/8T" },
  { value: 6, label: "1/16" },
];
export function syncRateHz(selection: number, bpm: number): number {
  const beats = SYNC_BEATS[Math.max(0, Math.min(SYNC_BEATS.length - 1, Math.round(selection)))];
  return beats > 0 ? bpm / (60 * beats) : 0;
}

const SPECTRAL_PROFILE_OPTIONS = [
  { value: 0, label: "Harmonic" },
  { value: 1, label: "Bright" },
  { value: 2, label: "Odd" },
  { value: 3, label: "Formant" },
  { value: 4, label: "Bell" },
];

const VOWEL_OPTIONS = [
  { value: 0, label: "A" },
  { value: 1, label: "E" },
  { value: 2, label: "I" },
  { value: 3, label: "O" },
  { value: 4, label: "U" },
];

export const DRUM_TYPE_OPTIONS = [
  { value: 0, label: "Kick" },
  { value: 1, label: "Snare" },
  { value: 2, label: "Hat C" },
  { value: 3, label: "Hat O" },
  { value: 4, label: "Clap" },
  { value: 5, label: "Perc" },
  { value: 6, label: "Cowbell" },
  { value: 7, label: "Rimshot" },
  { value: 8, label: "Tom" },
  { value: 9, label: "Crash" },
  { value: 10, label: "Ride" },
  { value: 11, label: "909 Kick" },
  { value: 12, label: "Zap" },
];

export const analogParams: ParamDef[] = [
    { id: "oscA", label: "OSC A", min: 0, max: 3, default: 2, options: WAVE_OPTIONS },
    { id: "oscB", label: "OSC B", min: 0, max: 3, default: 2, options: WAVE_OPTIONS },
    {
      id: "oscBDetune",
      label: "DETUNE",
      min: -50,
      max: 50,
      default: 8,
      unit: "ct",
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct`,
    },
    { id: "subLevel", label: "SUB", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "noiseLevel", label: "NOISE", min: 0, max: 0.5, default: 0.04, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 9000, unit: "Hz", format: formatHz, taper: "log" },
    { id: "resonance", label: "RESO", min: 0.1, max: 12, default: 1, format: (v) => v.toFixed(2) },
    {
      id: "mode",
      label: "FILTER",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "LP" },
        { value: 1, label: "BP" },
        { value: 2, label: "HP" },
      ],
    },
    { id: "keytrack", label: "KEY TRK", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "filterEnv", label: "FLT ENV", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "unison", label: "UNISON", min: 1, max: 8, default: 1, format: (v) => `${Math.round(v)}×` },
    { id: "spread", label: "SPREAD", min: 0, max: 50, default: 0, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
    {
      id: "lfoRate",
      label: "LFO RATE",
      min: 0,
      max: 16,
      default: 0,
      unit: "Hz",
      format: (v) => (v < 0.05 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
    { id: "lfoSync", label: "LFO SYNC", min: 0, max: 6, default: 0, options: SYNC_OPTIONS },
    { id: "lfoDepth", label: "LFO DEPTH", min: 0, max: 1, default: 0, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.01, unit: "s", format: formatMs },
    { id: "decay", label: "DECAY", min: 0.02, max: 3, default: 0.25, unit: "s", format: formatMs },
    { id: "sustain", label: "SUSTAIN", min: 0, max: 1, default: 0.7, format: formatPct },
    { id: "envDelay", label: "ENV DELAY", min: 0, max: 2, default: 0, unit: "s", format: formatSec },
    { id: "envHold", label: "ENV HOLD", min: 0, max: 2, default: 0, unit: "s", format: formatSec },
    { id: "aShape", label: "A SHAPE", min: 0, max: 2, default: 0, options: ENV_SHAPE_OPTIONS },
    { id: "dShape", label: "D SHAPE", min: 0, max: 2, default: 0, options: ENV_SHAPE_OPTIONS },
    { id: "rShape", label: "R SHAPE", min: 0, max: 2, default: 0, options: ENV_SHAPE_OPTIONS },
    {
      id: "dLoop",
      label: "D LOOP",
      min: 0,
      max: 8,
      default: 0,
      format: (v) => (v < 0.5 ? "OFF" : `${Math.round(v)}×`),
    },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.2, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
    ...modMatrixParams(false),
  ];


export const bassParams: ParamDef[] = [
    { id: "sub", label: "SUB", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.7, format: formatPct },
    { id: "punch", label: "PUNCH", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "grit", label: "GRIT", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "glide", label: "GLIDE", min: 0, max: 1, default: 0.34, format: formatPct },
    {
      id: "distType",
      label: "DIST",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "Soft" },
        { value: 1, label: "Tube" },
        { value: 2, label: "Hard" },
      ],
    },
    { id: "movement", label: "MOVE", min: 0, max: 1, default: 0.15, format: formatPct },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "unison", label: "UNISON", min: 1, max: 6, default: 1, format: (v) => `${Math.round(v)}×` },
    { id: "spread", label: "SPREAD", min: 0, max: 50, default: 10, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 4000, default: 700, unit: "Hz", format: formatHz, taper: "log" },
    { id: "resonance", label: "RESO", min: 0.1, max: 10, default: 1.2, format: (v) => v.toFixed(2) },
    {
      id: "mode",
      label: "FILTER",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "LP" },
        { value: 1, label: "BP" },
        { value: 2, label: "HP" },
      ],
    },
    { id: "keytrack", label: "KEY TRK", min: 0, max: 1, default: 0, format: formatPct },
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
    ...modMatrixParams(false),
  ];


export const bass808Params: ParamDef[] = [
    { id: "decay", label: "DECAY", min: 0.05, max: 4, default: 0.9, unit: "s", format: (v) => `${v.toFixed(2)} s` },
    { id: "pitchDrop", label: "P-DROP", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "click", label: "CLICK", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "glide", label: "GLIDE", min: 0, max: 1, default: 0.34, format: formatPct },
    {
      id: "distType",
      label: "DIST",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "Soft" },
        { value: 1, label: "Tube" },
        { value: 2, label: "Hard" },
      ],
    },
    { id: "sub", label: "SUB", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "tone", label: "TONE", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.85, format: formatPct },
    {
      id: "gate",
      label: "GATE",
      min: 0,
      max: 1,
      default: 1,
      options: [
        { value: 0, label: "One-shot" },
        { value: 1, label: "Gated" },
      ],
    },
    {
      id: "mono",
      label: "MONO",
      min: 0,
      max: 1,
      default: 1,
      options: [
        { value: 0, label: "Poly" },
        { value: 1, label: "Mono" },
      ],
    },
    ...modMatrixParams(false),
  ];


export const samplerParams: ParamDef[] = [
    { id: "root", label: "ROOT", min: 24, max: 84, default: 60, format: (v) => `${Math.round(v)}` },
    { id: "start", label: "START", min: 0, max: 1, default: 0, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 1, default: 0.003, unit: "s", format: formatMs },
    { id: "decay", label: "DECAY", min: 0.005, max: 2, default: 0.25, unit: "s", format: formatMs },
    { id: "sustain", label: "SUSTAIN", min: 0, max: 1, default: 1, format: formatPct },
    { id: "release", label: "RELEASE", min: 0.01, max: 2, default: 0.12, unit: "s", format: formatMs },
    { id: "pitchDrop", label: "P-DROP", min: 0, max: 24, default: 0, unit: "st", format: (v) => `${v.toFixed(1)} st` },
    { id: "pitchDecayT", label: "P-DECAY", min: 0.005, max: 1, default: 0.12, unit: "s", format: formatMs },
    { id: "cutoff", label: "CUTOFF", min: 500, max: 16000, default: 15000, unit: "Hz", format: formatHz, taper: "log" },
    { id: "resonance", label: "RESO", min: 0.1, max: 8, default: 0.7, format: (v) => v.toFixed(2) },
    {
      id: "mode",
      label: "FILTER",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "LP" },
        { value: 1, label: "BP" },
        { value: 2, label: "HP" },
      ],
    },
    { id: "keytrack", label: "KEY TRK", min: 0, max: 1, default: 0, format: formatPct },
    { id: "velFlt", label: "V-FLT", min: 0, max: 1, default: 0, format: formatPct },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.9, format: formatPct },
    {
      id: "stretch",
      label: "STRETCH",
      min: 0,
      max: 1,
      default: 0,
      options: [
        { value: 0, label: "Pitch" },
        { value: 1, label: "Stretch" },
      ],
    },
    {
      id: "loop",
      label: "LOOP",
      min: 0,
      max: 1,
      default: 0,
      options: [
        { value: 0, label: "One-shot" },
        { value: 1, label: "Loop" },
      ],
    },
    { id: "loopXfade", label: "L-XFADE", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "loopStart", label: "L-START", min: 0, max: 1, default: 0, format: formatPct },
    { id: "loopEnd", label: "L-END", min: 0.01, max: 1, default: 1, format: formatPct },
    { id: "reverse", label: "REVERSE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0, format: formatPct },
    ...modMatrixParams(false),
  ];


export const textureParams: ParamDef[] = [
    { id: "color", label: "COLOR", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "motion", label: "MOTION", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "space", label: "SPACE", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "sync", label: "SYNC", min: 0, max: 6, default: 0, options: SYNC_OPTIONS },
    { id: "density", label: "DENSITY", min: 0, max: 1, default: 0.7, format: formatPct },
    { id: "texture", label: "TEXTURE", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "chaos", label: "CHAOS", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.01, max: 3, default: 0.5, unit: "s", format: (v) => `${v.toFixed(2)}s` },
    { id: "hold", label: "HOLD", min: 0, max: 6, default: 1.5, unit: "s", format: (v) => `${v.toFixed(2)}s` },
    {
      id: "gate",
      label: "GATE",
      min: 0,
      max: 1,
      default: 0,
      options: [
        { value: 0, label: "Hold" },
        { value: 1, label: "Gate" },
      ],
    },
    { id: "release", label: "RELEASE", min: 0.05, max: 4, default: 0.6, unit: "s", format: (v) => `${v.toFixed(2)}s` },
    { id: "unison", label: "UNISON", min: 1, max: 6, default: 2, format: (v) => `${Math.round(v)}×` },
    { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0, format: formatPct },
    { id: "drift", label: "DRIFT", min: 0, max: 1, default: 0, format: formatPct },
    { id: "diffuse", label: "DIFFUSE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -10, unit: "dB", format: formatDb },
    ...modMatrixParams(false),
  ];


export const wavetableParams: ParamDef[] = [
    {
      id: "table",
      label: "TABLE",
      min: 0,
      max: FACTORY_WAVETABLES.length - 1,
      default: 0,
      options: FACTORY_TABLE_OPTIONS,
    },
    { id: "morph", label: "MORPH", min: 0, max: 1, default: 0.3, format: formatPct },
    {
      id: "morphRate",
      label: "M RATE",
      min: 0,
      max: 12,
      default: 0,
      unit: "Hz",
      format: (v) => (v < 0.05 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
    { id: "morphDepth", label: "M DEPTH", min: 0, max: 1, default: 0.5, format: formatPct },
    {
      id: "scanRate",
      label: "S RATE",
      min: 0,
      max: 8,
      default: 0,
      unit: "Hz",
      format: (v) => (v < 0.02 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
    {
      id: "detune",
      label: "DETUNE",
      min: -50,
      max: 50,
      default: 7,
      unit: "ct",
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct`,
    },
    { id: "sub", label: "SUB", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "unison", label: "UNISON", min: 1, max: 8, default: 1, format: (v) => `${Math.round(v)}×` },
    { id: "spread", label: "SPREAD", min: 0, max: 50, default: 0, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 12000, unit: "Hz", format: formatHz, taper: "log" },
    { id: "resonance", label: "RESO", min: 0.1, max: 12, default: 1, format: (v) => v.toFixed(2) },
    {
      id: "mode",
      label: "FILTER",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "LP" },
        { value: 1, label: "BP" },
        { value: 2, label: "HP" },
      ],
    },
    { id: "keytrack", label: "KEY TRK", min: 0, max: 1, default: 0, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.01, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.25, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
    ...modMatrixParams(true),
  ];


export const granularParams: ParamDef[] = [
    { id: "position", label: "POSITION", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "size", label: "GRAIN", min: 0.02, max: 0.4, default: 0.09, unit: "s", format: formatMs },
    { id: "rate", label: "RATE", min: 1, max: 60, default: 14, unit: "/s", format: (v) => `${Math.round(v)}/s` },
    { id: "rateSync", label: "R SYNC", min: 0, max: 6, default: 0, options: SYNC_OPTIONS },
    { id: "jitter", label: "JITTER", min: 0, max: 1, default: 0.15, format: formatPct },
    {
      id: "scan",
      label: "SCAN",
      min: -2,
      max: 2,
      default: 0,
      format: (v) => (Math.abs(v) < 0.005 ? "HOLD" : `${v > 0 ? "+" : ""}${v.toFixed(2)}/s`),
    },
    { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0.5, format: formatPct },
    {
      id: "pitch",
      label: "PITCH",
      min: -24,
      max: 24,
      default: 0,
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st`,
    },
    {
      id: "pRand",
      label: "P RAND",
      min: 0,
      max: 12,
      default: 0,
      unit: "st",
      format: (v) => `±${v.toFixed(1)} st`,
    },
    { id: "reverse", label: "REVERSE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "tone", label: "TONE", min: 200, max: 16000, default: 9000, unit: "Hz", format: formatHz, taper: "log" },
    { id: "shape", label: "SHAPE", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.02, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 3, default: 0.4, unit: "s", format: formatMs },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.8, format: formatPct },
  ];


export const fmParams: ParamDef[] = [
    {
      id: "ratio",
      label: "RATIO",
      min: 0.25,
      max: 16,
      default: 2,
      format: (v) => v.toFixed(2),
    },
    { id: "index", label: "INDEX", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "modDecay", label: "M-DECAY", min: 0.02, max: 3, default: 0.4, unit: "s", format: formatMs },
    { id: "modSustain", label: "M-SUS", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "feedback", label: "FEEDBK", min: 0, max: 1, default: 0.15, format: formatPct },
    { id: "fbDecay", label: "FB-DECAY", min: 0.02, max: 3, default: 0.5, unit: "s", format: formatMs },
    { id: "fbSus", label: "FB-SUS", min: 0, max: 1, default: 1, format: formatPct },
    {
      id: "modWave",
      label: "M-WAVE",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "SIN" },
        { value: 1, label: "TRI" },
        { value: 2, label: "SQR" },
      ],
    },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.003, unit: "s", format: formatMs },
    { id: "decay", label: "DECAY", min: 0.01, max: 3, default: 0.5, unit: "s", format: formatMs },
    { id: "sustain", label: "SUSTAIN", min: 0, max: 1, default: 0.45, format: formatPct },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.4, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
  ];


export const keysParams: ParamDef[] = [
    { id: "tine", label: "TINE", min: 0, max: 1, default: 0.55, format: formatPct },
    { id: "bell", label: "BELL", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "damp", label: "DAMP", min: 0, max: 1, default: 0.45, format: formatPct },
    { id: "tremolo", label: "TREM", min: 0, max: 1, default: 0.15, format: formatPct },
    { id: "ratio", label: "RATIO", min: 1, max: 7, default: 3.5, format: (v) => v.toFixed(2) },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "unison", label: "UNISON", min: 1, max: 3, default: 1, format: (v) => `${Math.round(v)}×` },
    { id: "spread", label: "SPREAD", min: 0, max: 25, default: 7, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 4500, unit: "Hz", format: formatHz, taper: "log" },
    { id: "resonance", label: "RESO", min: 0.1, max: 8, default: 1.8, format: (v) => v.toFixed(2) },
    {
      id: "mode",
      label: "FILTER",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "LP" },
        { value: 1, label: "BP" },
        { value: 2, label: "HP" },
      ],
    },
    { id: "keytrack", label: "KEY TRK", min: 0, max: 1, default: 0, format: formatPct },
    {
      id: "lfoRate",
      label: "LFO RATE",
      min: 0,
      max: 16,
      default: 0,
      unit: "Hz",
      format: (v) => (v < 0.05 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
    { id: "lfoSync", label: "LFO SYNC", min: 0, max: 6, default: 0, options: SYNC_OPTIONS },
    { id: "lfoDepth", label: "LFO DEPTH", min: 0, max: 1, default: 0, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.005, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.35, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -8, unit: "dB", format: formatDb },
    ...modMatrixParams(false),
  ];


export const pluckParams: ParamDef[] = [
    { id: "pick", label: "PICK", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "damp", label: "DAMP", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "tone", label: "TONE", min: 300, max: 8000, default: 3500, unit: "Hz", format: formatHz, taper: "log" },
    { id: "decay", label: "DECAY", min: 0.1, max: 4, default: 0.9, unit: "s", format: formatSec },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 9000, unit: "Hz", format: formatHz, taper: "log" },
    { id: "resonance", label: "RESO", min: 0.1, max: 8, default: 1.2, format: (v) => v.toFixed(2) },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.002, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.3, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -8, unit: "dB", format: formatDb },
    ...modMatrixParams(false),
  ];


export const logdrumParams: ParamDef[] = [
    { id: "decay", label: "DECAY", min: 0.15, max: 3.5, default: 1.1, unit: "s", format: formatSec },
    { id: "pitchDrop", label: "DROP", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "dropSplay", label: "D SPLAY", min: 0, max: 1, default: 0, format: formatPct },
    { id: "tone", label: "TONE", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "hollow", label: "HOLLOW", min: 0, max: 1, default: 0.45, format: formatPct },
    { id: "grit", label: "GRIT", min: 0, max: 1, default: 0.12, format: formatPct },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "glide", label: "GLIDE", min: 0, max: 1, default: 0.34, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
    ...modMatrixParams(false),
  ];


export const spectralParams: ParamDef[] = [
    { id: "profile", label: "PROFILE", min: 0, max: 4, default: 0, options: SPECTRAL_PROFILE_OPTIONS },
    { id: "partials", label: "PARTIALS", min: 2, max: 8, default: 6, format: (v) => `${Math.round(v)}` },
    { id: "spacing", label: "SPACING", min: 0.5, max: 2, default: 1, format: (v) => `${v.toFixed(2)}×` },
    { id: "inharm", label: "INHARM", min: 0, max: 1, default: 0.12, format: formatPct },
    { id: "shimmer", label: "SHIMMER", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "skew", label: "SKEW", min: 0, max: 1, default: 0.45, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 4, default: 0.6, unit: "s", format: formatSec },
    { id: "release", label: "TAIL", min: 0.05, max: 8, default: 3, unit: "s", format: formatSec },
    { id: "cutoff", label: "CUTOFF", min: 200, max: 16000, default: 6000, unit: "Hz", format: formatHz, taper: "log" },
    { id: "resonance", label: "RESO", min: 0.1, max: 12, default: 0.8, format: (v) => v.toFixed(2) },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -12, unit: "dB", format: formatDb },
    {
      id: "motion",
      label: "MOTION",
      min: 0,
      max: 1,
      default: 0,
      options: [
        { value: 0, label: "OFF" },
        { value: 1, label: "ROTARY" },
      ],
    },
    {
      id: "motionRate",
      label: "M RATE",
      min: 0.3,
      max: 8,
      default: 0.8,
      unit: "Hz",
      format: (v) => `${v.toFixed(2)} Hz`,
      taper: "log",
    },
    { id: "motionSync", label: "M SYNC", min: 0, max: 6, default: 0, options: SYNC_OPTIONS },
    ...modMatrixParams(false),
  ];


export const vocalchopParams: ParamDef[] = [
    { id: "root", label: "ROOT", min: 24, max: 84, default: 60, format: (v) => `${Math.round(v)}` },
    { id: "vowel", label: "VOWEL", min: 0, max: 4, default: 0, options: VOWEL_OPTIONS },
    { id: "color", label: "COLOR", min: 0, max: 1, default: 0.85, format: formatPct },
    {
      id: "shift",
      label: "SHIFT",
      min: 0.7,
      max: 1.5,
      default: 1,
      format: (v) => `${v.toFixed(2)}×`,
    },
    { id: "sharp", label: "SHARP", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "vib", label: "VIB", min: 0, max: 1, default: 0, format: formatPct },
    { id: "cons", label: "CONS", min: 0, max: 1, default: 0, format: formatPct },
    { id: "morph", label: "MORPH", min: 0, max: 1, default: 0, format: formatPct },
    { id: "tone", label: "TONE", min: 500, max: 16000, default: 12000, unit: "Hz", format: formatHz, taper: "log" },
    { id: "reverse", label: "REVERSE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 1, default: 0.005, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 2, default: 0.15, unit: "s", format: formatMs },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.85, format: formatPct },
    ...modMatrixParams(false, { cutoff: false }),
  ];


export const drumsynthParams: ParamDef[] = [
    { id: "type", label: "TYPE", min: 0, max: 12, default: 0, options: DRUM_TYPE_OPTIONS },
    {
      id: "tune",
      label: "TUNE",
      min: -12,
      max: 12,
      default: 0,
      unit: "st",
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} st`,
    },
    { id: "tone", label: "TONE", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "decay", label: "DECAY", min: 0.05, max: 2, default: 0.4, unit: "s", format: formatSec },
    { id: "snap", label: "SNAP", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
  ];

/* ---------------- pure registry ---------------- */

/** Metadata half of an instrument definition (params without the runtime). */
export interface InstrumentDefinitionMeta {
  kind: InstrumentKind;
  name: string;
  params: ParamDef[];
}

/** kind/name/params for every instrument kind — no runtime attached. */
export const INSTRUMENT_META: Record<InstrumentKind, InstrumentDefinitionMeta> = {
  analog: { kind: "analog", name: "Analog Synth", params: analogParams },
  bass: { kind: "bass", name: "Bass Synth", params: bassParams },
  808: { kind: "808", name: "808 Synth", params: bass808Params },
  sampler: { kind: "sampler", name: "Sampler", params: samplerParams },
  texture: { kind: "texture", name: "Texture Synth", params: textureParams },
  wavetable: { kind: "wavetable", name: "Wavetable Synth", params: wavetableParams },
  granular: { kind: "granular", name: "Granular Synth", params: granularParams },
  fm: { kind: "fm", name: "FM", params: fmParams },
  keys: { kind: "keys", name: "Keys", params: keysParams },
  pluck: { kind: "pluck", name: "Pluck Synth", params: pluckParams },
  logdrum: { kind: "logdrum", name: "Log Drum", params: logdrumParams },
  spectral: { kind: "spectral", name: "Spectral Pad", params: spectralParams },
  vocalchop: { kind: "vocalchop", name: "Vocal Chop", params: vocalchopParams },
  drumsynth: { kind: "drumsynth", name: "Drum Synth", params: drumsynthParams },
};

export const INSTRUMENT_ORDER: InstrumentKind[] = [
  "sampler",
  "analog",
  "bass",
  "808",
  "texture",
  "wavetable",
  "granular",
  "keys",
  "fm",
  "pluck",
  "logdrum",
  "spectral",
  "vocalchop",
  "drumsynth",
];

export function defaultInstrumentParams(kind: InstrumentKind): Record<string, number> {
  return Object.fromEntries(INSTRUMENT_META[kind].params.map((p) => [p.id, p.default]));
}

export function clampInstrumentParam(kind: InstrumentKind, paramId: string, value: number): number {
  const def: ParamDef | undefined = INSTRUMENT_META[kind].params.find((p) => p.id === paramId);
  if (!def) return value;
  return Math.min(def.max, Math.max(def.min, value));
}
