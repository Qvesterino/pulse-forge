/**
 * QMR HUD STUB — the build-time fallback for the ecosystem chip trigger.
 *
 * The real @qvester/qmr-hud chip trigger ships as TS SOURCE from the sibling
 * monorepo checkout (aliased in vite.config.ts / vitest.config.ts). A clean
 * checkout — GitHub Actions, a pilot reviewer's clone — has no sibling, and an
 * unresolvable import is FATAL there: `vite build` dies on ENOENT before
 * producing anything and the studio crashes on boot ("KYX crashed … Failed to
 * resolve import @qvester/qmr-hud/command-bus.ts", reproduced in CI on
 * 2026-10-28).
 *
 * So the alias falls back HERE when the sibling is absent. The stub renders
 * nothing, because the chip trigger is an optional affordance and the app
 * already treats a failed chip load as "no chip" (QmrErrorBoundary renders
 * null). Everything else the ecosystem integration needs — the capability
 * manifest, the command bus, the Audio Canvas handoff sender — lives in KYX
 * and is unaffected by the chip's absence.
 *
 * The marker string below is what scripts/check-bundle-size.mjs looks for: a
 * build that shipped the stub must SAY so in the budget report instead of
 * printing a suspiciously small "QMR HUD" line that reads like a measurement.
 */

/** Marker scanned by the bundle-budget script to report a stubbed HUD. */
export const QMR_HUD_STUB_MARKER = "kyx-qmr-hud-stub";

export interface QmrMiniChipMountProps {
  appId?: string;
  surfaceId?: string;
  manifest?: unknown;
  onHandoff?: (packet: Record<string, unknown>) => void | Promise<void>;
  initialOpen?: boolean;
  [key: string]: unknown;
}

/** No sibling checkout → no chip trigger. The app stays fully usable. */
export function QmrMiniChipMount(_props: QmrMiniChipMountProps): null {
  return null;
}
