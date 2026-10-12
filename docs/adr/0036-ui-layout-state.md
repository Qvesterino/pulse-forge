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

## Vlna B — responsive / fluid layout (2026-10-11)

The tokens the bridge writes are now CONSUMED by the stylesheet.

1. **New sheet `src/styles/24-layout-tokens.css`, appended LAST** in
   `src/styles/index.css`. Appending rather than editing in place keeps the
   change auditable and reversible: the old literals stay visible in the earlier
   files for anyone comparing. Cascade order remains load-bearing and untouched.
2. **Fluid inspector**: `.workspace` uses
   `clamp(180px, var(--inspector-width, 280px), 420px)` instead of a fixed
   `280px` (narrowed to `230px` below 1100px). The clamp means a user width is
   honoured but can never grow large enough to starve the sequencer.
3. **Fluid rack**: `.rack` uses `repeat(var(--rack-columns, 8), minmax(0, 1fr))`.
4. **Typography scale**: `body` uses
   `calc(13px * var(--type-scale, 1))` — independent of the document zoom, so
   larger text does not also stretch every panel.
5. **The user label width is applied as a CLASS, never as an inline custom
   property.** This is the load-bearing decision of the wave: an inline
   `--steps-label` on `<html>` outranks every stylesheet rule and would
   permanently kill the existing 760px media query that narrows the label to
   112px on phones. `.user-label-width` sets
   `--steps-label: var(--user-steps-label)` in the sheet, so media queries still
   win where they have an opinion, and the class is REMOVED when the user
   returns to the default so no stale override survives.
6. **`Sequencer.tsx` reads the label width from the layout store.** The old
   `STEPS_LABEL_PX`-style comment ("MUST mirror `--steps-label`") is gone: the
   component now consumes the same value the applier writes. The user's width is
   a BASE, not an override — below 760px the breakpoint value wins, matching
   what the stylesheet does.
7. **Density has a third rung**: `.density-dense` adds rules that
   `.theme-compact` never had. `.theme-compact` is still applied so the existing
   stylesheet is untouched; comfortable/compact render exactly as before.
8. **The breakpoint ladder is documented** (520 / 640 / 860 / 1100 / 1450) so
   new rules stop inventing values. The 860px inspector row-switch stays owned
   by `01-base.css`; this sheet deliberately does NOT duplicate it.

## Vlna C — live resize grips (2026-10-12)

Panels are resized by dragging their edge, not by typing a number into a
dialog. A slider is a poor fit here: it hides the thing being resized while you
adjust it.

1. **`src/ui/ResizeGrip.tsx`** extracts the interaction contract the dock grip
   had already proven (drag, double-click to reset, arrows when focused) into
   one reusable component driving `inspectorWidth` and `dockSplitRatio` through
   the layout store. Both regions therefore get identical behaviour and one
   place to fix a bug.
2. **The grip is an OVERLAY, never a grid item.** `.workspace` computes the
   sequencer's width from a two-column `minmax(0,1fr)` grid; a third cell —
   even a zero-width one — changes that arithmetic and shifts the sequencer.
   The grip is `position: absolute` against the workspace edge.
3. **One drag rule for every region**: dragging a boundary LEFT gives the space
   on its RIGHT more room. The inspector sits right of its grip; in the A/B
   split, slot B sits right of the divider, so slot A's share grows. Arrow keys
   mirror the drag exactly (`ArrowLeft` = grow), so keyboard and mouse can
   never disagree about which way a panel opens.
4. **A drag writes to the store ONCE, on release.** Mid-drag the value is
   local component state; `applyLayoutToDocument` re-applies every variable,
   class and the document zoom, so a per-`pointermove` write would do that 120
   times a second on the thread that renders the DAW — the exact hazard the
   dock grip's debounce exists to prevent. The preview still tracks the pointer,
   so the edge never feels laggy. This is pinned by a test that asserts zero
   storage writes mid-drag.
5. **A ratio is divided, not multiplied.** `dockSplitRatio` converts a pixel
   delta by dividing by the dock's approximate width; multiplying sent a 100px
   drag to ±80000 and slammed the clamp (the bug this rule replaced).
6. **Reset targets come from `DEFAULT_LAYOUT_STATE`**, never a literal, so
   "reset" cannot drift from "default".
7. Below the 860px row-switch the inspector is no longer a side column, so its
   grip is hidden rather than left dragging something invisible.

## Token editor (2026-10-12) — the confirmed scope, shipped

The palette presets own eleven variables; the glass layer is not preset-aware
at all. The token editor is the surface that closes that gap.

1. **`src/ui/tokenCatalog.ts` is an AUTHORIZED list, not a CSS scrape.** A
   picker needs to know per token whether the value is even a colour:
   `--elev-1..3` are box-shadows and `--hairline` an alpha, and offering them
   yields a field the user cannot fill meaningfully. A scraped list would also
   grow silently on every unrelated CSS edit, so the editable surface would
   change without anyone deciding it. Fifteen tokens in four groups: SURFACES,
   TEXT, ACCENT + STATUS, GLASS.
2. **The catalog is pinned against the real `:root`.** A token that no longer
   exists fails as a dead row; a new colour token absent from the catalog fails
   as an unreachable one. Either direction breaks the build rather than
   shipping an editor that lies about what it controls.
3. **A per-token reset is part of the contract, not a nicety.** An override the
   user cannot see or undo is a trap: they tune one colour, later cannot explain
   why the UI looks off, and the only escape is a global reset that throws away
   every other setting. The reset appears only for a token that actually
   carries an override, and clearing one leaves the others untouched.
4. **Rows read the LIVE document**, so a swatch always shows what the user is
   looking at — including a preset's value and an existing override — rather
   than a value re-derived from a table that can drift.
5. **An unparseable colour is refused, not swallowed.** `sanitizeColorOverrides`
   would drop it silently; a field that silently swallows input is worse than
   one that keeps the old value, because the user would believe it applied.
6. `toHexInput` returns `null` for values a native `<input type="color">`
   cannot represent (gradients, `currentColor`, `var()`), and the row falls
   back to a text field instead of showing a swatch that differs from the
   value.

## Settings glass (2026-10-12) — premium, measured

1. **`src/styles/26-settings-glass.css`, appended last.** It upgrades the
   settings popover in place rather than rewriting `09-scale-panel-popover.css`,
   so the original surface stays intact for comparison.
2. **The fill alpha is a legibility budget, not a taste knob.** The popover
   floats over the DAW, so its text renders on a blend of the panel colour and
   whatever is behind it. Measured at 94% over the app background, `--text`
   is 12.4:1, `--text-dim` 6.2:1 and `--text-faint` 4.86:1 — all above the AA
   floor. `tests/settings-glass.test.ts` recomputes these from the real
   `:root` tokens, so lowering the fill for a "more glassy" look fails the
   build before it fails the UI.
3. **A tight text shadow covers the case the alpha cannot.** Against a LIGHT
   backdrop — a lit sequencer step, a bright meter — the composite alone falls
   below AA. The test asserts that limitation explicitly rather than hiding it:
   alpha alone is NOT sufficient there, and the declared `text-shadow` is what
   closes the gap. Documenting the limit is the point; claiming the alpha
   sufficed would be a measurement made only against a black backdrop.
4. **`@supports not (backdrop-filter)` makes the panel opaque** where the blur
   is unavailable. A browser that ignores the blur would otherwise render the
   fill alpha over raw sequencer pixels, with no warning.
5. **The `-webkit-` prefix is kept**, or Safari applies no blur at all and the
   panel loses its depth silently.
6. **Calm Motion cuts the blur as well as the animation** — a large blur
   radius is a per-frame compositing cost, and the motion toggle is an
   accessibility affordance that should also lighten rendering work.
7. Entry motion animates opacity/transform, never layout. The panel is scrollable
   with a themed scrollbar because the token editor can exceed its height, and
   every control gets a 2px focus ring, which matters more than usual on
   translucent glass.

## Non-goals for this ADR

No change to `:root` defaults, no bundle-budget change. `--inspector-width`,
`--rack-columns` and `--type-scale` are written inline (they have no competing
media query today); `--steps-label` is class-based precisely because it does.
