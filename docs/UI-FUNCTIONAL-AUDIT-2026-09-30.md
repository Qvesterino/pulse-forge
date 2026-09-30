# UI FUNCTIONAL INTEGRITY AUDIT — 2026-09-30

Functional (not visual) audit of the KYX / Pulse Forge UI, with repairs.
Scope: every interactive surface in `src/ui/**` — 85 components, 1.7 MB of
React. Two waves, 10 confirmed defects repaired, each covered by a
regression test that was proven to FAIL against the pre-fix code.

This file is a working report. Per `AGENTS.md` §10, any number claimed here
must be reproducible from the working tree.

---

## 1. INVENTORY (measured)

Static extraction over `src/ui/**.tsx` (script: `.zcode/ui-wiring-scan2.mjs`):

| Control kind                 | Count |
| ---------------------------- | ----- |
| `<button>`                   | 313   |
| `<select>`                   | 70    |
| `<input>`                    | 46    |
| interactive `<div>`/`<span>` | 5     |
| shared `<Slider>`            | 78    |
| shared `<DragNumber>`        | 30    |

Plus 313 buttons' `onClick`, 70 selects' option sets, context menus,
keyboard shortcuts, drag handles and editor gestures.

The shared control library `src/ui/controls.tsx` (`Slider`, `DragNumber`,
`ValueMenu`) was audited first because it is the highest-leverage file: both
controls are reused across ~20 panels, so one defect there is many defects
in the product.

---

## 2. REPAIRED — 14 confirmed defects

### WAVE 4 — found by real-browser verification (not static inspection)

**14. The flagship PRISM and VLYX editors rendered at ZERO height in the
devices dock (CRITICAL).**
`src/styles/15-command-palette-2.css:14-30`. This one is invisible to jsdom
tests, unit tests and typecheck — it only appears when a browser lays the page
out, which is why the audit's final browser pass found it.

Measured in Chromium, replaying the `tests/e2e/06-plugin-workflow` steps:

| Element                    | Height    | Laid-out children        |
| -------------------------- | --------- | ------------------------ |
| `.devices-panel`           | 413 px    | —                        |
| `.fx-device-content`       | 164 px    | —                        |
| `.fxeq-panel.prism-docked` | **0 px**  | 187 px across 6 children |
| `.vlyx-docked` (VLYX)      | **10 px** | 160 px across 5 children |

Root cause: `.fx-device-content` is a column flex box with a definite 164 px,
and its fixed sibling rows total **245 px** (preset 59 + sidechain 45 + pager
24 + params 77 + trim 40). The docked panel was the only child allowed to
shrink (`flex: 1 1 0`), so it absorbed the whole 81 px of negative free space
and collapsed to nothing while `overflow: hidden` hid its 187 px of perfectly
laid-out content. The plugin surface was in the DOM, focusable, and completely
invisible — the "renders but has no effect" class in its most literal form.

Note the failed hypothesis, recorded because it is the obvious one: changing
`flex: 1 1 0` to `flex: 1 1 auto` did **not** help. With a content basis the
container overflows further and shrink still wins. The fix is a `min-height`
floor so the panel cannot be crushed below a usable height.

Verified: PRISM 0 → 200 px, VLYX 10 → 200 px, both `VISIBLE=true`, and
`tests/e2e/06-plugin-workflow` went from failing after 58 retries to passing
in 9.4 s.

**14b. The overflow that caused it was being silently discarded (MAJOR).**
`src/styles/14-command-palette.css:1121`. `.device-editor
.fx-device-content` had `overflow: hidden`, so once the panel had a floor the
remaining overflow — the output-trim row and, on a shorter window, part of the
parameter grid — was crushed out of reach. A visible plugin and an
unreachable control in the same dock is still a broken dock. The content box
now scrolls (`overflow-y: auto`, `overscroll-behavior: contain`) instead of
clipping. Measured after the change: `clientHeight 164 / scrollHeight 491 /
maxScroll 327`, and a sweep of both scroll ends finds **0 unreachable rows**
of 6. The dock is still shorter than the content; growing it remains a
product call, but nothing is lost.

### WAVE 1

**1. `Slider` leaked its `disabled` state (MAJOR).**
`src/ui/controls.tsx:339,335`. Pointer-down and keyboard were guarded by
`disabled`, but the double-click reset (`onCommit(defaultValue)`) and the
right-click value menu were not. A control rendered greyed out still wrote
to the project. Live hosts: `BeatManglerEditor.tsx:179` (CHANCE slider is
disabled when `trigger < 0.5`) and `SourceMacroDock.tsx:86` (macros before
the profile loads). Fixed by gating both paths; all four gesture paths are
now inert while disabled.

**2. `DragNumber` resolution was hardcoded (MAJOR).**
`src/ui/controls.tsx:473,476,531,536,569`. Values were quantised to
`Math.round(raw * 10) / 10` and the arrow keys stepped by a hardcoded `1`.
On sub-unit controls this destroyed the precision the control advertises:
`HUMANIZE` / `VEL·RND` (0..0.5, drag sensitivity 0.005/px, 2-decimal
display) snapped to 0.0 / 0.1 / 0.2 — roughly 10 dead pixels of drag
followed by a jump across a fifth of the range — and one arrow press
slammed the value to the maximum. Introduced `dragNumberResolution(min,
max, step?)` (pure, unit-tested): step is `1` for unit-scale ranges and
`span/100` below that; decimals derive from the range. Unit-scale controls
(120→121 BPM) keep their historical behaviour.

**3. `DragNumber` committed a no-op on every click (MINOR).**
`src/ui/controls.tsx:484`. `handlePointerUp` committed unconditionally, so
a zero-movement click pushed a no-op command into undo history and
re-sent the parameter to the engine. Now commits only when the quantised
value actually changed.

**4. `EffectRack` devices dock rendered a dead Collapse button (MINOR).**
`src/ui/EffectRack.tsx:397,566`. In device-editor mode the device is
hardcoded `expanded` and the chevron was bound to `onToggleFocus={() => {}}`
— a visible, live-looking button that did nothing. `tests/e2e/06-plugin-workflow.spec.ts:13`
already documented the intent ("The DEV dock intentionally hides rack
collapse controls in its device-editor mode"), so this was a regression
against that. `onToggleFocus` is now optional and the toggle renders only
when the host owns the expand state.

### WAVE 2

**5. Ozvena blend pad wrote two commands per gesture step (MAJOR).**
`src/ui/OzvenaPanel.tsx:155-156,184-185`. Every pointermove and every arrow
key issued `blendPad.x` then `blendPad.y` — two `setEffectParam` commands
each. A one-second drag produced ~120 history entries, evicted real edits
from the store's 256-entry cap, and a single Ctrl+Z peeled back only one
coordinate, landing the pad in a state the user never authored. The pad is
now bracketed by the store's existing undo-frame API, passed down by
`EffectRack` as optional `onGestureStart` / `onGestureEnd` (so the panel
keeps no store dependency). A cancelled drag still closes the frame.

**6. Ozvena pad numeric fields committed per keystroke (MAJOR).**
`src/ui/OzvenaPanel.tsx:279-283,296-300`. Typing `85` created two history
entries and one Ctrl+Z snapped the field back to `8`. They now hold a local
draft and commit on blur/Enter; Escape reverts to the stored value, and a
cleared field is treated as a cancel rather than `Number("") === 0`.

**7. WavetablePanel offered an unimplemented modulation destination (MAJOR).**
`src/ui/WavetablePanel.tsx:28`. `DST_OPTIONS` included
`{ value: 2, label: "Detune" }`, but index 2 is reserved:
`src/instruments/modmatrix.ts:387-397` documents it as unimplemented, and
neither the wtvoice worklet (`src/audio-worklets/wtvoice-processor.js:363,373,445`
handle 0/1/3) nor the offline fallback reads `modADst/modBDst === 2`. A user
could build a route that produced no sound at any amount, with nothing on
screen indicating it was dead. Removed; a test now pins the panel's list to
`modDstOptions()` so it cannot drift again.

**8. Inspector pad-LFO Rate could not reach half its legal range (MINOR).**
`src/ui/Inspector.tsx:1093`. The slider capped at 20 Hz while
`src/project-model/schema.ts` clamps the document to 40. Both now read the
exported `PAD_MOD_RATE_HZ_MAX` — one source of truth.

**9. An unbounded clip length could freeze the tab (CRITICAL).**
`src/ui/ArrangementPanel.tsx:2674` and
`src/commands/commands.ts:2869,6289`. The clip SECS field had no upper
bound and both resize commands clamped only the low end, so a single typed
value could request ~300 000 bars. The arrangement view allocates
`Array.from({ length: totalBars })` bar-grid nodes
(`src/ui/ArrangementPanel.tsx:3263`) plus ruler marks (`:3084`), so that
demand froze the tab. Introduced `MAX_ARRANGEMENT_CLIP_BARS = 8192`
(~5.7 hours in 4/4) as a _rendering_ invariant, not a musical limit.

### WAVE 3

**10. The clip-length bound did not apply on load (CRITICAL).**
`src/project-model/schema.ts:1552,562`. Closing #9 in the commands left the
import/persistence path open: `normalizeProject` filtered clips with
`lengthBars >= 1` and no ceiling, so an imported, hand-edited or corrupted
project JSON could reintroduce the freeze. Both the arrangement-clip and
audio-clip sanitizers now enforce the same bound.

**11. An audio clip's left-edge trim produced two undo entries (MAJOR).**
`src/ui/ArrangementPanel.tsx:1990-2000`. Trimming the left edge issues
`updateAudioClip` (trim + offset) and then `resizeAudioClip` (length) as two
separate commands. One Ctrl+Z therefore undid only the resize, leaving the
clip reading a different region of the sample at its original length — silent
content desync requiring a second undo. This also contradicted the contract
the same file asserts 190 lines earlier ("One gesture = one undo entry",
`:1798`). Added `trimAudioClipStart` to the command layer, which writes
trim, offset and length in one snapshot and keeps fades contained in the
trimmed clip, exactly as `resizeAudioClip` does.

**12. Ripple multi-move persisted fractional bar positions (MAJOR).**
`src/ui/ArrangementPanel.tsx:1782`. `delta` derives from a fractional pointer
position, and the ripple branch wrote `startBar + delta` unrounded — while the
non-ripple branch 20 lines below rounds (`:1804`). A 4.37-bar drag persisted
every moved clip off the bar grid, which the file's own comment at `:3176`
calls out as a past bug, and made a later resize report an overlap the user
cannot see. Now rounded, matching the sibling branch.

**13. Kit save/delete reported success before the write resolved (MINOR).**
`src/ui/RackStrip.tsx:251-255,267-273`. `setKitStatus('Saved "…"')` fired
unconditionally, with no `.catch` on the promise chain. If the IndexedDB
write rejected (quota, private mode) the user was told the kit had saved
while nothing was written and the list never refreshed. Status now moves
into the success path, with a failure message.

---

## 3. VERIFIED FUNCTIONAL (with evidence)

- **No UI doc mutation bypasses the command layer.** Grep for `setDoc(`,
  `doc.x = `, `project.x = ` across `src/ui/*.tsx` → zero matches. Every
  traced mutation goes through `services.store.execute`.
- **Every effect param id a panel writes resolves in the schema**
  (`blendPad.x/y`, `engines.e2.algo`, `convolution.mode/wet`,
  `global.deltaListen` …), and `setEffectParam` throws on an unknown id, so
  a bad write cannot be silently dropped.
- **Drag-preview/commit-once pattern is correct** in the editors scanned:
  `FxEqPanel.tsx:291-319`, `KaskadaPanel.tsx:315,374`,
  `ModPanel.tsx:1631-1652` (intensity curve), `PatternBar.tsx:131-148`
  (reorder), `ArrangementPanel.tsx:1931-1969` (audio clip move/trim/fade/
  gain/stretch). Each previews in local state, executes once on pointerup,
  and aborts on pointercancel. Ozvena was the only outlier.
- **Undo frames already existed and work** — `tests/store-undo-frame.test.ts`
  covered the record-take path; this audit reused that API rather than
  inventing a mechanism, and extended the coverage to the XY-pad shape.
- **Number inputs are bounded and clamped** at
  `ReferenceMapPanel.tsx:433` (MIN_BPM..MAX_BPM),
  `FxEqPanel.tsx:825-833` (`clampSplit`),
  `ArrangementPanel.tsx:3792-3800` (1..4 bars),
  `SliceLab.tsx:253-264` (`updateBoundary` clamps between neighbours).
- **Paste-a-code fields reject garbage**: `RackStrip.tsx:284,340,404` all
  check `if (!code) return` and surface an explicit "Invalid … code" status
  when the decoder returns null.
- **The mixer's typed fader value** (`Mixer.tsx:758`) validates with
  `Number.isFinite` and clamps gain `0..1.5`, pan `-1..1`, sends `0..1.5`.
- **Engine clamps what the UI under-constrains**: over-long fades are
  bounded in `AudioEngine.ts:1966,1970` (`Math.min(fadeIn, dur/2)`), so the
  SliceLab fade fields' unenforced upper `max` is cosmetic, not corrupting.

---

## 4. EDGE CASES COVERED BY TESTS

Added to `tests/ui/controls.test.tsx`, `tests/ui/EffectRack.test.tsx`,
`tests/ui/ozvena-panel.test.tsx`, `tests/ui/WavetablePanel.test.tsx`,
`tests/pad-mod.test.ts`, `tests/store-undo-frame.test.ts`,
`tests/clip-editing-audit-deep.test.ts`:

- disabled control inert on all four gesture paths (drag, dblclick, arrows,
  context menu) and no document write
- 1-pixel drag is not a dead zone on a sub-unit control
- arrow key nudges a fraction of the range instead of the end stop
- unit-scale behaviour unchanged (BPM step stays 1)
- a plain click without movement writes nothing
- a drag commits exactly once, on release
- degenerate / NaN ranges and non-finite step overrides do not produce NaN
- interrupted drag (`pointercancel`) aborts and reverts the display; a stale
  pointerup cannot commit
- a whole 30-move pad drag collapses to ONE undo entry that restores both
  coordinates
- a cancelled drag still closes the undo frame
- typed pad value is one command, not one per keystroke; Escape reverts; a
  cleared field is a cancel
- a clip longer than the bound is clamped (finite + absurd + Infinity), while
  realistic lengths pass through untouched
- the bound is enforced on document LOAD, not only on resize
- the offered wavetable destinations match the registry's authoritative list
- a left-edge trim writes trim + offset + length together, and the command's
  own undo restores all three at once
- a trim keeps fades inside the new clip length, rejects non-finite input,
  and never drops below the 0.25-bar floor

Each of the wave-1/wave-2 test groups was run against the reverted
source to confirm it fails there (falsification check) — 5 Ozvena, 2
Wavetable, 4 DragNumber and 1 Slider test failed pre-fix, and the load-bound
test failed until the normalizer filter was re-applied.

---

## 5. INCOMPLETE / INTENTIONALLY NOT "FIXED"

- **SliceLab FADE IN / FADE OUT** declare `max` = slice length but the
  handler only clamps the low end. The engine bounds the value downstream,
  so this is a UI-honesty issue, not a state-corruption one. Left as-is to
  keep the diff focused; recorded here rather than silently dropped.
- **Native `window.prompt` in the kit/PACK/BINDS/theme import paths and the
  mixer fader menu.** The values are validated and the UX is dated, but
  replacing them with dialogs is a design change, not a defect repair.
- **Pre-existing per-keystroke commits in other small numeric fields**
  (`ModPanel.tsx:934,952` automation point tick/value, `SliceLab.tsx:637,648`).
  Same class as #6, lower severity (single param, snap-to-step). Fixing
  them all is a broader refactor than this audit should make unprompted.

---

## 6. REMAINING RISKS

- **The dock is shorter than a device's content — now scrollable, not clipped.**
  The `min-height` floor alone would have been a half fix: it made the
  flagship panel visible but left the overflow silently discarded by
  `overflow: hidden`, so `fx-output-trim-row` (and on a shorter window, part of
  the parameter grid) would have been unreachable. `.device-editor
  .fx-device-content` now scrolls the overflow instead of clipping it
  (`overflow-y: auto` + `overscroll-behavior: contain`).
  Measured in Chromium: box `clientHeight=164 / scrollHeight=491 /
  maxScroll=327`, and a reachability sweep over both scroll ends reports
  **zero unreachable rows** of six. The dock itself is still shorter than the
  content — growing it is a product decision, but nothing is lost now.
- **`npm run build` FAILS its bundle budget, and did so before this audit.**
  Measured, not assumed: DAW JS is **3314 KB with this audit's source
  changes fully reverted** vs **3315 KB with them applied** (budget 3170 KB).
  The entire audit therefore accounts for **+1 KB**; the 145 KB overage comes
  from the concurrent reference/MCP/tooling expansion. Per `AGENTS.md` §4 a
  budget increase needs a measured justification in
  `scripts/check-bundle-size.mjs` — that decision belongs to whoever owns
  that work, not to this audit.
- **32 pre-existing test failures elsewhere in the suite**
  (sound-quality-pass, symbolic-prior, drone, curated-samples, wav-bwf,
  multi-tap-delay, boombap, …). Verified unrelated: the identical subset
  produces the identical 18 files / 32 tests with this audit's changes
  reverted to HEAD.
- **Browser verification is Chromium-only.** The Playwright run covers the
  layout defect in Chromium; the `min-height` floor is plain CSS with no
  engine-specific syntax, but no Firefox/WebKit layout pass was run for it.
- **`prettier --check src tests` reports 71 dirty files.** None of them are
  files this audit touched (checked by name); they belong to other in-flight
  work.
- **Coverage is targeted, not exhaustive.** Read in full:
  `controls.tsx`, `EffectRack.tsx`, `OzvenaPanel.tsx`, `WavetablePanel.tsx`,
  `Inspector.tsx` (pad-mod section), `ArrangementPanel.tsx` (gestures,
  SECS, transitions), `RackStrip.tsx` (import paths),
  `ModPanel.tsx` (automation + intensity), `PatternBar.tsx`,
  `Mixer.tsx` (fader menu), `SliceLab.tsx` (slice fields),
  `ReferenceMapPanel.tsx`, `FxEqPanel.tsx` (crossover). Audited by delegated
  pass but not personally verified line-by-line: `IntentPanel.tsx`
  (163 KB), `App.tsx` keyboard table, `TopBar.tsx`, `PianoRoll.tsx`.
- **No real-browser verification was run** for most of the repaired controls
  (`npm run test:browser` / `test:e2e`). Every repair in waves 1–3 is covered by
  jsdom tests against the real command/store layer. Wave 4 came from the
  Chromium Playwright pass and is browser-verified; see §6 for what that pass
  still does not cover.
