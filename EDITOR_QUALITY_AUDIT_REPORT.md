# Editor Quality Audit — KYX / Pulse Forge

Scope: the timeline/arrangement editor — clip commands, selection state, undo/redo
transaction boundaries, coordinate conversion, and the interaction state machine.

Method: read the implementation, then **reproduce every claimed defect with a failing
test before fixing it**. No defect below is reported on the strength of a code reading
alone. A defect is marked CONFIRMED only where a test failed first and passed after
the fix.

Every section distinguishes **VERIFIED** (read and, where stated, reproduced) from
**UNCONFIRMED** (a specific suspicion that needs an instrumented repro to settle).

---

## Baseline

Before any change, the timeline/undo suites were green:

```
tests/arrangement-tools-audit      tests/undo-redo-integrity
tests/arrangement-variations       tests/undo-roundtrip-sweep
tests/clip-editing-audit-deep      tests/selection-store-dead-refs
tests/clip-editing-audit2          tests/update-audio-clip
tests/editing-timeline-audit       tests/undo-redo-audit

Test Files  10 passed (10)
      Tests  155 passed (155)
```

This matters: a green baseline is what lets every failure below be attributed to a
change I made rather than to pre-existing damage.

---

## D1 — A clip's fade can outlive the clip (P2, CONFIRMED)

### Invariant

```
0 <= fadeIn  <= duration(clip)
0 <= fadeOut <= duration(clip)
duration(clip) = lengthBars * BAR_TICKS * 60 / (bpm * PPQ)
```

A fade longer than its clip is not cosmetic. The engine clamps it audibly, so the
stored document disagrees with both what the user hears and where the fade handles
are drawn.

### Root cause

Three **structural fragment builders** derive their fragments by spreading the parent
clip (`...clip`) and overwriting only the geometry — never the fades:

| Command                       | Parent fade copied                   | Fragment can be as short as         |
| ----------------------------- | ------------------------------------ | ----------------------------------- |
| `splitAudioClipAtTick`        | `fadeIn` → left fragment             | 0.05 bar (`leftBars < 0.05` throws) |
| `splitAudioClipAtTick`        | `fadeOut` → right fragment           | 0.05 bar                            |
| `sliceAudioClipToArrangement` | `fadeIn` + `fadeOut` → every slice   | one sample wide                     |
| `stripSilenceAudioClip`       | `fadeIn` + `fadeOut` → every segment | one sample wide                     |

The sibling commands that rewrite a clip's length _in place_ — `resizeAudioClip`,
`stretchAudioClip`, `trimAudioClipStart` — all clamped correctly, with an explicit
comment citing the audit. The three fragment builders were the siblings that missed it.

### Reproduction (measured, before the fix)

An 8-bar clip (16 s at the default 120 BPM) carrying `fadeIn: 4`, `fadeOut: 3`:

```
splitAudioClipAtTick, left   lengthBars 0.1 → 0.194 s,  fadeIn  4.000   ← 20× the clip
splitAudioClipAtTick, right  lengthBars 0.1 → 0.194 s,  fadeOut 3.000   ← 15× the clip
sliceAudioClipToArrangement   lengthBars 0.3 → 1.490 s,  fadeIn  4.000
sliceAudioClipToArrangement   lengthBars 0.1 → 0.480 s,  fadeIn  4.000
stripSilenceAudioClip         0.097 s clip,               fadeIn  4.000
```

5 of 7 assertions failed; the baseline and undo assertions passed.

### Fix

`src/commands/commands.ts`

- New `audioClipDurationSec(doc, lengthBars)` — one formula for "how long is this clip".
- New `clampClipFades(doc, clip, lengthBars)` — the invariant, taking the clip's
  **stored** length (post-rounding, post-clamp) so the bound matches the length that
  actually lands in the document.
- Applied at all six length-rewriting call sites; the three fragment builders now
  bound the inherited fades by their own fragment length.

### Regression coverage

`tests/clip-fade-bounds-invariant.test.ts` — 7 tests, including an undo round-trip
(which was already correct and is pinned so it stays that way).

---

## D2 — The clip selection keeps ids for clips that no longer exist (P2, CONFIRMED)

### Invariant

Every id in the selection names a live object. The track half of this contract already
existed: `SelectionStore.pruneTrack` / `retainTracks`, covered by
`tests/selection-store-dead-refs.test.ts`. The clip half did not.

### Root cause

Commands are pure `ProjectDocument → Command` and cannot see the UI selection, so a
destructive action has to drop the dead ids at its own call site. The keyboard Delete
path in `App.tsx` calls `selectionStore.clear()` — but the context menu, the DEL
buttons and `deleteClipsWithToast` cleared only the panel's **local** `selectedClipId`
/ `selectedAudioClipId`. `selection.clipIds` kept naming a deleted clip.

### Reproduction (measured, before the fix)

```
selection kept a dead clip id after delete: expected [ Array(1) ] to deeply equal []
```

### Consequences (not speculation — read off the code)

- **Dead undo entries.** The next Delete maps `selection.clipIds` through the live id
  sets, matches nothing, leaves the document untouched — and still executes its
  `deleteClips` command with `execute: () => newDoc` where `newDoc === doc`. A history
  entry the user must Ctrl+Z through for no edit.
- **Dead UI.** The context menu keeps reporting `hasClips`, so Duplicate / Consolidate
  / Split stay enabled over a selection that resolves to nothing.
- **Not delete-specific.** `splitAudioClipAtTick` replaces a clip's id with two new
  ids, so a split of a selected clip produces the same ghost without any delete.

### Fix

- `SelectionStore.retainClips(liveIds)` — the clip-side counterpart to `retainTracks`,
  no-op without emitting when everything is still live.
- `src/ui/useClipSelectionInvariant.ts` — `pruneDeadClipIds(store, selectionStore)` plus
  a hook that subscribes it to `store.subscribe`, so it fires on **every** mutation
  source at once: buttons, context menu, keyboard, MCP, the intent engine, collab and
  undo/redo.
- Mounted in `App.tsx` — the component that owns the `SelectionStore`.

Typed against a structural `ClipSelectionSource` (`getDoc` + `subscribe`) rather than
the concrete `ProjectStore`, because `services.store` is a union with the collab
`YDocStore`, which mirrors the same surface.

### Regression coverage

`tests/ui/selection-clip-dead-refs.test.ts` — 9 tests, including the no-emit-when-nothing-
changed guard (re-rendering every selection subscriber on every mutation is a real cost)
and the "does not touch `trackIds` / `noteSelections`" boundary.

---

## D3 — Escape and window-blur do not cancel a timeline drag (P1, CONFIRMED)

### Invariant (§20 cancel and recovery)

An incomplete interaction must roll back cleanly or commit under explicit semantics. No
operation may leave the editor stuck in a dragging/trimming state.

### Root cause

Every drag machine in `ArrangementPanel.tsx` wired exactly two terminals —
`onPointerUp` (commit) and `onPointerCancel` (abort). Escape and window-blur are
neither, and the panel registers no `window` pointerup/blur listener, unlike its
siblings `Sequencer.tsx:1766-1768` and `App.tsx:422-423`.

### Reproduction (measured, before the fix)

```
✗ does NOT commit the move when Escape is pressed between pointerdown and pointerup
✗ clears a latched drag preview when the window loses focus mid-drag
✓ still commits the move when no cancel key is pressed     ← control
✓ cancels a marquee drag on Escape
```

The control passing is what makes the other two meaningful: the harness genuinely
drags and genuinely commits.

### Why this was P1 and not cosmetic

`dragRef.current` holds `movingIds` captured **at gesture start**. Escape does not clear
it, so releasing the mouse afterwards **commits the move** — after the user pressed the
cancel key. `App.tsx`'s contextual Escape handler calls `selectionStore.clear()` at that
same moment, so the selection visibly vanished while the clip slid anyway.

Losing window focus had the second half: no `pointercancel` is delivered, so the preview
stayed latched — the clip painted at a drag offset with no gesture behind it.

### Fix

`src/ui/ArrangementPanel.tsx`

- `cancelAllArrangementGestures()` fans out to every top-level ref: clip drag,
  multi-drag, audio drag + its fade/gain/stretch previews, marquee, ruler time-drag,
  take-lane drag.
- One window listener set: `keydown Escape`, `blur`, `pointercancel` (the last is a
  backstop; all three paths are idempotent).
- Deliberately **no** `stopPropagation` — `App.tsx` still owns contextual Escape
  (close menu → close help → clear selection → reset tool → blur input), and cancelling a
  gesture is independent of that cascade.
- The Escape path only acts when a gesture is actually live, so Escape behaviour is
  otherwise untouched.

Two overlay drags live in **child** components with their own refs (`WarpPinsOverlay`,
`IntensityLane`). The panel cannot reach into them, so it bumps an `overlayCancelEpoch`
counter that each child resets against. Without this a dragged warp pin or intensity
point would still commit after a cancel.

### Regression coverage

`tests/ui/arrangement-escape-cancels-drag.test.tsx` — 5 tests, including the control.

---

## Collateral fix — a test asserting a param id that does not exist

`tests/commands.test.ts` used `{ kind: "fxParam", paramId: "lowGain" }` against an `eq`
instance. `eqParams` (`src/effects/definitions.ts:468`) has no `lowGain`; the low-shelf
gain is `lowShelfGain` (bare `lowGain` belongs to the **M/S EQ** definition). The target
validator correctly rejected it, so the test failed with `Invalid macro target`.

Unrelated to D1–D3 and pre-existing — none of the changes touch the effect registry or
the macro-target path. Fixed to `lowShelfGain`, preserving the test's intent (a generic
FX target mapping carries a `source`). 69/69 in that file pass.

---

## D4 — An audio-clip trim commits against two different documents (P1, CONFIRMED)

### Invariant

A gesture commits against ONE document. Geometry, source offset and length must all
come from the same live state.

### Root cause

`onClipPointerUp` (ArrangementPanel.tsx:1925-1929) carries an explicit guard for
precisely this:

```
// A clip in the block can be deleted mid-drag (undo/collab). Moving a
// dead id wrote a target from its stale startBar and could false-trip
// the overlap guard with length 0 — drag only what is still live.
const movingIds = current.movingIds.filter((id) => beforeDoc.arrangement.clips.some((c) => c.id === id));
```

The audio-clip trim path had no such guard, and was worse than a dead id. It called
`trimAudioClipStart(services.store.doc, …, { offsetSec })` — a LIVE document with an
`offsetSec` read from the render-scope `audioClips` memo. The geometry had already been
hardened against this race (`audioDragLiveRef`); `offsetSec` had not.

`trimAudioClipStart` throws on a missing clip, so a deleted id was contained. A
_changed_ offset was not: the command succeeded, and the clip played the wrong region
of its sample — silently.

### Reproduction (measured, before the fix)

Same gesture (2-bar rightward trim), document's offset changed 3 → 10 mid-drag:

```
expected 22.7741935483871 to be close to 22.7741935483871
received  15.7741935483871     ← difference of exactly 7
```

Committed as `3 + delta` (the pre-change memo) instead of `10 + delta`. Seven seconds
of wrong source audio, no error raised.

**How this was established matters.** The first version of the test PASSED — not
because the race was unreachable but because its assertions were too weak
(`toBeGreaterThanOrEqual(10)` happens to be satisfied by `3 + 12.77`). Measuring the
raw values is what exposed it: the control run and the changed run both produced
exactly `15.774`, which is `3 + delta`, not `10 + delta`. A test that cannot fail is
decoration, not evidence.

### Fix

`src/ui/ArrangementPanel.tsx` — the commit now resolves the clip from
`services.store.doc` and returns if it is gone, mirroring the scene-clip guard:

```
const liveClip = (services.store.doc.arrangement.audioClips ?? []).find((c) => c.id === cur.clipId);
if (!liveClip) return;
...
offsetSec: liveClip.offsetSec + deltaSec,
```

This also removed an unhandled `throw` escaping into the test run when a clip was
deleted mid-drag (scenario 3 in the spec file).

### Regression coverage

`tests/ui/audio-trim-stale-offset.test.tsx` — 3 tests: the control, the stale-offset
invariant, and mid-drag deletion.

---

## D5 — A live gesture can switch unit system mid-drag (P2, CONFIRMED)

### Invariant

A gesture converts pixels to bars in ONE unit system for its whole lifetime. Its
grab and its live position must share a divisor, or the delta is a difference of
two incompatible scales.

### Root cause

`beginClipDrag` captured `grabBar: barFromEvent(event)`, which divides by the
`barWidth` in scope at pointerdown. `onClipPointerMove` recomputed `bar` through
the same helper, dividing by the `barWidth` of _that_ render.

The Ctrl+wheel zoom handler (ArrangementPanel.tsx:634-645) is registered on
`scrollRef` with `[]` deps and gates only on `event.ctrlKey`:

```
if (!(event.ctrlKey || event.metaKey)) return;
```

It never checks whether a gesture is live. Zooming mid-drag (a trackpad pinch, or
Ctrl+scroll while holding a clip) changes `barWidth`, React re-renders, and the
next `pointermove` computes a bar in the new scale while `grabBar` still holds the
old one. The clip lands somewhere the pointer never pointed at.

### Reproduction (measured, before the fix)

Identical 200 px gesture, the only difference being one Ctrl+wheel step in the middle:

```
control (no zoom)        → clip moved  3 bars
with zoom mid-drag       → clip moved  7 bars
```

The baseline test also asserts `barWidthEnd !== barWidthStart`, so the second run
provably zoomed — the difference cannot be an inert wheel event.

### Fix

`src/ui/ArrangementPanel.tsx`

- Split the converters so the divisor is explicit: `barFromEventAt(event, width)`
  and `audioBarFromEventAt(event, width)`.
- `DragState` and the audio drag ref now carry `barWidth`, captured at pointerdown.
- Both `onClipPointerMove` handlers convert with the gesture's own width.
- The width-less `audioBarFromEvent` was deleted rather than kept: every audio
  gesture spans a pointerdown→pointerup window, so there is no call site where
  "the current render's width" is the right answer. (`barFromEvent` remains —
  non-gesture callers genuinely want the live width.)

Both the scene and the audio path are fixed; they shared the identical defect.

### Regression coverage

`tests/ui/arrangement-zoom-during-drag.test.tsx` — 2 tests, including the
"did the zoom actually happen" guard.

---

## D6 — The ruler asserted non-null on a sibling's ref (Low, hardened)

### Root cause

The ruler (`.arr-ruler`) and the lane (`.arr-lane`) are **siblings** inside
`.arr-lane-scroll`. Every px→bar conversion in the ruler is measured against the
LANE's rect, and three of the ruler's handlers reached across with a non-null
assertion:

```
const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth);
```

Meanwhile the panel's own three helpers one screen up — `barFromEvent`,
`audioBarFromEvent`, `seekFromRulerEvent` — all guard the same ref with
`if (!lane) return`. The helpers were hardened; the inline JSX handlers were not.

### Severity, stated honestly

**Low, and no user-facing consequence was demonstrated.** I checked the one path
the earlier report claimed gated the lane (`showSkeletonPreview`,
ArrangementPanel.tsx:3203) and it renders a _different_ region — before
`scrollRef`, not around it. Both the ruler and the lane render unconditionally as
siblings, so in practice `laneRef.current` is non-null whenever a pointer handler
on either can run. This is hardening against a state I could not produce, not a
reproduced crash. The four `laneRef.current!` uses inside the `.arr-lane`
element's own handlers were deliberately left alone: that ref belongs to the
element carrying the handler, so React's own invariant covers it.

### Fix

The three ruler handlers now resolve the lane through the same
`if (!lane) return` guard the helpers use. Net effect: zero `laneRef.current!`
outside the element that owns the ref.

---

## Items investigated and NOT changed (with reasons)

### #8 "split is unsnapped" — INVALID, and "fixing" it would reintroduce a bug

The report claimed `splitAudioClipAtTick` produces fractional `leftBars` as a defect. It is a
**documented, deliberate design decision**, documented in the code itself
(`commands.ts:2440-2446`):

```
// Preserve the split's fractional-tick position. Rounding bars to 0.01
// moved the timeline edge and accumulated source-offset drift on repeated
// edits.
```

The tests actively pin it. `tests/edit-tools-geometry-refs-audit.test.ts:471` locates the
right fragment by `startBar === 0.5` — exactly, not `0.4999` — and line 427 asserts the
left fragment still has its parent's exact `startBar`. Quantising a split would move the
timeline edge and reintroduce the drift that comment describes. **No change made**, and
this one is worth flagging: it is the item most likely to be "fixed" by a later pass
into a regression.

### #10 take-lane click suppression — real fragility, NOT a demonstrated defect

The mechanism is exactly as described: `finishTakeLaneRangeDrag`
(ArrangementPanel.tsx:1525-1529) sets a bare boolean `suppressTakeLaneClickRef` and arms
`window.setTimeout(..., 0)`; `onClickCapture` (4066-4071) consumes it and stops
propagation. The flag carries **no pointerId, no target, and no drag identity** — it is
decided purely by when a macrotask happens to run.

I built the harness and measured it, with a guard that the comp-range drag really
produced a visible `.arr-audio-take-lane-range` (without that guard, a drag that never
moved would make every other assertion vacuous). In jsdom the click is **not** suppressed
and `setActiveAudioTake` is dispatched, discarding the range the user just drew.

**But that is not evidence of a product bug.** The design bets on the browser firing
`click` in the same task as `pointerup`, before any 0 ms macrotask — and jsdom's
`fireEvent` dispatches each event synchronously and independently, so it does not model
that ordering in either direction. The test is therefore committed as a
**characterization** (`tests/ui/take-lane-click-suppression.test.tsx`, 4 passing) that
pins the real, worth-knowing property: the mechanism is a timing bet, not an identity
check. Settling it requires a Playwright repro against a real browser. **No change made**,
because changing it on jsdom evidence would be acting on a harness artefact.

The three other tests in that file are real and green: the drag alone commits no
activation, a later deliberate activation is not swallowed by a stale flag, and a plain
click with no drag is never suppressed.

### #11 `releasePointerCapture` asymmetry — FIXED (on request)

Confirmed first: three call sites (3424, 3548, 3574) wrapped the call in `try/catch`,
while `onClipPointerUp`, `onClipPointerCancel`, `onAudioPointerUp` and
`onAudioPointerCancel` never called it at all.

Worth recording why this was initially left alone: the HTML pointer-capture spec
releases capture **implicitly** on `pointerup`/`pointercancel`, so the omission was
inert, and `releasePointerCapture` throws `NotFoundError` when the element is not
capturing — so bolting the call on unguarded would have been the riskier change, turning
a working terminal into a throwing one. It was raised rather than fixed, and fixed on
request with that risk designed out.

`src/ui/ArrangementPanel.tsx`

- Module-level `releasePointerCaptureSafely(target, pointerId)`: checks target, checks
  the method exists, wraps the call in `try/catch`. One safe shape, matching what the
  lane and ruler already do by hand.
- `DragState` and the audio drag ref now carry `pointerId`, captured at pointerdown.
  Terminals read it from the gesture record rather than from the releasing event,
  because a `pointerup` can carry a different `pointerId` than the one capture was taken
  on — releasing the wrong id would silently leave the capture on the element.
- All four terminals release before clearing their ref, since the id only exists on the
  record.

**One design constraint surfaced by the compiler.** Three of the four call sites are
wrappers that existed to chain a long-press handler, and `dragGuard`'s stuck-drag
fallback terminal calls `onClipPointerUp()` with no event at all. The event parameter is
therefore optional, and the helper no-ops on a null target — which is correct, since
there is no live event target to release from and the spec releases implicitly anyway.
The three wrappers were updated to forward their event.

### #12 dead members in the transient surface — FIXED (on request)

All four confirmed as genuinely unreferenced, then removed:

| Member                          | Evidence                                                        | Disposition                                                                                                            |
| ------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `seekFromRulerEvent`            | defined then immediately `void`ed                               | removed with its `void`                                                                                                |
| `origTrimEnd`                   | captured in the ref, never read                                 | removed from the ref and its initializer                                                                               |
| `grabX`                         | captured, never read (`grabY` **is** read, by the gain gesture) | removed; `grabY` kept                                                                                                  |
| `"trimEnd"` in the `mode` union | no branch handled it; the right edge sends `"resize"`           | removed from the ref union **and** from `beginAudioDrag`'s parameter type, so neither side can reintroduce it silently |

The union member was the one flagged as dangerous, and the fix is the strict one: the
parameter type of `beginAudioDrag` now mirrors the ref union exactly, so the two cannot
drift, and the comment records why `"trimEnd"` is absent rather than what it used to do.

---

## Audited and found correct

These were checked and are **not** defects. Stating them matters as much as the findings.

| Area                               | Evidence                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gesture transaction boundaries** | A drag is preview-only in React state; exactly ONE command is committed on `onPointerUp`. No per-`pointermove` dispatch, so a continuous drag cannot produce dozens of undo entries.                                                                                                                                                                                       |
| **Editor → audio engine sync**     | `services.ts:1024` `store.onDocChanged` calls `engine.setProject(doc)`, and `engine.restartFrozenSources(transport.position)` when playing — the ghost-audio guard for structural edits during playback.                                                                                                                                                                   |
| **Waveform rendering**             | `audioClipWaveformWindow` (`audioClipChannels.ts:46`) is a shared function that mirrors `audioClipPlayWindow`, so the drawn envelope is the window actually played. Defensive against degenerate windows.                                                                                                                                                                  |
| **Undo/redo integrity**            | 155-test baseline plus `undo-roundtrip-sweep` green; the split undo round-trip restores the parent document verbatim.                                                                                                                                                                                                                                                      |
| **Coord conversion round-trip**    | `barFromEvent` / `audioBarFromEvent` are self-consistent and negate cleanly on the same rect.                                                                                                                                                                                                                                                                              |
| **Determinism**                    | `snapshot()` (`commands.ts:150`) records a **document delta** (`computeDocDelta`), id-anchored, not a whole-document chain. Forward and backward deltas are both computed, so undo survives a document that changed between dispatch and undo (async render, collab merge). A dev-only verifier re-applies each delta and compares, with a legacy whole-document fallback. |

---

## Remaining risk — intentionally left unchanged

Each is a real observation with the reason it was not auto-fixed.

1. **Ten inline px→beat conversion sites in `ArrangementPanel.tsx` alone** (VERIFIED count
   by grep). Lines 1687, 1696, 1703, 3139, 3151, 3243, 3260, 3271, 3290 all recompute
   `(event.clientX - rect.left) / barWidth` inline, with three different rounding
   policies — `Math.floor` (1687, 3290), no rounding (1696, 1703, 3139, 3243, 3260),
   and `Math.min(totalBars, …)` clamping (3151, 3271). Line 561 is a different formula
   again: `((el.scrollLeft + cursorX) / (BASE_BAR_WIDTH * zoomRef.current)) * BAR_TICKS`.
   Today they agree on the tested inputs, but a snap threshold or half-pixel rule fixed
   in one place would silently diverge from the others. Consolidating this into one
   module is an architectural change touching every panel — a human-review decision,
   not an auto-fix.

2. **Mid-drag zoom or horizontal scroll re-scales a live drag** (UNCONFIRMED).
   `deltaBasis` is captured at gesture start; changing `zoom` or `scrollLeft` mid-drag
   leaves the delta in the old px scale while the preview is drawn in the new one. Needs
   an instrumented repro to confirm it is user-visible; plausible but not established.

3. **`onAudioPointerUp` mixes two document bases** (UNCONFIRMED).
   It computes `offsetSec` from `audioClips` captured at gesture start, while
   `trimAudioClipStart` re-resolves the clip from the live document at execute time. If
   the document changed between pointerdown and pointerup, the two can disagree.

4. **Right-edge resize override in `onClipPointerMove`** (VERIFIED as written, impact
   unquantified) — a `drag.resize === "right"` branch overrides the dragged length after
   snapping. Intended behaviour, flagged only because it bypasses the snap result.

5. **No clipboard in the arrangement timeline** (VERIFIED absent).
   `grep -ri clipboard src/` returns nothing. Copy/paste/duplicate-paste does not exist
   for timeline clips, so §30 clipboard integrity is not applicable to this editor.
   Duplicate is implemented separately.

6. **Audio-clip drag cancel.** The `WarpPinsOverlay` and `IntensityLane` cancel paths are
   reached only through the new epoch token. They have no window-level listener of their
   own, so a cancel arriving while the parent panel is unmounting depends on the parent's
   cleanup — correct today, but it is a contract rather than an independent guarantee.

---

## D7 (P1, CONFIRMED) — the lane mounted the whole song on every render

### Correction to the earlier finding, made during the fix

The performance write-up named **three** clip maps. That was wrong, and it was
wrong in a way that would have produced a regression if implemented as described.

`ArrangementPanel.tsx:3474` maps `clips` into `.arr-role-flow`, but that widget is
**not a timeline**. Its CSS is `display: flex; overflow-x: auto; gap: 3px`, it is
positioned in document order with `→` arrows between sections, and nothing about
it is a function of `barWidth`. Culling it by bar range would delete the arrows
that are the entire point of the widget. It was left alone.

There are **two** timeline maps, plus a third thing nobody had counted.

### Root cause

Three O(n)-or-worse render paths, all re-running on every React commit — and the
panel commits on every `pointermove`:

| Site                                | Pre-fix      | What it is                      |
| ----------------------------------- | ------------ | ------------------------------- |
| `clips.map` (scene lane)            | O(n)         | timeline                        |
| `audioClips.map` (audio lane)       | **O(n²)**    | timeline                        |
| `Array.from({ length: totalBars })` | O(totalBars) | bar grid — previously uncounted |

The audio map is quadratic because `compSourceTakeNumber` rebuilds a `Set` over
every audio clip per clip, and `arrangementSecondsBetweenTicks` walks `clips`.
Windowing the outer loop collapses both.

The bar grid was the surprise: one absolutely-positioned `<div>` per bar, with no
interaction attached whatsoever.

### Measured (before → after), 800 px viewport

| Song      | `.arr-clip` before | after  | `.arr-bar-grid` before | after  |
| --------- | ------------------ | ------ | ---------------------- | ------ |
| 50 clips  | 50                 | **10** | 200                    | **40** |
| 200 clips | 200                | **10** | 800                    | **40** |
| 800 clips | 800                | **10** | 3200                   | **40** |

Rendered nodes are now **constant in song length**. Before, the count grew linearly
and the commit cost with it.

### Design decisions that are load-bearing

- **The window is quantized to whole bars.** Storing raw `scrollLeft` would re-render
  at pixel frequency — trading an O(n) render for an O(1) one plus a render per pixel.
  Whole-bar bounds mean at most one render per bar of travel.
- **`null` window means "render everything"**, never "render nothing". A viewport
  that cannot be measured (jsdom, hidden panel) keeps the last window instead of
  collapsing to an empty lane.
- **The measure effect is declared after the zoom re-anchor effect** so it sees the
  `scrollLeft` zoom just set, not the pre-zoom value.
- **Entries keep their ORIGINAL index**, because `clips[index + 1]` renders the
  transition mark to the next section. Resolving it against the window instead of the
  full list would silently strip the `+` button from the last visible clip.

### The bug the fix would have introduced, and the falsification that caught it

A naive window drops the clip being dragged the moment it leaves the window. The
element the pointer is captured on then unmounts and **the commit is silently lost**
— no error, no move.

Disabling the forced-inclusion union (`forced`) and re-running produced
`expected 0 to be greater than 10`: the dragged clip stayed at bar 0. That is the
falsification, and it is what proves the guard is load-bearing rather than
decoration.

Note what did _not_ catch it: the clip **count** assertion stayed green, because the
window still holds other clips. Only the committed position of the dragged clip by
id exposes it. `arrangement.clips[0]` does not work for this — the move command
re-sorts the array, so index 0 is a different clip after any drag that passes the
first neighbour.

### A fixture that would have produced a fake defect

The first version of the test packed a clip onto **every bar**. No drag committed:
every move collided with its neighbour and the command refused. Read naively that is
"dragging is broken". It was a property of the fixture, not the product — with
gaps every 4th bar the same gesture commits normally (bar 0 → bar 7).

The fixture now uses spacing, and the reason is recorded in the test file so the next
person does not rediscover it as a product bug.

### New test

`tests/ui/arrangement-viewport-windowing.test.tsx` — 5 tests: a positive control on
the document (300 clips really present), bounded clip count, bounded grid count,
window follows scroll, and the drag-owns-its-clip guard.

---

## Pre-existing defect found and fixed en route

`tests/ui/DiceContext.test.tsx` could not be parsed. Commit `ccdf108d`
("perf(bundle): F2 eager diet") inserted `await waitFor(...)` into a non-async `it`
callback, so esbuild failed the whole file.

**None of its tests were running** — they were not failing, they were absent, and
vitest reported a suite-level transform error rather than six reds. Fixed by making
that callback `async`; the file now runs **6 tests, all passing**. A test file that
cannot parse is worse than a red one: it looks like a broken suite instead of
silently-absent coverage.

---

## Bundle budget: the responsiveness number is not the one we were watching

### What was already there

The `studio boot path` gate — `BOOT_PATH_BUDGET_KB`, a BFS over the **static**
import closure of the `App-` chunk — already existed. No new gate was written.
What was missing was evidence of whether it could fire, and whether its number
still meant anything.

### Falsification

Dropping the budget to 2000 produced `FAIL — studio boot path over budget:
2017 > 2000 KB` with exit 1. The line is live, not decoration. Restored after.

### The measurement that settles the 5 MB question

| Metric               | 2026-10-04 | 2026-10-10  | Δ over five days of waves |
| -------------------- | ---------- | ----------- | ------------------------- |
| DAW **sum**          | 3778 KB    | **4975 KB** | **+1197 KB** (+32 %)      |
| **Studio boot path** | 2123 KB    | **2017 KB** | **−106 KB** (−5 %)        |

The waves landed in **lazy chunks**. The sum grew by a third while the payload a
waiting user actually parses and evaluates got smaller. This is the empirical
version of the anchor-diet note in the budget script, and it is why the 5000 cap
can be loose without costing startup: a rising total is **not** a user getting
slower.

### Tightened: 2400 → 2200

At 2400 the guard held 383 KB (19 %) of dead slack against a number trending
**down**. A guard that cannot fire protects nothing. 2200 is +9 % headroom.

### The diet, and why it is not one import

The closure is 21 chunks; four are 77 % of it:

| KB    | chunk                |
| ----- | -------------------- |
| 570.6 | `App-`               |
| 355.7 | `curated-layer-`     |
| 284.2 | `index-` (shared)    |
| 198.0 | `preference-ledger-` |

`curated-layer` and `preference-ledger` are **not** single careless imports —
~58 chunks statically reach each, so Rollup hoisted them as shared chunks. They
leave the boot path only by removing the underlying imports across callers, not
by moving one file behind a dynamic import. Anyone promising a 300 KB quick win
here is promising the wrong shape of work.

A caveat that held on this build and is worth re-checking: the walker reads only
the first 8000 characters of each chunk for static edges. An audit found **zero**
edges beyond that prologue here, so no closure was silently truncated — but that
is a property of this build, not a guarantee.

---

## Gates

| Gate                                                              | Result                                                                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                               | **EXIT 0 for every file this audit owns.** Whole-repo `tsc` is now red on another session's uncommitted WIP — see the note below |
| `npm run format:check` (all touched files)                        | **All matched files use Prettier code style!**                                                                                   |
| Targeted suites (9 files, clip + gesture + selection + take-lane) | **89 passed / 0 failed**                                                                                                         |
| `vite build` + `check-bundle-size.mjs`                            | **EXIT 0** — `✓ built in 32.62s`, `[size-budget] OK`                                                                             |
| `npm run build` (full, incl. `tsc`)                               | **EXIT 1 — not this audit's code.** See the note below                                                                           |

Build budget output as measured on the current working tree:

```
entry: 255 KB (budget 1070)              DAW JS chunks: 3778 KB (budget 5000)
optional on-demand runtimes: 640 KB (budget 650)      optional codecs: 166 KB (budget 170)
optional Audiotool Nexus: 713 KB (budget 750)         optional QMR HUD: 1078 KB (budget 1600)
core worklets: 137 KB (budget 150)                     landing route: 167 KB (budget 600)
shipped JS total: 5297 KB
```

### Why `npm run build` does not currently exit 0

`npm run build` runs `tsc --noEmit && vite build && …`, and the typecheck stage is red:

```
src/reference/analysis/chords.ts(183,42): error TS2345: Float64Array<ArrayBuffer> not assignable to 'readonly number[]'
src/reference/analysis/chords.ts(183,75): error TS2345: (same)
src/ui/ReferenceMapPanel.tsx(983,40): error TS2367: types '"instrument" | "group" | "generative"' and '"audio"' have no overlap
src/vocal/comping.ts(2,1): error TS6192: All imports in import declaration are unused
tests/unsuno/golden-set.test.ts(193,24): error TS2304: Cannot find name 'expandChordSpans'
tests/unsuno/golden-set.test.ts(198,22): error TS2304: Cannot find name 'chordBarAccuracy'
tests/unsuno/golden-set.test.ts(210,24): error TS2304: Cannot find name 'expandChordSpans'
tests/unsuno/golden-set.test.ts(215,22): error TS2304: Cannot find name 'chordBarAccuracy'
tests/unsuno/golden-set.test.ts(225,35): error TS2304: Cannot find name 'drumsOnlyTrack'
```

**None of these are files this audit touched.** All of them are in another session's
uncommitted WIP (`src/reference/`, `src/vocal/comping.ts`, `src/ai/audio-tempo-key.ts`,
`tests/unsuno/`), and the shared-tree protocol says not to edit another session's work. The
bundle figure above was therefore taken by running the `vite build` and
`check-bundle-size.mjs` stages directly — which is sound, because the size gate reads
`dist/`, not the type system. When that session lands its fixes, the full `npm run build`
should return to green with the numbers in the block above.

### Documentation drift corrected along the way

`AGENTS.md` stated the DAW JS budget as **3170 KB** in two places (§4 and §7), and after a
later correction drifted to **3500 KB** while the enforcing value climbed the ladder to
**4010 KB** and then **5000 KB**. The doc was stale — and stale in the dangerous direction,
reading as though there were far more KB of headroom than exist. Both occurrences now read
**5000 KB**, matching `TOTAL_BUDGET_KB` in `scripts/check-bundle-size.mjs`.

The 5000 bump itself is a deliberate pre-authorization, not a red-gate fix: the gate was
already green at 3778 KB against the old 4010 cap. The reasoning, the measured evidence and
the trigger to tighten it again are written into the script next to the constant.

### Shared working tree — files that belong to another session

`src/mcp/tools.ts` and `tests/sample-license-gate.test.ts` were being written by a
parallel agent during this audit (`git status` shows `M` and `??`, with timestamps
advancing during this session's own test runs). Neither relates to any file above.
`tools.ts` briefly produced a parse error mid-write, which cleared once that session
finished. `sample-license-gate.test.ts:24` still reports `TS7053`. Both left untouched.

`src/intent/audio-feedback.ts` is also another session's edit, and it broke the whole
module graph: it imports `./audio-targets.generated`, a file that does not exist and was
never committed. Nothing in the repo could resolve — no test, no `tsc`, no `vite build`.

`npm run references:genres` (the generator that produces it) could not fix this on its
own: it measures genres by loading `src/intent/song.ts` through a live Vite server, and
`song.ts` reaches `audio-feedback.ts`, which imports the very file being generated — a
bootstrap cycle. With a minimal stub in place (a correctly-shaped, empty
`GENERATED_AUDIO_TARGETS`) the graph resolves and tests run again, but the generator then
failed with a separate `SyntaxError: Unexpected end of input` while evaluating the page,
so the table is still empty.

**That stub is not a fix and must not be committed as one.** An empty
`GENERATED_AUDIO_TARGETS` silently makes every audio-target lookup fall back to defaults,
which is worse than the build being broken. The header comment in
`src/intent/audio-targets.generated.ts` says so. Whoever owns that feature needs to break
the cycle properly (e.g. import the table lazily, or generate from a source that does not
traverse `song.ts`) and then run `npm run references:genres` for real.

The typecheck row above is therefore scoped to the files this audit changed: a repo-wide
`tsc --noEmit` cannot pass while another session holds this repo in that state.

---

# Wave 2 — 2026-10-11 — locking (§29) and clipboard integrity (§30)

Wave 1 audited geometry, selection, the gesture state machine and render cost. The
areas it never reached are the ones this wave takes: **locking** and the
**clipboard**. Both turned out to be load-bearing contracts with a real defect
class, and both were found by asking one question — *does every code path that
claims to honour a guard actually reach it?*

Baseline before this wave — the editor hardening suites were green:

```
tests/editor-hardening-audit      tests/editor-ultra-hardening
tests/editor-hardening-chaos     tests/ui/editor-hardening-interactions
tests/clip-fade-bounds-invariant

Test Files  6 passed (6)
      Tests  65 passed (65)
```

---

## D8 — The clip lock was enforced by the primitive verbs and bypassed by the compound ones (P1, CONFIRMED)

### The contract

`src/commands/clipGroups.ts` states it in its own module header:

> Direct editing verbs (move/resize/trim/split/slip/stretch/delete) refuse locked
> clips; non-destructive verbs (mute, duplicate, selection) stay allowed.
> Compound/whole-range operations are lock-aware only for their TARGET clip in v1
> — the ripple tail and range operations flowing around a locked clip are a
> documented boundary.

`assertClipEditable` is the single choke point for that contract. **Every entry
point in the product shares it** — UI, MCP, the intent engine — which is
exactly why it is worth asking which callers actually call it.

### Root cause

The guard is present in `audioClips.ts` and `arrangement.ts` (the primitives) and
was missing in `clipEditing.ts` (the surgical/compound verbs) and in the panel's
block-move commits.

**A. Command layer — five verbs never called the guard**

| Verb | What it does to a locked clip | Guard |
| --- | --- | --- |
| `moveAudioClip` / `resizeAudioClip` / `deleteAudioClip` | refuse | ✅ |
| `sliceAudioClipToArrangement` | **deletes the clip, writes fragments** | ❌ |
| `stripSilenceAudioClip` | **deletes the clip, writes segments** | ❌ |
| `consolidateAudioClips` | **deletes every selected clip** | ❌ |
| `fitAudioClipTempo` | rewrites `stretchMode`/`stretchRate` | ❌ |
| `updateAudioClip` | slip / trim / stretch fields | ❌ |

`splitAudioClipAtTick` — the one sibling in the same file — *does* guard. That is
what makes this a defect and not a design: the author guarded the split and
missed the other three ways of destroying a clip.

**B. UI layer — the block drag never reaches the guard at all**

The single-clip drag commits through `moveArrangementClip` / `moveAudioClip`, so
the factory throws and the move is refused. The **block** drag does not call
those factories: it maps a spread over the clips and commits the resulting
`nextDoc` by hand (`ArrangementPanel.tsx:2429` scene, `:2795` audio) precisely so
the whole selection moves as one undo entry. Building the document by hand is the
right call for the transaction boundary — and it routes around the lock on the
way.

So the guard was not merely bypassable, it was **inverted**: dragging a locked
clip alone was refused, and dragging it as part of a selection moved it.

### Reproduction (measured, before the fix)

```
CONTROL: an unlocked block drag moves every selected clip     ✓ (moves +7 bars)
a block drag refuses to move a LOCKED member                   ✗ expected [ {0, 4} ] to equal [ {0, 4} ]
a refused gesture must not be undoable                         ✗ expected true to be false
```

The locked clip moved by the same +7 bars as its unlocked neighbour, and the
gesture cost a real undo entry — a history entry the user has to Ctrl+Z through
for an edit that should never have happened.

### Fix

**Commands** (`src/commands/clipEditing.ts`): `assertClipEditable` added to
`sliceAudioClipToArrangement`, `stripSilenceAudioClip`, `consolidateAudioClips`
(every member, since consolidation deletes all of them) and
`fitAudioClipTempo`. `updateAudioClip` guards **only** the fields that *are*
contract verbs — `offsetSec` (slip), `trimStart`/`trimEnd` (trim),
`stretchRate`/`stretchMode` (stretch) — so gain, fades, mute, loop, reverse and
source props stay editable on a locked clip, exactly as the contract requires.

**Gestures** (`src/ui/ArrangementPanel.tsx`): the lock is sampled **once at
pointerdown** and stored on the gesture record (`movingHasLocked`) alongside
`barWidth`, for the same reason `barWidth` is: it is gesture state, and
re-reading it per `pointermove` would let the preview and the commit disagree.
A locked block writes a **0** delta rather than `null`, so the commit can tell
"never moved" (a click, which must stay silent) from "moved and refused".

**Policy chosen: refuse the whole gesture, with a message.** Not "skip the locked
clip". A block move's entire meaning is that its members keep their relative
spacing; a partial move silently produces a layout the user did not ask for.
The keyboard nudge skips instead, and that is not a contradiction — a nudge moves
each clip independently, so dropping one loses no spacing.

### One more defect found on the way: refusals were silent, and one escaped entirely

The scene commits wrapped their factories in `catch {}` with the comment *"clip
deleted mid-drag — drop silently"*. That is correct for a clip deleted by a
collab merge, and wrong for a lock refusal: the user drags a locked clip and
nothing at all happens.

The audio path was worse. `execute(moveAudioClip(...))` evaluates the **factory
before** `execute`, so the throw bypassed `execute`'s own try/catch entirely and
escaped the React event handler as an uncaught exception — no message, no commit,
an error in the console. Every branch of `onAudioPointerUp` is now inside one
guard that surfaces the message, and the scene catches report too.

### Regression coverage

- `tests/clip-lock-verbs.test.ts` — 9 specs. Written as a **contract test** over
  the verb list quoted above, not as a per-bug pin, so a future verb added to
  that enumeration has to be added here. Two controls: the primitive verbs refuse
  (proving the harness measures the lock, not the arguments) and an unlocked clip
  passes every verb.
- `tests/ui/clip-lock-block-drag.test.tsx` — 6 specs across both lanes, plus
  "the refusal costs no undo entry" and "unlocking restores the gesture".

**Falsification.** Disabling the audio commit guard turns the audio spec red
(`1 failed | 1 passed`) while its unlocked control stays green — the guard is
load-bearing, not decoration. The scene guard was observed red on pre-fix HEAD.

---

## D9 — Paste could write a clip that evaporates on the next save (P1, CONFIRMED)

### Correction to wave 1 first

Wave 1's remaining-risk item 5 recorded: *"No clipboard in the arrangement
timeline (VERIFIED absent) — `grep -ri clipboard src/` returns nothing."*

**That was wrong, and wrong in a way that cost coverage.** `src/commands/clipClipboard.ts`
landed on 2026-10-07 (copy/cut/paste for timeline clips, Ctrl+C/X/V) with callers
in `App.tsx` and `ContextMenu.tsx`. The grep was run at a moment when the file
did not exist and the conclusion was written down as a property of the editor
rather than a property of that moment. §30 was therefore audited as *not
applicable*. It is applicable, and it had a defect.

### Root cause

The clipboard payload is a `structuredClone` taken at copy time — deliberately,
so it outlives the document it was cut from. That is what makes copy/paste work
at all, and it is why every reference the payload carries must be re-validated at
paste time.

`pasteClips` re-validates exactly one of them. The audio lane checks the clip's
`trackId` and falls back to a live track. The arrangement lane checks nothing:
an `ArrangementClip` carries a `sceneId`, and `deleteScene` removes the clips that
referenced it — but not the copy sitting in the clipboard.

### Reproduction (measured, before the fix)

```
payload sceneId:      scene-f03e1911…
after delete — scenes: scene-f4d9e721…      (the payload's scene is gone)
after delete — clips:  0
paste OK — clips now:  1
PASTED CLIPS WITH A DEAD sceneId:  1
tempoAtTick(orphan)  = 124            ← no crash, doc.bpm fallback
secondsBetween(orphan) = 1.935…        ← no crash
normalizeProject kept orphan?  0      ← THE DAMAGE
```

The paste **succeeds**. The clip renders, has a length, resolves a tempo, draws
its role in the lane, and participates in undo exactly like a real clip. Then the
next save/load runs `normalizeProject`, which prunes it — and the clip the user
pasted is gone, with a history entry that no longer corresponds to anything.

Nothing throws, so §36's "fail safely" and §24's "UI showing edits that did not
commit" both apply: the editor showed an edit it did not commit.

### Fix

`pasteClips` refuses the paste with a named reason when any carried arrangement
clip's scene no longer exists.

**Why refuse rather than fall back**, when the audio lane right above it falls
back for a dead track: a track is **routing** and the buffer is the content, so
re-hosting a clip on a different track preserves exactly what it plays. A scene
*is* the content — re-pointing the copy at an arbitrary live scene would play
different material just as silently. Refusing is the honest answer: the user
learns the copy cannot be pasted, and nothing is lost later.

### Regression coverage

`tests/clip-clipboard-integrity.test.ts` — 11 specs: deep-clone payload
independence, paste as one undoable transaction, cut→paste as two steps,
repeated paste (unique ids, no overlap), editing one copy leaving the others and
the payload untouched, the audio dead-track fallback (pinned as the contract it
is), the dead-scene refusal with a save/load survival check.

**Falsification.** Disabling the refusal turns exactly that spec red
(`1 failed | 10 passed`).

---

## Audited in this wave and NOT changed

### `crossfadeAudioClips` writes fades on a locked clip — a scope question, not a bug

The crossfade verb (the `X` key, range crossfade, comping) rewrites `fadeIn` /
`fadeOut` without consulting the lock. Every verb the contract *names* refuses;
fades are not in that list, and mute/gain/fades deliberately stayed editable in
`updateAudioClip` for the same reason. Whether a lock should also freeze fades is
a **product decision about what "locked" means**, so it is recorded here rather
than decided here. If the answer is "yes", the fix is one `assertClipEditable`
call and the guard in `updateAudioClip` becomes the whole story.

### The waveform canvas does not re-render on resize (§26/§33, P3)

The envelope effect depends on
`[buffer, bufferId, sourceChannel, reverse, showOnsets, onsets, offsetSec, trimStart, trimEnd]`
and reads `canvas.clientWidth` inside. Zooming or resizing changes the element's
width with **no** dependency change, so the backing store keeps its old pixel
size and the browser upscales it — the drawn window stays correct, its resolution
goes soft.

This is deliberate-looking and cheap to get wrong: a `ResizeObserver` would
re-run a 240-column min/max reduction on every resize frame, which is precisely
the main-thread cost the wave-1 windowing work was built to remove. Documented,
not fixed. A DPR-and-size-aware redraw on zoom only (not on every resize frame)
is the shape a fix should take.

### `pasteClips` stacks a repeated audio paste exactly in place

Pasting the same audio clip twice lands both copies on the same bars. Because
audio clips layer by contract, that is a deliberate +6 dB doubling. Every DAW
that pastes at the playhead behaves this way; changing it would be a UX decision.

---

## Gates for this wave

Recorded when each ran; see the final wave summary for the aggregate.

| Gate | Result |
| --- | --- |
| `tests/clip-lock-verbs.test.ts` | 9 passed |
| `tests/ui/clip-lock-block-drag.test.tsx` | 6 passed (1 red under falsification) |
| `tests/clip-clipboard-integrity.test.ts` | 11 passed (1 red under falsification) |
| Wave-1 editor suites re-run after the changes | 65 passed |
| `prettier --check` on every touched file | `All matched files use Prettier code style!` |

---

## D10 — A snap-grid test passed alone and failed in file order (P3, CONFIRMED)

Found by the full-suite gate, not by reading the editor: the editor-surface
regression run came back with `tests/ui/audio-selection-parity.test.tsx` red on
*"SNAP OFF keeps the exact pre-snap free behavior"* — the drag landed on the
1/2 grid (1.5 bars) where the test expected free placement (1.3 bars).

`snapController` is a deliberate UI-wide singleton (`src/ui/snap.ts:143` — "snap
is a view preference, not per-mount state"), and that is correct: snap *is* a
user preference, and it should survive unmount. The spec's `afterEach` cleared
`localStorage["pf:arr-snap"]` only, so the in-memory grid stayed at the `1/2` its
predecessor had set and leaked into the next spec.

**Attribution was measured, not assumed.** This failure sat next to files I had
just changed, which is exactly when a red gets misfiled. Two checks:

- `git log -S "movingHasLocked"` isolates this wave's panel diff — every changed
  line is lock- or catch-related; not one touches `snapDelta`, the grid id, or
  any snap state.
- The spec **passes when run alone** (`-t "SNAP OFF"` → 1 passed, 10 skipped)
  and fails only behind its predecessor. An order-dependent red cannot be caused
  by a change that does not touch the order.

Fix: the `afterEach` resets `snapController.setGrid("off")` as well as the
persisted key, so no spec in that block depends on the one before it. File
result: 11 passed.

This is also the one place in this audit where the honest reading of a red
required *disproving* my own change first. A red next to your own diff is not
evidence that your diff caused it.

---

## Wave-2 gates — what actually ran, and what it did not cover

Recorded as executed. This repo is shared with at least two other sessions
(intent, rezonans) and they hold it dirty, so repo-wide gates cannot report a
clean baseline; each row below says what it covered and what it could not.

| Gate | Command | Result |
| --- | --- | --- |
| Wave-2 specs | `npx vitest run tests/clip-lock-verbs.test.ts tests/ui/clip-lock-block-drag.test.tsx tests/clip-clipboard-integrity.test.ts` | 9 + 6 + 11 passed |
| Falsification | audio block guard disabled / dead-scene refusal disabled | 1 red each, controls stayed green |
| Wave-1 editor suites, re-run after the changes | `npx vitest run` on the 6 wave-1 suites | 65 passed |
| Snap-parity isolation | `npx vitest run tests/ui/audio-selection-parity.test.tsx` | 11 passed |
| Editor-surface sweep | 137 suites matched `clip\|arrangement\|editor\|drag\|trim\|split\|select\|snap\|undo\|waveform\|audio\|track\|marker\|automation\|transport\|zoom\|viewport\|command` | see final summary |
| `tsc --noEmit` (repo-wide) | `npx tsc --noEmit` | **EXIT 2** — errors confined to `src/intent/providers/local.ts` + `tests/intent-binding.test.ts`, another session's in-flight work. Zero errors in any file this audit touched. |
| `prettier --check` | on every file this wave changed | `All matched files use Prettier code style!` |
| `tests/drift-check.test.ts` | `npx vitest run tests/drift-check.test.ts` | passed with the updated spec count |

**Not run in this wave:** `npm run build`, `npm run test:expectations`,
`npm run drift:check`, `npm run test:browser`, `npm run test:e2e` — each reads
repo-wide state that other sessions had dirty, and a red from them would say
nothing about this work. They remain the merge owner's gates.

---

## Final sweep — attribution of the 4 red files

The editor-surface sweep (137 suites matching
`clip|arrangement|editor|drag|trim|split|select|snap|undo|waveform|audio|track|marker|automation|transport|zoom|viewport|command`)
finished **4 failed / 133 passed files, 9 failed / 1314 passed / 1 skipped tests**.
Every red was attributed before being dismissed:

| Failing file | Failure | Owner |
| --- | --- | --- |
| `tests/audio-engine-lifecycle.test.ts` | source-grep: `applyMasterConfig` limiter-knee pattern | concurrent session — this audit touched no engine file |
| `tests/audio-metering-purity.test.ts` | *"Novel export(s) in metering.ts not yet tracked: `describeStageAdjustmentLimitation` — add them to KNOWN_EXPORTS"* | concurrent session — the repo's own no-orphan-export guard doing its job |
| `tests/chord-track-intent.test.ts` | `section "Break"/"Bridge" failed generation: candidate-0:brief-gate:empty` | intent wave |
| `tests/probe-split-undo.test.ts` | a committed scratch probe (`it("probe")`, console.log only, no assertions) | concurrent session — left in place, not mine to delete |

**Zero reds in any file this audit changed.** That claim is not "the suites I
wrote pass" — it is the full 137-suite sweep filtered against the diff, with the
two source-grep failures read to confirm they name symbols this audit never
touched.

### Final state of every suite this wave depends on

```
tests/clip-lock-verbs               9 passed
tests/ui/clip-lock-block-drag       6 passed
tests/clip-clipboard-integrity     11 passed
tests/ui/audio-selection-parity    11 passed
tests/editor-hardening-audit        green (wave 1)
tests/editor-hardening-chaos        green (wave 1)
tests/editor-ultra-hardening        green (wave 1)
tests/ui/editor-hardening-interactions  green (wave 1)
tests/ui/editor-ultra-hardening     green (wave 1)
tests/clip-fade-bounds-invariant    green (wave 1)

Test Files  10 passed (10)
      Tests  102 passed (102)
```

A dead duplicate lock check was removed from the scene block commit during this
final pass — the first `movingHasLocked` branch returns before it, so the second
was unreachable code left by writing the guard twice.

---

## D11 — Mid-drag zoom re-scaling a live gesture: NOT a defect, and now proven (remaining-risk item #2 closed)

Wave 1 left this as **UNCONFIRMED**: *"Mid-drag zoom or horizontal scroll
re-scales a live drag."* It is not a defect — and the reason it is not is worth
writing down, because the failure mode is silent.

`barWidth` is a **render** value (`BASE_BAR_WIDTH * zoom`), and the Ctrl+wheel
handler is live during a gesture. A drag that read `barWidth` from the render
would convert its grab position on the old scale and its release position on the
new one: the delta becomes a difference of two scales, and the clip lands where
the pointer never was. Every intermediate value is still a legal bar number, so
nothing throws, nothing looks wrong in the lane, and the commit is wrong.

The prevention is already in the code — `DragState.barWidth` and
`audioDragRef.barWidth` capture px-per-bar at pointerdown, and both move
handlers pass the captured value into their converters. What was missing was
evidence, so this wave adds `tests/ui/drag-zoom-invariance.test.tsx` (3 specs):
drag → **zoom in mid-gesture** → move again → release, asserting the commit
equals the gesture's own scale.

**Falsification, both lanes.** Reverting the scene handler to the render scale:
`1 failed | 2 passed` — the scene spec went red (it would have committed +4 bars
instead of +7) while the audio spec correctly stayed green, because I had only
broken the scene converter. Doing the same to `audioBarFromEventAt`:
`2 failed | 1 passed`. Each spec is sensitive to its own lane and neither is
decorative.

### What remains open in this item: horizontal scroll

Scrolling the lane mid-drag is **not** the same defect and is not covered here.
The lane is the wide inner element inside the scroll container, so a scroll
shifts the lane's own `getBoundingClientRect().left` and the pixel→bar
conversion picks that up — which is why scrolling does not break the same way
zoom does. Whether a drag should also freeze the scroll *origin* it grabbed
against is a genuine product decision (a user who scrolls mid-drag may expect
either "keep dragging in the original scale" or "follow the new view"), and it
is recorded for human review rather than decided here.

---

## Wave 3 — 2026-10-11 — §32/§36 malformed clip data

Wave 2 closed the locking and clipboard contracts. Wave 3 asks the question
§36 poses directly: *one bad entity should not crash the entire editor when
isolation is possible* — and builds documents by writing **past the command
layer** on purpose, because `normalizeProject` sanitises on load and a
malformed clip therefore cannot arrive from a normal import. The realistic
sources are a **collab peer applying a remote update** (CRDT updates bypass
`normalizeProject`) and a project written by an older build.

## D12 — One clip at `1e308` unmounts the whole timeline (P0, CONFIRMED)

### Root cause

```ts
const totalBars = Math.max(
  16,
  ...clips.map((clip) => clip.startBar + clip.lengthBars + 4),
  ...audioClips.map((c) => c.startBar + c.lengthBars + 4),
);
```

`Math.max` **propagates NaN**, and any finite-but-absurd position passes
straight through. That number is the grid extent:

```ts
(visibleBarIndices ?? Array.from({ length: totalBars }, (_, index) => index))
```

`visibleBarIndices` is null exactly when the viewport has **never been
measured** — which is the **first render of every session**, before
`measureViewport()`'s effect runs. So the fallback is not an edge case: it is
the frame the user sees on open, every time.

`Array.from({ length: 1e308 })` throws `RangeError: Invalid array length`,
React unmounts the subtree, and the editor is blank. Measured, pre-fix:

```
[probe grid] {"finite":"grid=16 clips=1",
              "NaN":"grid=16 clips=0",
              "huge":"THREW RangeError: Invalid array length"}
```

`RangeError: Invalid array length` / *"The above error occurred in the
`<ArrangementPanel>` component"*. Priority model: **P0 — editor action
crashing the application.**

### The NaN case, measured rather than assumed

The same probe shows NaN does **not** crash: `clips=0` — the malformed clip is
simply not drawn, because the window test `startBar + lengthBars >= firstBar` is
false for NaN, so the window skips it. That is already correct isolation, and
the report's first draft of this finding claimed a blanked grid that measurement
says does not happen. The spec stayed, but as a **guard**, not as a pin for this
fix: it was green before and after.

### Fix

`timelineExtentBars(clips, audioClips)` replaces the spread. Non-finite
contributions are **dropped, not clamped into range** — a NaN position has no
position to clamp, and inventing one (0) would drag the entire timeline to bar
0 — and the result is bounded by `UNMEASURED_GRID_BAR_CAP = 512`, a documented
budget for the one pre-measurement frame (the measured path stays windowed).

Post-fix, same probe:

```
[probe grid] {"finite":"grid=16 clips=1",     ← unchanged: no behaviour change for valid documents
              "NaN":"grid=16 clips=0",        ← unchanged: already isolated
              "huge":"grid=512 clips=1"}      ← was THREW
```

The `finite` row is the one that matters for the no-regression claim: **the fix
changes nothing for a valid document.**

### Regression coverage

`tests/ui/malformed-clip-render.test.tsx` — 8 specs: a control document, then
NaN / Infinity / 1e308 / negative lengthBars / dead `sceneId` / a malformed
audio clip, plus "one malformed clip does not hide its healthy neighbour"
(the bad one is skipped, the good one still renders at the right offset).

**Falsification:** restoring the pre-fix spread turns the 1e308 spec red
(`1 failed | 7 passed`) with the `RangeError` back. The NaN guard stays green in
both directions, which is what makes it a guard and not a pin.

### One honest note on the cap

A project longer than 512 bars now renders 512 grid cells in the
never-measured frame instead of N. That is one frame, on a path the very next
effect replaces with a windowed render, and the alternative was an unbounded
allocation from untrusted document content. Named and bounded rather than
silent — the shape of clamp that §41 allows, as opposed to the scattered
clamps it forbids.

---

## Wave 4 — 2026-10-11 — the sanitization boundary, and a hypothesis that measurement killed

Wave 3 fixed the P0 and then went looking for the same pattern elsewhere (§38).
The sibling hunt turned up something more useful than a second crash: it
exposed **where malformed project data is actually stopped**, and in the process
killed a defect I had already written up.

## D13 — FALSIFIED: "a NaN member poisons the whole block move"

The hypothesis, built from D12's root cause: the block move computes its floor
as `Math.min(...Object.values(origStarts))`, `Math.min` propagates NaN, so one
non-finite member would make `delta` NaN and the commit would write NaN into
**every** member — one bad clip becoming many, i.e. §32 corruption arriving
through the gesture layer instead of a command. Reachable without any trick:
select-all picks up the bad id, and a clip with no renderable position is
*culled from the lane*, so the user drags a perfectly healthy neighbour while
the selection carries the poison.

I wrote the spec, and it failed in the direction that refutes the hypothesis:

```
the dragged clip must stay a real bar position: expected 7 to be …   ← landed on 7, correct
one bad clip must stay one bad clip:            expected [] to be ['clip-nan']
```

The dragged clip landed exactly on the pointer's bar, and after the gesture the
document contained **no** non-finite position at all. The NaN never reached the
gesture. Reason: `ProjectStore` runs `normalizeProject` at construction,
`execute`, `undo`, `redo` and `replaceDoc`, and that sanitizer **drops** a clip
whose startBar is not a finite number.

The UI spec was deleted rather than kept. A test that passes for a reason
nobody intended is worse than no test — it would have read as coverage of a
gesture-corruption bug that does not exist.

## The measured boundary (what replaced it)

`tests/clip-sanitization-boundary.test.ts` — 8 specs pinning the actual table:

| Injected value | Result at the store boundary |
| --- | --- |
| `startBar: 4` | kept (control) |
| `startBar: NaN` / `±Infinity` | **clip dropped** |
| `lengthBars: 0` / `-2` / `NaN` | **clip dropped** |
| audio clip `startBar: NaN` | **clip dropped** |
| **`startBar: 1e308`** | **KEPT** |
| a command that writes NaN | stripped before it reaches the doc |

The `1e308` row is the whole lesson, and it retroactively sharpens D12: **a
non-finite position can never reach the timeline, but a large FINITE one sails
through every sanitizer in the system.** That is exactly why D12 was a
reachable crash and not a theoretical one — the value that detonates the grid is
the one class of hostile position the boundary deliberately lets through.

**Falsification:** bypassing the store's normalizer on construction
(`this.doc_ = initial`) turns **3 of the 8 red**, and the source was restored
byte-identical afterwards (`git diff` empty). The specs measure the boundary,
not the fixture.

### Two side-effects worth recording

- **D12's framing is corrected.** Wave 3 reported "NaN silently emptied every
  grid cell in the document". The probe says otherwise: a NaN clip is dropped
  before the panel ever sees it. The grid never emptied. The spec stayed in
  `malformed-clip-render.test.tsx` as a **guard** — green before and after the
  fix — and the report says so rather than claiming it as a pin.
- **The paste infinite-loop worry from wave 2 is closed by measurement.**
  `pasteClips` walks forward by `stored.lengthBars` until it finds a free slot;
  a zero or negative length would loop forever. Every clip that reaches the
  clipboard has passed the boundary, which requires `lengthBars > 0`. The
  loop cannot spin.

---

## Wave 5 — 2026-10-11 — §35 memory and cleanup, measured

The §35 requirement is *"repeated mount/unmount … listeners … must not leak"*,
and until now the evidence behind it was **reading the effects and seeing a
`return () => …`**. That is evidence that someone wrote a cleanup, not that the
counts balance. This wave measures the balance instead.

`tests/ui/mount-unmount-balance.test.tsx` wraps `addEventListener` /
`removeEventListener` / `setInterval` / `clearInterval` and asserts:

- a single mount/unmount cycle registers and releases the **same** number of
  window listeners;
- **five** consecutive cycles register a stable count (no per-cycle growth);
- five cycles balance document listeners and intervals as well;
- a cycle that unmounts **mid-gesture** — pointer captured, preview live —
  releases everything it armed.

Result: **all pass. No leak.** The panel's cleanup is genuinely disciplined,
including the `usePointerDragGuard` terminator that wave 1 added.

### A wrong assertion, caught by measurement

The mid-gesture spec first asserted that a mid-gesture cycle registers the
*same* listeners as a clean one. Measurement said 9 vs 4 — and the 9 is
**correct**: arming a live capture registers the guard's own pointer routing.
The assertion was wrong, not the code. Rewritten to the invariant that actually
matters: arming registers *extra* listeners, and **every one of them comes
back**.

This is the same shape as the `snapController` finding (D10): a test that fails
for a reason nobody intended is a test that will be "fixed" by weakening a
correct behaviour.

### Falsification

Deleting one line — `window.removeEventListener("pointercancel",
cancelAllArrangementGestures)` — turns **3 of the 4 specs red**. Source
restored byte-identical afterwards (`git diff` empty). The specs measure the
cleanup, not the fixture.

### What this does and does not prove

It proves **registrations balance** across repeated mount/unmount cycles,
including mid-gesture. It does **not** prove heap stability: canvas backing
stores, waveform peak caches, the bank and the engine's node graph are not
observable from a listener count. §35's memory half still wants the real-browser
pass (`npm run test:browser`), which this wave could not run — see the open
items below.

---

## Wave 6 — 2026-10-11 — the real-browser attempt, and why it did not produce a verdict

Five waves deferred the browser gates with the excuse that other sessions held
the repo dirty. That excuse was convenient and mostly true, but it is not a
finding. This wave actually ran them.

### `npx playwright test 01…04` — 1 passed, 7 failed (4.9 min, Chromium)

| Failure class | Evidence | Owner |
| --- | --- | --- |
| `page.goto` timeouts | `02-panel-toggles`: *"navigating to http://127.0.0.1:5199/, waiting until domcontentloaded — Timeout 60000ms exceeded"* | environmental (see below) |
| Landing CTA copy | `01-landing-to-studio:59` waits for `getByRole('button', { name: /open in studio/i })`; the page renders `Open the studio` (`LandingPage.tsx:160,302`) while `LandingPrompt.tsx:196` still reads `Open in studio →` | not this audit |
| Dock hit-target | `03-generate-flow` / `04-persistence-roundtrip`: clicking `.pattern-actions button:has-text("GEN")` reports *".dock-resize-handle … intercepts pointer events"* and *"element was detached from the DOM"* | not this audit — see below |

None of these files is touched by this audit's commits (`ArrangementPanel`,
`clipEditing`, `clipClipboard`, spec files).

### Direct browser probe — attempted, and it is inconclusive

Rather than trust a harness that was already failing on timeouts, I drove the
app in the in-app browser at 1280×720. Result:

- `navigate` → `BROWSER_OPERATION_TIMEOUT` (the app did eventually load: title
  `KYX`, **zero console errors**);
- `inspect` → the page was still on the boot screen, `KYX — loading…`;
- after a further 25 s wait, a trivial `query(kind: text)` on `body` timed out
  at **275 s**.

At that point the machine showed **44 `node` processes** and ~1219 s of
accumulated CPU. That is the honest explanation available, and it is the
conservative one: a starved renderer looks exactly like a hung one. **I am not
claiming a boot defect**, and I am equally not claiming a clean browser
verification. Both statements are unsupported by the evidence I have.

### The one real finding this produced — §33 hit target

`.dock-resize-handle` is a **7px-tall `flex: none` sibling** in the bottom
dock's column (`12-floating-instrument-plugin-2.css:812`), not an overlay. So
Playwright's "intercepts pointer events" means the pattern panel's GEN button
was being **squeezed underneath the splitter** at 1280×720 — the bottom dock is
tall enough at that viewport that the panel content overflows beneath its own
resizer. §33 asks that "controls and hit targets must remain aligned and
usable" at narrow viewports; this is a candidate violation, measured, and it
needs a responsive browser to root-cause.

**Not fixed here, deliberately.** The CSS is shared dock layout, another session
may be mid-change on it, and every rule of §41 applies: a blind `z-index` or
`pointer-events` patch against an unreproduced symptom is exactly the kind of
false fix the objective forbids. The reproduction is recorded instead — viewport
1280×720, open the pattern panel, click GEN.

### Net position on the DoD

The jsdom-verified half of the DoD stands (waves 1–5). The browser half does
not: **playback editing / ghost audio, responsive layout, heap stability, and
the take-lane click suppression all remain unverified**, and this wave is the
attempt that did not close them. They should be run on an idle machine before
the audit can honestly claim completion.

---

## Wave 7 — 2026-10-11 — the boot screen has no watchdog (P2, observed — attribution deliberately left open)

Wave 6 called the browser gate inconclusive. This wave repeated it on a quieter
box and instrumented properly, which turned an unexplained stall into two
separate findings: one that is **not** a defect, and one that is.

### What it is not: a failed module

Repeated in a real Chromium at 1280×720 against the dev server:

- console: `[vite] connecting…` → React chunk loaded → `[vite] connected.`
  **Zero errors, zero warnings.**
- network: **no failed, no 5xx, no pending** requests.
- `inspect` returns in ~33 ms — the renderer is responsive, not wedged.
- the body contains exactly `KYX — loading…` and nothing else.

And the dev server, probed directly:

```
main.tsx             HTTP 200  53 KB   0–3 s
ArrangementPanel.tsx HTTP 200 982 KB  20 s
```

A single module costs 20 s to transform and serve. The studio route's chunk
graph contains hundreds of them. **That is what the stall is**: Vite cold
transform on a contended machine, not an application fault. Nothing in this
audit's commits runs before the studio route resolves — the lock guards, the
clipboard refusal and the grid extent all live *inside* the chunk that never
finished loading.

### What it is: an eternal loading state with no recovery surface (§20, §36)

```ts
// src/main.tsx:121
const ROUTE_FALLBACK = <div className="boot">KYX — loading…</div>;
```

That is a plain React `<Suspense>` fallback. It has:

- **no timeout** — a chunk that never resolves and a chunk that resolves in 4
  minutes are pixel-identical;
- **no error surface** — §36 asks that failures not be swallowed, and a stalled
  import fails *silently* by construction here;
- **no retry or reload affordance** — §20 asks that nothing leave the user
  "permanently stuck in dragging, trimming, **loading**, or disabled state".

Reproduced twice (two independent loads, ~5 min and ~2 min, both still on the
fallback). The browser's own view is unchanged: an idle page, no console
output, no failed requests, forever.

**Not fixed here.** A boot watchdog changes application startup architecture —
it decides what the user sees when the app cannot start — which is §40's human
review boundary, and `main.tsx` is shared surface that other sessions are
editing. The honest disposition is to name it, with a reproduction: *load the
dev server on a cold module cache and watch the boot screen; there is no state
in which it admits it is stuck.*

### Why this still does not complete the DoD

The §17 playback, §33 responsive-layout, §35 heap and take-lane items need a
**loaded** editor. Two attempts on this machine produced a loaded page at most
once (one Playwright scenario passed, others reached interaction before timing
out). Those items stay open, and the correct next step is a run on an idle box
against a **production build** — where the module graph is pre-bundled and the
982 KB dev transform does not apply — not a third attempt here.

---

## Wave 8 — 2026-10-11 — the production build, the budget gate, and the answer to wave 7

Wave 7 ended with an open question: *is the boot stall an application defect or a
dev-server artefact?* The way to answer it is to remove the dev server.

### `npm run build` — FAILED, and not on our code

```
> build:rezonans
X [ERROR] Failed to write to output file:
  open D:\pulse-forge\public\rezonans-worklet.js:
  The requested operation cannot be performed on a file with a user-mapped section open.
```

A **Windows memory-mapped-file lock** — another process has that worklet bundle
mapped. This is the shared-worktree hazard `AGENTS.md` §7 warns about, not a
compile error: every worklet before it (bass-harmonic, kopa, skrutka, spectral)
built cleanly, and the failure is a file-open, not a syntax error.

### `npx vite build` — SUCCEEDED

```
dist/assets/ArrangementPanel-CE73adNp.js   150.55 kB │ gzip: 46.92 kB
✓ built in 42.12s
PWA v1.3.0 … precache 442 entries (283887.34 KiB) … dist/sw.js
```

Skipping only the `prebuild` worklet hooks (whose outputs already exist) gives
the pre-bundled graph the browser needs.

### `node scripts/check-bundle-size.mjs` — **OK (exit 0)**

```
[size-budget] entry: 300 KB (budget 1070)
[size-budget] DAW JS chunks: 5134 KB (budget 5160)
[size-budget] optional on-demand runtimes: 640 KB (budget 650)
[size-budget] optional FLAC codec: 570 KB (budget 600)
[size-budget] optional Audiotool Nexus: 713 KB (budget 750)
[size-budget] shipped JS total: 7225 KB
[size-budget] core worklets: 149 KB (budget 150)
[size-budget] studio boot path: 2101 KB across 22 chunks (budget 2200)
[size-budget] OK
```

**Four budgets are within a rounding error of their limit**, and this is worth
more than the pass itself:

| Budget | Actual | Headroom |
| --- | --- | --- |
| core worklets | 149 / 150 KB | **1 KB** |
| optional codecs | 168 / 170 KB | 2 KB |
| optional on-demand runtimes | 640 / 650 KB | 10 KB |
| DAW JS chunks | 5134 / 5160 KB | 26 KB |

One more worklet of ~1 KB, or one modest feature import, turns the build red.
That is a **merge risk for every session in the repo**, not a defect, and it is
the kind of thing that gets discovered as an unrelated "the build broke" report
rather than as a budget conversation. Raised here for the owner.

### The answer to wave 7

Serving `dist/` and loading it in the in-app browser:

```
open_tab  http://127.0.0.1:4173/   →  success, navigation detected, loaded, 532 ms
```

**532 ms**, against a dev server that never finished in five minutes. That
settles the question: **the boot stall is Vite's cold transform, not an
application fault.** The §20 "eternal loading state" finding stands as a
*robustness gap* (the fallback has no watchdog), but it is not manifesting as a
real boot bug, and this report should not be read as claiming one.

Every Browser operation *after* that navigation timed out at the tool's 275 s
ceiling — the control channel, not the page (navigation had already reported
`loaded`). Interactive browser verification was therefore unavailable to this
wave, and §17 / §33 / §35-browser / take-lane remain **unverified**. What this
wave did establish is that they are *runnable*: the production build is fast,
budget-clean and available, so those checks need a working Browser session on
this machine, not another rewrite of the same gate.

## Wave 9 - 2026-10-11 - the intensity strip was sitting ON the clips (P1, CONFIRMED)

Wave 8 left the editor loaded but untested. With a real page finally available,
the first thing the §42 chaos spec asked was not "does the drag work" but "what
is actually under the pointer" - and the answer ended this wave.

### The measurement (Chromium, 1280x720, production build, INT = default ON)

```
clip      {"x":330,"y":534,"w":116,"h":44}  position:absolute  z-index:auto
intensity {"x":330,"y":529,"w":480,"h":44}  position:relative   z-index:auto
lane      {"x":329,"y":528,"w":480,"h":56}

elementFromPoint(clip centre) = div.arr-intensity-lane
chain: div.arr-intensity-lane < div.arr-lane < div.arr-lane-scroll < div.arr-timeline
```

The strip occupies **the same vertical band as the clips** (529..573 vs
534..578) across the **full lane width** - not a strip *under* the clips. With
`showIntensity` initialised to `true` (`ArrangementPanel.tsx:455`), a mouse
press anywhere on any scene clip landed on the strip. Consequence, at the
default configuration: **scene clips could be neither clicked nor dragged.**

### Root cause: tree order, not z-index

Neither element declares a `z-index`, so both sit at `auto` and CSS painting
order falls through to **tree order**. `.arr-clip` is
`position:absolute` (`.arr-clip`, `04-arrangement.css:621`) and the intensity
strip is the **last in-flow child** of `.arr-lane` (`ArrangementPanel.tsx`
rendered it immediately before the lane's closing tag), i.e. a *later* sibling.
Later wins. The lane itself is `height: LANE_HEIGHT` (56px, inline), the strip
is `height: 44px`, and being in flow it placed itself at the top of the lane's
content box - squarely on top of the clips.

Two comments in the tree already described the intended design and neither
matched the render:

- `src/styles/04-arrangement.css:323` - "a 0..1 editable curve strip **under
  the clip lane**"
- `IntensityLane`'s own doc comment - "One strip **under the clip lane**"
- the toolbar `title` - "Show the scene-intensity lane **under the clip lane**"

So this is not a design decision awaiting a product call: the code contradicted
its own three-times-stated contract, and the contract is unambiguous.

### Fix

One structural move, no geometry maths, no new state: the strip is rendered as
a **sibling of `.arr-lane`** in the scroll flow instead of its last child
(`ArrangementPanel.tsx`, plus `margin-top: 4px` on the class so the band reads
as separate). `IntensityLane` measures only its own ref
(`localFromEvent` -> `laneRef`), and it already takes `totalBars * barWidth` as
an inline width, so it needed no other adaptation.

After the fix, same probe, same build path:

```
intensity {"x":329,"y":588,"w":480,"h":44}      <- 588 = lane bottom (584) + margin
elementFromPoint(clip centre) = span.arr-clip-role
chain: span.arr-clip-role < span.arr-clip-copy < div.arr-clip < div. < div.arr-lane
```

### Regression coverage, and its falsification

`tests/e2e/18-editor-chaos-chain.spec.ts` asserts the invariant as an
assertion rather than a log line:

```ts
expect(probe.closestToClip,
  `pointer at the clip centre resolved to ${probe.top} (...)`).toBe(true);
```

plus `expect(await int.getAttribute("aria-pressed")).toBe("true")` - the spec
must run in the **default** configuration. An earlier revision of this very
spec turned INT off to let a drag through; that is the exact shape of a test
that hides the defect it exists to catch, and it was removed rather than kept.

`tests/ui/ArrangementPanel.test.tsx` gains a structural pin: the strip must not
be a descendant of `.arr-lane`. It is honestly labelled in the file as what it
is - jsdom has no layout engine, so it cannot observe hit-testing; the
behavioural guard lives in the browser spec.

**Falsification.** Re-nesting the strip (the one-line inverse), rebuilding and
re-running:

```
1 failed
  [chromium] 18-editor-chaos-chain.spec.ts:160
  Expected: true
  Received: false
```

One changed thing, one failure, at exactly the new assertion - and every step
before it (boot, project open, ARR tab, INT-on assertion) stayed green. The
guard is not blind. The fix was restored, rebuilt and re-run: **1 passed
(19.2 s)**, zero JS errors, and the whole §42 chain (move, undo, redo,
drag/undo/drag, zoom, final click) completed on the default configuration for
the first time.

## Wave 9b - the wave-5 test file was red under `tsc` since it was written

`npx tsc --noEmit` on the whole project reported **4 errors, all in my own
`tests/ui/mount-unmount-balance.test.tsx`** - the four `addEventListener`
spies were typed `listener: never`, which collapses `vi.spyOn`'s overload set
and makes every call site unassignable. Vitest never saw it: the specs pass,
because the parameter type is erased at runtime.

Fixed by typing the listener as `EventListenerOrEventListenerObject` with the
real options union, which is what an implementation of an overloaded method has
to accept. `npx tsc --noEmit` -> **exit 0**, and those 4 specs still pass.

Recorded because it is the second time in this audit that "my suite is green"
and "the repo gate is green" turned out to be different claims (the first was
the registry audit in wave 2). The file was committed at `b241bfb6` with the
whole project red; `npm run typecheck` was not run at that boundary.

---

## Wave 10 (D14) — the Browser blocker was not the page. The page was broken.

Wave 9 (another session) got a loaded page and immediately found a P1 in the
arrangement lane. This wave starts where wave 8 stopped: the in-app Browser
reported `loaded: true` in 532 ms and then refused every operation that touched
the page for 275 s. Wave 8 attributed that to "the control channel, not the
page" and left it as an assumption. The assumption was right, and it was worth
settling — because the moment the page became drivable, the studio turned out
to be broken at **every viewport size**.

### The blocker, settled by measurement

Same build, same preview server, two drivers:

| driver | result |
| --- | --- |
| in-app Browser — `open_tab` | `loaded: true`, **678 ms** |
| in-app Browser — `inspect`, `query(console)` | `BROWSER_OPERATION_TIMEOUT` at the **275 s** ceiling, twice |
| Playwright — `page.goto(waitUntil: "commit")` | **183 ms** |
| Playwright — `page.evaluate(() => …)` ×5 | **205 / 789 / 1331 / 1874 / 2414 ms**, all returned |
| Playwright — console errors during boot | **0** |

`document.readyState` went `loading → complete` inside 789 ms and the DOM grew
to 134 nodes by 1.9 s. A slow boot and a dead renderer look identical from
outside; only this measurement separates them, and it says the renderer was
never blocked. Playwright also has its own timeouts, which turns "the page never
answered" from a 275 s wall into an attributable failure — that is the whole
reason the measurement is possible at all.

### The machine was also contaminated, and it matters for reading waves 6–8

Two processes, `scripts/measure-genre-references.mjs`, belonging to another
session, were running with **2418 s** and **2388 s** of accumulated CPU since
10:43 and 11:59 — and still burning **128%** and **124%** of a core at the
moment of measurement (+7.69 s and +7.47 s over a 6 s sample). That is the
honest explanation available for wave 6's "44 node processes and ~1219 s of
accumulated CPU", and it means every earlier "starved renderer" reading was
taken on a box with two cores pinned by someone else's job.

**Not killed.** They are another session's work and `AGENTS.md` §7 is explicit
about not interfering in a shared worktree. It is the owner's call, and it is
recorded here because two pinned cores explain a lot of the flakiness that
waves 6–8 kept hitting.

### D14 — the workspace had two grid columns instead of three (P0, CONFIRMED)

`main.workspace` has **three** children: `BrowserStrip`, `.workspace-main`
(TrackTabs + PatternBar + Sequencer) and the Inspector. It was rendering with
**two** grid tracks.

Measured in Chromium against the production build, at four viewports:

| viewport | `grid-template-columns` | `.workspace-main` | `.sequencer` | GEN hit test |
| --- | --- | --- | --- | --- |
| 1280×720 | `1000px 280px` | 280 × 173 | **256 × 20** | `BUTTON.dock-resize-handle` |
| 1366×768 | `1086px 280px` | 280 × 197 | **256 × 20** | GEN |
| 1440×900 | `1160px 280px` | 280 × 263 | **256 × 20** | GEN |
| 1920×1080 | `1640px 280px` | 280 × 353 | **256 × 20** | GEN |

Two things in that table are worse than the GEN button:

1. **`.workspace-main` — the column that holds the sequencer — was 280 px wide
   at every viewport.** The Inspector got the fluid track and the sequencer got
   the clamped one.
2. **`.sequencer` was 256 × 20 with `scrollHeight` 618.** The step sequencer —
   the reason the application exists — rendered as a 20 px window onto 618 px
   of grid, at 1920×1080 as well as at 1280×720. The screenshot at 1280×720
   shows the consequence plainly: a large empty black rectangle where the
   editor should be.

`elementFromPoint` at the centre of GEN returned `BUTTON.dock-resize-handle`:
the pattern bar had overflowed out of its column into the dock band, and the
dock — a later sibling — won the hit test. **The flagship GENERATE action was
unclickable**, which is why `03-generate-flow`, `04-persistence-roundtrip` and
`05-keyboard-shortcuts` all failed on the same line.

### Root cause: cascade order, not specificity

```
01-base.css:532          .workspace { grid-template-columns: minmax(0,1fr) 280px }
20-control-kit.css:472   .workspace { grid-template-columns: auto minmax(0,1fr) 280px }
24-layout-tokens.css:45  .workspace { grid-template-columns: minmax(0,1fr) clamp(180px, var(--inspector-width,280px), 420px) }
```

All three are `.workspace` — identical specificity. `src/styles/index.css`
imports `24-layout-tokens.css` **last** (added today in `fe072bbf`, 16:38), so
the two-column rule silently replaced the three-column template. Grid
auto-placement then did exactly what two tracks imply with three children:
`.workspace-main` into column 2, the Inspector into a second **row**.

The file's own comment recorded the mistaken belief that produced it:

> the clamp above is overridden by the existing 01-base.css block, which stays
> as the single owner of that layout switch

`01-base.css` cannot override anything — it is imported *first*. A media query
does not add specificity either, so the same mistake also killed the
`@media (max-width: 860px)` "inspector becomes a row" switch declared in
`20-control-kit.css:479`.

### Fix

`24-layout-tokens.css` now declares the three tracks
(`auto | minmax(0,1fr) | clamp(...)`) and re-declares the ladder's own two
breakpoints **inside itself**, mirroring `20-control-kit.css:474-484` verbatim.
Restoring the previous behaviour, not inventing new behaviour. The wrong
comment is replaced by the measurement.

### Falsification — the guard was made to fail on the old build

Injecting the pre-fix rule into the built CSS
(`.workspace{grid-template-columns:minmax(0,1fr) clamp(180px,var(--inspector-width,280px),420px)}`)
makes all three layout assertions fail with the exact measured symptoms:
`columns were "1000px 280px"`, `GEN hit test at 1280x720` ≠ GEN, `sequencer
height at 1440x900` ≤ 120. The suite also stays green on the fixed build, so
the assertions describe the defect and not the fix.

### Suite result, production build, Chromium

| | before the fix | after the fix |
| --- | --- | --- |
| specs 01–08 | **8 passed / 5 failed** | **15 passed / 1 failed** |
| failing | 01, 03, 04, 05, 07 | 07 only |
| new `19-workspace-layout` | — | 4 passed |

Four product specs turned green — landing→studio, GEN generate flow,
persistence roundtrip and keyboard shortcuts — all of them downstream of GEN
being unclickable.

### D14 sibling — the same mistake killed the phone label breakpoint (P2)

`.user-label-width` in the same file sets `--steps-label` on `<html>` with the
same specificity as `:root { --steps-label: 112px }` from
`12-floating-instrument-plugin-2.css`'s `@media (max-width: 760px)`, and is
loaded later. Its comment claimed "classes lose to media queries, so the
responsive behaviour survives". Measured at 720×900 in Chromium:

```
default user            -> --steps-label: 112px   (breakpoint alive)
user chose 220px        -> --steps-label: 220px   (breakpoint dead)
```

Scope is narrow and was measured before anything was claimed: `ui/layout.ts`
only adds the class when the user has changed the label width, so this affects
that subset, on phones only. But 220 px of a 720 px screen is 30% of the
width, which is exactly what the 760 px step exists to prevent. Fixed by
re-declaring the phone step after the class rule, and falsified the same way
(220 px vs 112 px).

The sweep over that file is **closed**: it holds five rules that touch layout,
and exactly two of them killed behaviour declared earlier — `.workspace` and
`.user-label-width`. The other three were checked and are clean: `.rack`
re-declares the 01-base `repeat(8, 1fr)` with the user's column count and no
earlier file owns a responsive `.rack`; `body { font-size: calc(13px *
var(--type-scale, 1)) }` reduces to the same 13 px at the default scale and no
media query sets a body font-size; and `.density-dense .dock-tabs { height:
28px }` outranks the 760 px `.dock-tabs` block in `19-dock-chrome.css:210`
anyway, and that block sets only `position`, `top`, `z-index` and `background`
— no height to collide with.

### What this wave does not close

- **The sequencer still gets ~20 px at a 720 px viewport height.** With the
  columns restored it is 732 × 20 at 1280×720: the dock (266 px), the rack
  strip (~151 px) and the pattern bar (~149 px) leave nothing. This is a
  vertical-space **policy** question — what gives when the screen is short —
  and §56 puts it outside an autonomous fix. Measured and recorded, not
  silently resized.
- **Six e2e specs can only run against the dev server**: `07`, `10`, `11`,
  `12`, `13`, `18-tsar` import `/src/*.ts` from inside the page (67 call
  sites). They exercise source modules, not the shipped bundle, so they have
  never validated a production build. `07` is the one red in the table above
  and it is red for that reason, not because of a product defect.
- **The boot watchdog (§20)** from wave 7 is still open, still an architecture
  decision.

### Gates for this wave — what actually ran

| gate | result |
| --- | --- |
| `npx vite build` (production bundle, after each change) | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run format:check` | clean for every file this wave touched; the one remaining warning is `tests/probe-split-undo.test.ts`, which belongs to another session |
| `npm run test` (vitest) | 906 / 944 files passed, 38 red, 53 tests red — none reachable from this wave: the only source change is one CSS file, and `vitest.config.ts:86` excludes `tests/e2e/**`, so a stylesheet rule and the new Playwright spec cannot produce a vitest failure. The reds are co-tenant work in flight; `npm run test:expectations` is the gate that attributes them |
| `playwright --project=chromium`, specs 01–08 + 19, production build | **15 passed / 1 failed** (1.7 min), the single red being `07`, which imports `/src/*.ts` and cannot run against a production build at all |
| falsification runs | pre-fix CSS injected into the built bundle makes 4 of the 5 layout assertions fail with the exact measured symptoms (`columns were "1000px 280px"`, GEN hit test ≠ GEN, sequencer height ≤ 120, `--steps-label` 220px vs 112px, and at 800×900 `columns were "520px 280px"` with 2 tracks instead of 1) |

One guard had to be rewritten because it was **not a guard**: the first version
of the 860px-ladder test asserted `workspace-main` width, which is true on the
broken build too (the fluid track lands there either way at that width), and it
passed against the pre-fix CSS. The discriminator is the track count — 2 on the
broken cascade, 1 after the fix — plus the Inspector actually moving below the
sequencer. Rewritten, then falsified.

## Wave 10 - 2026-10-11 - the rest of the 42 chain, run for real (P1/P2, one new defect)

With the production build served and the page controllable, the chaos spec was
extended from "move / undo / redo / zoom" to the chain the objective actually
names. Two findings came out of it - one a real defect, one a false alarm that
measurement killed.

### D15 - the onboarding hint bar ate clip presses at 900x700 (P2, CONFIRMED)

Found by the §33 stage: at a 900x700 viewport the pointer at the clip's own
centre resolved to

```
narrowViewport={"ok":false,"why":"span.onboarding-text","rect":{"x":436,"y":599,"w":114,"h":44}}
```

`OnboardingHint` renders `.onboarding` as `position: fixed; bottom: 40px;
z-index: 60`. At 1280x720 that bar sits below the lane and nothing is wrong; at
900x700 the arrangement lane comes up under it, and an ordinary positioned box
answers `elementFromPoint` for whatever is beneath. The first run of this stage
was **red exactly here**, and green at the same line after one CSS change -
that is the falsification, in the useful order: red, then fix, then green, with
every preceding stage green in both runs.

Fix (two lines, no behaviour change): the bar is a status bar, not a control
surface, so it is `pointer-events: none` and its own buttons opt back in. The
identical twin `.install-prompt` (`position: fixed; right: 14px; bottom: 40px`)
was fixed in the same commit - same shape, same reason, and §38 asks for the
sibling sweep rather than the single occurrence.

```
narrowViewport={"ok":true,"why":"span.arr-clip-name","rect":{"x":436,"y":599,"w":114,"h":44}}
```

### The false alarm: "the toolbar removed one clip from a two-clip selection"

The chain ctrl-selected two clips, pressed the arrangement toolbar's `DEL`,
and measured **3 clips before, 2 after** - one clip removed from a two-clip
selection, which reads exactly like the §14 grouped-edit defect this audit is
looking for.

It is not a defect. `ArrangementPanel.tsx:3817` and `:3834` show the toolbar
`DUP`/`DEL` keyed to the panel's single `selectedClipId`, while the keyboard path
(`:1610`) and the context menu (`:4927`) pass the whole selection. Both are
self-consistent; the surviving selected clip is a legitimate member of the
multi-selection that the single-clip action did not touch. Recorded as a
**human review item**, not fixed - "toolbar acts on the active clip, keyboard
acts on the selection" is a product convention, not a bug.

The assertion was rewritten anyway, because the first version was measuring the
wrong thing. It compared *counts*, and "1 selected before, 1 after" reads
identically whether the selection was pruned correctly or a dead id was swapped
for a survivor. It now compares **identities**: every clip still marked selected
must still exist, and no removed clip may remain rendered.

### What the chain verified, in a real browser, on the default configuration

| Section | Stage | Measured result |
| --- | --- | --- |
| 19/33 | pointer identity at the drag origin | `div.arr-clip` (was `.arr-intensity-lane`, D14) |
| 5 | move, undo, redo | positions move, restore exactly, re-apply |
| 6 | trim via `.arr-clip-resize` | committed width changes, clip count unchanged |
| 7 | split with CUT | 1 clip -> 2 |
| 8 | duplicate + move the copy | copy moves, original does not |
| 4/14 | ctrl+click multi-select | 2 clips selected |
| 9/4 | remove a clip | one gone, no dead id left selected |
| 22 | undo/redo that removal | counts restore and re-apply exactly |
| 13 | horizontal scroll | no unmount, no timing change |
| 17 | play -> edit during playback -> stop | playhead 0px -> 29.4px -> seeked 543.9px, one clip `.playing`, clip count stable through a live drag, playhead frozen after Stop, zero `.playing` clips |
| 33 | 900x700 viewport | clip is the pointer target |

`1 passed (37.6 s)`, **jsErrors = 0** across the whole chain.

Two of these were environment artefacts before they were test facts, and both
are worth recording because each would have become a false defect report:

- **`Space` did not start the transport.** It does in a fresh studio (measured:
  playhead 0 -> 11.25 -> 26.25 px). In the chain, focus was still on the Undo
  button from the previous stage, and Space activates a focused button. Standard
  browser behaviour, not an editor defect; the spec now drives the transport by
  the button.
- **No clip reported `.playing`.** The transport was running; the playhead had
  simply walked through bar 0, where - after trim, split, duplicate, move and one
  removal - there is no clip. The assertion now seeks to a real clip first,
  because "a clip is playing" is only a claim about a clip the playhead is
  inside.

### Still not verified in a browser

Fades/crossfades (§10) need an audio clip; the default template renders one
scene clip and zero audio clips, so the fade handle was never under the pointer.
Take lanes need a recorded take. These remain open.

## Wave 11 - 2026-10-11 - §16 ripple, the mode with the largest blast radius

The objective calls ripple out explicitly ("ripple editing has high blast
radius and should receive especially strict invariant checks"), and it was the
largest untouched DoD area. New spec: `tests/e2e/ripple-semantics.spec.ts`.

### The contract, taken from the commands rather than from the UI

`src/commands/clipPlayback.ts` states it in two sentences, and the second one is
the one worth testing:

> `deleteArrangementClipRipple` - "removing a clip closes the gap: every later
> clip slides left by the deleted length"
> `resizeArrangementClipRipple` - "growing a clip pushes every later clip right
> ... **the gaps after the edit stay exactly as before**"

So ripple is not "shift the material left". It is "the tail flows and the
SPACES inside the tail survive". A shift-everything implementation satisfies the
first clause perfectly and silently destroys the arrangement's spacing - which
is why this spec asserts spacing separately from position.

### Measured

```
before  [{left:0,width:116},{left:120,width:116},{left:240,width:116}]   (bars 0/4/8)
toggle  RIPPLE ON
remove the first clip
after   [{left:0,width:116},{left:120,width:116}]
shift   120px          jsErrors=0
undo/redo  positions, lengths and re-application all exact
```

### An assertion that was wrong, and what the editor actually does

The first version of this spec shifted by `removed.width`, i.e. the clip's
**rendered** width, and failed:

```
Error: clip 0: expected 4, got 0
```

The editor was right and the assertion was wrong. The committed `style.width`
carries a ~4 px inset (`116px` for a 4-bar clip at `30px/bar` = `120px`), and
the model flows the tail by **bar length**, not by rendered pixels. The spec now
states the contract in unit-free terms:

1. **closes the gap** - the clip that followed now starts where the removed one
   started (`after[0].left === removed.left`);
2. **uniform flow** - every tail clip moved by the same amount;
3. **spacing survives** - the offsets between surviving clips are unchanged.

(1) and (2) hold for contiguous material and are what a "delete without
ripple" run cannot fake; (3) is what a shift-everything run cannot fake.

### Falsification

The same spec with the ripple toggle deliberately left **off**:

```
before  [{0,116},{120,116},{240,116}]   toggleLabel=RIPPLE OFF
after   [{left:120,width:116},{left:240,width:116}]
-> RED on "ripple must close the gap, not just remove the clip"
```

The tail simply stood still. So the spec is measuring ripple behaviour and not
"a clip disappeared" - and the editor's ripple is confirmed to actually ripple.
The temporary env-var switch used for that run was removed afterwards rather
than committed: a branch no CI run ever exercises is a guard that can only ever
pass, which is the exact shape this audit keeps refusing.
