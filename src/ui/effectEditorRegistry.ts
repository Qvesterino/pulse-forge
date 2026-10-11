import type { EffectType } from "../project-model/types";
import { EFFECT_DEFS } from "../effects/registry";

/** UI-level grouping and first-view controls; independent from the DSP registry. */
export type EffectEditorFamily = (typeof EFFECT_DEFS)[EffectType]["category"];

export interface EffectEditorSpec {
  family: EffectEditorFamily;
  primaryParamIds?: readonly string[];
}

const PORTAL_PRIMARY_BY_MODE: ReadonlyArray<readonly string[]> = [
  ["mode", "time", "feedback", "mix"],
  ["mode", "focus", "resonance", "mix"],
  ["mode", "feedback", "decay", "mix"],
];
const PORTAL_MODE_LABELS = ["DELAY", "RESONATOR", "FREEZE"] as const;
const PORTAL_ACTIVE_PARAMS_BY_MODE: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["mode", "time", "sync", "feedback", "decay", "shift", "diffuse", "freeze", "drive", "tone", "mix"]),
  new Set(["mode", "resonance", "focus", "focusWidth", "drive", "tone", "mix"]),
  new Set([
    "mode",
    "time",
    "sync",
    "feedback",
    "decay",
    "shift",
    "diffuse",
    "resonance",
    "focus",
    "focusWidth",
    "drive",
    "tone",
    "mix",
  ]),
];

const EDITOR_OVERRIDES: Partial<Record<EffectType, Pick<EffectEditorSpec, "primaryParamIds">>> = {
  eq: { primaryParamIds: ["hpFreq", "lowShelfGain", "lowMidGain", "highShelfGain"] },
  compressor: { primaryParamIds: ["threshold", "ratio", "attack", "release"] },
  kaskada: { primaryParamIds: ["time", "sync", "feedback", "mix"] },
  // Frequency Shifter: the four headline controls on page 1; sweep detail
  // (fine, side, LFO), echo loop, drive/tone and spread live on later pages.
  freqShifter: { primaryParamIds: ["shift", "side", "lfoDepth", "mix"] },
  // Reverse Swell: the gesture controls first (arm + length + shape);
  // reach/tone/level live on the details page.
  reverseSwell: { primaryParamIds: ["engaged", "time", "curve", "mix"] },
  // Granular Freeze: the hold gesture first (freeze + window + drift + mix);
  // grain size/scatter/pitch/tone/level live on the details page.
  granularFreeze: { primaryParamIds: ["freeze", "window", "drift", "mix"] },
  // Vinyl Suite: the age macro + the three headline artefacts on page 1;
  // module detail (tones, decay, rates, drive, trims) lives on later pages.
  vinyl: { primaryParamIds: ["amount", "crackle", "hiss", "wow"] },
  // GROW: the four controls the "phone speakers" move actually turns —
  // generator strength, tracking focus, sub retention, blend.
  bassHarmonic: { primaryParamIds: ["drive", "focusHz", "presence", "mix"] },
  // TWIST: the character controls first — smear amount, transient tilt,
  // where the hump sits, and stereo split; mix/output live on the details page.
  skrutka: { primaryParamIds: ["dispersion", "punch", "focusHz", "spread"] },
  // PORTAL's first page follows MODE: DELAY surfaces time/feedback, RESONATOR
  // surfaces focus/strength, and FREEZE surfaces feedback/decay. Mix stays in
  // the shared quick-control strip; inactive mode-specific values are explained.
  portal: { primaryParamIds: ["mode", "time", "feedback", "mix"] },
  // REZONANS: the four decisions that define the sound — how far the formants
  // move, which musical rule the voices obey, how many of them sing, and how
  // far they are spread. Detection and output live on the details page; the
  // 24 per-voice parameters are edited in the panel's own voice table.
  rezonans: { primaryParamIds: ["formant", "harmony.mode", "harmony.voices", "harmony.spread"] },
};

/**
 * Every effect inherits a family from its audio definition. Only effects that
 * need a curated first page need an override here, so new effects get a usable
 * editor without adding another render branch.
 */
export function effectEditorSpec(type: EffectType, values: Readonly<Record<string, number>> = {}): EffectEditorSpec {
  const spec = { family: EFFECT_DEFS[type].category, ...EDITOR_OVERRIDES[type] };
  if (type !== "portal") return spec;
  const mode = portalModeIndex(values.mode);
  return { ...spec, primaryParamIds: PORTAL_PRIMARY_BY_MODE[mode] };
}

/** Plain-language note for controls whose values are stored but inactive now. */
export function portalParamModeHint(paramId: string, modeValue: number): string | undefined {
  if (paramId === "mode") return undefined;
  const mode = portalModeIndex(modeValue);
  if (PORTAL_ACTIVE_PARAMS_BY_MODE[mode]!.has(paramId)) return undefined;

  if (paramId === "freeze" && mode === 2) {
    return "FREEZE mode already holds the spectrum; this switch is used by DELAY mode.";
  }

  const activeModes = PORTAL_ACTIVE_PARAMS_BY_MODE.flatMap((params, index) =>
    params.has(paramId) ? [PORTAL_MODE_LABELS[index]!] : [],
  );
  if (activeModes.length === 0) return undefined;
  return `Not used in ${PORTAL_MODE_LABELS[mode]} mode; this saved value applies in ${activeModes.join(" and ")}.`;
}

function portalModeIndex(value: number | undefined): number {
  const raw = value ?? 0;
  return Number.isFinite(raw) ? Math.max(0, Math.min(2, Math.round(raw))) : 0;
}
