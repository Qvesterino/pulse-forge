import { FACTORY_FX_CHAIN_GAIN_DB, FACTORY_FX_PRESET_GAIN_DB } from "./preset-loudness.generated";
import { valueClamp, type ClampSink } from "../shared/clamp-report";

/**
 * Clamp generated/reference trims so an outlier cannot create an unsafe jump.
 *
 * Audit F-12: the sink is optional and reports what the clamp CHANGED, so a
 * trim the caller asked for and did not get is disclosed instead of being
 * silently rounded away.
 */
export function clampFxOutputTrimDb(value: number, sink?: ClampSink): number {
  if (!Number.isFinite(value)) {
    const event = valueClamp("effect:outputTrimDb", "Output trim", value, 0, -18, 12, "not a number — 0 dB was used");
    if (event) sink?.(event);
    return 0;
  }
  const clamped = Math.max(-18, Math.min(12, value));
  const applied = Math.round(clamped * 10) / 10;
  const event = valueClamp(
    "effect:outputTrimDb",
    "Output trim",
    value,
    applied,
    -18,
    12,
    applied !== clamped ? "rounded to 0.1 dB" : undefined,
  );
  if (event) sink?.(event);
  return applied;
}

export function factoryFxPresetGainDb(presetId: string): number {
  return clampFxOutputTrimDb(FACTORY_FX_PRESET_GAIN_DB[presetId] ?? 0);
}

export function factoryFxChainGainDb(chainId: string): number {
  return clampFxOutputTrimDb(FACTORY_FX_CHAIN_GAIN_DB[chainId] ?? 0);
}
