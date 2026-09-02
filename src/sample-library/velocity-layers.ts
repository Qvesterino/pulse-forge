import type { SampleLayer } from "../project-model/types";

/**
 * Factory kick velocity kit — four dynamics zones mapped onto the factory
 * kick bank. Apply with `setVelocityLayersCommand(trackId, FACTORY_KICK_LAYERS)`.
 * Soft hits land in the low zone, full-velocity hits in the sub zone.
 */
export const FACTORY_KICK_LAYERS: SampleLayer[] = [
  { id: "layer.kick.soft", sampleId: "factory.kick.soft", min: 0, max: 0.25 },
  { id: "layer.kick.punch", sampleId: "factory.kick.punch", min: 0.25, max: 0.5 },
  { id: "layer.kick.deep", sampleId: "factory.kick.deep", min: 0.5, max: 0.75 },
  { id: "layer.kick.sub", sampleId: "factory.kick.sub", min: 0.75, max: 1 },
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
export const FACTORY_HAT_OPEN_RR = roundRobinLayers([
  "factory.hat.open.short",
  "factory.hat.open.short.rr2",
]);

/** Kick RR set — kicks vary less than snares, two takes are enough. */
export const FACTORY_KICK_PUNCH_RR = roundRobinLayers([
  "factory.kick.punch",
  "factory.kick.punch.rr2",
  "factory.kick.punch.rr3",
]);

/** Curated beat kits ready for `setVelocityLayersCommand`. */
export const FACTORY_BEAT_RR_KITS: Record<string, SampleLayer[]> = {
  kick: FACTORY_KICK_PUNCH_RR,
  snare: FACTORY_SNARE_RR,
  hatClosed: FACTORY_HAT_CLOSED_RR,
  hatOpen: FACTORY_HAT_OPEN_RR,
};

/**
 * Keyzone layer set: each zone covers a pitch range across the full velocity
 * window — the sampler picks the zone containing the played note.
 */
export function keyzoneLayers(
  zones: Array<{ sampleId: string; minPitch: number; maxPitch: number }>,
): SampleLayer[] {
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
