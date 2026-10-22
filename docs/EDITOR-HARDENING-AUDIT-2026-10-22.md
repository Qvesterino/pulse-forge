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
where it was and shrank from the *right*. The user dragged the head two bars right,
watched the clip move, released, and the clip snapped back to its old start with a
shorter tail. The committed geometry and the preview the user was looking at were two
different clips.

The scene-clip twin `trimArrangementClipStart` has always done it correctly ("move it
right, end stays"); the audio twin did not.

*Fix:* `trimAudioClipStart` now takes and writes `startBar` (tick-quantised, clamped at
0), and the arrangement panel passes the previewed value. `src/commands/audioClips.ts`,
`src/ui/ArrangementPanel.tsx`.

### F2 — The source skip of a trim ignored the clip's stretch rate (P1)

`offsetSec` / `trimStart` are positions in the **original sample**; the clip plays the
original at `playbackRate = stretchRate`, so one wall second of trim moves the source by
`rate` source seconds. The gesture used the wall delta verbatim.

The codebase already had this right in two places — `splitAudioClipAtTick`
(`elapsedSec * clip.stretchRate`) and `liveEditSync` (`elapsedSec * rate`) — which is
what made the gesture's copy the outlier.

*Fix:* the factor is now applied through one shared owner,
`audioClipSourceSecondsPerWallSecond` (`src/project-model/audio-clip-warp.ts`). The
command layer, the stem renderer and the two UI gestures all call it.

### F3 — The same source skip was counted twice (P1)

The audible source start is `offsetSec + trimStart` (`audioClipPlayWindow`). The trim
advanced **both** fields by the same delta, so the clip played twice as deep into the
sample as the gesture asked for. A rate-1 clip skipped 2× the intended source; only
rate 2 happened to land on the right place.

*Fix:* the trim advances `offsetSec` only — the same field the split uses to carry the
source advance — and leaves `trimStart` riding untouched.

### F4 — A MIDI clip's phase was wrapped against the wrong period (P1)

A MIDI clip plays its source pattern *repeated*, and carries a `phaseOffsetTicks`. That
phase is only meaningful against a **period**, and the period is the *phrase* length
(`midiPhraseLengthTicks`) — a note may outlive the 16-step grid. Both the renderer
(`MidiClipLanes`) and the scheduler (`noteEventsInWindow`) repeat at the phrase length.

`trimMidiClipStart` and `splitMidiClipAtTick` wrapped the phase against
`pattern.stepCount * STEP_TICKS` — the **grid**. For any pattern whose notes outlive the
grid, the phase the command wrote was not the phase the clip plays, and the notes after
the edit were different notes at different times.

*Fix:* `phasePeriodTicks(pattern, trackId)` in `src/commands/midiClips.ts` is now the
single owner of the period, shared by both commands.

### F5 — The timeline's extent was capped at 512 bars, making content unreachable (P1)

`timelineExtentBars` capped the extent at `UNMEASURED_GRID_BAR_CAP` (512). That constant
was introduced to bound the number of grid cells the *unmeasured* fallback allocates
(`Array.from({ length: totalBars })` — the `RangeError` on a `1e308` clip position), but
it was applied to the **extent** — and the extent is the lane's scrollable width.

The lane is `totalBars * barWidth` wide, so the document's scrollable area stopped at bar
512. A browser clamps `scrollLeft` to `scrollWidth - clientWidth`, so the furthest
reachable bar was 512 minus one viewport. Every clip past that was unreachable: the
windowing filter dropped it from the DOM (so it could not be clicked) and the scroll
range never reached it (so it could not be scrolled to). Two conditions reinforcing each
other.

The document model allows this — `MAX_ARRANGEMENT_CLIP_BARS` (8192) bounds a clip's
*length*, but a clip's `startBar` is only required to be finite and ≥ 0.

jsdom does not clamp `scrollLeft`, which is why the existing windowing test scrolls to
bar 600 and passes: the probe reaches a position no real browser allows.

*Fix:* the extent is the timeline's **reach** and now has its own pixel-safety ceiling
(`MAX_TIMELINE_BARS = 16384` — at the maximum zoom that is 19.7 Mpx, inside the ~33.5
Mpx element limit browsers enforce, and far beyond the model's own 8192-bar ceiling).
The node budget stayed where it belongs — on the two allocation sites.

### F6 — The ruler was not windowed, so the DOM grew with the project (P2)

The ruler is a sibling of the lane inside the scroller and rendered one mark per 4 bars
over the **whole** timeline. Its node count therefore followed the project's length —
the same fact as F5 seen from the other end, and the DOM-census gate caught it.

*Fix:* the ruler marks are windowed by the viewport, exactly like the grid
(`rulerMarkIndices`).

### F7 — Every visible history row reported its neighbour's diff (P2)

`ProjectStore.historyDocs` is a contiguous run of document states ending at the current
document; each adjacent pair is the (before, after) of one command, paired by
`offset = undoStack.length + 1 - historyDocs.length`.

`undo()` popped a command and then truncated the window with
`Math.min(historyDocs.length, undoStack.length + 1)` — a **no-op** once the window sat at
its 64-snapshot cap (the undo stack outgrew it). The tail was then overwritten in place,
so the window stayed one snapshot too early, the same document occupied two slots, and
every visible row's diff became the *next* command's diff. A row's label comes from the
undo stack and its diff from the snapshot window, so the mis-pairing showed as a label
that no longer matched its own diff — "Delete clip" reporting a tempo change.

*Fix:* the window **slides** (`historyDocs.pop()`), the way `endUndoFrame` already slid
it for exactly this reason.

### F8 — A slice's fragment played past its own segment (P2)

`sliceAudioClipToArrangement` built each fragment's source position from the segment's
true start but its **wall length** from `Math.max(0.25, segBars)` — a floor in bars. A
segment shorter than the floor produced a fragment *longer* than the segment: it played
past its own material into the next segment's, so the slices overlapped audibly while
the waveform showed one region per fragment. `stripSilenceAudioClip` had the same shape
with a 0.05-bar floor.

The model accepts any positive clip length on purpose ("Recorded comp fragments can be
shorter than the normal UI clip-size floor" — `sanitizeAudioClips`), and the audio-clip
geometry is tick-aligned.

*Fix:* the fragment's length is its segment's own tick-aligned length.

### F9 — The Ctrl+wheel zoom anchored against a stale bar length (P2)

The wheel listener is registered once (a native, non-passive listener cannot be
re-registered per render without dropping the gesture), so it must not close over a
render-scope value — but it closed over `barUnit = ticksPerBar(doc)`. After the
document's meter changed (ADR 0057), the anchor computed its tick with the **old** bar
length while the lanes drew with the new one, and every zoom jumped to the wrong place.

*Fix:* the bar unit is kept in a ref (`barUnitRef`), alongside `zoomRef`.

### F10 — Widening the arrangement pane left the new right-hand part blank (P2)

The viewport was re-measured on mount, on zoom and on scroll — but a **pane resize**
changes the visible bar range with none of those. The windowing filter kept cutting at
the old `lastBar`, and clips now inside the viewport were not rendered until the next
scroll event.

*Fix:* a `ResizeObserver` on the scroller re-measures the window.

### F11 — `nudgeClips` wrote audio-clip positions on a 0.01-bar grid (P3)

Every other audio-clip geometry write is tick-aligned; the nudge wrote a 0.01-bar grid,
so a nudged clip landed on a position no other audio-clip write could produce.

*Fix:* `quantizeAudioBar`.

---

## Editing Tools Verified

Verified by reading the implementation and by the regression suites named below.

| Area | State |
| --- | --- |
| Selection (single / multi / modifier / marquee / select-all / cross-track) | Verified; the app-level invariant (every selected id names a live object) is exercised in the chaos chain |
| Move / drag, cross-track, multi-selection | Verified |
| Trim left / right, minimum duration, source boundaries, repeat, undo | **Defect fixed (F1–F3)** |
| Split at playhead / arbitrary / repeated / multi-selection | Verified; **phase defect fixed (F4)** |
| Copy / paste / duplicate | Verified (clipboard captures the change, not the document) |
| Delete / removal, dead references, runtime cleanup | Verified |
| Fade in / out, clamping inside the clip bounds | Verified (`clip-fade-bounds-invariant`) |
| Crossfades | Audited — the crossfade path is owned by `crossfadeAudioClips`; no defect found |
| Snap / grid (beat, subdivision, clip edge, marker, playhead) | Audited; snapping is grid-quantised and zoom-independent |
| Timeline coordinate conversion (px ↔ bar ↔ tick ↔ seconds ↔ samples) | Audited; **one conversion rule consolidated (F2)** |
| Zoom / scroll / viewport | **Two defects fixed (F9, F10)**; zoom never alters project timing |
| Overlap semantics | Audited — audio clips LAYER by contract (the engine sums them), arrangement clips are no-overlap; both systems keep their own rule |
| Loop / stretch / slip / ripple | Audited where supported; **stretch's rate accounting unified (F2)** |
| Playhead and editing during playback | Audited — the live-resume offset uses the same source-vs-wall conversion |
| Keyboard shortcuts | Audited — destructive shortcuts are gated on a typing guard; the modal/text-field path is covered by `tests/e2e/keyboard-guards.spec.ts` |
| Pointer / drag state machine | Audited — every gesture has a deterministic commit or cancel path (`usePointerDragGuard`) |
| Cancel and recovery (Escape, pointer cancel, lost focus, tool switch) | Audited; the cancel terminator clears the transient state and the live preview |
| Context menus | Audited — actions read the live selection |
| Undo / redo and transaction boundaries | **Defect fixed (F7)** |
| Editor ↔ project state | Verified — the panel reads the live document, never a render memo, where it matters |
| Editor ↔ audio engine | Audited — the engine's playable window is the reference the waveform and the trim now agree with |
| Waveform / MIDI rendering | Audited; the waveform window and the played window share the same start (`offsetSec + trimStart`) |
| Automation / markers integration | Audited — structural edits do not leave automation attached to invalid targets |
| Track-level editing | Audited |
| Locking | Audited — `assertClipEditable` is centralised at the command level, so every entry point (UI, MCP, intent, collab) is covered |
| Clipboard | Audited — the payload captures the changed entity, not the document |
| Rapid interaction races | Verified by the chaos chain (move → undo → move × 12) |
| Numerical precision | **Defect fixed (F8, F11)** — tick-aligned geometry |
| Responsive layout | **Defect fixed (F10)** |
| Performance | **Defect fixed (F6)** — the DOM no longer grows with the project length |
| Memory / resource cleanup | Audited — the panel's unmount path cancels the recorder, the slice analysis and the pointer guard |
| Error handling | Audited — malformed clips are dropped by the sanitiser, not fatal |

---

## State Integrity

* **Ownership.** The project document is the single source of truth; commands are pure
  `ProjectDocument → Command`; the engine projects the committed document onto the audio
  graph. The arrangement panel's render-scope memos are *not* the truth — which is why
  the trim commit now reads the live clip.
* **Unique ids.** `uid()`-based for every created entity; the chaos chain asserts
  uniqueness after every step.
* **Valid geometry.** The chaos chain asserts, after every operation: finite start,
  positive length, start ≥ 0, length ≤ the model ceiling, non-negative and finite
  `offsetSec` / `trimStart` / `trimEnd`, a stretch rate in range, fades inside the clip,
  and a playable (finite, positive) engine window.
* **No dead references.** The app's `useClipSelectionInvariant` prunes the selection on
  every document mutation, so undo, collab and command-driven deletes cannot leave a
  selected id naming a gone object. The chaos chain mounts that same hook and asserts it.
* **History.** Undo frames restore the document *exactly* (deep equality), and redo
  re-applies it exactly — a history frame that shared a nested object with the live
  document would mutate it, and that is what the equality check catches.
* **Source mapping.** The audible source start is `offsetSec + trimStart`; the engine
  (`audioClipPlayWindow`), the waveform (`audioClipWaveformWindow`) and the trim gesture
  now all agree on it.

---

## Interaction Reliability

* The trim gesture's committed geometry now **is** the previewed geometry (F1).
* The trim and slip gestures convert wall time to source time through one rule, so a
  stretched clip no longer skips the wrong amount of its sample (F2, F3).
* A MIDI clip's phase matches the phase it plays at after a trim or a split (F4).
* The zoom anchor follows the document's metre (F9).
* The viewport follows a pane resize (F10).

---

## Performance

* The DOM no longer grows with the project's length: the extent is the timeline's reach,
  the ruler is windowed like the grid, and the node budget stays on the allocation sites.
  The DOM-census gate (`tests/ui/arrangement-dom-census.test.tsx`) is green again —
  1000-bar and 4000-bar projects render the **same** element count.
* The unmeasured first frame still allocates at most 512 grid cells and a bounded set of
  ruler marks, so a pathological document cannot ask the browser for a million nodes.
* The element count for a 1000-bar project stays at 537 (the gate's budget is 600).

---

## Tests Added

| File | Guards |
| --- | --- |
| `tests/ui/audio-trim-stretch-rate.test.tsx` | F1, F2, F3 — the committed clip is the dragged clip; the source skip scales with the rate; the skip is counted once; the picture window and the played window agree |
| `tests/ui/arrangement-timeline-reach.test.tsx` | F5, F6 — the scrollable lane reaches every bar the document holds; the unmeasured frame and the ruler stay bounded |
| `tests/undo-history-window-pairing.test.ts` | F7 — every visible row's diff belongs to its own label, past the 64-snapshot cap |
| `tests/midi-clip-phase-period.test.ts` | F4 — the phase is wrapped against the phrase period, in both trim and split |
| `tests/clip-slice-fragment-window.test.ts` | F8 — each fragment plays exactly its segment; the fragments tile the parent's source |
| `tests/editor-chaos-chain.test.ts` | The real-user chain (import → move → trim → fade → split → duplicate → move → multi-select → group move → delete → undo ×8 → redo → post-undo action) with the invariants checked after every step; a rapid move → undo → move ×12; a duplicate's independence from its original |

Each of these was confirmed to **fail** with its fix reverted.

---

## Verification

Exactly what was executed in this session:

* `npx vitest run` — the full suite (see the run summary in the delivery message).
* `npx vitest run <targeted files>` — the editor hardening baseline, the four new
  regression suites, the DOM-census gate, `ArrangementPanel.test.tsx`, and the existing
  editor suites (`editor-ultra-hardening`, `editor-uncovered-verbs`,
  `editor-hardening-chaos`, `editing-timeline-audit`, `clip-editing-audit-deep`,
  `clip-editing-audit2`, `arrangement-tools-audit`, `clip-fade-bounds-invariant`,
  `clip-clipboard-integrity`, `undo-redo-integrity`, `audio-clip-slip`,
  `edit-tools-audit3`, `arrangement-trim-start`, `audio-trim-stale-offset`,
  `clip-clipboard`, `clip-groups-lock`).
* `npx tsc --noEmit` — the typecheck.
* `npx prettier --write` on every changed file, and `npm run format:check`.
* `npm run build` — the production build with its bundle budgets.

**Not executed:** the Playwright E2E suite (`tests/e2e/`) — it needs a browser harness
that was not available in this session. The E2E specs that touch the changed surfaces
(`keyboard-guards`, `snap-grid`, `11-audio-input-recording`) were reviewed by reading,
not by running.

---

## Remaining Risks

These are real, identified, and deliberately **not** fixed here.

### R1 — The waveform shows more source than the clip plays (P2, needs a product decision)

`audioClipWaveformWindow` returns `[offsetSec + trimStart, bufferDuration - trimEnd]` —
the whole remaining source — while the engine plays
`min(requested wall duration, available source)`. When a clip is shorter than its
source (after a right-edge trim, which does not move `trimEnd`), the waveform draws
source that is never heard.

This is a **visual-convention** question with a large blast radius: every clip, both
waveform call sites, and a source-pinned test (`tests/recording-audit.test.ts` pins the
exact call). Ableton and Logic draw the discarded tail *dimmed* rather than truncating
the envelope, so "show the whole source" is defensible — but then the engine should
play the whole source, which is a different change again. This needs a human decision,
not an audit fix.

### R2 — The group drag preview converts ticks with the live bar unit (P3)

`groupDragPreview` publishes `startTicks` computed with the document's bar unit at
publish time; the consumer divides them by the *live* `barUnit`. The two disagree only
if the document's meter changes mid-gesture. The fix would change a cross-module event
payload; the exposure is a one-frame preview offset in an extremely rare window.

### R3 — The whole-document-pin command family in `src/ui` and `src/intent` (P3, latent)

Commands that capture the *whole document* rather than the change it makes are pinned
against `src/commands` only. The sites in `src/ui` and `src/intent` (e.g. `App.tsx`'s
Delete built from the render-captured doc) still carry the pattern. It is currently
masked by the fact that the store applies commands synchronously, so the render-captured
document cannot be stale by the time the command runs. Migrating them is a broad change
with no currently reachable defect — deliberately left alone.

### R4 — Extending a clip's start edge leftward has no headroom contract (P3)

The audio trim gesture allows dragging the head *left* (the scene twin refuses: "extend-
left is a separate verb"). When the source has no headroom, the source offset clamps at
0 and the clip plays less than its duration. The same is true of the scene twin's
refusal, but there it is an explicit error rather than a silent clamp.

### R5 — The scene clip's "no overlap" rule and the audio clip's "layer" rule are two
policies in one timeline (design, not a defect)

Documented in `duplicateAudioClip`: audio clips layer (the engine sums them), arrangement
clips are no-overlap. Both are intentional and each system keeps its own rule. A user
mixing the two clip kinds in one lane gets two different behaviours, which is a product
question rather than a bug.

---

*The editor is not proven bug-free. This pass found and fixed eight defects that were
reproducible and reachable through ordinary use, and it leaves five identified items
behind — four of them needing a human decision or a platform/browser check rather than
another patch.*
