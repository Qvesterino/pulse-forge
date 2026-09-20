import { FACTORY_FX_CHAIN_GAIN_DB, FACTORY_FX_PRESET_GAIN_DB } from "./preset-loudness.generated";

/** Clamp generated/reference trims so an outlier cannot create an unsafe jump. */
export function clampFxOutputTrimDb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-18, Math.min(12, Math.round(value * 10) / 10));
}

export function factoryFxPresetGainDb(presetId: string): number {
  return clampFxOutputTrimDb(FACTORY_FX_PRESET_GAIN_DB[presetId] ?? 0);
}

export function factoryFxChainGainDb(chainId: string): number {
  return clampFxOutputTrimDb(FACTORY_FX_CHAIN_GAIN_DB[chainId] ?? 0);
}
