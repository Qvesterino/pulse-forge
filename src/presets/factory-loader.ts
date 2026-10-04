import type { InstrumentPreset } from "./types";

/**
 * FACTORY PRESET BANK LOADER — the sync facade over the lazy bank.
 *
 * `presets/factory.ts` is ~130 KB built — the second-biggest eager anchor —
 * yet nothing needs it at boot: preset asks arrive through the IntentPanel,
 * the MCP hosts or the model adapter, all of which can warm the bank first.
 * The loader keeps the bank OUT of the boot chunk while every existing sync
 * consumer keeps a synchronous read:
 *
 *   - `warmFactoryPresets()` — async, idempotent, cached; call it at the
 *     entry surfaces (panel mount, MCP host start) and in tests.
 *   - `factoryPresets()` — sync access; THROWS when cold. Loud-by-contract:
 *     a preset ask parsed against a cold bank must never silently fall
 *     through to generation (the explicit-unknown contract upstream depends
 *     on the bank being present).
 *
 * The invariant that makes this safe: every code path that can reach a
 * preset parse awaits the warm first (IntentPanel mount effect, MCP host
 * start, tests). The warm is a cached dynamic import — one extra chunk
 * fetch, zero repeat cost.
 */

let bank: InstrumentPreset[] | null = null;
let warm: Promise<void> | null = null;

/**
 * Load the factory bank on demand. Repeated calls await the same load.
 *
 * The warm pulls TWO chunks: the core curated bank and the pack presets
 * (Salamander piano + VSCO2 orchestra — their generated layer tables live in
 * their own lazy chunk). Merged here so every consumer of `factoryPresets()`
 * sees the identical full bank as before the pack seam; code that never
 * touches presets never pays for the pack data at all.
 */
export function warmFactoryPresets(): Promise<void> {
  warm ??= Promise.all([import("./factory"), import("./pack-presets")]).then(([core, packs]) => {
    bank = [...core.FACTORY_PRESETS, ...packs.packPresets()];
  });
  return warm;
}

/** True once the bank is readable synchronously. */
export function isFactoryPresetsWarm(): boolean {
  return bank !== null;
}

/** Synchronous bank access — throws loudly when the bank was not warmed. */
export function factoryPresets(): InstrumentPreset[] {
  if (bank === null) {
    throw new Error("factory preset bank not warmed — await warmFactoryPresets() before preset parsing");
  }
  return bank;
}
