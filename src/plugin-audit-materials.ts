/**
 * AUDIT MATERIALS — what the host probe measures an effect ON.
 *
 * Node-pure on purpose, for the same reason as ./plugin-audit-fingerprint:
 * this module holds the rule that decides WHICH SOUND an effect is judged on,
 * and it has to be unit-testable without a browser. The audit
 * (src/plugin-audit-checks.ts) does the measuring; this module only decides.
 *
 * WHY THERE IS A THIRD MATERIAL
 *
 * The house template is a MONO mix. MEASURED 2026-10-25 on the house doc with
 * its real drum samples: the drum bus renders `side = 0` — bit-exact zero —
 * because every source in it is a mono sample played straight down the middle.
 * The melodic tracks are mono for the same reason.
 *
 * That is fatal for a stereo imager. SPAN is a per-band mid/side rescaler
 * (`L' = M + w·S`, `R' = M − w·S`), so with `S = 0` in every band every width
 * is a mathematical no-op — the processor's own header calls width 1 a
 * "mathematically neutral pass-through". The audit read side 0 → 0 on the drum
 * bus and on every melodic track. That is a TRUE measurement of a working
 * effect on material that cannot excite it, and a FALSE verdict about the
 * effect.
 *
 * So the third material is a SPREAD KIT: the same drum bus with its pads
 * panned, which puts side energy in FRONT of the insert chain. The pad pan is
 * pre-insert (the track's own pan is post-insert), so the imager actually sees
 * a stereo signal. MEASURED with SPAN's audit fingerprint state on the spread
 * kit: side 0.039 → 0.022, delta 0.355 (metric `side`) — against 2.6e-9 on
 * the mono drum bus.
 *
 * THE ORDER IS THE BLAST RADIUS. The mono materials come first and the spread
 * kit last: an effect that already processes on the drum bus keeps exactly the
 * measurement it had, and only the effects that NO mono material can excite
 * ever reach the stereo one. Measured on the 2026-10-25 baseline: 57 effects,
 * one of them ("sirka") reached the spread kit, 56 kept their numbers.
 */

import type { ProjectDocument, Track } from "./project-model/types";

/**
 * A track the host test can put the effect on.
 *
 * A material is a TRACK plus, optionally, a different DOCUMENT. The drum bus
 * and the melodic tracks are the same doc on a different track; the spread kit
 * is a different doc on the same track. `prepare` returns that document — it
 * must never mutate the document it is given, because the base doc is shared
 * by every material and by every effect.
 */
export interface HostMaterial {
  trackId: string;
  label: string;
  melodic: boolean;
  /**
   * Optional document transform. The probe renders the prepared document, not
   * the base one — the base document is shared and must stay untouched.
   */
  prepare?: (doc: ProjectDocument) => ProjectDocument;
}

/**
 * How far the spread kit pans each pad.
 *
 * Half-way left or right: far enough to carry real side energy, close enough
 * that the kit stays a kit and the render does not turn into two mono halves.
 */
const SPREAD_PAN = 0.5;

/**
 * The spread kit: the house drum track with its pads panned.
 *
 * The pads alternate sides by index, which puts side energy in EVERY band the
 * imager splits: the kick (index 0) goes left, the clap (index 6) left, the
 * closed hat (index 8) right and the open hat (index 10) left — low, mid and
 * high all carry side information.
 *
 * WHY THE PADS AND NOT THE TRACK: the track's own pan is POST-insert, so
 * panning the track leaves the insert chain with the same mono signal it had
 * (MEASURED: side 0 → 0). A pad's pan is PRE-insert — pad → track input →
 * insert chain — so the effect sees the stereo signal. Measured on the house
 * doc: a panned pad on the drum bus moves SPAN by 0.355, a panned track by
 * 7.4e-9.
 */
export function spreadKitDoc(doc: ProjectDocument): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((track: Track) =>
      track.kind === "drum"
        ? {
            ...track,
            pads: track.pads.map((pad, index) => ({
              ...pad,
              pan: index % 2 === 0 ? -SPREAD_PAN : SPREAD_PAN,
            })),
          }
        : track,
    ),
  };
}

/**
 * The document a material is measured on.
 *
 * A material may need a DIFFERENT document, not just a different track: the
 * spread kit is the same drum bus with its pads panned, so the stereo imager
 * sees side energy in front of the insert chain.
 *
 * `prepare` returns a COPY — the base document is shared by every material and
 * by every effect, and a material that panned the shared kit would poison every
 * measurement that follows it.
 */
export function materialDoc(base: ProjectDocument, material: HostMaterial): ProjectDocument {
  return material.prepare ? material.prepare(base) : base;
}

/**
 * The drum bus first, then every track that plays notes in the active pattern,
 * then the spread kit.
 *
 * The drum bus is what the house template plays and what most devices are
 * built for. The MELODIC tracks follow, and they exist because a drum bus
 * cannot excite every device — a pitch corrector has nothing to correct in a
 * kick. MEASURED 2026-10-25 on the house template WITH its real drum samples
 * (an empty sample bank renders the drum bus silent, which is a different
 * failure and must not be confused with this one):
 *
 *   material        effect at defaults   audit fingerprint {amount:0,speed:0}
 *   drum bus        8.5e-5               8.5e-5
 *   808 bass        5.4e-9               7.9e-8
 *   analog chords   0.108                6.9e-9
 *
 * The SPREAD KIT comes last and only ever gets probed by the effects that no
 * mono material could excite.
 */
export function hostMaterials(doc: ProjectDocument): HostMaterial[] {
  const materials: HostMaterial[] = [];
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (!drum) throw new Error("house template lost its drum track");
  materials.push({ trackId: drum.id, label: `${drum.name} (drum bus)`, melodic: false });
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId) ?? doc.patterns[0];
  for (const trackId of Object.keys(pattern?.notes ?? {})) {
    if (trackId === drum.id) continue;
    const notes = pattern?.notes?.[trackId] ?? [];
    if (notes.length === 0) continue;
    const track = doc.tracks.find((t) => t.id === trackId);
    if (!track) continue;
    materials.push({ trackId, label: `${track.name} (melodic)`, melodic: true });
  }
  // The stereo material. Same track, different document: the kit is spread so
  // the drum bus carries side energy in front of the insert chain.
  materials.push({
    trackId: drum.id,
    label: `${drum.name} (drum bus, spread kit)`,
    melodic: false,
    prepare: spreadKitDoc,
  });
  return materials;
}
