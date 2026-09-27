import type { Command } from "../commands/types";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";
import { applyInstrumentPreset, resolveExactTargetTracks, snapshot } from "../commands/commands";
import { FACTORY_PRESETS } from "../presets/factory";
import type { InstrumentPreset } from "../presets/types";
import type { ExactTarget } from "./exact";

/**
 * PRESET INTENT — "load the Warm Sub preset on the bass" /
 * "načítaj preset deep sub na basu".
 *
 * The word "preset" is REQUIRED (bounded v1 — "load deep sub on the bass"
 * stays a generation prompt). Names match against the FACTORY registry
 * deaccented + case-insensitive with a three-tier score (exact > prefix >
 * includes) and a +1 bonus when the preset's instrument family fits the
 * named target. An unknown name is an EXPLICIT unknownPreset result with
 * family suggestions — never a silent fall-through to generation.
 *
 * Target families are the strict exact-target ones (bass/lead/chords): the
 * applier folds `applyInstrumentPreset` over EVERY track of the family (same
 * family-wide etiquette as the fader) as ONE undoable snapshot — params,
 * sampleId and presetId all restore on undo. Drums are not a preset target:
 * instrument presets do not apply to drum tracks (the drum-synth preset bank
 * has no intent surface yet).
 */

export type PresetTargetFamily = Extract<ExactTarget, "bass" | "lead" | "chords">;

export interface PresetIntent {
  preset: InstrumentPreset;
  target: PresetTargetFamily;
  matchedBy: "exact" | "prefix" | "includes";
}

const deaccent = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const TARGET_WORDS: ReadonlyArray<readonly [RegExp, PresetTargetFamily]> = [
  [/\b(?:bass|808|bas[au])\b/, "bass"],
  [/\b(?:chords?|keys?|akord\w*)\b/, "chords"],
  [/\b(?:lead|synth\w*|melodi\w*)\b/, "lead"],
];

const FAMILY_INSTRUMENTS: Record<PresetTargetFamily, ReadonlySet<string>> = {
  bass: new Set(["bass", "808", "logdrum"]),
  chords: new Set(["keys", "analog", "organ", "strings", "bell", "texture"]),
  lead: new Set([
    "pluck",
    "spectral",
    "flute",
    "brass",
    "acid",
    "fm",
    "reese",
    "wavetable",
    "granular",
    "vocalchop",
    "sampler",
  ]),
};

const PRESET_ASK =
  /\b(?:load|apply|use|nacitaj|pouzi|nahraj)\s+(?:the\s+)?(?:presets?\s+)?["']?(.+?)["']?\s*(?:presets?)?\s+(?:on|to|na)\s+(?:the\s+)?(bass|808|bas[au]|chords?|keys|akord\w*|lead|synth\w*|melodi\w*)\b/;

export type ParsedPresetIntent =
  { ok: true; intent: PresetIntent } | { ok: false; name: string; suggestions: string[] };

export function parsePresetIntent(text: string): ParsedPresetIntent | null {
  const lower = deaccent(text);
  if (!/\bpresets?\b/.test(lower)) return null;
  const ask = PRESET_ASK.exec(lower);
  if (!ask) return null;
  const targetFamily = TARGET_WORDS.find(([re]) => re.test(ask[2]))?.[1];
  if (!targetFamily) return null;
  const want = deaccent(ask[1]).replace(/\s+/g, " ").trim();
  if (want.length < 2) return null;

  let best: { preset: InstrumentPreset; score: number; matchedBy: PresetIntent["matchedBy"] } | null = null;
  for (const preset of FACTORY_PRESETS) {
    const name = deaccent(preset.name);
    let score = 0;
    let matchedBy: PresetIntent["matchedBy"] = "includes";
    if (name === want) {
      score = 3;
      matchedBy = "exact";
    } else if (name.startsWith(want)) {
      score = 2;
      matchedBy = "prefix";
    } else if (name.includes(want)) {
      score = 1;
      matchedBy = "includes";
    } else {
      continue;
    }
    if (FAMILY_INSTRUMENTS[targetFamily].has(preset.instrument)) score += 1;
    if (!best || score > best.score) best = { preset, score, matchedBy };
  }
  if (best) {
    return { ok: true, intent: { preset: best.preset, target: targetFamily, matchedBy: best.matchedBy } };
  }
  const suggestions = FACTORY_PRESETS.filter((p) => FAMILY_INSTRUMENTS[targetFamily].has(p.instrument))
    .slice(0, 3)
    .map((p) => p.name);
  return { ok: false, name: ask[1].trim(), suggestions };
}

/**
 * Fold the preset over EVERY track of the target family (the fader's
 * family-wide etiquette) as ONE undoable snapshot. Throws when the family
 * has no track in this project — an explicit ask lands or fails loudly.
 */
export function applyPresetIntentCommand(doc: ProjectDocument, intent: PresetIntent): Command {
  const ids = resolveExactTargetTracks(doc, intent.target);
  if (ids.length === 0) {
    throw new Error(`no track matches the "${intent.target}" family — add the track first or pick another target`);
  }
  let next = doc;
  for (const id of ids) next = applyInstrumentPreset(next, id, intent.preset).execute(next);
  return snapshot("applyPresetIntent", `Preset "${intent.preset.name}" → ${ids.length} track(s)`, doc, next);
}

/**
 * VERIFICATION READ-BACK — the preset ACTUALLY installed: every track of the
 * target family must carry this preset's id in the post-execution document.
 * ✓ per track; ✗ would mean the fold missed (a bug worth surfacing).
 */
export function presetReadback(after: ProjectDocument, intent: PresetIntent): string {
  const ids = resolveExactTargetTracks(after, intent.target);
  const entries = ids.map((id) => {
    const track = after.tracks.find((candidate): candidate is InstrumentTrack => candidate.id === id);
    if (!track) return "✗";
    return track.presetId === intent.preset.id ? `${track.name} ✓` : `${track.name} ✗`;
  });
  return entries.join(", ");
}
