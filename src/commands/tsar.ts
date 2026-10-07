/**
 * TSAR commands — the Forge apply (docs/TSAR-ROADMAP.md T2, ADR 0023).
 *
 * `forgeSampleCommand(doc, trackId, sampleId, plan)` installs a forged patch
 * onto an existing TSAR track as ONE undoable command: engine routing, the
 * per-slot root, the envelope, the loop flag and the level. The plan itself
 * is pure data (`src/tsar/forge.ts`) — this file owns only the mutation, so
 * the mapping is testable without React or a store.
 *
 * Honesty: an `empty` plan is REFUSED (nothing was forged — applying silence
 * would look like a successful import). A null root keeps the track's current
 * root and the caller warns; the command never invents a pitch.
 */

import type { Command } from "./types";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";
import type { ForgePlan } from "../tsar/forge";
import { snapshot } from "./core";

export interface ForgeSampleOptions {
  /** Which TSAR slot receives the sample: 0 = Source A, 1 = Source B. */
  slot?: 0 | 1;
}

/**
 * Apply a Forge plan to a TSAR track. One undo step; source takes/samples
 * are referenced (not copied) — the user sample repository owns the bytes.
 */
export function forgeSampleCommand(
  doc: ProjectDocument,
  trackId: string,
  sampleId: string,
  plan: ForgePlan,
  options: ForgeSampleOptions = {},
): Command {
  const track = doc.tracks.find((candidate): candidate is InstrumentTrack => candidate.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  if (track.kind !== "instrument" || track.instrument !== "tsar") {
    throw new Error("Sample Forge applies to a TSAR track");
  }
  if (typeof sampleId !== "string" || sampleId === "") {
    throw new Error("Sample Forge needs a sample to forge");
  }
  if (plan.kind === "empty") {
    throw new Error("Nothing was forged — the source is silent or unreadable");
  }
  const slot = options.slot ?? 0;

  const engineValue = plan.engine === "wavetable" ? 1 : plan.engine === "granular" ? 2 : 0;
  const prefix = slot === 0 ? "srcA" : "srcB";
  const params: Record<string, number> = {
    ...track.params,
    [`${prefix}Engine`]: engineValue,
    [`${prefix}Level`]: slot === 0 ? Math.max(0.6, track.params.srcALevel ?? 0.8) : Math.max(0.6, track.params.srcBLevel ?? 0),
    [`${prefix}Atk`]: plan.envelope.attackSec,
    [`${prefix}Rel`]: plan.envelope.releaseSec,
  };
  if (plan.rootMidi !== null) {
    // A readable root is applied to BOTH slots' ROOT? No — only the slot the
    // source landed in. The other slot's root is its own sample's contract.
    params[`${prefix}Root`] = plan.rootMidi;
    // Sustained material benefits from a full sustain; a one-shot keeps the
    // decaying shape the analyzer measured (sustain 0 lets the envelope die
    // with the sample instead of holding a silent loop).
    params[`${prefix}Sus`] = plan.kind === "sustained" ? 0.85 : 0;
    params[`${prefix}Dec`] = plan.kind === "sustained" ? 0.8 : Math.max(0.05, plan.envelope.releaseSec);
  } else {
    // No readable root: a one-shot sampler with the measured envelope is the
    // honest route; leave the root untouched and let the caller warn.
    params[`${prefix}Engine`] = 0;
    params[`${prefix}Sus`] = 0;
    params[`${prefix}Dec`] = Math.max(0.05, plan.envelope.releaseSec);
  }

  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((candidate) => {
      if (candidate.id !== trackId || candidate.kind !== "instrument") return candidate;
      return slot === 0
        ? { ...candidate, sampleId, params, presetId: null }
        : { ...candidate, sampleIdB: sampleId, params, presetId: null };
    }),
  };
  const targetLabel = slot === 0 ? "A" : "B";
  return snapshot("forgeSample", `Forge into TSAR ${targetLabel}`, doc, next);
}
