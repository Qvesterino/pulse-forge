import type { ChannelLevels } from "./metering";

/**
 * Metering snapshot contracts (Wave 4a). They moved out of AudioEngine.ts
 * beside their only owner (meteringRig.ts); AudioEngine re-exports both
 * names so every existing consumer import keeps working unchanged.
 */

export interface TrackMeterSnapshot {
  level: number;
  peakDb: number;
  clipping: boolean;
}

export interface MasterMeterSnapshot {
  left: ChannelLevels;
  right: ChannelLevels;
  correlation: number;
  peakHoldDb: number;
  truePeakDb: number;
  lufsMomentary: number;
  lufsShortTerm: number;
  lufsIntegrated: number;
  monoLossDb: number;
  lrImbalanceDb: number;
  gainReductionDb: number;
  glueReductionDb: number;
}
