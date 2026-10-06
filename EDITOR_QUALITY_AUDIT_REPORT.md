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
