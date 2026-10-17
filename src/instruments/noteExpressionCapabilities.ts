import type { InstrumentKind, NoteExpression } from "../project-model/types";

export type NoteExpressionTarget = keyof NoteExpression;

const NOTE_EXPRESSION_TARGETS: Partial<Record<InstrumentKind, readonly NoteExpressionTarget[]>> = {
  sampler: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  analog: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  bass: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  "808": ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  texture: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  wavetable: ["releaseVelocity"],
  granular: ["releaseVelocity"],
  fm: ["pan", "releaseVelocity"],
  keys: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  organ: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  strings: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  bell: ["pan", "filterCutoffHz", "filterResonance", "modX", "modY"],
  reese: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  clav: ["pan", "releaseVelocity"],
  acid: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  brass: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  pluck: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  flute: ["pan", "filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  logdrum: ["pan", "filterCutoffHz", "filterResonance", "modX", "modY"],
  spectral: ["filterCutoffHz", "filterResonance", "releaseVelocity", "modX", "modY"],
  vocalchop: ["pan", "releaseVelocity"],
};

const HELD_VOICE_SLIDE_NOTE_INSTRUMENTS = new Set<InstrumentKind>(["808", "acid"]);

export function noteExpressionTargetsForInstrument(kind: InstrumentKind): readonly NoteExpressionTarget[] {
  return NOTE_EXPRESSION_TARGETS[kind] ?? [];
}

/** Instruments whose runtimes can bend an already held voice without a new attack. */
export function supportsHeldVoiceSlideNote(kind: InstrumentKind | undefined): boolean {
  return kind !== undefined && HELD_VOICE_SLIDE_NOTE_INSTRUMENTS.has(kind);
}
