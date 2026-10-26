/**
 * The LOW-END STACK (ADR 0035 family follow-up) — KOPA + KOREŇ + sidechain
 * bound as one musical system.
 *
 * `lowEndPlan` is the PURE part: from the document and the song key it
 * computes what the stack needs — the tonic-offset tunes for the kick, the
 * existing/missing track roles, and the sidechain wiring. The command in
 * commands/instrument.ts materializes the plan as ONE undoable snapshot.
 *
 * Musical contract: the KICK anchors the key tonic (its BODY/SUB tuned to
 * the tonic one octave below C), the BASS (an 808 carrying the KOREŇ
 * harmonic engine) plays the same tonic, and a sidechain effect on the
 * bass keyed to the kick ducks it under every beat. The bass's played
 * notes stay the musical authority — the stack tunes the INSTRUMENTS and
 * wires the DUCKING, it does not write notes.
 */

import { parseKey } from "../project-model/scales";
import type { EffectInstance, ID, InstrumentTrack, ProjectDocument } from "../project-model/types";

export interface LowEndPlan {
  /** The song's tonic pitch class 0–11 (0 = C). */
  keyRootPc: number;
  /** bodyTune/subTune for the kick: the tonic, one octave down (−12..−1). */
  kickTuneSt: number;
  /** Existing KOPA track id, or null when the command must create one. */
  kickTrackId: ID | null;
  /** Existing bass (808) track id, or null when the command must create one. */
  bassTrackId: ID | null;
  /** True when the bass already carries a sidechain keyed to the kick. */
  sidechainWired: boolean;
  /** Whether the document even declares a key (false → chromatic warning). */
  keyKnown: boolean;
}

const isInstrument = (track: ProjectDocument["tracks"][number]): track is InstrumentTrack =>
  track.kind === "instrument";

export function lowEndPlan(doc: ProjectDocument): LowEndPlan {
  const parsed = doc.key ? parseKey(doc.key) : null;
  const keyRootPc = parsed ? parsed.root : 0;
  // The tonic, one octave below the default C anchor: A (pc 9) → −3 st.
  const kickTuneSt = ((keyRootPc + 12) % 12) - 12;

  const kick = doc.tracks.find((t): t is InstrumentTrack => isInstrument(t) && t.instrument === "kopa");
  const bass = doc.tracks.find((t): t is InstrumentTrack => isInstrument(t) && t.instrument === "808");
  const kickTrackId = kick?.id ?? null;
  const bassTrackId = bass?.id ?? null;

  const bassEffects = bass?.effects ?? [];
  const sidechainWired =
    kickTrackId !== null &&
    bassTrackId !== null &&
    bassEffects.some((fx) => fx.type === "sidechain" && fx.sidechainTrackId === kickTrackId);

  return {
    keyRootPc,
    kickTuneSt,
    kickTrackId,
    bassTrackId,
    sidechainWired,
    keyKnown: Boolean(doc.key) && parsed !== null,
  };
}

/** The sidechain EffectInstance the stack installs on the bass track. */
export function lowEndSidechainEffect(fxId: string, kickTrackId: ID): EffectInstance {
  return {
    id: fxId,
    type: "sidechain",
    bypassed: false,
    sidechainTrackId: kickTrackId,
    params: {},
  };
}
