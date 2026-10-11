/**
 * REZONANS — parameter contract.
 *
 * ONE SCALE, USED EVERYWHERE. The doc layer, the node bridge and the DSP all
 * speak the same musical units (semitones, Hz, ratios, 0..1), so there is no
 * deep-scale translation layer and therefore nothing to register in
 * `src/effects/scale-bridges.ts`. That is a deliberate divergence from MORPH
 * (which stores 0..1 in the doc and wants 0..100 in the DSP and bridges at the
 * node): the bridge is exactly the kind of indirection that produces
 * "automated in the wrong scale" defects, and REZONANS has no use for it.
 *
 * Namespaced ids follow the flagship convention (`harmony.*`, `detect.*`,
 * `voice{n}.*`).
 */

export const REZ_PARAM = {
  mix: "mix",
  glide: "glide",
  quality: "quality",
  formant: "formant",
  formantVoiceScale: "formant.voiceScale",
  envelopeSmooth: "envelope.smooth",
  harmonyMode: "harmony.mode",
  voices: "harmony.voices",
  spread: "harmony.spread",
  width: "harmony.width",
  chordFollow: "harmony.chordFollow",
  bodyGate: "harmony.bodyGate",
  minHz: "detect.minHz",
  clarity: "detect.clarity",
} as const;

export type RezParamId = (typeof REZ_PARAM)[keyof typeof REZ_PARAM];

export const VOICE_COUNT = 4;
export const VOICE_FIELDS = ["enabled", "degree", "level", "pan", "formant", "humanize"] as const;
export type VoiceField = (typeof VOICE_FIELDS)[number];

/** Per-voice parameter id, e.g. `voice2.formant`. */
export function voiceParamId(voice: number, field: VoiceField): string {
  return `voice${voice}.${field}`;
}

/** Every parameter id REZONANS owns, including all per-voice params. */
export function allParamIds(): string[] {
  const ids: string[] = Object.values(REZ_PARAM);
  for (let i = 0; i < VOICE_COUNT; i++) {
    for (const f of VOICE_FIELDS) ids.push(voiceParamId(i, f));
  }
  return ids;
}

/** Quality tiers → FFT size. The size is what drives both CPU and latency. */
export const QUALITY_ECONOMY = 0;
export const QUALITY_BALANCED = 1;
export const QUALITY_FINE = 2;
export const QUALITY_FFT_SIZE: Record<number, number> = {
  [QUALITY_ECONOMY]: 1024,
  [QUALITY_BALANCED]: 2048,
  [QUALITY_FINE]: 4096,
};

/** Synthesis hop is a quarter of the window (75 % overlap). */
export function hopFor(fftSize: number): number {
  return fftSize >> 2;
}

export interface RezParamDef {
  id: string;
  min: number;
  max: number;
  def: number;
}

/** Default per-voice values: a 3rd / 5th / octave / octave-below stack. */
const VOICE_DEFAULTS: Record<VoiceField, number[]> = {
  enabled: [1, 1, 1, 0],
  degree: [3, 7, 12, 0],
  level: [0.7, 0.7, 0.7, 0.7],
  pan: [-0.6, -0.2, 0.2, 0.6],
  formant: [0, 0, 0, 0],
  humanize: [0.15, 0.15, 0.15, 0.15],
};

const VOICE_RANGES: Record<VoiceField, { min: number; max: number }> = {
  enabled: { min: 0, max: 1 },
  // 0..14 covers a two-octave scale degree span (an octave is 7-8 steps).
  degree: { min: 0, max: 14 },
  level: { min: 0, max: 1.5 },
  pan: { min: -1, max: 1 },
  formant: { min: -12, max: 12 },
  humanize: { min: 0, max: 1 },
};

export const REZONANS_PARAMS: RezParamDef[] = [
  { id: REZ_PARAM.mix, min: 0, max: 1, def: 0.5 },
  { id: REZ_PARAM.glide, min: 0, max: 1, def: 0.35 },
  { id: REZ_PARAM.quality, min: QUALITY_ECONOMY, max: QUALITY_FINE, def: QUALITY_BALANCED },
  { id: REZ_PARAM.formant, min: -12, max: 12, def: 0 },
  { id: REZ_PARAM.formantVoiceScale, min: 0, max: 1, def: 1 },
  { id: REZ_PARAM.envelopeSmooth, min: 0, max: 1, def: 0.5 },
  // 0 = off, 1 = interval, 2 = degrees, 3 = chordTones.
  { id: REZ_PARAM.harmonyMode, min: 0, max: 3, def: 2 },
  { id: REZ_PARAM.voices, min: 1, max: VOICE_COUNT, def: VOICE_COUNT },
  { id: REZ_PARAM.spread, min: 0, max: 2, def: 1 },
  { id: REZ_PARAM.width, min: 0, max: 2, def: 1 },
  { id: REZ_PARAM.chordFollow, min: 0, max: 1, def: 1 },
  { id: REZ_PARAM.bodyGate, min: 0, max: 1, def: 0.5 },
  { id: REZ_PARAM.minHz, min: 50, max: 200, def: 70 },
  { id: REZ_PARAM.clarity, min: 0, max: 1, def: 0.75 },
  ...Array.from({ length: VOICE_COUNT }, (_, i) =>
    VOICE_FIELDS.map((f) => ({
      id: voiceParamId(i, f),
      min: VOICE_RANGES[f].min,
      max: VOICE_RANGES[f].max,
      def: VOICE_DEFAULTS[f][i] ?? 0,
    })),
  ).flat(),
];

const BY_ID = new Map<string, RezParamDef>(REZONANS_PARAMS.map((p) => [p.id, p]));

export function paramDef(id: string): RezParamDef | undefined {
  return BY_ID.get(id);
}

/** Full default map (every id present). */
export function buildDefaultParams(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of REZONANS_PARAMS) out[p.id] = p.def;
  return out;
}

/** Clamp to the declared range; unknown ids and non-finite values fall back. */
export function clampParam(id: string, value: number): number {
  const def = BY_ID.get(id);
  if (!def) return 0;
  if (!Number.isFinite(value)) return def.def;
  return value < def.min ? def.min : value > def.max ? def.max : value;
}

export const REZ_PARAM_COUNT = REZONANS_PARAMS.length;
