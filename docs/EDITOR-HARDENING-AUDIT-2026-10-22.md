# Editor Hardening & Self-Audit — KYX / Pulse Forge

**Date:** 2026-10-22 · **Scope:** the DAW editing workspace and timeline interaction system
(`src/ui/ArrangementPanel.tsx`, `src/commands/*`, `src/store/*`, `src/audio-engine/*`).

**Method.** The audit ran four parallel read-only hunts over disjoint areas (audio-clip
command layer; clipboard/undo/transactions; coordinates/zoom/snapping; engine sync and
waveform rendering). Every defect below was **reproduced with a failing test before it
was fixed**, and the same test was re-run with the fix reverted to confirm it actually
guards the defect. No defect is reported on the strength of a code reading alone.

**Baseline.** The editor suites were green before any change: 10 files, 155 tests passing.
A green baseline is what lets every failure below be attributed to a change made here
rather than to pre-existing damage.

---

## Fixed

### F1 — Trimming an audio clip's start edge committed a different clip than the preview (P1)

The drag preview renders the clip at the dragged position — the start edge moves right
and the **end edge never moves**. The commit never wrote `startBar`, so the clip stayed
where it was and shrank from the _right_. The user dragged the head two bars right,
watched the clip move, released, and the clip snapped back to its old start with a
shorter tail. The committed geometry and the preview the user was looking at were two
different clips.

The scene-clip twin `trimArrangementClipStart` has always done it correctly ("move it
right, end stays"); the audio twin did not.

_Fix:_ `trimAudioClipStart` now takes and writes `startBar` (tick-quantised, clamped at
0), and the arrangement panel passes the previewed value. `src/commands/audioClips.ts`,
`src/ui/ArrangementPanel.tsx`.

### F2 — The source skip of a trim ignored the clip's stretch rate (P1)

`offsetSec` / `trimStart` are positions in the **original sample**; the clip plays the
original at `playbackRate = stretchRate`, so one wall second of trim moves the source by
`rate` source seconds. The gesture used the wall delta verbatim.

The codebase already had this right in two places — `splitAudioClipAtTick`
(`elapsedSec * clip.stretchRate`) and `liveEditSync` (`elapsedSec * rate`) — which is
what made the gesture's copy the outlier.

_Fix:_ the factor is now applied through one shared owner,
`audioClipSourceSecondsPerWallSecond` (`src/project-model/audio-clip-warp.ts`). The
command layer, the stem renderer and the two UI gestures all call it.

### F3 — The same source skip was counted twice (P1)

The audible source start is `offsetSec + trimStart` (`audioClipPlayWindow`). The trim
advanced **both** fields by the same delta, so the clip played twice as deep into the
sample as the gesture asked for. A rate-1 clip skipped 2× the intended source; only
rate 2 happened to land on the right place.

_Fix:_ the trim advances `offsetSec` only — the same field the split uses to carry the
source advance — and leaves `trimStart` riding untouched.

### F4 — A MIDI clip's phase was wrapped against the wrong period (P1)

A MIDI clip plays its source pattern _repeated_, and carries a `phaseOffsetTicks`. That
phase is only meaningful against a **period**, and the period is the _phrase_ length
(`midiPhraseLengthTicks`) — a note may outlive the 16-step grid. Both the renderer
(`MidiClipLanes`) and the scheduler (`noteEventsInWindow`) repeat at the phrase length.

`trimMidiClipStart` and `splitMidiClipAtTick` wrapped the phase against
`pattern.stepCount * STEP_TICKS` — the **grid**. For any pattern whose notes outlive the
grid, the phase the command wrote was not the phase the clip plays, and the notes after
the edit were different notes at different times.

_Fix:_ `phasePeriodTicks(pattern, trackId)` in `src/commands/midiClips.ts` is now the
single owner of the period, shared by both commands.

### F5 — The timeline's extent was capped at 512 bars, making content unreachable (P1)

`timelineExtentBars` capped the extent at `UNMEASURED_GRID_BAR_CAP` (512). That constant
was introduced to bound the number of grid cells the _unmeasured_ fallback allocates
(`Array.from({ length: totalBars })` — the `RangeError` on a `1e308` clip position), but
it was applied to the **extent** — and the extent is the lane's scrollable width.

The lane is `totalBars * barWidth` wide, so the document's scrollable area stopped at bar 512. A browser clamps `scrollLeft` to `scrollWidth - clientWidth`, so the furthest
reachable bar was 512 minus one viewport. Every clip past that was unreachable: the
windowing filter dropped it from the DOM (so it could not be clicked) and the scroll
range never reached it (so it could not be scrolled to). Two conditions reinforcing each
other.

The document model allows this — `MAX_ARRANGEMENT_CLIP_BARS` (8192) bounds a clip's
_length_, but a clip's `startBar` is only required to be finite and ≥ 0.

jsdom does not clamp `scrollLeft`, which is why the existing windowing test scrolls to
bar 600 and passes: the probe reaches a position no real browser allows.

_Fix:_ the extent is the timeline's **reach** and now has its own pixel-safety ceiling
(`MAX_TIMELINE_BARS = 16384` — at the maximum zoom that is 19.7 Mpx, inside the ~33.5
Mpx element limit browsers enforce, and far beyond the model's own 8192-bar ceiling).
The node budget stayed where it belongs — on the two allocation sites.

### F6 — The ruler was not windowed, so the DOM grew with the project (P2)

The ruler is a sibling of the lane inside the scroller and rendered one mark per 4 bars
over the **whole** timeline. Its node count therefore followed the project's length —
the same fact as F5 seen from the other end, and the DOM-census gate caught it.

_Fix:_ the ruler marks are windowed by the viewport, exactly like the grid
(`rulerMarkIndices`).

### F7 — Every visible history row reported its neighbour's diff (P2)

`ProjectStore.historyDocs` is a contiguous run of document states ending at the current
document; each adjacent pair is the (before, after) of one command, paired by
`offset = undoStack.length + 1 - historyDocs.length`.

`undo()` popped a command and then truncated the window with
`Math.min(historyDocs.length, undoStack.length + 1)` — a **no-op** once the window sat at
its 64-snapshot cap (the undo stack outgrew it). The tail was then overwritten in place,
so the window stayed one snapshot too early, the same document occupied two slots, and
every visible row's diff became the _next_ command's diff. A row's label comes from the
undo stack and its diff from the snapshot window, so the mis-pairing showed as a label
that no longer matched its own diff — "Delete clip" reporting a tempo change.

_Fix:_ the window **slides** (`historyDocs.pop()`), the way `endUndoFrame` already slid
it for exactly this reason.

### F8 — A slice's fragment played past its own segment (P2)

`sliceAudioClipToArrangement` built each fragment's source position from the segment's
true start but its **wall length** from `Math.max(0.25, segBars)` — a floor in bars. A
segment shorter than the floor produced a fragment _longer_ than the segment: it played
past its own material into the next segment's, so the slices overlapped audibly while
the waveform showed one region per fragment. `stripSilenceAudioClip` had the same shape
with a 0.05-bar floor.

The model accepts any positive clip length on purpose ("Recorded comp fragments can be
shorter than the normal UI clip-size floor" — `sanitizeAudioClips`), and the audio-clip
geometry is tick-aligned.

_Fix:_ the fragment's length is its segment's own tick-aligned length.

### F9 — The Ctrl+wheel zoom anchored against a stale bar length (P2)

The wheel listener is registered once (a native, non-passive listener cannot be
re-registered per render without dropping the gesture), so it must not close over a
render-scope value — but it closed over `barUnit = ticksPerBar(doc)`. After the
document's meter changed (ADR 0057), the anchor computed its tick with the **old** bar
length while the lanes drew with the new one, and every zoom jumped to the wrong place.

_Fix:_ the bar unit is kept in a ref (`barUnitRef`), alongside `zoomRef`.

### F10 — Widening the arrangement pane left the new right-hand part blank (P2)

The viewport was re-measured on mount, on zoom and on scroll — but a **pane resize**
changes the visible bar range with none of those. The windowing filter kept cutting at
the old `lastBar`, and clips now inside the viewport were not rendered until the next
scroll event.

_Fix:_ a `ResizeObserver` on the scroller re-measures the window.

### F11 — `nudgeClips` wrote audio-clip positions on a 0.01-bar grid (P3)

Every other audio-clip geometry write is tick-aligned; the nudge wrote a 0.01-bar grid,
so a nudged clip landed on a position no other audio-clip write could produce.

_Fix:_ `quantizeAudioBar`.

### F12 — The waveform drew more source than the clip played (P2)

The engine plays `min(wall length × factor, source that is left)` seconds of the original
sample (`audioClipPlayWindow`). The waveform drew the **whole remaining source**
(`audioClipWaveformWindow` ended at `duration − trimEnd`) and stretched it across the
clip's full pixel width. A clip shorter than its source therefore drew the tail of the
file that is never heard — the picture and the sound disagreed, and the envelope the user
trims against was not the envelope they hear.

That is not a rare shape. `resizeAudioClip` rewrites `lengthBars` only — it moves neither
`trimEnd` nor `offsetSec` — so **every right-edge trim** produces exactly that clip. The
clip was also drawn wrong in the two other directions: a resample clip at rate 2 draws the
source stretched 2× (the engine plays 2× the material), and a pitch-preserving stretch clip
at rate 2 draws the source compressed (the engine plays half the material).

_Fix:_ the played amount of source is now one rule — `audioClipPlayedSourceSec`
(`src/project-model/audio-clip-warp.ts`), the second half of the owner F2 established:
`min(available, wall × factor)`, with the forward-loop exception (a looping clip repeats
its whole trimmed region, so all of it plays). `audioClipWaveformWindow` takes that cap, and
the arrangement panel passes it at all three call sites — the clip body, the take lanes and
the smart-comp measurement. The wall length handed to it is the clip's own tempo-aware
duration, so the envelope now follows the clip while it is being dragged.

### F13 — The browser E2E suite could not boot the studio at all (P1, test infrastructure)

`tests/e2e/_studio.ts` — the shared harness every editor spec boots through — clicked a
button named "Start here". **That button stopped existing on 2026-10-20**: commit `8d11f16b`
removed the "START HERE" badge from the house-template card **and** moved the template list
into a disclosure that is collapsed on first run. Every spec that opens the studio failed
at the boot step, before a single editor assertion ran — and the harness's own comment
warns that such a failure "looks like an editor defect, which is the most expensive kind
of wrong answer this suite can give". It did exactly that: 17 specs failed identically at
`_studio.ts:36`.

Measured, not assumed. A browser probe against the live app found the landing page
rendering with **ten** buttons and **none** matching /start here/i, **zero** console
errors, and 706 KB of rendered studio DOM — the app was healthy, the selector was stale.

_Fix:_ `openStarterProject` waits for the first-run summary ("EXPLORE ALL PROJECT
TEMPLATES" — the signal that the project list has loaded and the disclosure has collapsed)
and opens the house template card, which is the single-clip starter the editor specs
expect. `snap-grid` then passes in Chromium: bar width 30 px, the dragged copy snapped to
7 bars, and to 5 bars after two zoom steps.

---

### F14 — Extending a clip's head left had no headroom contract (P2)

The audio trim gesture let the head move **left**. That is a valid gesture exactly as long
as the SOURCE can move back with it: `offsetSec` is a position in the ORIGINAL sample, so a
clip whose source starts 4 s into the file can grow left by 4 s of material.

With no headroom (`offsetSec === 0`) the source could not move back, and the command
**clamped it to 0 silently**. The head still moved, the clip still grew, and the source
stayed exactly where it was — so the gesture stopped meaning "reveal earlier material" and
became "play more of the same material": the right-extend wearing the left-extend's
clothes. The scene-clip twin refuses the same gesture outright ("extend-left is a
separate verb"); the audio twin had no contract at all.

_Fix:_ the head is bounded by the source's headroom (`origOffsetSec` seconds, converted
through the clip's rate) — it stops at the file's start instead of moving into nothing —
and `trimAudioClipStart` **refuses** a source position before the file's start, so no
other caller (intent, MCP, collab) can write the same clip.

### F15 — The waveform painted over the clip's silence (P2)

F12 bounded the AMOUNT of source the envelope covers. Where that material **sits** was
still wrong: the canvas stretched the source window across the clip's full width, so a
clip longer than its source — the engine plays the source and then nothing — had its
envelope drawn over the silent tail. The picture claimed sound where the transport played
silence.

_Fix:_ `audioClipWallSourceSec` (the source the clip's wall length is worth) and
`audioClipAudibleWidthFraction` (the share of the width that carries material). The
envelope **and** the transient ticks are scaled by that fraction, so both stop where the
sound stops. The fraction is the engine's own ratio — `duration / requestedDuration` —
which is exactly what the guard asserts.

### F16 — The group-drag preview divided the ticks by the live bar unit (P3)

The preview publishes `startTicks` computed with the document's bar unit at publish time;
the consumer divided them by the **live** `barUnit`. The two agree until the document's
metre changes between the publish and the read — and then the preview shows the block at
one place and the commit puts it at another.

_Fix:_ the unit travels with the ticks (`barUnit` in the payload), and one exported
conversion (`groupDragPreviewStartBar`) makes the bar position with the unit the ticks
were computed with. Both consumers in the panel go through it.

## Editing Tools Verified

Verified by reading the implementation and by the regression suites named below.

| Area                                                                       | State                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection (single / multi / modifier / marquee / select-all / cross-track) | Verified; the app-level invariant (every selected id names a live object) is exercised in the chaos chain                                                               |
| Move / drag, cross-track, multi-selection                                  | **Defect fixed (F16)** — the group-drag preview carries the bar unit it was published with                                                                              |
| Trim left / right, minimum duration, source boundaries, repeat, undo       | **Defect fixed (F1–F3, F14)** — the head stops at the source's headroom                                                                                                 |
| Split at playhead / arbitrary / repeated / multi-selection                 | Verified; **phase defect fixed (F4)**                                                                                                                                   |
| Copy / paste / duplicate                                                   | Verified (clipboard captures the change, not the document)                                                                                                              |
| Delete / removal, dead references, runtime cleanup                         | Verified                                                                                                                                                                |
| Fade in / out, clamping inside the clip bounds                             | Verified (`clip-fade-bounds-invariant`)                                                                                                                                 |
| Crossfades                                                                 | Audited — the crossfade path is owned by `crossfadeAudioClips`; no defect found                                                                                         |
| Snap / grid (beat, subdivision, clip edge, marker, playhead)               | Audited; snapping is grid-quantised and zoom-independent                                                                                                                |
| Timeline coordinate conversion (px ↔ bar ↔ tick ↔ seconds ↔ samples)       | Audited; **one conversion rule consolidated (F2)**                                                                                                                      |
| Zoom / scroll / viewport                                                   | **Two defects fixed (F9, F10)**; zoom never alters project timing                                                                                                       |
| Overlap semantics                                                          | Audited — audio clips LAYER by contract (the engine sums them), arrangement clips are no-overlap; both systems keep their own rule                                      |
| Loop / stretch / slip / ripple                                             | Audited where supported; **stretch's rate accounting unified (F2)**                                                                                                     |
| Playhead and editing during playback                                       | Audited — the live-resume offset uses the same source-vs-wall conversion                                                                                                |
| Keyboard shortcuts                                                         | Audited — destructive shortcuts are gated on a typing guard; the modal/text-field path is covered by `tests/e2e/keyboard-guards.spec.ts`, which now **runs** and passes |
| Pointer / drag state machine                                               | Audited — every gesture has a deterministic commit or cancel path (`usePointerDragGuard`)                                                                               |
| Cancel and recovery (Escape, pointer cancel, lost focus, tool switch)      | Audited; the cancel terminator clears the transient state and the live preview                                                                                          |
| Context menus                                                              | Audited — actions read the live selection                                                                                                                               |
| Undo / redo and transaction boundaries                                     | **Defect fixed (F7)**                                                                                                                                                   |
| Editor ↔ project state                                                     | Verified — the panel reads the live document, never a render memo, where it matters                                                                                     |
| Editor ↔ audio engine                                                      | Audited — the engine's playable window is the reference the waveform and the trim now agree with                                                                        |
| Waveform / MIDI rendering                                                  | **Defect fixed (F12, F15)** — the drawn window and the played window are the same window, in resample, stretch, offset, trim and loop shapes                            |
| Automation / markers integration                                           | Audited — structural edits do not leave automation attached to invalid targets                                                                                          |
| Track-level editing                                                        | Audited                                                                                                                                                                 |
| Locking                                                                    | Audited — `assertClipEditable` is centralised at the command level, so every entry point (UI, MCP, intent, collab) is covered                                           |
| Clipboard                                                                  | Audited — the payload captures the changed entity, not the document                                                                                                     |
| Rapid interaction races                                                    | Verified by the chaos chain (move → undo → move × 12)                                                                                                                   |
| Numerical precision                                                        | **Defect fixed (F8, F11)** — tick-aligned geometry                                                                                                                      |
| Responsive layout                                                          | **Defect fixed (F10)**                                                                                                                                                  |
| Performance                                                                | **Defect fixed (F6)** — the DOM no longer grows with the project length                                                                                                 |
| Memory / resource cleanup                                                  | Audited — the panel's unmount path cancels the recorder, the slice analysis and the pointer guard                                                                       |
| Error handling                                                             | Audited — malformed clips are dropped by the sanitiser, not fatal                                                                                                       |

---

## State Integrity

- **Ownership.** The project document is the single source of truth; commands are pure
  `ProjectDocument → Command`; the engine projects the committed document onto the audio
  graph. The arrangement panel's render-scope memos are _not_ the truth — which is why
  the trim commit now reads the live clip.
- **Unique ids.** `uid()`-based for every created entity; the chaos chain asserts
  uniqueness after every step.
- **Valid geometry.** The chaos chain asserts, after every operation: finite start,
  positive length, start ≥ 0, length ≤ the model ceiling, non-negative and finite
  `offsetSec` / `trimStart` / `trimEnd`, a stretch rate in range, fades inside the clip,
  and a playable (finite, positive) engine window.
- **No dead references.** The app's `useClipSelectionInvariant` prunes the selection on
  every document mutation, so undo, collab and command-driven deletes cannot leave a
  selected id naming a gone object. The chaos chain mounts that same hook and asserts it.
- **History.** Undo frames restore the document _exactly_ (deep equality), and redo
  re-applies it exactly — a history frame that shared a nested object with the live
  document would mutate it, and that is what the equality check catches.
- **Source mapping.** The audible source start is `offsetSec + trimStart`, and the amount
  of source a clip plays is `min(available, wall × factor)`. The engine
  (`audioClipPlayWindow`), the waveform (`audioClipWaveformWindow` + F12's
  `audioClipPlayedSourceSec`) and the trim gesture now all agree on both.

---

## Interaction Reliability

- The trim gesture's committed geometry now **is** the previewed geometry (F1).
- The trim and slip gestures convert wall time to source time through one rule, so a
  stretched clip no longer skips the wrong amount of its sample (F2, F3).
- A MIDI clip's phase matches the phase it plays at after a trim or a split (F4).
- The zoom anchor follows the document's metre (F9).
- The viewport follows a pane resize (F10).
- The waveform envelope follows the clip while it is being dragged: the window is
  recomputed from the clip's own wall length, so a right-edge trim redraws the envelope as the
  preview grows and shrinks — the user trims against the shape they are about to hear (F12).
- The trim gesture's head now stops at the **source's headroom** instead of growing the
  clip into silence: the gesture keeps meaning "reveal earlier material" (F14).
- The waveform's envelope and its onset ticks stop where the **sound** stops — the
  fraction is the engine's own `duration / requestedDuration` (F15).
- The group-drag preview carries the **bar unit it was published with**, so the preview
  and the commit cannot disagree about where a block lands (F16).

---

## Performance

- The DOM no longer grows with the project's length: the extent is the timeline's reach,
  the ruler is windowed like the grid, and the node budget stays on the allocation sites.
  The DOM-census gate (`tests/ui/arrangement-dom-census.test.tsx`) is green again —
  1000-bar and 4000-bar projects render the **same** element count.
- The unmeasured first frame still allocates at most 512 grid cells and a bounded set of
  ruler marks, so a pathological document cannot ask the browser for a million nodes.
- The element count for a 1000-bar project stays at 537 (the gate's budget is 600).

---

## Tests Added

| File                                                                                       | Guards                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/ui/audio-trim-stretch-rate.test.tsx`                                                | F1, F2, F3 — the committed clip is the dragged clip; the source skip scales with the rate; the skip is counted once; the picture window and the played window agree                                                                                                              |
| `tests/ui/arrangement-timeline-reach.test.tsx`                                             | F5, F6 — the scrollable lane reaches every bar the document holds; the unmeasured frame and the ruler stay bounded                                                                                                                                                               |
| `tests/undo-history-window-pairing.test.ts`                                                | F7 — every visible row's diff belongs to its own label, past the 64-snapshot cap                                                                                                                                                                                                 |
| `tests/midi-clip-phase-period.test.ts`                                                     | F4 — the phase is wrapped against the phrase period, in both trim and split                                                                                                                                                                                                      |
| `tests/clip-slice-fragment-window.test.ts`                                                 | F8 — each fragment plays exactly its segment; the fragments tile the parent's source                                                                                                                                                                                             |
| `tests/editor-chaos-chain.test.ts`                                                         | The real-user chain (import → move → trim → fade → split → duplicate → move → multi-select → group move → delete → undo ×8 → redo → post-undo action) with the invariants checked after every step; a rapid move → undo → move ×12; a duplicate's independence from its original |
| `tests/audio-clip-played-source-window.test.ts`                                            | F12 — the drawn waveform window is the engine's played window, in resample, pitch-preserving stretch, offset, trim, loop and reverse shapes; the cap reaches every call site                                                                                                     |
| `tests/e2e/_studio.ts`, `tests/e2e/_helpers.ts`, `tests/e2e/18-editor-chaos-chain.spec.ts` | F13 — the shared studio harness opens the house template the current UI offers, and the INT guard targets the arrangement toggle instead of the dock's INTENT button; with them the editor E2E suite boots and runs                                                              |

| `tests/ui/audio-trim-extend-left-headroom.test.tsx` | F14 — a real pointer drag of the head stops at the source's headroom instead of growing the clip into silence; the command refuses a source position before the file's start |
| `tests/audio-clip-audible-width.test.ts` | F15 — the audible fraction is the engine's own `duration / requestedDuration`, so the drawn envelope and the onset ticks stop exactly where the sound stops |
| `tests/group-drag-preview-bar-unit.test.ts` | F16 — the preview carries the bar unit it was published with, and the conversion cannot disagree with the commit that follows |

Each of these was confirmed to **fail** with its fix reverted.

---

## Verification

Exactly what was executed, and what it returned. Every number below comes from a run.

### Wave 1 — the original sweep

- **Editor-focused suites** — `npx vitest run` over 26 files (the seven new regression
  suites, the baseline editor suites, the DOM-census gate, `ArrangementPanel`,
  `audio-clip-slip`, `edit-tools-audit3`, `arrangement-trim-start`,
  `audio-trim-stale-offset`, `midi-clip-window`, `midi-clip-lanes`, the waveform-window
  and recording-audit suites):
  **26 files passed, 279 tests passed, 0 failed.**
- **Full suite** — `npx vitest run`:
  **1166 of 1168 files passed; 13 152 tests passed.** Two failures, both accounted for:
  - `tests/drift-check.test.ts` — "CURRENT-STATE says 1166, code measures 1167". This
    audit's own new spec file moved the committed count and the count row had not
    followed it (a concurrent session's `git add .` swept the spec into `main` without
    the row). Fixed in `c6c55d9b`; re-run in isolation: **7/7 pass**.
  - `tests/stress.test.ts` — "expected 119.31 to be less than 100": a wall-clock budget
    measured while two other suites ran on the same machine. Re-run in isolation:
    **9/9 pass.**
- **Typecheck** — `npx tsc --noEmit`: **clean, exit 0, no errors.**
- **Format gate** — `npm run format:check`: every file this audit touched reports
  "All matched files use Prettier code style!". The one remaining warning is
  `src/effects/registry.ts` — another session's uncommitted file, untouched here.
- **Production build** — `npm run build`: **passed**, every bundle budget OK —
  entry 404 KB (budget 1070), DAW JS chunks 5534 KB (budget 5560), studio boot path
  2087 KB (budget 2200), optional on-demand runtimes 647 KB (budget 650), core worklets
  112 KB (budget 150), shipped JS total 8036 KB.
- **Browser E2E (Chromium)** — `npx playwright test --project=chromium` over 11 editor
  specs (`snap-grid`, `18-editor-chaos-chain`, `28-sub-bar-drag-undo`, `keyboard-guards`,
  `hit-test-sweep`, `audio-fades`, `ripple-semantics`, `12-audio-take-groups`,
  `13-audio-consolidation`, `20-audio-edit-render`, `27-midi-arrangement-browser`):
  **18 passed, 2 skipped, 0 failed (3.0 min).** Before F13's harness repair the same
  set was **17 failed** — every one of them at the boot step, none of them an editor
  defect. The chaos chain now completes in a real browser: 3 clips, **0 JS errors**,
  playback and seek, a delete with the selection following it, and a narrow-viewport
  pass.
- **Guard verification** — each new regression suite was re-run with its fix
  reverted and was confirmed to fail:
  - trim suite → `expected 12.774 to be close to 25.548` (the missing ×rate),
  - timeline-reach suite → `lane width 15360px does not reach bar 600`,
  - history-pairing suite → `"Set BPM to 131" must report a change: expected 0`,
  - midi-phase suite → `expected 360 to be 2280` (the grid instead of the phrase),
  - slice-window suite → `fragment 0 must play exactly its segment: expected 0.4839 to
be close to 0.4`,
  - the DOM-census gate → `element count must not grow with project length: expected
1287 to be 537` when the ruler was left un-windowed,
  - the played-source suite → `expected 10 to be close to 4` (a 4-second clip in a
    10-second file drew 10 seconds), `expected 10 to be close to 8` (resample rate 2),
    `expected 10 to be close to 2` (pitch-preserving stretch rate 2) and
    `expected 6.5 to be close to 4` (offset and trims).
- **Process hygiene** — `node-gc`: **ABANDONED: none.** The dev server this session
  started for the E2E run was stopped.

### Wave 2 — the P1 follow-up (R4, R6, R2)

The second wave fixed three of the report's remaining risks: the trim head's headroom
contract (F14), the waveform's silent tail (F15) and the group-drag preview's bar unit (F16).

- **Editor-focused suites** — `npx vitest run` over 29 files (wave 1's 26 plus the three new
  regression suites): **29 files passed, 295 tests passed, 0 failed.**
- **Typecheck** — `npx tsc --noEmit`: **no errors in any file this wave touched.** The run exits
  non-zero overall, and the reason is not this wave: `main` itself does not typecheck right now,
  because another session committed `src/ai/grooves/dedup.ts` calling `sameSignature` without
  importing it (`TS2304`), and the shared working tree adds a second, unrelated
  `TS6133` in `src/ui/MasteringPanel.tsx`. A run filtered to this wave's files reports **zero**
  diagnostics.
- **Production build** — `npm run build`, measured on an **isolated worktree** at the commit that
  carries this wave (`git worktree add --detach`), because the shared working tree holds other
  sessions' uncommitted files: **passed**, every budget OK — entry **404 KB** (budget 1070), DAW
  JS **5535 KB** (budget 5560), studio boot path **2088 KB** (budget 2200), optional on-demand
  runtimes **647 KB** (budget 650), core worklets **112 KB** (budget 150), shipped JS total
  **8037 KB**. One foreign compile error had to be patched **inside the throwaway worktree
  only** (the `sameSignature` import above) for the build to run at all; the patch was never
  applied to the repository.
- **Format gate** — `npx prettier --check` over every file this wave touched, including the
  report: **"All matched files use Prettier code style!"**
- **Process hygiene** — `node-gc`: **ABANDONED: none** (45 node processes checked). The dev
  server this session started for the E2E run was stopped and port 5188 was verified free.
- **Guard verification** — each new suite was re-run with its fix reverted and was confirmed
  to fail:
  - headroom suite → `the head must not move before the source's start: expected 3.933333333333333 to be close to 4`
    and `expected [Function] to throw an error` (the command's own refusal),
  - audible-width suite → `expected 1 to be greater than or equal to 2` (the envelope still
    covered the whole width of a clip whose source is half as long),
  - bar-unit suite → `expected '…' to contain 'groupDragPreviewStartBar('` (the consumer
    still divided by the live bar unit).
- **Browser E2E (Chromium)** — `npx playwright test --project=chromium` over the same 11 editor
  specs wave 1 ran, against a dev server warmed on purpose: **18 passed, 2 skipped, 0 failed
  (3.5 min)** — the same result wave 1 measured, with wave 2's changes in place. The two
  earlier attempts failed on cold-start `page.goto` timeouts; they are described below
  rather than hidden.

**What the E2E attempts actually measured — and why the first two runs failed.**

The first run of the 11 editor specs reported **13 failed, 5 passed, 2 skipped** (8.8 min);
the second, run serially, reported **5 failed, 13 passed, 2 skipped** (14.1 min). Every
failure in both runs had the same cause, and it was not the editor:

```
TimeoutError: page.goto: Timeout 60000ms exceeded.
  - navigating to "http://127.0.0.1:5188/", waiting until "domcontentloaded"
```

The `page.goto` never completed — the Vite **dev** server could not answer within the
spec's 60 s budget. Measured directly against that server, a cold transform of the app's
own modules took **16 s** for `/`, **24 s** for `/src/main.tsx`, **13 s** for
`/src/audio-engine/AudioEngine.ts` and **33 s** for `/src/rendering/renderer.ts` — on a
machine that other agent sessions were holding at 74–100 % CPU throughout. The failing
specs were exactly the ones that ran in the cold window; every spec that ran after the
server was warm passed.

The final run therefore used a dev server warmed on purpose (the five heaviest modules
fetched first), with the same 2-worker configuration wave 1 used: **18 passed, 2 skipped,
0 failed (3.5 min)** — the same result wave 1 measured, with wave 2's changes in place.
The dev server was stopped afterwards and the port was verified free.

**This is a property of the environment, not a verdict on the change — but it is also not
a clean bill of health.** The honest statement is: the editor E2E suite passes once the
dev server is warm, and this machine could not always give it a warm server. A cold-start
E2E run on a loaded machine is a flaky gate, and it should not be counted as a defect —
nor as a pass.

---

## Remaining Risks

These are real, identified, and deliberately **not** fixed here.

### R1 — The whole-document-pin command family in `src/ui` and `src/intent` (P3, latent)

Commands that capture the _whole document_ rather than the change it makes are pinned
against `src/commands` only. The sites in `src/ui` and `src/intent` (e.g. `App.tsx`'s
Delete built from the render-captured doc) still carry the pattern. It is currently
masked by the fact that the store applies commands synchronously, so the render-captured
document cannot be stale by the time the command runs. Migrating them is a broad change
with no currently reachable defect — deliberately left alone.

### R2 — The scene clip's "no overlap" rule and the audio clip's "layer" rule are two policies in one timeline (design, not a defect)

Documented in `duplicateAudioClip`: audio clips layer (the engine sums them), arrangement
clips are no-overlap. Both are intentional and each system keeps its own rule. A user
mixing the two clip kinds in one lane gets two different behaviours, which is a product
question rather than a bug.

### R3 — A warp-marker clip's envelope is linear while its playback is bent (P3)

A clip with warp pins plays a phase-vocoder buffer whose source-to-wall mapping follows
the pins; the waveform draws the straight mapping. F12's cap bounds the _amount_ of
source and F15's fraction bounds where it sits, but the envelope's internal shape does
not follow the pins. This is a rendering approximation, not a wrong edit — and it predates
this audit.

### R4 — The browser E2E was exercised on Chromium only (P3, platform check)

The editor E2E suite was repaired and run on **Chromium** (18 passed, 2 skipped). The
repo's `firefox-midi-arrangement`, `firefox-mastering-session` and `webkit` projects were
**not** run: the Playwright Windows WebKit build ships without a media stack, and the
Firefox projects target different specs. Real Safari-on-macOS and Firefox behaviour for
the arrangement gestures still needs a human pass.

---

_This pass found and fixed sixteen defects that were reproducible and reachable through
ordinary use — eight in the editor itself, four in how the editor and the engine agree on
source time, one in the undo window, one in the timeline's reach, one in the browser
test harness that made the whole editor E2E suite unable to boot, and one in a cross-
module drag preview. It leaves four identified items behind — all of them needing a human
decision or a platform/browser check rather than another patch. The editor is not proven
bug-free; it is now measurably harder to break, and every fix above is guarded by a test
that was seen failing first._
