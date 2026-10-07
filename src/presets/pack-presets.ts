import type { InstrumentPreset } from "./types";
import { REAL_PIANO_PRESET } from "./piano-pack";
import { vscoPackPresets } from "./vsco-pack";
import { TSAR_FACTORY_PRESETS } from "./tsar-factory";

/**
 * REAL-INSTRUMENT PACK PRESETS - the lazy half of the factory bank.
 *
 * The Salamander piano + VSCO2 orchestra presets derive from their generated
 * velocity/keyzone layer tables (~230 KB built - by far the heaviest data in
 * the preset graph). They live in their own chunk behind the factory loader:
 * nothing needs them at boot, and every consumer that warmed the loader sees
 * exactly the same bank as before the seam. The SAMPLES behind these presets
 * were always optional (public/samples fetched on demand, silent zone
 * degradation) - this seam gives the preset DATA the same contract.
 *
 * TSAR presets ride the same lazy chunk for the same reason: a beat that never
 * opens the TSAR panel should not carry 48 hybrid patches in its boot graph.
 */
export function packPresets(): InstrumentPreset[] {
  return [REAL_PIANO_PRESET, ...vscoPackPresets(), ...TSAR_FACTORY_PRESETS];
}
