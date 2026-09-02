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
