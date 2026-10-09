import type { SampleLayer } from "../project-model/types";

/**
 * Factory kick velocity kit — four dynamics zones mapped onto the factory
 * kick bank. Apply with `setVelocityLayersCommand(trackId, FACTORY_KICK_LAYERS)`.
 * Soft hits land in the low zone, full-velocity hits in the sub zone.
 *
 * NOTE every zone must reference a REAL bank id: a missing id silently drops
 * the zone (the sampler skips candidates it cannot resolve), which used to
 * mute the loudest kick zone (`factory.kick.sub` — the bank ships `sub808`).
 *
 * PITCH HAZARD (since the bank-wide semitone snap): the four kick voices no
 * longer share a tuning — soft F1, punch G#1, deep F#1, sub808 D#1 — so these
 * velocity zones now STEP PITCH across the velocity range (a ghost kick and a
 * full kick read as two different tuned drums, up to 5 semitones apart). Kept
 * for the manual Inspector/SFZ-style mapping flows; deliberately NOT carried
 * by any factory preset — the melodic dynamics sets below are the shared-root
 * template, and the drum-side dynamics ride DrumPad.layers via the snare/hat
 * sets (whose members are timbre- not pitch-separated).
 */
export const FACTORY_KICK_LAYERS: SampleLayer[] = [
  { id: "layer.kick.soft", sampleId: "factory.kick.soft", min: 0, max: 0.25 },
  { id: "layer.kick.punch", sampleId: "factory.kick.punch", min: 0.25, max: 0.5 },
  { id: "layer.kick.deep", sampleId: "factory.kick.deep", min: 0.5, max: 0.75 },
  { id: "layer.kick.sub", sampleId: "factory.kick.sub808", min: 0.75, max: 1 },
];

/**
 * Round-robin layer set: every sample shares the full velocity window, so
 * the sampler's overlapping-window rule cycles through them on repeated
 * hits — micro-variations instead of machine-gun sameness.
 */
export function roundRobinLayers(sampleIds: string[]): SampleLayer[] {
  return sampleIds.map((sampleId, i) => ({ id: `layer.rr.${i}`, sampleId, min: 0, max: 1 }));
}

/** Snare RR set — base + two micro-variations (±~1.5% pitch/length, ±4% level). */
export const FACTORY_SNARE_RR = roundRobinLayers([
  "factory.snare.main",
  "factory.snare.main.rr2",
  "factory.snare.main.rr3",
]);

/** Closed-hat RR set — hats are where machine-gun fatique is loudest. */
export const FACTORY_HAT_CLOSED_RR = roundRobinLayers([
  "factory.hat.closed",
  "factory.hat.closed.rr2",
  "factory.hat.closed.rr3",
]);

/** Open-hat RR set. */
export const FACTORY_HAT_OPEN_RR = roundRobinLayers(["factory.hat.open.short", "factory.hat.open.short.rr2"]);

/** Kick RR set — kicks vary less than snares, two takes are enough. */
export const FACTORY_KICK_PUNCH_RR = roundRobinLayers([
  "factory.kick.punch",
  "factory.kick.punch.rr2",
  "factory.kick.punch.rr3",
]);

/**
 * Velocity-DYNAMIC set builder: DISJOINT windows so each velocity band picks
 * exactly one timbre (a real velocity layer, not a round robin).
 *
 * Layout: `ghost` for soft hits, the `main` pool rotating (round robin) in the
 * middle band, an optional `accent` timbre for hard hits. Windows must not
 * overlap — an overlap would turn the zone into another RR pool and a hard
 * accent would only sometimes get the hard sample.
 *
 * Every id must exist in the factory bank (manifest asset or a base with an
 * RR_VARIATIONS entry); a missing id would silently shrink the zone and could
 * mute a velocity band.
 */
export function dynamicLayers(options: {
  ghostSampleId: string;
  mainSampleIds: readonly string[];
  accentSampleId?: string;
  /** Ghost band upper bound (default 0.35). */
  ghostMax?: number;
  /** Accent band lower bound (default 0.8). */
  accentMin?: number;
}): SampleLayer[] {
  const ghostMax = options.ghostMax ?? 0.35;
  const accentMin = options.accentMin ?? 0.8;
  // Without an accent the body band runs to full velocity — capping it at
  // accentMin would leave 0.8..1 with no layer and a hard hit would silently
  // fall back to the pad's own sample.
  const mainMax = options.accentSampleId ? accentMin : 1;
  const layers: SampleLayer[] = [{ id: "layer.dyn.ghost", sampleId: options.ghostSampleId, min: 0, max: ghostMax }];
  options.mainSampleIds.forEach((sampleId, i) => {
    layers.push({ id: `layer.dyn.main.${i}`, sampleId, min: ghostMax, max: mainMax });
  });
  if (options.accentSampleId) {
    layers.push({ id: "layer.dyn.accent", sampleId: options.accentSampleId, min: accentMin, max: 1 });
  }
  return layers;
}

/**
 * Stock-kit snare dynamics: soft ghost → tight snare, backbeat → main snare
 * rotating, hard accent → punch snare. This is the difference between a
 * programmed backbeat and a played one: the SAME row velocity now changes
 * TIMBRE, not just gain.
 */
export const FACTORY_SNARE_DYNAMIC: SampleLayer[] = dynamicLayers({
  ghostSampleId: "factory.snare.tight",
  mainSampleIds: ["factory.snare.main", "factory.snare.main.rr2", "factory.snare.main.rr3"],
  accentSampleId: "factory.snare.punch",
});

/**
 * Stock-kit closed-hat dynamics: the soft hat sample is a different timbre
 * (not just quieter) and the body of the churn rotates through the RR pool —
 * 16th-note hat repetition is the most exposed machine-gun read in a beat.
 */
export const FACTORY_HAT_DYNAMIC: SampleLayer[] = dynamicLayers({
  ghostSampleId: "factory.hat.closed.soft",
  mainSampleIds: ["factory.hat.closed", "factory.hat.closed.rr2", "factory.hat.closed.rr3"],
  ghostMax: 0.35,
});

/**
 * Melodic velocity-dynamics sets for the factory SAMPLER presets — the
 * melodic counterpart of the drum-side DYNAMIC sets above. The contract that
 * makes a set musical: every member voice shares ONE recorded root (velocity
 * must change TIMBRE, never pitch — a detuned bass beats against tuned
 * melodies) and the windows partition 0..1 disjointly, so each velocity band
 * plays exactly one timbre. Consumed by the `*.dynamics` sampler presets,
 * which carry them as `velocityLayers` onto the track via
 * applyInstrumentPreset; roots are the documented recorded fundamentals of
 * the builders (808 D1=26, subs F1=29, acid C2=36, plucks A4=69).
 */
export const FACTORY_808_VELOCITY: SampleLayer[] = [
  { id: "layer.808.soft", sampleId: "factory.bass.808.soft", min: 0, max: 0.45 },
  { id: "layer.808.medium", sampleId: "factory.bass.808.medium", min: 0.45, max: 0.78 },
  { id: "layer.808.hard", sampleId: "factory.bass.808.hard", min: 0.78, max: 1 },
];

/** Held-sub dynamics: the pure sine under soft hits, the gritty square growl takes over once the hit bites. */
export const FACTORY_SUB_VELOCITY: SampleLayer[] = [
  { id: "layer.sub.sine", sampleId: "factory.bass.subsine", min: 0, max: 0.5 },
  { id: "layer.sub.square", sampleId: "factory.bass.subsquare", min: 0.5, max: 1 },
];

/** Acid dynamics: the held filter-fodder line under soft hits, the short squelch accent on hard ones. */
export const FACTORY_ACID_VELOCITY: SampleLayer[] = [
  { id: "layer.acid.line", sampleId: "factory.bass.acid.slow", min: 0, max: 0.5 },
  { id: "layer.acid.accent", sampleId: "factory.bass.acid.fast", min: 0.5, max: 1 },
];

/** Lead-pluck dynamics: darker pluck under the ghost band, the bright trance pluck takes the accents. */
export const FACTORY_PLUCK_VELOCITY: SampleLayer[] = [
  { id: "layer.pluck.dark", sampleId: "factory.lead.pluck.dark", min: 0, max: 0.55 },
  { id: "layer.pluck.bright", sampleId: "factory.lead.pluck.bright", min: 0.55, max: 1 },
];

/** Curated beat kits ready for `setVelocityLayersCommand`. */
export const FACTORY_BEAT_RR_KITS: Record<string, SampleLayer[]> = {
  kick: FACTORY_KICK_PUNCH_RR,
  snare: FACTORY_SNARE_DYNAMIC,
  hatClosed: FACTORY_HAT_DYNAMIC,
  hatOpen: FACTORY_HAT_OPEN_RR,
};

/**
 * Keyzone layer set: each zone covers a pitch range across the full velocity
 * window — the sampler picks the zone containing the played note.
 */
export function keyzoneLayers(zones: Array<{ sampleId: string; minPitch: number; maxPitch: number }>): SampleLayer[] {
  return zones.map((z, i) => ({
    id: `layer.kz.${i}`,
    sampleId: z.sampleId,
    min: 0,
    max: 1,
    minPitch: z.minPitch,
    maxPitch: z.maxPitch,
  }));
}

/** Factory tonal keyzones — bells up top, keys in the middle, stabs down low. */
export const FACTORY_TONAL_KEYZONES = keyzoneLayers([
  { sampleId: "factory.tonal.bell", minPitch: 72, maxPitch: 127 },
  { sampleId: "factory.tonal.keys", minPitch: 48, maxPitch: 71 },
  { sampleId: "factory.tonal.stab", minPitch: 0, maxPitch: 47 },
]);
