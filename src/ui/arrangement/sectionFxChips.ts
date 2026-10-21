import type { ProjectDocument } from "../../project-model/types";
import type { EffectType } from "../../project-model/types";
import { EFFECT_META } from "../../effects/definitions";

/**
 * The FX chips of an arrangement section — a LEAF module.
 *
 * WHY THIS FILE EXISTS (boot-path seam, 2026-10-21).
 *
 * `sectionFxChips` used to live in `src/intent/song.ts`. That module is the
 * song-generation god-module: 122 KB of source that pulls the whole AI stack
 * (normalize, plan, pipeline, multi-voice, harmony, quality, transitions,
 * genre-kit, mix, preference-ledger, personal-ranker, prosody, vocal/form…).
 *
 * The ArrangementPanel — a MAIN surface, so it is boot-critical by nature —
 * imported exactly ONE function from it. One function dragged the entire
 * intent engine into the studio boot path, and the boot path is what a
 * waiting user actually parses.
 *
 * So the derivation moved here, to a module that depends on the document and
 * the effect registry and on nothing else. `EFFECT_META` is already
 * boot-critical (the effects registry is), so this file adds no new weight to
 * the boot path — it REMOVES the intent engine from it.
 *
 * The rule this file exists to protect: a boot-critical surface imports the
 * HOME module of what it uses, never a barrel or a god-module that happens to
 * export it. `tests/boot-path-seam.test.ts` walks the static import graph
 * from the app entry and fails if the intent engine becomes boot-critical
 * again.
 */

/** One derived FX chip for an arrangement section (wave: FX chips UI). */
export interface SectionFxChip {
  type: EffectType;
  /** Display name from the effect registry. */
  label: string;
  /** True when the section automates the device with a sweep (riser/closing). */
  sweep: boolean;
}

/**
 * Derive the FX chips shown on an arrangement section: every device with a
 * sceneAutomation lane in this scene, one chip per device, `sweep` when the
 * lane's value actually moves inside the section (risers, closing filters)
 * versus a flat gate (vinyl only in the break). Pure — reads the document,
 * so chips stay correct across undo/redo and re-generated songs without any
 * extra persisted state.
 */
export function sectionFxChips(doc: ProjectDocument, sceneId: string): SectionFxChip[] {
  const chips: SectionFxChip[] = [];
  const seen = new Set<string>();
  for (const lane of doc.sceneAutomation) {
    if (lane.sceneId !== sceneId || lane.target.kind !== "fxParam" || !lane.target.fxId) continue;
    if (seen.has(lane.target.fxId)) continue;
    seen.add(lane.target.fxId);
    const track = doc.tracks.find((t) => t.id === lane.target.trackId);
    const instance =
      track && "effects" in track
        ? (track.effects as { id: string; type: EffectType }[]).find((f) => f.id === lane.target.fxId)
        : undefined;
    if (!instance) continue;
    const def = EFFECT_META[instance.type];
    if (!def) continue;
    const first = lane.points[0]?.value ?? 0;
    const last = lane.points[lane.points.length - 1]?.value ?? 0;
    chips.push({ type: instance.type, label: def.name, sweep: lane.points.length > 1 && first !== last });
  }
  return chips;
}
