import type { DrumPad } from "../project-model/types";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import type { AssetCategory, AssetMood } from "../sample-library/manifest";

const CATEGORY_COLORS: Record<AssetCategory, string> = {
  Kick: "#f59e0b",
  Snare: "#fb7185",
  Clap: "#f472b6",
  Hat: "#34d399",
  Cymbal: "#4ade80",
  Crash: "#2dd4bf",
  Tom: "#a78bfa",
  Rim: "#facc15",
  Percussion: "#38bdf8",
  Tonal: "#22d3ee",
  FX: "#e879f9",
};

const MOOD_LABELS: Record<AssetMood, string> = {
  dark: "Dark",
  bright: "Bright",
  warm: "Warm",
  aggressive: "Aggressive",
  clean: "Clean",
  deep: "Deep",
  atmosphere: "Atmosphere",
};

const CATEGORY_LOOKUP = new Map(FACTORY_ASSETS.map((a) => [a.id, a.category] as const));

export function categoryColor(category: AssetCategory): string {
  return CATEGORY_COLORS[category];
}

export function moodLabel(mood: AssetMood): string {
  return MOOD_LABELS[mood];
}

export function assetCategoryOf(pad: DrumPad): AssetCategory {
  if (pad.assetId === null) return "Percussion";
  return CATEGORY_LOOKUP.get(pad.assetId) ?? "Percussion";
}
