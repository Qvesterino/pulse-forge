# ADR 0036 — Unified UI layout state (one owner for look and geometry)

Date: 2026-10-10 · Status: Accepted · Scope: theme system, dock layout, UI
customization, share codes

## Context

KYX is asking for a genuinely modifiable UI: sizes, colors, and a layout that
adapts to the window instead of hard-coded pixel values. The audit behind
ROADMAP-UI-2027 found that the pieces which already exist are real, but they are
owned by three unrelated systems:

- **Theme** (`src/shared/theme-data.ts` + `src/ui/theme.ts`, `pf-theme-v1`) owns
  palette, accent hue, a single `scale` applied as `documentElement.style.zoom`,
  a boolean `compact` and `reduceMotion`. Seven presets override exactly the 11
  variables in `PRESET_OWNED_VARS`; the Tokens 2.0 block in `01-base.css`
  (`--space-*`, `--radius-*`, `--elev-*`, `--surface-*`, `--ctrl-h`, `--fs-*`)
  is **not** in that list, so a preset can never change it. Hundreds of literal
  colors and ~3000 hard-coded `px` values across `src/styles/*.css` are outside
  the theme's reach entirely.
- **Dock** (`src/ui/dockLayout.ts`, `pf-dock-v1`) owns dock height, the A/B
  split and per-panel visibility. It has a resize grip and a debounced,
  `pagehide`-flushed writer.
- **Hard-coded CSS** owns everything else: the inspector is a literal `280px`
  (230px below 1100px), the sequencer label column `168px`, the rack
  `repeat(8, 1fr)`, and the body `font-size: 13px`.

Consequences that block customization:

1. There is no single value that can be exported, shared, restored or migrated.
   `PFTHM1:` carries colors and motion only — not geometry, so a shared theme
   lands on a machine with a completely different layout.
2. Density is binary (`compact: boolean`) though the UI has three natural steps.
3. `scale` is a CSS `zoom`, while `clampDockHeight` derives its ceiling from
   `window.innerHeight`. Whether those two compose correctly is unverified, and
   a wrong answer silently starves the sequencer above the dock.
4. `STEPS_LABEL_PX` in `Sequencer.tsx` must manually mirror `--steps-label` in
   `01-base.css`. Any geometry that becomes user-settable turns that comment into
   a live bug source.

## Decision

1. Introduce `src/shared/layout-data.ts` as the **single owner of the UI
   appearance + geometry contract**: one `LayoutState` object holding palette,
   accent, ui scale, type scale, density, dock geometry (height, split ratio,
   collapse, slot A/B, per-panel visibility), inspector width, sequencer label
   width, rack columns, and per-token color overrides.
2. It is **pure**: no React, no DOM, no storage. It holds types, defaults,
   normalization and the legacy migration, so `domain-purity.test.ts` can pin it
   as Node-executable and any future host (Electron, non-browser embed) can
   consume it. `src/ui/theme.ts` and `src/ui/dockLayout.ts` keep their existing
   public APIs and become thin appliers over this state.
3. Store the merged state under one key, `pf-layout-v1`. Migration reads
   `pf-theme-v1` and `pf-dock-v1` when present, folds them into the new shape
   and never writes back to the legacy keys. Migration is **additive and
   idempotent**, and is covered by tests that assert both legacy keys are
   preserved (a user on an older build must not lose their preferences).
4. `normalizeLayoutState` clamps every field into a declared range and
   validates every enum and color string. The number rule is deliberately ONE
   rule rather than a per-field policy: a **finite number is clamped** to the
   nearest legal value, because the nearest legal reading preserves the user's
   intent (a dock persisted as 800 px by a build whose ceiling was 800 lands on
   today's 560 px ceiling — still "a tall dock", not a reset to the 220 px
   default), while a **non-number falls back to the default**, because there is
   no direction to preserve. This matches what `decodeThemeCode` already does
   for an imported scale. The accepted trade: a corrupt-but-numeric value
   (`uiScale: 5`) becomes the band edge (1.3) rather than 1.0.
   A malformed or hostile stored value yields a legal layout, never a thrown
   render.
5. Add `PFLYT1:` (`src/export/layoutCode.ts`) — a compressed, validated share
   code for the whole layout. It supersedes `PFTHM1:` for new shares;
   `PFTHM1:` keeps decoding so existing links stay valid.
6. Density becomes a three-step scale (`comfortable` | `compact` | `dense`)
   and typography gets its own `typeScale`, independent of `uiScale`. The old
   `compact` boolean survives as a derived read for the current
   `.theme-compact` class so Vlna A changes no pixel.
7. Persisted layout stays **out of the project document** (same boundary the
   theme had). It is a per-user preference; putting it in the project would make
   a saved mix carry someone's window size.
8. Layout code pins `PANEL_KEYS` as the panel registry. `dockLayout.ts`
   re-exports it so the tab row and the state contract can never disagree about
   which panels exist.

## Consequences

- Every future wave (fluid/responsive grid, resize grips for inspector and the
  A/B split, a token editor, three-step density) has a single place to write to
  instead of a new ad-hoc localStorage key.
- `PFLYT1:` makes a look shareable as a whole — colors _and_ geometry — which
  is what "send someone your console" actually means.
- **The bridge is live.** `ui/layout.ts` is now the only writer of
  `pf-layout-v1` and the only thing that touches the document root. `theme.ts`
  is a transparent view over it and `dockLayout.ts` writes its fields into the
  same state, so a dock height and a palette can no longer drift apart.
  `initTheme()` and `useDockLayout()` both delegate to `initLayout()`, and
  calling it twice is harmless.
- `theme.ts` deliberately keeps the legacy `ThemeState` shape. Shared packs
  (`packCode.ts`) already carry that object on other people's machines; changing
  it would orphan them. The mapping lives in exactly two functions, `toTheme`
  and `fromTheme`, so the compatibility cost stays visible.
- The dock's debounce is unchanged — only the key and the persisted field moved
  (`pf-dock-v1`/`.height` → `pf-layout-v1`/`.dockHeight`).
- The two-sources-of-truth hazard is removed at the data level in Vlna A, before
  any pixels move. Vlna A is deliberately additive: no CSS changes, so the
  rendered UI is identical before and after, and every existing test keeps its
  meaning.
- `typeScale` separated from `uiScale` is what makes the UI readable at 125 %
  without also stretching every panel.
- Migration cannot be perfect: a user whose only legacy state was corrupt
  lands on the clamped/default value. The migration is additive and idempotent,
  and the legacy keys are never rewritten, so a downgrade keeps working.
- Layout is per-user, not per-project. A shared project opens in the
  recipient's own layout.

## Confirmed scope (2026-10-10)

Product decisions taken alongside this ADR, so later waves do not re-litigate
them:

1. **A token editor IS in scope** — per-variable color fields (hex and friends)
   over the `colorOverrides` map this module already carries. It is the highest-
   value piece of "really modifiable", and `sanitizeColorOverrides` already
   validates what such an editor would write. ADR 0036 itself still ships only
   the data half; the UI arrives in a later wave. It must come with an explicit
   reset-to-preset per variable, or an override becomes permanent and invisible.
2. **Both targets** — KYX Web and KYX Studio. Electron shares the renderer, so
   the same layout code covers both; nothing in this module may assume a browser
   beyond the optional DOM applier, which is exactly why the data half is pure.
3. **Layout stays local** (per-user), NOT inside the project document — the
   boundary this ADR already established. A saved mix carries audio and musical
   decisions, never someone's window size or palette.

## Non-goals for this ADR

No responsive/fluid grid rewrite (Vlna B), no resize grips (Vlna C), no token
editor UI, no change to `:root` defaults, no bundle-budget change.

The bridge already writes `--inspector-width`, `--steps-label`, `--rack-columns`
and `--type-scale` to the document root using the CURRENT values, so the tokens
exist for the CSS that reads them next. Nothing moves until that CSS changes.
