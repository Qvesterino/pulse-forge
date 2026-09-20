import type { InstrumentPreset, PresetBpmRange, PresetEnergy, PresetMetadata, PresetUseCase } from "./types";

export const PRESET_USE_CASES: PresetUseCase[] = [
  "bass",
  "lead",
  "keys",
  "pad",
  "pluck",
  "texture",
  "vocal",
  "drums",
  "fx",
];

export const PRESET_ENERGIES: PresetEnergy[] = ["low", "medium", "high"];

const TOKEN_USE_CASES: Array<{ useCase: PresetUseCase; tokens: string[] }> = [
  { useCase: "fx", tokens: ["fx", "riser", "impact", "sweep", "reverse", "noise", "downlifter"] },
  { useCase: "vocal", tokens: ["vocal", "voice", "chop", "formant"] },
  { useCase: "bass", tokens: ["bass", "sub", "808", "reese", "body"] },
  { useCase: "pad", tokens: ["pad", "drone", "atmosphere", "wash"] },
  { useCase: "keys", tokens: ["keys", "chord", "piano", "organ"] },
  { useCase: "pluck", tokens: ["pluck", "arp", "arpeggio"] },
  { useCase: "lead", tokens: ["lead", "stab"] },
];

function tokensOf(preset: Pick<InstrumentPreset, "name" | "tags" | "mood">): string[] {
  return `${preset.name} ${preset.tags.join(" ")} ${preset.mood.join(" ")}`.toLowerCase().split(/[^a-z0-9]+/);
}

function hasAny(tokens: string[], needles: string[]): boolean {
  return needles.some((needle) => tokens.includes(needle));
}

function inferUseCase(preset: Pick<InstrumentPreset, "instrument" | "name" | "tags" | "mood">): PresetUseCase {
  // Bass-role instruments normalize against the bass plateau even when
  // play-style words match other families ("pluck", "stab", "impact"):
  // families are role plateaus, and a bass preset auditioned at e.g. pluck
  // loudness (-30.9) lands ~18 dB off at the clamp (factory.bass.house.pluck
  // measured -13.2 → -17.7; factory.808.score.impact measured -2.4 → -18.0).
  if (["bass", "808", "logdrum"].includes(preset.instrument)) return "bass";
  const tokens = tokensOf(preset);
  for (const entry of TOKEN_USE_CASES) if (hasAny(tokens, entry.tokens)) return entry.useCase;
  if (preset.instrument === "drumsynth") return "drums";
  if (["bass", "808", "logdrum"].includes(preset.instrument)) return "bass";
  if (preset.instrument === "vocalchop") return "vocal";
  if (preset.instrument === "keys" || preset.instrument === "sampler") return "keys";
  if (preset.instrument === "pluck") return "pluck";
  if (["texture", "granular"].includes(preset.instrument)) return "texture";
  if (preset.instrument === "spectral") return "pad";
  return "lead";
}

function inferEnergy(preset: Pick<InstrumentPreset, "name" | "tags" | "mood">): PresetEnergy {
  const tokens = tokensOf(preset);
  let score = 0;
  if (hasAny(tokens, ["aggressive"])) score += 2;
  if (hasAny(tokens, ["bright", "punchy", "heavy", "driving", "gritty"])) score += 1;
  if (hasAny(tokens, ["clean", "warm", "deep", "atmosphere", "soft", "round"])) score -= 1;
  return score >= 2 ? "high" : score <= -1 ? "low" : "medium";
}

function bpmRangeFor(genre: InstrumentPreset["genre"]): PresetBpmRange {
  switch (genre) {
    case "house":
      return { min: 115, max: 135 };
    case "techno":
      return { min: 120, max: 150 };
    case "trap":
      return { min: 65, max: 95 };
    case "ambient":
      return { min: 50, max: 110 };
    case "score":
      return { min: 50, max: 140 };
    default:
      return { min: 60, max: 140 };
  }
}

function isValidMetadata(value: PresetMetadata | undefined): value is PresetMetadata {
  if (!value || typeof value !== "object") return false;
  const range = value.bpmRange;
  return Boolean(
    PRESET_USE_CASES.includes(value.useCase) &&
    PRESET_ENERGIES.includes(value.energy) &&
    value.keySuitability === "any" &&
    range &&
    typeof range === "object" &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.min >= 20 &&
    range.max <= 300 &&
    range.min <= range.max &&
    ["KYX factory", "user library"].includes(value.source) &&
    ["internal", "user-owned", "unknown"].includes(value.license),
  );
}

/** Return stable metadata for factory and legacy user presets alike. */
export function getPresetMetadata(preset: InstrumentPreset): PresetMetadata {
  if (isValidMetadata(preset.metadata)) return preset.metadata;
  const factory = preset.user !== true && preset.id.startsWith("factory.");
  return {
    useCase: inferUseCase(preset),
    energy: inferEnergy(preset),
    keySuitability: "any",
    bpmRange: bpmRangeFor(preset.genre),
    source: factory ? "KYX factory" : "user library",
    license: factory ? "internal" : preset.user ? "user-owned" : "unknown",
  };
}

/** Attach only the derived catalog field; audio/project parameters stay untouched. */
export function withPresetMetadata(preset: InstrumentPreset): InstrumentPreset {
  return { ...preset, metadata: getPresetMetadata(preset) };
}
