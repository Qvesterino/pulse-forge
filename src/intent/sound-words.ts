import type { Command } from "../commands/types";
import type { DrumTrack, ProjectDocument } from "../project-model/types";
import { setPadParams, setStepMeta, setStepVelocityCommand, snapshot } from "../commands/commands";
import { FACTORY_ASSETS } from "../sample-library/manifest";

/**
 * SOUND WORDS — step-level edits and pad sound swaps (Phase B of
 * docs/INTENT-MCP-EXPANSION-PLAN.md).
 *
 * STEP EDITS — "remove the kick on beat 3 of bar 2", "add a ghost snare on
 * the last 16th", "accent the kick on beat 1". Bars/beats are HUMAN 1-based;
 * the adapter converts to pattern step indexes and refuses out-of-range
 * bars explicitly (a 16-step pattern is one bar). Folded into ONE snapshot.
 *
 * SOUND SWAP — "swap the snare to something fatter", "make the kick
 * darker". The DESCRIPTOR maps to factory-asset mood/tags scoring within
 * the pad family's category; the current asset is excluded. One undo step
 * per family-wide swap. No candidate → explicit failure, never a guess.
 */

export interface StepEditIntent {
  action: "remove" | "ghost" | "accent";
  family: "kick" | "snare" | "clap" | "hat" | "perc" | "tom";
  bar?: number;
  beat?: number;
  last16th?: boolean;
}

const FAMILY_WORDS: ReadonlyArray<readonly [RegExp, StepEditIntent["family"]]> = [
  [/\bkick\b|\bkop[áa]k/i, "kick"],
  [/\bsnare\b|\bgentle\b|\bvenov/i, "snare"],
  [/\bclap\b|\btliesk/i, "clap"],
  [/\bhat\b|\bhi-?hat\b|\bÄinel/i, "hat"],
  [/\bperc\b|\bperkus/i, "perc"],
  [/\btom\b/i, "tom"],
];

const STEP_EDIT_ASK =
  /\b(?:remove|delete|cut|zmaz|odstraÅ|odstran|drop)\b|\b(?:add|ghost|pridaj)\b|\baccent\b|\bzv\u00fdrazni\b/i;

export function parseStepEditIntent(text: string): StepEditIntent | null {
  if (!STEP_EDIT_ASK.test(text)) return null;
  const family = FAMILY_WORDS.find(([re]) => re.test(text))?.[1];
  if (!family) return null;
  if (!/\b(?:beat|step|16th|takte?|šestnástine?)\b/i.test(text)) return null; // position required

  const barMatch = /\bbar\s*(\d{1,2})\b|\btakt(?:e|u)?\s*(\d{1,2})\b/i.exec(text);
  const beatMatch = /\bbeat\s*(\d{1,2})\b|\bštvrtin[ea]\s*(\d{1,2})\b/i.exec(text);
  const last16th = /\blast\s*16th|posledn[ýy]\s*16(?:th)?|posledn[áa]\s*šestn[iá]stin/i.test(text);
  const bar = barMatch ? Number(barMatch[1] ?? barMatch[2]) : undefined;
  const beat = beatMatch ? Number(beatMatch[1] ?? beatMatch[2]) : undefined;

  let action: StepEditIntent["action"];
  if (/\b(?:remove|delete|cut|zmaz|odstran|odstraÅ|drop)\b/i.test(text)) action = "remove";
  else if (/\bghost\b/i.test(text)) action = "ghost";
  else if (/\b(?:accent|harder)\b|\bzv\u00fdrazni\b/i.test(text)) action = "accent";
  else if (/\b(?:add|pridaj)\b/i.test(text)) action = "ghost";
  else return null;

  return {
    action,
    family,
    ...(bar != null ? { bar } : {}),
    ...(beat != null ? { beat } : {}),
    ...(last16th ? { last16th: true } : {}),
  };
}

/** 1-based bar/beat (or last16th) → 0-based step index within the pattern. */
function stepIndexOf(stepCount: number, intent: StepEditIntent): number | { error: string } {
  const bar = intent.bar ?? 1;
  const beat = intent.beat ?? 1;
  if (intent.last16th) return stepCount - 1;
  const stepsPerBar = 16;
  if (bar > Math.floor(stepCount / stepsPerBar)) {
    return { error: `pattern mÃ¡ ${Math.floor(stepCount / stepsPerBar)} taktov â bar ${bar} neexistuje` };
  }
  if (beat > 4) return { error: `beat ${beat} neexistuje (takte sÃº 4)` };
  return (bar - 1) * stepsPerBar + (beat - 1) * 4;
}

const GHOST_VELOCITY = 0.35;

export function applyStepEditIntent(doc: ProjectDocument, intent: StepEditIntent): Command | null {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) return null;
  const step = stepIndexOf(pattern.stepCount, intent);
  if (typeof step === "object") throw new Error(step.error);

  const drums = doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
  if (drums.length === 0) return null;
  const familyRole = intent.family === "hat" ? "hat" : intent.family;

  let next = doc;
  const labels: string[] = [];
  let touched = 0;
  for (const track of drums) {
    for (const pad of track.pads) {
      const role = inferRole(pad.name, track.pads.indexOf(pad));
      if (role !== familyRole) continue;
      const velocity = pattern.rows[pad.id]?.[step] ?? 0;

      if (intent.action === "remove") {
        if (velocity <= 0) continue;
        next = setStepVelocityCommand(next, pad.id, step, 0).execute(next);
        labels.push(`${pad.name} â`);
        touched += 1;
      } else if (intent.action === "ghost") {
        if (velocity > 0) continue; // ghost only lands on empty steps
        next = setStepVelocityCommand(next, pad.id, step, GHOST_VELOCITY).execute(next);
        next = setStepMeta(next, pattern.id, pad.id, step, { probability: 0.5 }).execute(next);
        labels.push(`${pad.name} ghost`);
        touched += 1;
      } else {
        // accent: only steps that already hit get full velocity
        if (velocity <= 0) continue;
        next = setStepVelocityCommand(next, pad.id, step, 1).execute(next);
        labels.push(`${pad.name} accent`);
        touched += 1;
      }
    }
  }
  if (touched === 0) return null;
  return snapshot("applyStepEditIntent", `Steps: ${labels.join(", ")}`, doc, next);
}

// inferRole lives in ai/pad-roles (already the fader's source of truth)
import { inferPadRole } from "../ai/pad-roles";
function inferRole(name: string, index: number): string {
  return inferPadRole(name, index);
}

// ── SOUND SWAP — descriptor â factory asset within the pad family ─────────

export interface SoundSwapIntent {
  family: StepEditIntent["family"];
  descriptor: "fatter" | "thinner" | "tighter" | "darker" | "brighter" | "harder" | "softer";
}

const SWAP_ASK = /\b(?:swap|replace|change|vymen|zamen|cono)\b/i;
const DESCRIPTORS: ReadonlyArray<readonly [RegExp, SoundSwapIntent["descriptor"]]> = [
  [/\bfatter\b|\bdeeper\b|\bdlhÅ¾\b|\bÅ¥aÅ¾Å¡\w*/i, "fatter"],
  [/\bthinner\b|\bthinner\b|\btenÅ¡\w*/i, "thinner"],
  [/\btight(?:er)?\b|\bpevnej\b/i, "tighter"],
  [/\bdarker\b|\btmavÅ¡\w*/i, "darker"],
  [/\bbrighter\b|\bsvetlejÅ¡\w*/i, "brighter"],
  [/\bharder\b|\baggressiv/i, "harder"],
  [/\bsofter\b|\bjemnej\b/i, "softer"],
];

const FAMILY_CATEGORY: Record<StepEditIntent["family"], string> = {
  kick: "Kick",
  snare: "Snare",
  clap: "Clap",
  hat: "Hat",
  perc: "Percussion",
  tom: "Tom",
};

const DESCRIPTOR_MOOD: Partial<Record<SoundSwapIntent["descriptor"], string>> = {
  fatter: "deep",
  darker: "dark",
  brighter: "bright",
  harder: "aggressive",
};

export function parseSoundSwapIntent(text: string): SoundSwapIntent | null {
  if (!SWAP_ASK.test(text)) return null;
  const family = FAMILY_WORDS.find(([re]) => re.test(text))?.[1];
  if (!family) return null;
  const descriptor = DESCRIPTORS.find(([re]) => re.test(text))?.[1];
  if (!descriptor) return null;
  return { family, descriptor };
}

export function applySoundSwapIntent(doc: ProjectDocument, intent: SoundSwapIntent): Command | null {
  const drums = doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
  const category = FAMILY_CATEGORY[intent.family];
  const familyPads: Array<{ padId: string; assetId: string | null }> = [];
  for (const track of drums) {
    for (const [index, pad] of track.pads.entries()) {
      if (inferRole(pad.name, index) !== intent.family) continue;
      familyPads.push({ padId: pad.id, assetId: pad.assetId });
    }
  }
  if (familyPads.length === 0) return null;
  const current = new Set(familyPads.map((entry) => entry.assetId));

  // score candidates in the family category: descriptor stem in name/tags/
  // character +1, mood hit +2; current assets excluded
  const stem = intent.descriptor.slice(0, 5);
  let best: { id: string; score: number } | null = null;
  for (const asset of FACTORY_ASSETS) {
    if (asset.category !== category) continue;
    if (current.has(asset.id)) continue;
    let score = 0;
    if (
      DESCRIPTOR_MOOD[intent.descriptor] != null &&
      asset.mood.includes(DESCRIPTOR_MOOD[intent.descriptor] as never)
    ) {
      score += 2;
    }
    if (
      asset.name.toLowerCase().includes(stem) ||
      asset.tags.some((tag) => tag.toLowerCase().includes(stem)) ||
      asset.character.toLowerCase().includes(stem)
    ) {
      score += 1;
    }
    if (score === 0) continue;
    if (!best || score > best.score) best = { id: asset.id, score };
  }
  if (!best) return null;

  let next = doc;
  let swapped = 0;
  for (const entry of familyPads) {
    if (entry.assetId === best.id) continue;
    next = setPadParams(next, entry.padId, { assetId: best.id }).execute(next);
    swapped += 1;
  }
  if (swapped === 0) return null;
  return snapshot("applySoundSwapIntent", `Swap ${intent.family} â ${best.id} (${intent.descriptor})`, doc, next);
}

/** Read-back: the family's current assets after the swap. */
export function soundSwapReadback(after: ProjectDocument, family: StepEditIntent["family"]): string {
  const drums = after.tracks.filter((t): t is DrumTrack => t.kind === "drum");
  const entries: string[] = [];
  for (const track of drums) {
    for (const [index, pad] of track.pads.entries()) {
      if (inferRole(pad.name, index) === family) {
        entries.push(`${pad.name} â ${pad.assetId ?? "synth"}`);
      }
    }
  }
  return entries.slice(0, 4).join(", ");
}
