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
class, and both were found by asking one question — _does every code path that
claims to honour a guard actually reach it?_

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

| Verb                                                    | What it does to a locked clip          | Guard |
| ------------------------------------------------------- | -------------------------------------- | ----- |
| `moveAudioClip` / `resizeAudioClip` / `deleteAudioClip` | refuse                                 | ✅    |
| `sliceAudioClipToArrangement`                           | **deletes the clip, writes fragments** | ❌    |
| `stripSilenceAudioClip`                                 | **deletes the clip, writes segments**  | ❌    |
| `consolidateAudioClips`                                 | **deletes every selected clip**        | ❌    |
| `fitAudioClipTempo`                                     | rewrites `stretchMode`/`stretchRate`   | ❌    |
| `updateAudioClip`                                       | slip / trim / stretch fields           | ❌    |

`splitAudioClipAtTick` — the one sibling in the same file — _does_ guard. That is
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
`fitAudioClipTempo`. `updateAudioClip` guards **only** the fields that _are_
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

The scene commits wrapped their factories in `catch {}` with the comment _"clip
deleted mid-drag — drop silently"_. That is correct for a clip deleted by a
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

Wave 1's remaining-risk item 5 recorded: _"No clipboard in the arrangement
timeline (VERIFIED absent) — `grep -ri clipboard src/` returns nothing."_

**That was wrong, and wrong in a way that cost coverage.** `src/commands/clipClipboard.ts`
landed on 2026-10-07 (copy/cut/paste for timeline clips, Ctrl+C/X/V) with callers
in `App.tsx` and `ContextMenu.tsx`. The grep was run at a moment when the file
did not exist and the conclusion was written down as a property of the editor
rather than a property of that moment. §30 was therefore audited as _not
applicable_. It is applicable, and it had a defect.

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
_is_ the content — re-pointing the copy at an arbitrary live scene would play
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
`fadeOut` without consulting the lock. Every verb the contract _names_ refuses;
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

| Gate                                          | Result                                       |
| --------------------------------------------- | -------------------------------------------- |
| `tests/clip-lock-verbs.test.ts`               | 9 passed                                     |
| `tests/ui/clip-lock-block-drag.test.tsx`      | 6 passed (1 red under falsification)         |
| `tests/clip-clipboard-integrity.test.ts`      | 11 passed (1 red under falsification)        |
| Wave-1 editor suites re-run after the changes | 65 passed                                    |
| `prettier --check` on every touched file      | `All matched files use Prettier code style!` |

---

## D10 — A snap-grid test passed alone and failed in file order (P3, CONFIRMED)

Found by the full-suite gate, not by reading the editor: the editor-surface
regression run came back with `tests/ui/audio-selection-parity.test.tsx` red on
_"SNAP OFF keeps the exact pre-snap free behavior"_ — the drag landed on the
1/2 grid (1.5 bars) where the test expected free placement (1.3 bars).

`snapController` is a deliberate UI-wide singleton (`src/ui/snap.ts:143` — "snap
is a view preference, not per-mount state"), and that is correct: snap _is_ a
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
required _disproving_ my own change first. A red next to your own diff is not
evidence that your diff caused it.

---

## Wave-2 gates — what actually ran, and what it did not cover

Recorded as executed. This repo is shared with at least two other sessions
(intent, rezonans) and they hold it dirty, so repo-wide gates cannot report a
clean baseline; each row below says what it covered and what it could not.

| Gate                                           | Command                                                                                                                                                               | Result                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wave-2 specs                                   | `npx vitest run tests/clip-lock-verbs.test.ts tests/ui/clip-lock-block-drag.test.tsx tests/clip-clipboard-integrity.test.ts`                                          | 9 + 6 + 11 passed                                                                                                                                                               |
| Falsification                                  | audio block guard disabled / dead-scene refusal disabled                                                                                                              | 1 red each, controls stayed green                                                                                                                                               |
| Wave-1 editor suites, re-run after the changes | `npx vitest run` on the 6 wave-1 suites                                                                                                                               | 65 passed                                                                                                                                                                       |
| Snap-parity isolation                          | `npx vitest run tests/ui/audio-selection-parity.test.tsx`                                                                                                             | 11 passed                                                                                                                                                                       |
| Editor-surface sweep                           | 137 suites matched `clip\|arrangement\|editor\|drag\|trim\|split\|select\|snap\|undo\|waveform\|audio\|track\|marker\|automation\|transport\|zoom\|viewport\|command` | see final summary                                                                                                                                                               |
| `tsc --noEmit` (repo-wide)                     | `npx tsc --noEmit`                                                                                                                                                    | **EXIT 2** — errors confined to `src/intent/providers/local.ts` + `tests/intent-binding.test.ts`, another session's in-flight work. Zero errors in any file this audit touched. |
| `prettier --check`                             | on every file this wave changed                                                                                                                                       | `All matched files use Prettier code style!`                                                                                                                                    |
| `tests/drift-check.test.ts`                    | `npx vitest run tests/drift-check.test.ts`                                                                                                                            | passed with the updated spec count                                                                                                                                              |

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

| Failing file                           | Failure                                                                                                             | Owner                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `tests/audio-engine-lifecycle.test.ts` | source-grep: `applyMasterConfig` limiter-knee pattern                                                               | concurrent session — this audit touched no engine file                   |
| `tests/audio-metering-purity.test.ts`  | _"Novel export(s) in metering.ts not yet tracked: `describeStageAdjustmentLimitation` — add them to KNOWN_EXPORTS"_ | concurrent session — the repo's own no-orphan-export guard doing its job |
| `tests/chord-track-intent.test.ts`     | `section "Break"/"Bridge" failed generation: candidate-0:brief-gate:empty`                                          | intent wave                                                              |
| `tests/probe-split-undo.test.ts`       | a committed scratch probe (`it("probe")`, console.log only, no assertions)                                          | concurrent session — left in place, not mine to delete                   |

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

Wave 1 left this as **UNCONFIRMED**: _"Mid-drag zoom or horizontal scroll
re-scales a live drag."_ It is not a defect — and the reason it is not is worth
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
zoom does. Whether a drag should also freeze the scroll _origin_ it grabbed
against is a genuine product decision (a user who scrolls mid-drag may expect
either "keep dragging in the original scale" or "follow the new view"), and it
is recorded for human review rather than decided here.

---

## Wave 3 — 2026-10-11 — §32/§36 malformed clip data

Wave 2 closed the locking and clipboard contracts. Wave 3 asks the question
§36 poses directly: _one bad entity should not crash the entire editor when
isolation is possible_ — and builds documents by writing **past the command
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
visibleBarIndices ?? Array.from({ length: totalBars }, (_, index) => index);
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

`RangeError: Invalid array length` / _"The above error occurred in the
`<ArrangementPanel>` component"_. Priority model: **P0 — editor action
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
_culled from the lane_, so the user drags a perfectly healthy neighbour while
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

| Injected value                 | Result at the store boundary       |
| ------------------------------ | ---------------------------------- |
| `startBar: 4`                  | kept (control)                     |
| `startBar: NaN` / `±Infinity`  | **clip dropped**                   |
| `lengthBars: 0` / `-2` / `NaN` | **clip dropped**                   |
| audio clip `startBar: NaN`     | **clip dropped**                   |
| **`startBar: 1e308`**          | **KEPT**                           |
| a command that writes NaN      | stripped before it reaches the doc |

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

The §35 requirement is _"repeated mount/unmount … listeners … must not leak"_,
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
_same_ listeners as a clean one. Measurement said 9 vs 4 — and the 9 is
**correct**: arming a live capture registers the guard's own pointer routing.
The assertion was wrong, not the code. Rewritten to the invariant that actually
matters: arming registers _extra_ listeners, and **every one of them comes
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

| Failure class        | Evidence                                                                                                                                                                                                            | Owner                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `page.goto` timeouts | `02-panel-toggles`: _"navigating to http://127.0.0.1:5199/, waiting until domcontentloaded — Timeout 60000ms exceeded"_                                                                                             | environmental (see below)  |
| Landing CTA copy     | `01-landing-to-studio:59` waits for `getByRole('button', { name: /open in studio/i })`; the page renders `Open the studio` (`LandingPage.tsx:160,302`) while `LandingPrompt.tsx:196` still reads `Open in studio →` | not this audit             |
| Dock hit-target      | `03-generate-flow` / `04-persistence-roundtrip`: clicking `.pattern-actions button:has-text("GEN")` reports _".dock-resize-handle … intercepts pointer events"_ and _"element was detached from the DOM"_           | not this audit — see below |

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
clipboard refusal and the grid extent all live _inside_ the chunk that never
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
  import fails _silently_ by construction here;
- **no retry or reload affordance** — §20 asks that nothing leave the user
  "permanently stuck in dragging, trimming, **loading**, or disabled state".

Reproduced twice (two independent loads, ~5 min and ~2 min, both still on the
fallback). The browser's own view is unchanged: an idle page, no console
output, no failed requests, forever.

**Not fixed here.** A boot watchdog changes application startup architecture —
it decides what the user sees when the app cannot start — which is §40's human
review boundary, and `main.tsx` is shared surface that other sessions are
editing. The honest disposition is to name it, with a reproduction: _load the
dev server on a cold module cache and watch the boot screen; there is no state
in which it admits it is stuck._

### Why this still does not complete the DoD

The §17 playback, §33 responsive-layout, §35 heap and take-lane items need a
**loaded** editor. Two attempts on this machine produced a loaded page at most
once (one Playwright scenario passed, others reached interaction before timing
out). Those items stay open, and the correct next step is a run on an idle box
against a **production build** — where the module graph is pre-bundled and the
982 KB dev transform does not apply — not a third attempt here.

---

## Wave 8 — 2026-10-11 — the production build, the budget gate, and the answer to wave 7

Wave 7 ended with an open question: _is the boot stall an application defect or a
dev-server artefact?_ The way to answer it is to remove the dev server.

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

| Budget                      | Actual         | Headroom |
| --------------------------- | -------------- | -------- |
| core worklets               | 149 / 150 KB   | **1 KB** |
| optional codecs             | 168 / 170 KB   | 2 KB     |
| optional on-demand runtimes | 640 / 650 KB   | 10 KB    |
| DAW JS chunks               | 5134 / 5160 KB | 26 KB    |

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
_robustness gap_ (the fallback has no watchdog), but it is not manifesting as a
real boot bug, and this report should not be read as claiming one.

Every Browser operation _after_ that navigation timed out at the tool's 275 s
ceiling — the control channel, not the page (navigation had already reported
`loaded`). Interactive browser verification was therefore unavailable to this
wave, and §17 / §33 / §35-browser / take-lane remain **unverified**. What this
wave did establish is that they are _runnable_: the production build is fast,
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
534..578) across the **full lane width** - not a strip _under_ the clips. With
`showIntensity` initialised to `true` (`ArrangementPanel.tsx:455`), a mouse
press anywhere on any scene clip landed on the strip. Consequence, at the
default configuration: **scene clips could be neither clicked nor dragged.**

### Root cause: tree order, not z-index

Neither element declares a `z-index`, so both sit at `auto` and CSS painting
order falls through to **tree order**. `.arr-clip` is
`position:absolute` (`.arr-clip`, `04-arrangement.css:621`) and the intensity
strip is the **last in-flow child** of `.arr-lane` (`ArrangementPanel.tsx`
rendered it immediately before the lane's closing tag), i.e. a _later_ sibling.
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
expect(probe.closestToClip, `pointer at the clip centre resolved to ${probe.top} (...)`).toBe(true);
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

| driver                                        | result                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| in-app Browser — `open_tab`                   | `loaded: true`, **678 ms**                                  |
| in-app Browser — `inspect`, `query(console)`  | `BROWSER_OPERATION_TIMEOUT` at the **275 s** ceiling, twice |
| Playwright — `page.goto(waitUntil: "commit")` | **183 ms**                                                  |
| Playwright — `page.evaluate(() => …)` ×5      | **205 / 789 / 1331 / 1874 / 2414 ms**, all returned         |
| Playwright — console errors during boot       | **0**                                                       |

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

| viewport  | `grid-template-columns` | `.workspace-main` | `.sequencer` | GEN hit test                |
| --------- | ----------------------- | ----------------- | ------------ | --------------------------- |
| 1280×720  | `1000px 280px`          | 280 × 173         | **256 × 20** | `BUTTON.dock-resize-handle` |
| 1366×768  | `1086px 280px`          | 280 × 197         | **256 × 20** | GEN                         |
| 1440×900  | `1160px 280px`          | 280 × 263         | **256 × 20** | GEN                         |
| 1920×1080 | `1640px 280px`          | 280 × 353         | **256 × 20** | GEN                         |

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

`01-base.css` cannot override anything — it is imported _first_. A media query
does not add specificity either, so the same mistake also killed the
`@media (max-width: 860px)` "inspector becomes a row" switch declared in
`20-control-kit.css:479`.

### Fix

`24-layout-tokens.css` now declares the three tracks
(`auto | minmax(0,1fr) | clamp(...)`) — but **scoped to `@media (min-width:
1101px)`**, not unscoped and not by restating the ladder.

That scope is the actual repair, and the first attempt at it was wrong. The
first version re-declared the ladder's own two rungs inside this file, which
worked — and turned `tests/layout-responsive.test.ts` red:

```
the inspector row-switch below 860px is still owned by the base sheet
  expect(tokens).not.toMatch(/@media \(max-width: 860px\)/)
```

That guard is a deliberate contract from an earlier wave, and its comment gives
the reason: _"24-layout-tokens.css must NOT define its own 860px block that could
race the existing one — that duplication is how these ladders drift."_ Rewriting
a guard to fit my own patch is the failure mode §57 exists to prevent, and the
guard had a point I had not measured: the ladder drifts by duplication, not only
by override.

The duplication-free formulation is better on both counts. A media query adds no
specificity, so an **unscoped** rule in this last-imported file beats every
breakpoint an earlier file declares — but a `min-width` rule whose range never
overlaps theirs cannot. So:

| width      | owner of `grid-template-columns`                   |
| ---------- | -------------------------------------------------- |
| ≥ 1101px   | `24-layout-tokens.css` (`auto                      | 1fr | clamp(...)`) |
| 861–1100px | `20-control-kit.css:475` (230 px inspector)        |
| ≤ 860px    | `20-control-kit.css:479` (inspector becomes a row) |

One owner per range, no duplicated rung, and the existing guard is satisfied
rather than rewritten. Same treatment for the label rule below
(`@media (min-width: 761px)` around `.user-label-width`).

### Falsification — the guard was made to fail on the old build

Injecting the pre-fix rule into the built CSS
(`.workspace{grid-template-columns:minmax(0,1fr) clamp(180px,var(--inspector-width,280px),420px)}`)
makes all three layout assertions fail with the exact measured symptoms:
`columns were "1000px 280px"`, `GEN hit test at 1280x720` ≠ GEN, `sequencer
height at 1440x900` ≤ 120. The suite also stays green on the fixed build, so
the assertions describe the defect and not the fix.

### Suite result, production build, Chromium

|                           | before the fix          | after the fix            |
| ------------------------- | ----------------------- | ------------------------ |
| specs 01–08               | **8 passed / 5 failed** | **15 passed / 1 failed** |
| failing                   | 01, 03, 04, 05, 07      | 07 only                  |
| new `19-workspace-layout` | —                       | 4 passed                 |

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
scoping the class rule to `@media (min-width: 761px)` so
`12-floating-instrument-plugin-2.css:839` stays the single owner of the phone
step, and falsified the same way (220 px vs 112 px).

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

### §17 — playback, finally measured instead of argued

Waves 6–8 left "playback editing / ghost audio" as the loudest unverified item,
because neither the dev server nor the in-app Browser could carry the check. With
the production build drivable it runs, and the evidence is worth stating plainly
because it is the first hard number this audit has for audio actually happening.

`tests/e2e/20-playback-master-bus.spec.ts` plays the House template and reads the
master strip's own peak readout (`.master-channel-peak-readout`, rendered by
`MasterStereoMeters` straight from the engine's master stereo snapshot, in dB,
`-∞` for silence). Three consecutive independent runs:

| run | transport       | master peak   | track meters | after stop |
| --- | --------------- | ------------- | ------------ | ---------- |
| 1   | `1.1.3 → 8.2.3` | **−1.3 dBFS** | 100          | **−∞**     |
| 2   | `1.1.3 → 9.2.3` | **−1.3 dBFS** | 100          | **−∞**     |
| 3   | `1.1.2 → 9.4.4` | **−1.3 dBFS** | 100          | **−∞**     |

A sampled run of the master peak, 200 ms apart:

```
-2.4, -4.8, -6.1, -2.7, -9.5, -6.5, -1.3, -1.6, -2.7, -8.9, -3.6, -6.7,
-2.2, -6.0, -2.3, -5.8, -1.3, -6.1, -2.1, -3.1, -5.0, -4.9, -1.3, -1.3, -1.3
```

That is a real mix moving between about −9.5 and −1.3 dBFS — not a stuck tone,
not silence, not clipping. **No ghost audio**: the bus returns to true `-∞`
after stop, which is the stuck-voice / released-buffer class the objective names,
and the House template (drums + bass + chords) is exactly the case where one
would expect.

What the spec deliberately does **not** claim: that the output is pleasant, or
that the mix is balanced. It measures that audio is produced, that the transport
advances, and that stop releases the bus. Loudness balance still needs manual
listening.

Two guards make it a guard rather than a smoke test. The **pre-playback
baseline** asserts the master is already silent, so the measured signal cannot be
attributed to ambient meter state — it is caused by the transport press. And the
console-error filter is scoped by origin rather than filtered blind: this
environment runs the studio from `vite preview` with no collab server, and the
refused requests are `http://127.0.0.1:1234/api/intake` (a different origin). A
refused **same-origin** request means the app failed to load one of its own
assets, and that stays red.

### §35 — heap stability, measured across lifecycle cycles

Wave 5 measured mount/unmount listener balance in jsdom; heap stability stayed
unverified because no browser could be driven. `tests/e2e/21-heap-stability.spec.ts`
runs ten identical panel open/close cycles with `HeapProfiler.collectGarbage`
before every reading, so the delta is live retention rather than uncollected
garbage from the cycle itself, and with a warm-up phase first so the first-touch
allocations (lazy chunks, audio node pools, analyser buffers) are not charged to
a leak.

```
run 1  baseline 15.29 MB   samples 14.86 … 15.42   growth -0.22 MB
run 2  baseline 16.40 MB   samples 15.09 … 16.16   growth -0.24 MB
```

Flat in both runs, and slightly _down_ at the end — there is no per-cycle
retention in the panel lifecycle to find. The 4 MB bound is derived from those
measurements rather than chosen in advance: the observed noise band is about
±0.6 MB, so 4 MB is roughly seven times the band, loose enough not to flake and
tight enough to catch ~0.4 MB per cycle, which is what an unmounted analyser,
listener set or worklet buffer would look like. The bound this spec carried
before the measurement was 12 MB, which would only have noticed at ~1.2 MB per
cycle.

What it does **not** cover: audio buffer churn during long playback, IR loading,
or project churn. Those need a longer soak than a CI-shaped run.

### D15 — the editor was last in line for vertical space (owner decision, P1)

Wave 10 fixed the grid but left the sequencer at 20 px. That number deserved a
second look rather than a deferral, because of what the studio actually looked
like: at 1280×720 the workspace column was 349 px and spent **151 px on the pad
rack and 149 px on the pattern toolbar**, leaving **20 px for the sequencer** —
the editor the application exists for. There was no empty rectangle to complain
about; there was _content without meaning_: a pad grid, four rows of buttons and
a mixer. At 1366×768 the sequencer got ~68 px.

Two of my first visual readings here were wrong and the measurements killed
them both: the pattern bar is **not** clipped (`scrollHeight == clientHeight ==
149`, every child inside its own box — what looked like a half-rendered row is
the 20 px sequencer), and the pad grid is **not** duplicated (one `.rack`, 16
pads, 0 in the inspector).

The owner chose the model, and the reasoning is recorded because it is the part
worth keeping: **the editor has priority.** The pad rack is a sound browser and
the pattern bar is a toolbar; neither is a canvas.

`src/styles/25-short-viewport.css`:

- `.workspace-main > .sequencer { min-height: 150px }` — outside any media
  query, because the priority is the rule at every height and is only
  observable where space is scarce.
- `.workspace-main > .pattern-bar { min-height: 72px; overflow-y: auto }` — the
  toolbar yields to the editor, and what it cannot show stays reachable.
- `@media (max-height: 820px)` — the pad rack drops to one row, and the dock
  stops at 34vh. The rack rule is written against the `.rack` RULE, not the
  `--rack-columns` token: `ui/layout.ts` writes that token as an inline style on
  `<html>`, so a media query on the token would need `!important` **and** would
  overwrite the user's stored preference.
- `@media (max-width: 860px)` — the editor floor relaxes to 90px, because below
  860px the inspector becomes a ROW and shares the vertical budget.

Measured after:

| viewport  | sequencer         | rack        | pattern bar | dock         | clipped |
| --------- | ----------------- | ----------- | ----------- | ------------ | ------- |
| 1280×720  | **150** (was 20)  | 101, 1 row  | 79          | 245 (capped) | 0       |
| 1366×768  | **150** (was ~68) | 101, 1 row  | 111         | 261          | 0       |
| 1280×800  | **150**           | 101, 1 row  | 138         | 266          | 0       |
| 1440×900  | 218               | 130, 2 rows | 141         | 266          | 0       |
| 1920×1080 | 467               | 130, 2 rows | 72          | 266          | 0       |
| 800×900   | 90                | 151         | 72          | 266          | 0       |

The tall layouts are untouched — 1440×900 and 1920×1080 keep two rack rows and
a toolbar that does not scroll — which is the assertion that matters most here,
because a short-viewport rule that leaks upward is its own regression.

**A regression this work caused, recorded because it nearly shipped.** The first
formulation gave the editor its floor everywhere. At 800×900 the workspace column
only gets 341 px, and against the rack's 151 and the 150 px floor the pattern
toolbar was squeezed to **0 px tall** — the toolbar simply gone, worse than the
bug it replaced. Caught by measurement, fixed with the 72 px toolbar floor and
the 90 px narrow-layout editor floor, then locked by a test that asserts both
numbers.

**The file placement was fought over twice, and the repo was right both times.**
The first attempt put these rules in `24-layout-tokens.css`; that file must not
define its own 860px block, and the guard went red. The second attempt created
`25-short-viewport.css` and imported it LAST; the same file pins
`24-layout-tokens.css` as the final stylesheet, and the guard went red again.
The arrangement that satisfies both without touching the guard: `25` imported
BEFORE `24`, owning vertical-space priority only, with the `.rack` rule living in
`24` beside the `.rack` rule `24` already owns. `layout-responsive.test.ts` is
15/15.

The cost, stated plainly: below ~820px the dock cannot be dragged past 34vh, and
on one row the pad names truncate ("Kick Deep" → "Ki…"). Both are visible in the
after screenshot and both are the price of the editor existing.

### What this wave does not close

- **The sequencer still gets ~20 px at a 720 px viewport height.** With the
  columns restored it is 732 × 20 at 1280×720: the dock (266 px), the rack
  strip (~151 px) and the pattern bar (~149 px) leave nothing. This is a
  vertical-space **policy** question — what gives when the screen is short —
  and §56 puts it outside an autonomous fix. Measured and recorded, not
  silently resized. **(Resolved later in the same wave: the owner decided the
  editor has priority — see D15 above. The sequencer now measures 150 px at
  1280×720, 1366×768 and 1280×800.)**
- **Six e2e specs can only run against the dev server**: `07`, `10`, `11`,
  `12`, `13`, `18-tsar` import `/src/*.ts` from inside the page (67 call
  sites). They exercise source modules, not the shipped bundle, so they have
  never validated a production build. `07` is the one red in the table above
  and it is red for that reason, not because of a product defect.
- **The boot watchdog (§20)** from wave 7 is still open, still an architecture
  decision.

### Gates for this wave — what actually ran

| gate                                                                                                      | result                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vite build` (production bundle, after each change)                                                   | exit 0                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run typecheck`                                                                                       | exit 0                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run format:check`                                                                                    | clean for every file this wave touched; the one remaining warning is `tests/probe-split-undo.test.ts`, which belongs to another session                                                                                                                                                                                                                                      |
| `npm run test` (vitest)                                                                                   | 906 / 944 files passed, 38 red, 53 tests red — none reachable from this wave: the only source change is one CSS file, and `vitest.config.ts:86` excludes `tests/e2e/**`, so a stylesheet rule and the new Playwright spec cannot produce a vitest failure. The reds are co-tenant work in flight; `npm run test:expectations` is the gate that attributes them               |
| `tests/layout-responsive.test.ts` (pre-existing guard for this file)                                      | **15/15** against the final CSS — it was red against the first formulation                                                                                                                                                                                                                                                                                                   |
| `playwright --project=chromium`, specs 01–08 + 19, production build                                       | **15 passed / 1 failed** (1.7 min), the single red being `07`, which imports `/src/*.ts` and cannot run against a production build at all                                                                                                                                                                                                                                    |
| `playwright --project=chromium`, specs 01, 03, 04, 05 + 19, production build, **final** CSS               | **11 passed / 0 failed**                                                                                                                                                                                                                                                                                                                                                     |
| `playwright --project=chromium`, specs 19 + 20 (§17) + 21 (§35), production build                         | **7 passed / 0 failed** (1.4 min), §17 reproducing −1.3 dBFS master peak and `-∞` after stop across four independent runs                                                                                                                                                                                                                                                    |
| `playwright --project=chromium`, specs 19 (9) + 20 (§17) + 21 (§35) + 03, production build, **final** CSS | **12 passed / 0 failed** (1.1 min)                                                                                                                                                                                                                                                                                                                                           |
| falsification, D14                                                                                        | pre-fix CSS injected into the built bundle makes the layout assertions fail with the exact measured symptoms: at 800×900 `columns were "520px 280px"` (2 tracks, not 1); at 1280×720 `columns were "1000px 280px"` (2 tracks, not 3); GEN hit test `BUTTON.dock-resize-handle` instead of `GEN`; sequencer height 20 instead of >120; `--steps-label` 220px instead of 112px |
| falsification, D15                                                                                        | reverting the short-viewport rules in the built bundle fails the new guards with the measured numbers: sequencer **20 px** at 1280×720 (floor 150), **57 px** at 1366×768, and the 800×900 toolbar case                                                                                                                                                                      |

**The two browser-verification items this audit inherited as unverified are now
measured**: §17 playback/ghost audio (§17 section above) and §35 heap stability
(§35 section above). What is still unverified in a real browser: long-session
audio-buffer churn, IR/sample loading soak, and the take-lane click suppression
that wave 1 recorded as fragility without a demonstrated defect.

One guard had to be rewritten because it was **not a guard**: the first version
of the 860px-ladder test asserted `workspace-main` width, which is true on the
broken build too (the fluid track lands there either way at that width), and it
passed against the pre-fix CSS. The discriminator is the track count — 2 on the
broken cascade, 1 after the fix — plus the Inspector actually moving below the
sequencer. Rewritten, then falsified.

A second guard caught the fix itself. `tests/layout-responsive.test.ts` went
red on the first formulation, and it was right to: the repo had already decided
that `24-layout-tokens.css` must not restate the ladder. The `min-width`
formulation satisfies it without weakening anything — `layout-responsive.test.ts`
is **15/15 green** against the final CSS. Two editors independently reached for
the same wrong model of the cascade in this file, and the repo's own test suite
was carrying the correct one.

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
wrong thing. It compared _counts_, and "1 selected before, 1 after" reads
identically whether the selection was pruned correctly or a dead id was swapped
for a survivor. It now compares **identities**: every clip still marked selected
must still exist, and no removed clip may remain rendered.

### What the chain verified, in a real browser, on the default configuration

| Section | Stage                                | Measured result                                                                                                                                         |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19/33   | pointer identity at the drag origin  | `div.arr-clip` (was `.arr-intensity-lane`, D14)                                                                                                         |
| 5       | move, undo, redo                     | positions move, restore exactly, re-apply                                                                                                               |
| 6       | trim via `.arr-clip-resize`          | committed width changes, clip count unchanged                                                                                                           |
| 7       | split with CUT                       | 1 clip -> 2                                                                                                                                             |
| 8       | duplicate + move the copy            | copy moves, original does not                                                                                                                           |
| 4/14    | ctrl+click multi-select              | 2 clips selected                                                                                                                                        |
| 9/4     | remove a clip                        | one gone, no dead id left selected                                                                                                                      |
| 22      | undo/redo that removal               | counts restore and re-apply exactly                                                                                                                     |
| 13      | horizontal scroll                    | no unmount, no timing change                                                                                                                            |
| 17      | play -> edit during playback -> stop | playhead 0px -> 29.4px -> seeked 543.9px, one clip `.playing`, clip count stable through a live drag, playhead frozen after Stop, zero `.playing` clips |
| 33      | 900x700 viewport                     | clip is the pointer target                                                                                                                              |

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

## Wave 12 - 2026-10-11 - §18 destructive shortcuts vs focused fields

The objective states the invariant directly: "destructive shortcuts must not fire
while typing in unrelated controls". New spec: `tests/e2e/keyboard-guards.spec.ts`,
aimed at the panel's own `SECS` field - a `type="number"` input living inside
the arrangement toolbar, so every global handler in `App.tsx` is a candidate to
steal keys from it.

### Measured

```
selected a clip (the SECS field only renders for a selected clip)
typed "12"            -> field=12   clips=1
Delete  in the field  -> clips=1
Backspace in the field-> clips=1
Ctrl+Z  in the field  -> clips=1   (no undo leaked into the project stack)
Escape  in the field  -> draft reverted, field back to 7.74s, clips=1
POSITIVE CONTROL: Delete with the field NOT focused -> clips 1 -> 0
jsErrors=0
```

### Why the control is the falsification here

The negative assertions on their own would also pass on a build where the Delete
shortcut is dead everywhere - they cannot distinguish "guarded" from "broken".
The control is what makes them mean something: if `Delete` never removed a clip,
the control would fail and the spec would go red. So the control is the
falsifier of vacuity, and it doubles as the within-run A/B: same key, same
document, same session - only focus differs, and the outcome is opposite.

I did not additionally disable the app's focus guard to watch the negatives go
red. Doing so would mean editing the very code path the negatives are claiming
to cover, and the A/B already demonstrates the discrimination the guard exists
for.

### Also closed in this wave: the drift gate attribution

`npm run drift:check` came back red with two items, and **neither is this
audit's**:

```
DRIFT [domain-goldens] tests/domain-goldens/serialization.json: committed artifact is stale
DRIFT [counts]        docs/CURRENT-STATE.md: Vitest spec files: says 941, live code measures 942
```

Attribution before touching anything:

- The golden drift travels in one staged change together with
  `src/project-model/schema.ts` (+38 lines) and `src/project-model/types.ts`
  (+7) - a concurrent session's schema addition. Blessing it would bake another
  session's unreviewed schema into a committed artifact, which is exactly what
  `drift:bless` must not be used for. It clears when that session commits.
- The counts drift was a mid-flight snapshot: this audit's two new specs
  (`tests/clip-sanitization-boundary.test.ts`, `tests/ui/mount-unmount-balance.test.tsx`)
  are already named in the CURRENT-STATE row, and re-measuring after the other
  sessions settled gives **live 944 = documented 944**.

Neither was blessed, "fixed", or committed by this audit.

## Wave 13 - 2026-10-11 - §11 snapping: one contract pinned, one measurement left open

New spec `tests/e2e/snap-grid.spec.ts`. Bars are derived from the panel's own
geometry (the duplicated fixture sits exactly four bars from its original),
never assumed, and the same gesture is repeated at two zoom levels so that a
"zoom-dependent snapping" defect would show up as a difference between them.

### What is verified

```
lefts=0,120  barWidth=30 px/bar
zoomSteps=0  pxPerBar=30.00   clip landed at 7 bars (210 px)
zoomSteps=2  pxPerBar=58.80   clip landed at 5 bars (294 px)
```

Whole-bar landing, exact at both zooms, from a drag that is deliberately not a
whole number of bars. That is the §11 contract and it holds.

### A measurement of my own that was wrong before the editor was ever wrong

The first revision reported "4 bars" for a clip sitting at 210 px. It derived
px-per-bar from `left(clip2) - left(clip1)` AFTER the drag had already moved
clip1 - so it divided 210 by a denominator computed from the moved pair (52.5)
and got a tidy integer. The assertion looked healthy because both the positive
and the negative branch shared the same bad denominator and therefore "proved"
each other.

`pxPerBar` is now captured BEFORE the drag and passed in. The lesson is
narrower than "be careful": a derived quantity that is computed from the thing
under test, after the thing under test has moved, is not a measurement - it is
an echo.

### The open measurement, NOT reported as a defect

Three states were measured on the same gesture:

| state                     | committed result          |
| ------------------------- | ------------------------- |
| grid = `1`                | 120 → **210** px (7 bars) |
| grid = `off`              | 120 → **210** px (7 bars) |
| grid = `off` + Shift held | 120 → **210** px (7 bars) |

Two things are unexplained:

1. the select reads `off` (`selectValue=off` was logged) yet the result is
   byte-identical to grid-on;
2. **all three moved the clip +90 px for a +65 px pointer drag**, which is 3
   whole bars rather than the 2.1667 bars the pointer asked for.

Reading A: the scene-clip drag path applies secondary snap targets regardless
of the grid setting, and something at bar 7 (a marker, an edge) captures the
pointer. Reading B: the drag applies its own quantisation on commit. Both are
consistent with the numbers; neither is proven, and no code was changed on this
evidence - §41.

The grid-ON and Shift-suspend branches are therefore **not** asserted in the
committed spec. An assertion that contradicts an unexplained measurement is
exactly how a wrong test becomes a wrong bug report. What the spec does say, in
a comment, is that the OFF/Shift branches were measured and produced results
indistinguishable from grid-ON.

**This is the honest state of §11**: the grid contract is pinned, and whether
the OFF setting and the Shift suspend actually reach scene-clip drags is an
open question that needs one more controlled run (a marker-free fixture, and a
drag distance that lands far from every secondary target).

### Full-suite result, and what this audit did not do about it

`npm run test` over the whole repo:

```
Test Files  36 failed | 911 passed (947)
     Tests  51 failed | 10359 passed | 128 skipped (10538)
Duration 867.94s
```

The visible failure in the tail is `tests/ui/reference-map-panel.test.tsx`, which
belongs to the concurrent reference-map session, not to this audit's files. The
remaining 50 are attributed by `npm run test:expectations` (the repo's own
ratchet) rather than by eyeballing, and nothing here was "fixed", skipped or
weakened on the way.

### What the ratchet actually said

```
suite run: 947 files · 10358 passed · 52 failed · 128 skipped
ledger: 22 entries (against 36d3afbb)
✗ NEW REDS (39) — fix, or classify with owner + reason
✗ CURED (8)   — ratchet: remove from suite-expectations.json
```

The committed baseline records **22** known-red entries; the suite now produces
**52** failures. So the repo has drifted **39 tests away from its own declared
state**, and 8 of its declared reds have been cured without the ledger being
updated. Both directions fail the gate, by design — this is the ratchet working,
not the ratchet breaking.

Checked for this audit's blast radius and found clean: the failures visible in
the run (`panelTsar → unknown panel "tsar"`, a shortcut table that grew from 35
to 43 verbs, `symbolic-melodic`, `collab-ydoc-drift`, `midi-io`,
`bridge-rate-limit`, `multivoice-golden`) are all feature areas owned by
concurrent sessions. The one file whose failures could plausibly have been mine
— `tests/ux-audit.test.ts`, which does audit the overlay/panel surface this
audit changed — was run on its own to confirm: 2 failures, both unrelated to
`pointer-events` (an unregistered TSAR panel id, and the verb-count drift).

`tests/probe-split-undo.test.ts` is still in the tree as a committed scratch
probe with one failing test. It is noise in every full-suite run and should be
deleted by whoever owns it.

## Wave 14 - 2026-10-11 - closing the measurement gap: the hit-test sweep

D14 and D15 were the SAME bug twice: something invisible sat on top of an editing
surface and answered for it. Neither was catchable by a unit test - jsdom has no
layout and therefore no hit-testing. They were caught by asking one question of
a real page, and until now that question lived inside a single spec's probe.

That is now infrastructure: `tests/e2e/hit-test-sweep.spec.ts`.

### What it does

For every interactive surface, at every rendered viewport, ask
`document.elementFromPoint` at the surface's own centre and require the answer to
be the surface or something inside it. Surfaces swept: `.arr-clip`, the trim
handle `.arr-clip-resize`, `.arr-ruler`, `.arr-lane` (marquee), plus
`.arr-intensity-point` and `.arr-audio-clip` where rendered. It ALSO sweeps in
the opposite direction - decorative layers that must be click-through
(`.arr-bar-grid`), because a gridline that answers for the lane turns every
empty-lane gesture into a silent no-op that reads as "drag is broken".

Three viewports, because a fixed overlay only has to collide at ONE of them to
be a defect - D15 was invisible at 1280x720 and fatal at 900x700.

```
[sweep 1280x720] blocked=0    [sweep 1100x800] blocked=0    [sweep 900x700] blocked=0
not rendered at any size: .arr-intensity-point, .arr-audio-clip
```

Honest limitation, logged rather than hidden: **2 of the 6 surfaces are not
rendered by the default template** (no intensity-curve points, no audio clips),
so the sweep's coverage of those is exactly zero until a fixture provides them.
The sweep reports absent surfaces by name so that gap cannot quietly become
permanent.

### Falsification - and the control that was wrong first

The sweep's own control injects an overlay over the lane and requires it to be
reported. The first run of that control **failed**:

```
[sweep control] after injecting a cover: 0/1 clips blocked
```

The sweep was right and the control was broken: the injected element reused the
class `.arr-bar-grid`, which carries `pointer-events: none`, so the "overlay"
was click-through and nothing was blocked. A control that cannot actually
create the condition it claims to create proves nothing - and the sweep refused
to pass rather than agreeing with a fake. Fixed by injecting a plain element
with no stylesheet class:

```
[sweep control] after injecting a cover: 1/1 clips blocked, hit=div.
4 passed (13.4s)
```

### The harness, and what it is honestly worth

`tests/e2e/_studio.ts` opens a loaded, hittable editor: returning user, tour
dismissed, arrangement dock tab open, transient toasts cleared. All four of
those cost a failed drag somewhere in this audit before they were identified,
and every one of them fails in a way that LOOKS like an editor defect - the most
expensive wrong answer this suite can give.

The ripple spec was migrated onto it as proof it works for a second spec, not
just its author: **5 passed**, ripple still `shift=120px, jsErrors=0`. The other
four browser specs from waves 9-13 still carry their own boot code; migrating
them is mechanical follow-up and is deliberately not bundled into a commit that
changes what those specs assert.

### Attribution while this wave ran

`npx tsc --noEmit` turned red during the migration. One error was mine (an unused
`Page` type import, fixed immediately). The rest - five errors in
`tests/e2e/14-recording-soak.spec.ts` - are in an **untracked** file owned by the
concurrent recording session, and were left alone.

## Wave 15 - 2026-10-11 - migrating the specs, and the bug that was in the TEST

Four browser specs moved onto `_studio.ts` (chaos chain, keyboard guards, snap
grid, ripple). The point was never DRY: each one carried its own copy of four
boot obstacles, and each obstacle fails in a way that LOOKS like an editor
defect.

**No assertion changed.** Each spec was re-run after its migration and reports
the same measurements it did before: ripple `shift=120px`, snap `7 bars` and
`5 bars`, keyboard `control: 1 -> 0`, sweep `blocked=0` at three viewports,
chaos `chain complete: 3 clips; jsErrors=0`.

### What the migration exposed: the tests were measuring off-screen pixels

The first run after migrating failed in two specs. The geometry explains why:

```
clip      y=755     ← in a 720px viewport: BELOW THE FOLD
lane      y=749
intensity y=809
elementFromPoint at the clip's centre = "none"
[snap] drag before=120 after=120       ← the drag did nothing at all
```

`boundingBox()` returns **layout** coordinates even for an element that is not
visible; `page.mouse` needs **viewport** coordinates. The arrangement lane had
drifted ~220 px down the page as the shell grew, and every gesture in those two
specs was silently dispatching at a point that is not on screen.

The failure was loud, which is the only reason it was caught — but it pointed at
the editor, and the measurements it produced (`before=120 after=120`, and a
"4 bars" derived from an unmoved pair) were fiction. Fixed in all four call
sites by scrolling the target into view before measuring:

```
dragOrigin box={x:330, y:542} top=span.arr-clip-role
intensity y=596   (lane ends at 592 — D14's fix still holds)
chaos: chain complete: 3 clips; jsErrors=0    1 passed (38.4s)
```

**This is the same defect class as D14 and D15, in the test code instead of the
product**: a surface the user can reach is not the same as coordinates the test
believes exist. The sweep got it right from the start (its helper calls
`scrollIntoView` on the element before hit-testing), which is exactly why the
sweep stayed green while the older specs went red. A shared helper is worth
more than a shared copy.

## Wave 15b - §10 FADES: verified, after my own "blocked" verdict turned out wrong

`BOUNCE ZONE` was the way to get a real audio clip without a microphone: it
offline-renders the selected zone and flips it into a genuine audio clip
(`addAudioClip`, `ArrangementPanel.tsx:3193`), with a real buffer and a real
waveform. `tests/e2e/audio-fades.spec.ts` is written against it.

### The first verdict was wrong, and it is worth keeping

The first run reported the path as blocked:

```
ruler plain drag   -> enabled=false  .arr-time-range=0
lane ctrl+drag     -> enabled=false  .arr-time-range=0
lane shift+drag    -> enabled=false  .arr-time-range=0
```

`BOUNCE ZONE` is `disabled={!selection.timeRange}` (line 3743), so that reads
like a hole in range selection. It was not. The arrangement lane - **and the
ruler directly above it** - had drifted below the fold of the 720px viewport
(measured the same day: lane y=755), so `page.mouse` dispatched every event at a
point that is not on screen and the panel never saw a pointerdown.

That is the SAME bug the chaos chain hit hours earlier, one layer over, and the
report already named it: `boundingBox()` is layout space, `page.mouse` is
viewport space. What is worth recording is that **the two symptoms are
identical from inside the panel** - "the gesture does nothing" and "the gesture
never arrived" look exactly the same from there, and only one of them is a
defect. I marked the spec `fixme` on the cautious reading, which was the right
call under the evidence I had and the wrong conclusion.

### After `scrollIntoViewIfNeeded` — the last open DoD area closes

```
zone attempt ruler plain drag: origin=div.arr-ruler  BOUNCE ZONE enabled=true  .arr-time-range=2
clip={"count":1,"width":221,"height":48,"fadesInside":true,"waveform":1}
title="Drums · user.bounce-0b-... · 7.5b · trim 0.00/0.00 fade 0.00/0.00 gain 1.00 — ..."
before: fadeIn=0px      after drag: fadeIn=24px      clipWidth=221 (unchanged)
undo -> 0px   redo -> 24px   jsErrors=0
1 passed (19.1s)
```

What this covers in one gesture, in a real browser:

- **§10** the fade commits (0 px -> 24 px), stays inside the clip's own box,
  and the clip's length does not move underneath it;
- **§22** undo restores the committed fade exactly and redo re-applies it;
- **§26** the clip renders a real waveform element from the offline render -
  the visual is derived from the buffer that is actually played;
- **§25** the clip reaches the timeline through the real `addAudioClip` command
  path, not through a test-only shortcut.

**§10 fades are no longer an open DoD area.** The earlier "fades need a
microphone" framing was wrong: they needed a time range, which a ruler drag
produces, provided the pointer arrives.

---

## Final state, 2026-10-13

All browser specs from this audit, run together against the production build:

```
npx playwright test 18-editor-chaos-chain keyboard-guards snap-grid \
  ripple-semantics hit-test-sweep audio-fades --project=chromium --workers=2

9 passed (50.3s)
```

Nine tests, two workers, parallel — the same configuration that exposed the
off-screen drag earlier now passes, which is the point: the fix is in the
helpers, not in a serial-only path.

| Artifact                        | What it pins                                                           |
| ------------------------------- | ---------------------------------------------------------------------- |
| `hit-test-sweep.spec.ts`        | no overlay may cover an editing surface, 3 viewports (§19/§33)         |
| `18-editor-chaos-chain.spec.ts` | the §42 chain end to end, jsErrors=0                                   |
| `ripple-semantics.spec.ts`      | §16 gap closes, spacing survives, undo/redo exact                      |
| `keyboard-guards.spec.ts`       | §18 destructive keys inert while a field has focus                     |
| `snap-grid.spec.ts`             | §11 whole-bar landing at two zooms                                     |
| `audio-fades.spec.ts`           | §10 fade commits, stays in bounds; §26 waveform; §25 real command path |
| `_studio.ts`                    | the four boot obstacles, once, for all of the above                    |

Product changes made by this audit: **two**, both confirmed, both fixed, both
falsified - D14 (the intensity strip answering for every clip press) and D15
(the onboarding bar doing the same below 1280px).

### What a reader should still be suspicious of

- The grid-OFF and Shift-suspend branches: measured, indistinguishable from
  grid-ON, unexplained. Not asserted, not called a defect.
- The full-suite ratchet: 39 new reds and 8 cured, owned by concurrent
  sessions, attributed and left alone.
- Take lanes and heap behaviour: covered by other sessions' specs, not by this
  audit.
- Four product decisions still sit with a human, listed in this report rather
  than decided here.

**This audit does not claim the editor is correct.** It claims the things above
were reproduced or explicitly not claimed, and that the failures it did find
are no longer reachable in the way they were.

---

## Wave 15 - 2026-10-12 - error boundaries: one real defect, and a test harness that was lying to me

Owner ask: _"zrobustniť error boundaries, spraviť nejaké edge case testy, unit testy,
component testy ktoré by sa mohli zistiť."_

### D16 - a crash card outlives the panel that caused it (P1, CONFIRMED + fixed)

Dock slots render their occupant **by position, not by remount**. `App.tsx:1716-1718`:

```tsx
<div className="dock-slot" role="tabpanel" id={`dock-panel-${dock.slotA}`} ...>
  <Suspense fallback={<div className="panel-loading">Loading panel…</div>}>
    {renderDockSlot(dock.slotA)}      // no key
  </Suspense>
</div>
```

`renderDockSlot` (`App.tsx:1604`) returns `panelRenderers[id]`, and every one of those
is `<ErrorBoundary panel="…">`. React reconciles by type and position, so switching the
slot from `mixer` to `devices` **reuses the same `ErrorBoundary` instance** and updates
only its props. `hasError: true` survives the swap.

Consequence, in the order the user meets it:

1. The mixer throws. Card reads `mixer crashed — <the mixer's message>`.
2. The user clicks the `devices` tab to get unstuck.
3. The card now reads **`devices crashed — <the mixer's message>`**.

The new panel is blamed for an error it never threw, with the old panel's stack text
attached, and the user has to work out that `Retry` is the only way out. The error
report itself is wrong, which is worse than the crash.

The shared `devicePanel` element (`App.tsx:1538-1542`, reused for the `devices` / `fx` /
`plugin` ids) is the same instance, so it is unaffected by identity - correctly so,
since it is literally the same subtree.

Fix is in the boundary, not at each call site, so the whole class is covered
(`src/ui/ErrorBoundary.tsx`):

```tsx
componentDidUpdate(prevProps: Props) {
  if (!this.state.hasError) return;
  if ((this.props.resetKey ?? this.props.panel) !== (prevProps.resetKey ?? prevProps.panel)) {
    this.setState({ hasError: false, error: null });
  }
}
```

`resetKey` defaults to `panel`, so every existing call site is fixed without edits; it
exists for the case where the label is stable but the guarded content is not (e.g. the
same rack following a different track).

**Sibling sweep.** All four `TopBar` boundaries (`scale-panel`, `collab`, `theme`,
`assist`, `TopBar.tsx:862-883`) sit inside `{open && …}` and unmount wholesale, so they
get a fresh boundary every time. The unconditional `App` boundaries (`browser-strip`,
`sequencer`, `inspector`, `palette`) have stable identity and nothing to reset. The
conditional ones (`diagnostics`, `io-panel`) unmount too. **Dock slots are the only
swap-without-remount site in the app**, and the fix lives one level below them.

### The measurement that invalidated one of my own tests

I added a recovery test built on a counter inside the throwing child - "throw on the
first invocation, succeed on the second" - and it failed in a way I first misread as
test pollution. It was not pollution: it fails **in isolation too**, and the rendered DOM
already contained `recovered` before the first assertion.

Measured with a throwaway probe (since deleted):

| Probe                                 | Result                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| Always-throwing child, one `render()` | child invoked **5 times**                               |
| Throw-on-first child, one `render()`  | child invoked **4 times**, `crash card present = false` |

React 18 in DEV **replays a failed render**. A child that throws "only on its first
invocation" succeeds on the replay, the boundary never sees an error, and the crash is
silently swallowed. Any attempt-counter inside a throwing child is therefore worthless
as a probe: it reports recoveries that never reached the boundary.

The same replay explains a second number - `componentDidCatch` fires **4×** for one
logical crash. My first version of the "keeps the card" test asserted
`console.error` was called once and went red; that assertion was pinning a React
implementation detail, not a product property. It now measures child invocations across
the re-render, which is the property I actually care about: the crashed subtree is not
re-attempted behind the card.

Every flaky child in this file is now driven by an **external flag**, never a counter.
One test pins the trap itself so nobody walks into it again.

### Measured contracts, now pinned

- **Retry is a clean remount, not a resume** - `count 2` → crash → Retry → `count 0`.
  Recovering by _hiding_ the fallback would hand back a half-initialised panel.
- **Route mode offers reload only, never Retry** - a studio-wide crash is not something
  a re-render can clear, so a Retry button there would be a lie.
- **The chunk classifier matters in both directions** - a miss means the user is told to
  press Retry against a cached rejected promise (which can never resolve); a false
  positive means a plain render crash sends them to a full reload and loses unsaved work.
  All four patterns plus four near-misses are now covered, including the pair that only
  a truth table catches: `"Loading chunk 42 succeeded"` (chunk marker, no `failed`) and
  `"the render failed"` (`failed`, no chunk marker) must both stay on Retry.
- **`attachProcessorErrorGuard` is idempotent per node**, which only holds because the
  handler is a property assignment. If it ever becomes a listener list, every re-attach
  inflates a diagnostic count that is shown to the user. Now pinned.

`tests/fault-containment.test.tsx` went from **7 to 22 tests**.

### Falsification

Every guard was run against a deliberately broken build. None of these are "the test
passed" claims.

| Broken state                  | How                                | Result                                                                      |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| Panel-swap reset removed      | `componentDidUpdate` early-returns | **2 failed** (panel swap, `resetKey`)                                       |
| `handleRetry` is a no-op      | `if (true) return;`                | **3 failed** (RECOVERS, REMOUNTS, re-containment)                           |
| Classifier matches everything | `if (error) return true;`          | **7 failed** (all 4 negatives + the pre-existing "no Reload app" assertion) |

### Gates for this wave

| Gate                                                                                            | Result                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fault-containment.test.tsx`                                                              | **22 passed**                                                                                                                                                                                |
| `tests/ui/ErrorBoundary.test.tsx` + `tests/ui/App.test.tsx` + `tests/layout-responsive.test.ts` | **49 passed** across 4 files, no render loop from the new `setState`                                                                                                                         |
| `npx tsc --noEmit`                                                                              | **0 errors** - the red on `tests/e2e/14-recording-soak.spec.ts:395` recorded in wave 14 was fixed by the recording session in the meantime; the gate is green again without any edit from me |
| `prettier --check` on both owned files                                                          | unchanged                                                                                                                                                                                    |
| Sibling sweep                                                                                   | 21 boundary usages; only the dock-slot shape is affected                                                                                                                                     |

### What this wave does not close

`tests/ui/ErrorBoundary.test.tsx` still has 8 render-state-only tests that never click
Retry. They overlap the new coverage and are now the weaker half of the pair - worth
consolidating, but that is cleanup, not a defect. The dev-server-only e2e specs, the
boot watchdog and the take-lane remain open from earlier waves.

---

## Wave 16 - 2026-10-12 - the boot path: a loader with no way out, and a click that answered nothing

Owner ask: _"tak to dotiahni, a kľudne hľadaj ďalšie bugy, medzery, nedokonalosti."_

Both defects below are in the path between "the user decided something" and "the user
sees a result" - the part of the app that is easiest to leave silent, and the part that
matches the owner's stated trauma with empty screens.

### D17 - a stalled chunk left the boot screen up forever (P1, CONFIRMED + fixed)

`Boot` in `src/main.tsx` awaits `import("./services")` and `createCoreServices()` with no
timeout of its own.

**The first hypothesis was wrong, and checking it was the useful part.** "IndexedDB
blocked by another tab hangs the boot" is the classic version of this bug - and this
codebase already handles it. `persistence/db.ts:41-103` caps a blocked open at 5 s and
rejects with _"Database is locked by another KYX tab - close it and try again"_, and
`src/interop/qvesterHandoff.ts:205-226` documents the same convention for the interop
database. Reporting that as a defect would have been a false positive.

What is _not_ bounded is the **chunk request**. `fetch()` has no timeout of its own.

Measured in Chromium against the production build:

| Scenario                         | Result                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Healthy boot -> project browser  | **1596 ms**                                                                                           |
| `services` chunk never fulfilled | loader visible at **968 ms**, Reload button **never appeared** (spec failed after its full 30 s wait) |

A stalled or service-worker-starved chunk therefore left the user on _"KYX - forging
audio engine"_ with no error, no explanation and nothing to click - for as long as the
network wanted.

The fix is a **warning, deliberately not an abort** (`BOOT_WARN_MS = 15_000`, ~9x the
measured healthy boot):

```tsx
const [bootStalled, setBootStalled] = useState(false);
useEffect(() => {
  const timer = setTimeout(() => setBootStalled(true), BOOT_WARN_MS);
  return () => clearTimeout(timer);
}, []);
```

It renders `BootStalledScreen` only while `screen.kind === "booting"`, so a boot that
settles late takes the screen over by itself and the warning disappears. The screen
reuses the existing `.crash-screen` / `.crash-list` / `.crash-reload` classes, so there
is no new CSS, and it names the three real causes rather than shrugging.

Measured after the fix:

| Scenario                           | Result                                                               |
| ---------------------------------- | -------------------------------------------------------------------- |
| Stalled chunk                      | watchdog fired at **16 065 ms**, actionable screen                   |
| Healthy boot                       | **1976 ms**, untouched                                               |
| Chunk delayed 18 s, then delivered | warning shown, **boot still landed** in the browser, warning cleared |

The third row is the falsification of the _design_, not just of the code: a warning
surface is only safe if the boot is allowed to finish afterwards.

### D18 - opening a project gave no feedback, and left a double-open window (P2, CONFIRMED + fixed)

`ProjectBrowser` calls `onOpen`, and `openDoc` in `src/main.tsx` was fire-and-forget:

```js
void import("./services")
  .then(({ openProject }) => openProject(core, doc))
  .then((services) => setScreen({ kind: "studio", services }), ...)
```

`ProjectBrowser.openById` releases its `busy` guard in a `finally` right after `enterStudio`
returns - but `enterStudio` returns as soon as `openDoc` dispatches, not when the studio
is up. So the **entire studio build ran behind a fully interactive project browser**, and
any second click in that window started a **second** `openProject`. The loser was never
`closeProject()`-ed: no final save, `AudioContext` still open next to the winner's.

`openProject` only awaits something lazily when `?collab=` is present (the yjs runtime is
~300 KB and deliberately kept out of the boot path), which makes it the honest way to
measure a large window.

Measured, with the collab chunk delayed by 6 s:

| State                         | Time for `.project-browser` to leave the screen              |
| ----------------------------- | ------------------------------------------------------------ |
| Fire-and-forget (before)      | **still present after 2 s** - sits there for the whole build |
| `{ kind: "opening" }` (after) | **194 ms**                                                   |

The fix is one line - claim the transition synchronously:

```tsx
const openDoc = useCallback((core, doc) => {
  setScreen({ kind: "opening" });
  void import("./services")...
```

Because React flushes a discrete click synchronously, this also removes the double-open
window by unmounting the browser in the same commit. The new state holds no services, so
nothing can be closed on the way out of it.

### Falsification

| Broken state       | How                                | Result                                                |
| ------------------ | ---------------------------------- | ----------------------------------------------------- |
| No watchdog        | pre-fix build                      | **failed** - Reload button absent after 30 s          |
| No `opening` state | `setScreen` commented out, rebuilt | **failed** - `.project-browser` count 1 vs expected 0 |

### Gates for this wave

| Gate                                         | Result                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| `tests/e2e/22-boot-watchdog.spec.ts`         | **3 passed** (stall / healthy / slow-but-successful)    |
| `tests/e2e/23-project-open-feedback.spec.ts` | **2 passed** (feedback + failed-open surfaces an error) |
| `npx tsc --noEmit`                           | **0 errors**                                            |
| `prettier --check`                           | clean on all three files                                |

### Cost, stated plainly

The watchdog adds one `setTimeout` to the boot phase and nothing else; it cannot make a
slow boot fail because it does not abort anything. The cost is a screen change at 15 s
on a genuinely slow boot where previously the loader simply kept spinning - a user who
was waiting anyway now sees a button they do not need. Both states are safe; the new one
is recoverable, which is the point.

One honest caveat on D18: the double-open is a **latent** race rather than one I could
demonstrate a user reaching, because React's synchronous flush on a discrete click
usually unmounts the browser before a second click can land. The measured defect is the
missing feedback; closing the race is defence, not a fix for an observed loss.

### D19 - the crash banner called every ordinary exit a crash (P2, CONFIRMED + fixed)

The Project Browser shows a banner whenever the crash journal does not end on
`session-close`:

> "Previous session may have ended unexpectedly (crash or force-quit)."

But `session-close` is written in exactly one place - `closeProject`
(`src/services.ts:1169`) - which only runs when the user clicks **back-to-browser inside
the app**. Closing the tab, following a link or refreshing never writes it.

Measured, Chromium, production build: open a template, navigate away normally, reopen.
Last journal event = `session-open`, banner = visible, copy = _"Previous session may have
ended unexpectedly (crash or force-quit). No completed save was recorded."_

An entirely innocent session gets accused of a crash. A user who learns that this banner
cries wolf stops reading it - which costs us the one case where it would have mattered.

**The first fix I attempted was wrong, and measuring it is the useful part of this
entry.** I added a `session-exit` journal event written from a new `onUnload` hook, so
the app could distinguish a deliberate exit from a vanished tab. It never fired - the
journal still ended on `session-open`. Rather than assume, I instrumented both handlers
with a **synchronous `localStorage` write** alongside the IndexedDB one:

```
onUnload hook fired = 1791794444307
last recorded event after a normal session = session-open
```

The hook fires; the IndexedDB write dies with the document. An unload-time journal entry
is not writable, so the whole `session-exit` design was dead code and was removed.

That measurement became the actual fix's justification. Since the app **cannot** know
why a tab went away, it must not assert a cause. The copy now says only what is known:

> "The last session did not end through KYX's normal shutdown — you may have closed the
> tab or followed a link, or the app may have been interrupted."

The banner still appears (the journal genuinely cannot prove a clean shutdown, and the
module's contract is "may over-report, must never under-report" - hiding it would silence
genuine iOS terminations, which fire the same `pagehide`). What changed is that it stops
naming a cause. `CrashJournalReport` now carries that warning on the field itself, so the
next reader of `lastSessionClean: false` cannot repeat the mistake.

### D20 - the unload save flush does not save anything (P1, CONFIRMED + FIXED)

This is the most serious finding of the audit.

`installSaveUnloadGuards` exists for one reason. From its own header: _"the 'Continue last
project' pointer can drift away from the last-saved body if the user closes the tab while
a save is in flight or in the 800 ms debounce window."_ It answers **both**
`visibilitychange`→hidden (via `services.ts` `onVisibility`) and `pagehide` with
`flushSave()`.

Measured, Chromium, production build, reading the persisted project document back out of
IndexedDB rather than trusting the journal (the journal's own `save-ok` marker is _also_
an IndexedDB write, so a missing marker cannot distinguish "the save was lost" from "only
the marker was lost"):

| Scenario                           | Stored first step | Meaning                     |
| ---------------------------------- | ----------------- | --------------------------- |
| BASELINE - template untouched      | 0.95              | template ships this step on |
| CONTROL - click, then idle 3 s     | **0**             | toggle saved                |
| UNLOAD - click, then close the tab | **0.95**          | **the edit is gone**        |

And the guards are not being skipped - both events genuinely fire, proven with the
synchronous markers (`{"visibilityHidden":1791794912662,"pagehide":1791794912660}`).

**Neither IndexedDB transaction commits before teardown.** The user closes a tab and
their last edit silently disappears, with no error anywhere. The safety net provides a
false sense of protection.

What actually protects the user today is the autosave window alone
(`debounceMs: 800`, `maxDeferMs: 5000`), so the exposure is bounded at roughly **5
seconds of work**, not the whole session - but 5 seconds of unsaved work is exactly what
this guard was written to prevent.

**Owner's decision: the synchronous recovery buffer, not a shorter autosave window.**

`src/persistence/recoveryBuffer.ts` holds the uncommitted document in `localStorage`,
which is the one store whose writes provably survive unload - that is exactly what the
diagnostic above measured. The module is synchronous end to end; an async write is the
very thing that does not survive.

- **Written** from a new synchronous `onUnload` hook in `installSaveUnloadGuards`, which
  runs _before_ `flushSave` in the pagehide handler.
- **Cleared** the moment a save commits (`doSave` success), and when the user recovers or
  discards - so a stale buffer can never shadow newer work.
- **Offered** by the Project Browser only while `isBufferWorthOffering` holds, i.e. only
  when the buffer is NEWER than the saved project's `updatedAt`. Recovering is a real
  `repo.save` followed by opening the studio, not a one-shot view, so a second crash
  keeps the work.
- **Degrades silently** to exactly today's behaviour when `localStorage` is unavailable,
  over quota (a project larger than localStorage will take), or the document is not
  JSON-serialisable. The unload path can never throw because of it.

**One predicate bug, caught by measurement rather than by reading.** The first version
gated the write on `saveStatus` being `dirty` or `error`. Instrumenting the handler showed
what the status actually is at pagehide:

```
{"status":"saving","wrote":false,...}
```

`saving` - the debounce had already started a write, and that write is the one that dies
with the document. So the first version wrote **nothing** in precisely the case that loses
work. The rule is "protect unless nothing is uncommitted" (`saveStatus !== "saved"`), not a
whitelist of the states that look dirty.

Verified after the fix, same Chromium / production-build harness:

```
buffer present = true, length = 9969
stored step before recovery = 0.95     <- still lost from IndexedDB, as expected
[Recover] clicked
stored step after recovery = 0         <- the edit is back
```

The raw save still does not happen - that is the browser, not us - but the work is no
longer lost, which is what the decision was for.

`tests/recovery-buffer.test.ts` (10) covers round-trip, corrupt and structurally-wrong
leftovers, quota exhaustion, non-serialisable documents, and the `isBufferWorthOffering`
rule that stops Recover from downgrading current work.
`tests/e2e/25-unload-save-flush.spec.ts` (3) pins the BASELINE / CONTROL fixture and the
full recover-after-close flow.

**Cost, stated plainly.** The whole document is serialised synchronously on unload while
uncommitted. Measured for the House template: **9.9 KB**, so the common case is trivial. A
very large project could approach the `localStorage` quota, in which case the write fails
closed and the app behaves exactly as it does today. The autosave window is unchanged, so
write frequency is unchanged - the ~4x IndexedDB amplification the shorter window would
have cost was not paid.

### A test of mine that passed on the broken state

The first version of the D20 assertion was `expect(step).toBeGreaterThan(0)`. It **passed**
against the defect - the click toggles the step _off_ (0.95 → 0), so the untouched
template's 0.95 satisfies `> 0`. Had I not added the BASELINE run, this wave would have
reported "verified" on a test that could not fail. The assertion now compares against the
baseline value, and the BASELINE test fails loudly if the template's first step ever moves
so the recover test cannot quietly become meaningless.

## Wave 17 - 2026-10-12 - wow & flutter: the depth control was 500x too weak, and my instrument was louder than the signal

### The order of events, because it matters

Daniel asked for the wow & flutter effect. It was built, wired, typechecked and given an e2e
measurement spec. That spec was **red on arrival**:

```
[wow] depth=0 peak deviation = 231.85 cents over 48 windows     -> expected < 2, FAILED
[wow] depth=30 peak = 0.6 cents, mean = -0.02                   -> expected > 15, FAILED
[wow] requested 1 Hz -> measured 1.91 Hz over 131 windows       -> expected < 1.8, FAILED
3 failed, 1 passed
```

Three different magnitudes in one run. That is a measurement talking, not a defect talking,
so I built an instrument before touching the DSP.

### Instrument 1: windowed zero crossings (the original). Rejected, with numbers.

A 60 ms window at 440 Hz holds ~26 crossings, so frequency quantises in ~4% steps - about
66 cents. "The effect does a little" and "the effect does nothing" are the same reading, and a
small noisy envelope reads as a fast sign-flipping series, which is exactly how a requested
1 Hz wobble produced 1.91 Hz. It cannot answer the question the knob makes.

### Instrument 2: quadrature demodulation. Rejected, and this one was subtler.

Demodulate at the probe tone, unwrap `arg z`, differentiate: `f_inst = f0 + (1/2pi) d/dt arg z`.
Much finer resolution. Calibrated on a **pure 440 Hz sine through nothing at all**, it reported:

```
CALIBRATION (no effect)   peak = 13.80 cents   rms = 9.73 cents   sign changes at 879.89 Hz
```

880 Hz is 2*f0. The instrument was reporting the counter-rotating term of the analytic signal
beating against the demodulation window - the DC term is exactly `-j*A/4` and whatever of the
2*f0 component leaks rotates at 2*f0. The instrument's noise floor was ~14 cents while the
signal under test was 0.02 cents. **An instrument with a noise floor above the signal cannot
measure the signal.**

### Instrument 3: measure the delay. Accepted.

The effect modulates a delay, so measure the delay - the thing it actually claims to control.
Feed isolated impulses and recover each one's delay by **amplitude centroid**. The read is a
linear interpolation between two ring samples, so an impulse of amplitude 1 at fractional
position `f` lands as exactly `[1-f, f]`: the two samples sum to 1, which is what makes the
centroid exact rather than a fit. Then pitch follows analytically from the read position
`r(t) = t - D(t)`:

```
frequency ratio = dr/dt = 1 - dD/dt        (dD/dt is DIMENSIONLESS)
```

No window length to defend, no filter, no unwrap. Calibration on the pass-through reads
**0.000 cents**, which is what makes the other rows mean anything.

Three bugs lived in this instrument before it was right, and all three were mine:

1. **Sign.** A delay line _delays_: an impulse written at 2205 was observed at 2813.075, so
   `D = write + delay`. The first version searched backwards and measured a whole multiple of
   the impulse spacing (~60 ms for a 0 ms bypass).
2. **Fractional loop bounds.** `for (i = w + prevD - SEARCH; ...)` starts at a non-integer, so
   every array read was `undefined` and the whole train was unfindable while the integer-bounded
   lead impulse still worked.
3. **Dimension.** I divided `dD/dt` in samples-per-second by the delay in samples, which has
   units 1/s, and called it a frequency ratio. The textbook `dD/dt / D` is the **granular
   resampling** law - correct when `D` counts samples consumed per output sample, wrong for a
   continuously modulated delay line. It reported 1.45 cents where the time-domain answer is
   0.02.

### D21 - the depth control delivered 0.02 cents for a requested 10 (P1, CONFIRMED + fixed)

With the instrument calibrated, the table was unambiguous:

| case               | requested | measured, before           |
| ------------------ | --------- | -------------------------- |
| depth 0 / drift 0  | 0 c       | 0.00 c (but D = 13.789 ms) |
| depth 10 @ 0.5 Hz  | 10 c      | **0.02 c**                 |
| depth 30 @ 0.5 Hz  | 30 c      | **0.06 c**                 |
| depth 25 @ 1 Hz    | 25 c      | **0.05 c**                 |
| flutter 10 @ 11 Hz | 10 c      | **0.02 c**                 |
| drift = 1          | -         | **650 c**                  |

Two independent defects, and the factor fell out of the arithmetic:

1. `wfCentsToAmplitudeSeconds` multiplied by `baseDelaySeconds`. That is the resampling law
   again, one level down. It is worth exactly `1/baseDelay` = **250x** at a 4 ms base.
2. The read offset used `wobble * 0.5`, halving `dD/dt` and therefore halving the delivered
   deviation: **2x**.

250 x 2 = 500, which is the measured ratio. The model was not fitted after the fact - the
factor was predicted from the source and then confirmed.

A third defect came with it: `swing` unconditionally included `maxAmpSeconds * 0.35`, so the
drift term was 35% of the entire 56 ms ring. That swung the delay by **19.6 ms** and measured at
**650 cents** of pitch wander - the largest single bug in the effect, and invisible to a test
that only checked "is the drift audible".

### The fix, and what it costs

- The conversion is now `A = r / (2*pi*f)` with `r = 1 - 2^(-cents/1200)` - subtractive, because
  pitch goes _down_ as the delay grows. The two spellings differ by 3.4% at 60 cents, which is
  not noise at this scale.
- The offset centres as `base + swing/2 + wobble` with **no half on the wobble**, and the swing
  budget is `base - 1` samples. That is the exact condition under which the offset stays >= 1
  sample and the read provably never reaches the write pointer.
- Drift is expressed in cents like everything else (`DRIFT_MAX_CENTS = 6` at the walk's own
  3 Hz corner) instead of as a fraction of the ring.
- When the terms overflow the budget they are scaled down **proportionally**, so the balance
  between wow, flutter and drift survives the clamp instead of one term vanishing.
- `BASE_DELAY_SECONDS` moved 4 ms -> **10 ms**. This is the trade-off, stated plainly: the
  cents scale and the rate scale pull against each other, because delivering C cents at rate f
  needs a swing of `r / (2*pi*f)` seconds, and 0.05 Hz is where that is largest. At a 4 ms base
  the 60-cent end of the knob is unreachable below ~1.2 Hz; at 10 ms the full 60 cents is exact
  from 0.5 Hz up and `wfAchievableCents` reports the truth below that. **The price is 10 ms of
  insert latency** - ordinary for a musical time-based effect, but not free, and it is the
  number to argue with if someone wants a shorter base.

### After the fix - the same instrument, unchanged

| case               | requested | measured                           | deviation from design |
| ------------------ | --------- | ---------------------------------- | --------------------- |
| pass-through       | -         | 0.00 c                             | calibration           |
| depth 0 / drift 0  | 0 c       | **0.00 c**, D = 10.092 ms constant | exact                 |
| depth 0 / drift 1  | -         | 1.86 c                             | was 650 c             |
| depth 10 @ 0.5 Hz  | 10 c      | **9.86 c**                         | -1.4%                 |
| depth 30 @ 0.5 Hz  | 30 c      | **29.69 c**                        | -1.0%                 |
| depth 25 @ 1 Hz    | 25 c      | **25.01 c**                        | +0.04%                |
| flutter 10 @ 11 Hz | 10 c      | **9.95 c**                         | -0.5%                 |
| extreme corner     | -         | D = 16.0..24.9 ms, no wrap         |                       |

The measured **delay range** matches the closed-form prediction to the sample - depth 30 at
0.5 Hz measured 7.358..18.294 ms against a predicted 7.358..18.296 ms - which is a stronger
statement than the cents column, because it pins the mechanism and not just the consequence.

### One more instrument error, in the estimator this time

After the fix the table still showed ~1.9x too much deviation, which would have been the second
wrong "fix" of the day. It was not the DSP: **rms** sat exactly on `A/sqrt(2)` (depth 10 -> 6.97
vs 7.07 predicted) while **peak** over-read. Peak is a single-sample estimator over a lightly
sampled quasi-sine; one mis-assigned impulse spike doubles it. Depth is therefore judged on rms
and peak is kept only as a diagnostic.

### Three guards that were wrong before they were right

- "Each impulse sums to 1": reads `~f` or `~1-f` depending on which element of the interpolant
  pair is the peak.
- "Every nonzero run is exactly 2 samples": **fails for a legitimate reason** - at the worst
  corner the delay falls to ~220 samples, which _is_ the input spacing, so output impulses
  land adjacent and merge into 4-sample runs (measured: 20 merges out of 1529).
- "Total energy equals impulse count, to 0.01": the interpolant pair is `(1-f, f')` with
  `f' != f` because the offset moves between the two samples that share an impulse, so
  per-impulse energy varies by -0.7%..+1.4% and over 1529 impulses those differences random-walk
  with sigma ~= 0.78 units. Measured surplus: +0.99. The band is now 2%, and the invariants that
  are actually exact are the ones asserted: the delay never leaves the ring, and the tracker
  finds essentially every impulse.

### Falsification

Each defect reintroduced one at a time, against the 16 headless specs:

| mutation                                   | specs red |
| ------------------------------------------ | --------- |
| base-delay factor back into the conversion | **8**     |
| `wobble * 0.5` back into the offset        | **5**     |
| drift back to 35% of the ring              | **1**     |
| restored                                   | 0 (16/16) |

The drift mutation turning exactly one spec red - the regression that names it - is the useful
one: the other two are caught broadly, so their guard would survive a subtler variant.

### Gates for this wave

- `tests/wow-flutter.test.ts` - **16/16**. Runs the real processor source headlessly (module
  imported with the worklet globals stubbed, class captured from `registerProcessor`), so the
  defect is caught by `npm run test` rather than only in a browser.
- `tests/e2e/26-wow-flutter-measurement.spec.ts` - **7/7** in Chromium against the shipped
  bundle, same measurement method, with a calibration row that must read 0.00 cents.
- `scripts/probe-wow-flutter.mjs` - the standalone diagnostic that produced every table above.
- `npx tsc --noEmit` clean; prettier clean.

### What this wave does not close

- The effect adds **10 ms** of latency. The engine's latency calibration path knows about
  reported latency, but I have not verified that a 10 ms wow on a busy graph reads correctly in
  the reported total.
- `wfAchievableCents` is implemented and unit-tested, but **nothing in the UI calls it** - the
  panel still displays the requested cents, so below 0.5 Hz the readout can overstate what the
  buffer can deliver. The knob is honest; the number next to it is not yet.
- The `peak` vs `rms` distinction is now recorded in the probe and the specs, but any future
  measurement of a modulated delay should prefer rms for the same reason.

---

## Final sweep re-run, and a correction to the build gate

2026-10-13, after the working tree moved on. Two things changed since the
"Final state" section above, and one of them contradicts a gate recorded there.

### 1. The six browser specs, re-run against a fresh production build

```
npm run build                                     # tsc green, vite built in 19.64s
npx vite preview --host 127.0.0.1 --port 4181 --strictPort
npx playwright test 18-editor-chaos-chain keyboard-guards snap-grid \
  ripple-semantics hit-test-sweep audio-fades --project=chromium --workers=2

9 passed (55.0s)
```

Nine tests, two workers, same configuration as the 50.3s run recorded above -
so the result is reproducible rather than a single lucky pass. The falsification
control inside `hit-test-sweep.spec.ts` also fired as designed
(`1/1 clips blocked` once a cover is injected), which is the only proof that the
sweep can still see a defect.

Port 4180 was already occupied by a preview server from an earlier wave, so this
run used 4181. Worth writing down: a sweep that silently reuses whatever server
happens to hold the port is not a repeatable measurement.

### 2. `npm run build` now exits 1, and it is not this audit

Earlier in this report the bundle gate reads `EXIT 0`. That is no longer true,
and the honest thing is to say so rather than let the old line stand:

```
[size-budget] entry: 307 KB (budget 1070)
[size-budget] DAW JS chunks: 5271 KB (budget 5186)          FAIL
[size-budget] core worklets: 153 KB (budget 150)            FAIL
[size-budget] shipped JS total: 7369 KB
[size-budget] studio boot path: 2144 KB (budget 2200)
```

The typecheck stage now passes, so the failure has moved: it used to die in
`tsc`, it dies in the size gate. Two budgets are over - DAW JS by 85 KB and core
worklets by 3 KB.

### Attribution, and a method that was wrong on the first attempt

My first move was `git diff --name-only 3d7021c9~1 27f60b9c -- src/ public/`,
which returned **100 product files** - a list containing rezonans, skrutka,
portal, spectral, vocal and the whole intent tree. On a shared worktree that
range spans every commit that landed between the two points, including other
sessions' work. It would have handed me a confident, completely false story
about what I had changed.

Per-commit is the only sound attribution here:

| Commit                           | Message                                    | Files  |
| -------------------------------- | ------------------------------------------ | ------ |
| `3d7021c9`                       | fix(editor): the intensity strip (D14)     | 6      |
| `416509ef`                       | fix(editor): the onboarding hint bar (D15) | 5      |
| `abf80de1` `2c2329fc` `c5d9aae0` | ripple / keyboard / snap specs             | 2 each |
| `4e55295b`                       | wave 13 ratchet record                     | 1      |
| `00eed032`                       | the hit-test sweep                         | 4      |
| `0c7a76a0` `69829b07`            | `_studio` migration, fades                 | 5, 2   |
| `27f60b9c`                       | final state                                | 1      |
| **`62bb634c`**                   | **`jeje`**                                 | **86** |
| **`4fa075cc`**                   | **`dobre tda`**                            | **32** |

The last two are not mine. They are the fx / rezonans / skrutka / spectral /
wow&flutter / intent work, committed under the same repository author, and they
carry the code that pushed both budgets over. The union of my own commits
touches **three product files** - `src/ui/ArrangementPanel.tsx`,
`src/styles/04-arrangement.css`, `src/styles/07-project-browser.css` - and not
one of them is in a bundle the size gate measures. A 4px margin and a
click-through rule do not add 85 KB of JavaScript.

So: **not fixed here, not mine to fix.** Raising either budget needs the measured
justification `scripts/check-bundle-size.mjs` asks for, and that justification
belongs to whoever wrote the code that grew.

### The number I flagged earlier is now the number that broke

This audit recorded "core worklets 149/150 KB" as an open item - one kilobyte of
headroom, noted and left alone. It is now 153/150. That entry was not a nitpick
to shrug at; it was a boundary with one kilobyte in front of it, and concurrent
work walked straight through. The boot-path line is the one that still has room
(2144 of 2200), which is consistent with `AGENTS.md`: the total is not the
responsiveness number.

### What this wave changes about the audit's own claims

Nothing about the defects. D14 and D15 are still fixed, still falsified, and
still covered by the nine tests above. What changes is one gate line and the
standing of the "149/150 KB" note: the audit's build gate is no longer green,
and the reason is recorded here rather than quietly dropped.

---

# Wave 18 - 2026-10-13 - the deliverables the previous 17 waves never produced

Every wave so far was **defect-led**: read a surface, find something broken, fix it,
falsify the fix. That produces excellent evidence for the defects it found and **no
answer at all** to four things the objective asks for by name:

- **deliverable 1** - a complete edit-tool inventory, _including the DAW-specific
  tools_;
- **deliverable 2** - a functional matrix with an explicit status per operation;
- **deliverable 6** - undo/redo, save/reload, autosave **and MCP parity** findings;
- **deliverable 7** - a prioritized backlog of unsupported / partially implemented
  tools.

Waves 1-17 also never opened the **third door**. D8 argued that "every entry point in
the product shares `assertClipEditable` - which is exactly why it is worth asking which
callers actually call it", then audited the UI and the command layer. MCP is the
remaining caller. This wave opens it, and starts with the inventory, because a parity
claim needs a list of both sides.

## §A - The edit-tool inventory

Built from the **command layer outward**, not from the UI: a verb that exists as a
`ProjectDocument -> Command` factory is a real tool; anything reachable only through a
widget is UI. Sources: `src/commands/{arrangement,audioClips,clipEditing,clipPlayback,
clipClipboard}.ts`, `src/ui/shortcuts.ts`, `src/ui/ArrangementPanel.tsx`,
`src/mcp/tools.ts`.

### A1 - Scene clips (arrangement lane)

| #   | Tool                  | Entry point                  | Command                                             | Undo   | Status                                           |
| --- | --------------------- | ---------------------------- | --------------------------------------------------- | ------ | ------------------------------------------------ |
| 1   | Move                  | drag, marquee, nudge `,`/`.` | `moveArrangementClip` / `moveArrangementClipRipple` | 1 step | VERIFIED (D5, D11, wave 10/11)                   |
| 2   | Multi-move (block)    | ctrl-select then drag        | inline, hand-built doc                              | 1 step | VERIFIED (chaos chain §14; D8 guard)             |
| 3   | Resize (right edge)   | `.arr-clip-resize`           | `resizeArrangementClip` / `...Ripple`               | 1 step | VERIFIED (§6)                                    |
| 4   | Trim start            | left edge drag               | `trimArrangementClipStart`                          | 1 step | PARTIAL - command covered, no browser spec       |
| 5   | Split                 | CUT tool (`C`), toolbar      | `splitArrangementClipAtTick`                        | 1 step | VERIFIED (§7)                                    |
| 6   | Duplicate             | toolbar `DUP`                | `duplicateArrangementClip`                          | 1 step | VERIFIED (§8)                                    |
| 7   | Delete                | `DEL`, context menu          | `deleteArrangementClip` / `...Ripple`               | 1 step | VERIFIED (§4/§9, §16)                            |
| 8   | Copy / Cut / Paste    | `Ctrl+C/X/V`                 | `cutClips` / `pasteClips`                           | 1 step | VERIFIED (D9, 11 specs)                          |
| 9   | Lock / unlock         | `Shift+L`                    | `assertClipEditable` gate                           | n/a    | VERIFIED (D8)                                    |
| 10  | Group / ungroup       | `Ctrl+G` / `Ctrl+Shift+G`    | `clipGroups.ts`                                     | 1 step | NOT TESTED - no audit evidence                   |
| 11  | Loop                  | per-clip toggle (`:4142`)    | `setArrangementClipLoop`                            | 1 step | NOT TESTED                                       |
| 12  | Reassign scene        | -                            | `setArrangementClipScene`                           | 1 step | NOT TESTED                                       |
| 13  | Scene intensity curve | `.arr-intensity-point`       | `setSceneIntensityCurve`                            | 1 step | NOT TESTED - cancel path is epoch-only (D3 note) |
| 14  | Create variation      | -                            | `createVariationAndPlaceClip`                       | 1 step | NOT TESTED                                       |

### A2 - Audio clips (track lanes)

| #   | Tool                 | Entry point                   | Command                                                        | Undo   | Status                                                        |
| --- | -------------------- | ----------------------------- | -------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| 15  | Move                 | drag, `audioMove`             | `moveAudioClip`                                                | 1 step | VERIFIED (D11, §9, D8 guard)                                  |
| 16  | Multi-move (block)   | ctrl-select drag              | inline                                                         | 1 step | VERIFIED (D8)                                                 |
| 17  | Resize / trim        | `.arr-clip-resize`, left edge | `resizeAudioClip`, `trimAudioClipStart`                        | 1 step | VERIFIED (D4 stale-offset fix, §6)                            |
| 18  | Split                | CUT, `audioSplit`             | `splitAudioClipAtTick`                                         | 1 step | VERIFIED (§7, wave 18 parity)                                 |
| 19  | Duplicate            | toolbar / context menu        | `duplicateAudioClip`                                           | 1 step | NOT TESTED                                                    |
| 20  | Delete               | `DEL`, `audioDelete`          | `deleteAudioClip`                                              | 1 step | VERIFIED (§4/§9)                                              |
| 21  | Fade in / out        | fade handles                  | `updateAudioClip`                                              | 1 step | VERIFIED (wave 15b, real browser)                             |
| 22  | Crossfade            | `X`                           | `crossfadeAudioClips`                                          | 1 step | NOT TESTED - bypasses the lock by design (wave 2)             |
| 23  | Gain                 | clip gain field               | `updateAudioClip`                                              | 1 step | VERIFIED (wave 15b title reads gain)                          |
| 24  | Slip                 | drag with slip modifier       | `slipAudioClip`                                                | 1 step | NOT TESTED                                                    |
| 25  | Stretch (tempo fit)  | warp UI                       | `stretchAudioClip`, `fitAudioClipTempo`                        | 1 step | NOT TESTED (D8 added its guard)                               |
| 26  | Reverse / loop       | toggles                       | `updateAudioClip`                                              | 1 step | VERIFIED (parity, wave 18)                                    |
| 27  | Clip mute            | `M`                           | `toggleAudioClipsMute`                                         | 1 step | NOT TESTED                                                    |
| 28  | Consolidate          | toolbar                       | `consolidateAudioClips`                                        | 1 step | NOT TESTED (D8 added its guard)                               |
| 29  | Strip silence        | toolbar                       | `stripSilenceAudioClip`                                        | 1 step | NOT TESTED (D8 guard)                                         |
| 30  | Slice to arrangement | toolbar                       | `sliceAudioClipToArrangement`                                  | 1 step | NOT TESTED (D1 fade clamp, D8 guard)                          |
| 31  | Bounce stems -> clip | `BOUNCE ZONE`                 | `bounceStemsToAudioClip`                                       | 1 step | VERIFIED (wave 15b - the path that produced the fade fixture) |
| 32  | Take lanes / comping | take lane drag                | `addAudioTakeClip`, `compAudioTakeRange`, `setActiveAudioTake` | 1 step | PARTIAL - jsdom characterization only (wave 1 #10)            |

### A3 - Global editing tools

| #   | Tool                        | Entry point            | Status                                                        |
| --- | --------------------------- | ---------------------- | ------------------------------------------------------------- |
| 33  | Snap grid toggle            | `J` + toolbar          | VERIFIED whole-bar (wave 13); **grid-OFF/Shift unexplained**  |
| 34  | Zoom (horizontal)           | `Ctrl`+wheel           | VERIFIED (D5, D11)                                            |
| 35  | Vertical scroll             | scroll container       | VERIFIED (wave 10 §13)                                        |
| 36  | Marquee / time-range select | lane drag, ruler drag  | VERIFIED (D3, wave 15b)                                       |
| 37  | Playhead / seek             | ruler, `Home`, `,`/`.` | VERIFIED                                                      |
| 38  | Undo / redo                 | `Ctrl+Z` / `Ctrl+Y`    | VERIFIED (155-test baseline, wave 18 harness fix)             |
| 39  | Select all / deselect       | ctrl+A / `Escape`      | PARTIAL - deselect in the D3 cascade; select-all not isolated |
| 40  | Nudge                       | `,` / `.`              | VERIFIED in-command; not browser-tested                       |
| 41  | Save / reload / autosave    | autosave debouncer     | VERIFIED (D20 - the unload recovery buffer)                   |
| 42  | Viewport windowing          | automatic              | VERIFIED (D7, measured 800->10 nodes)                         |

**What is deliberately absent from this inventory**: no MIDI note edit, piano-roll
gesture, automation-lane point edit, mixer-strip edit or sample-editor tool appears,
because those surfaces were not audited in any wave. `kyx_notes` / `kyx_steps` /
`kyx_automation` exist on the MCP side and are covered by the repo's own MCP suites,
but this audit produced **no** evidence about their UI equivalents. Listing them as
VERIFIED because a handler exists is exactly the conflation the objective forbids.

---

## §B - MCP parity (deliverable 6)

### B1 - The parity table, measured

Every cell below was **executed**, not read. "Equivalent command" is the exact factory
the UI gesture commits on `pointerup`; both routes ran on **one shared document**. (An
early version of this test built two fixtures, which minted different uids, so it
compared two different clips and reported a difference. That is a fixture measuring its
own randomness - recorded here because it nearly read as a product defect.)

| MCP op                                      | Equivalent command     | Result                                                               |
| ------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `kyx_clips move`                            | `moveArrangementClip`  | **PARITY** - identical geometry, compared by id                      |
| `kyx_clips resize` / `duplicate` / `delete` | same-named commands    | same factories, same shared guards                                   |
| `kyx_clips audioMove`                       | `moveAudioClip`        | **PARITY**, and both refuse a locked clip                            |
| `kyx_clips audioSplit`                      | `splitAudioClipAtTick` | **PARITY** - fragment lengths, offsets and inherited fades identical |
| `kyx_clips audioUpdate`                     | `updateAudioClip`      | **PARITY** - including the D1 fade clamp                             |
| `kyx_clips audioDelete`                     | `deleteAudioClip`      | **PARITY** - lock honoured, D4 gate honoured                         |
| any of the above -> `undo()`                | `ProjectStore.undo`    | **PARITY after the fix in §C**                                       |

So: **the MCP door inherits every contract this audit fixed.** The D1 fade clamp, the D8
lock, the D4 destructive gate and the delta-based undo all reach an agent, because MCP
dispatches through the same command factories. That is a real, non-obvious result - it
was true, and until this wave nothing in the repository asserted it.

### B2 - Where MCP is genuinely behind the UI (backlog, not defects)

| Command verb                                                                       | UI                  | MCP | Note                                |
| ---------------------------------------------------------------------------------- | ------------------- | --- | ----------------------------------- |
| `splitArrangementClipAtTick`                                                       | CUT                 | -   | MCP splits **audio** clips only     |
| ripple move/resize/delete                                                          | `RIPPLE` toggle     | -   | MCP always uses the non-ripple verb |
| `cutClips` / `pasteClips`                                                          | `Ctrl+C/X/V`        | -   | no clipboard op                     |
| group / ungroup / lock                                                             | `Ctrl+G`, `Shift+L` | -   | no op                               |
| slip / stretch / consolidate / strip silence / slice / crossfade / duplicate-audio | toolbar + shortcuts | -   | ~9 verbs absent                     |
| `nudgeClips`                                                                       | `,` / `.`           | -   | no op                               |

**A deliberate scope statement, not an oversight**: the objective says "flag missing
parity without inventing unsupported endpoints". These are recorded as backlog. Nothing
in this wave adds an MCP op.

---

## §C - D22: the MCP test harness could not observe an undo (P2, CONFIRMED + fixed)

This is a finding **about the audit's own evidence**, and it is the reason the parity
table above needed a rebuild before it could be trusted.

### Root cause

`snapshot()` builds an inverse-patch command over a document delta
(`src/commands/core.ts`):

```ts
undo: (d) => applyDocDelta(d, backward.ops),
```

It does not care what `d` **is** - it applies "restore these rows / remove these rows"
to whatever document it is handed. `ProjectStore.undo` therefore passes `this.doc_`,
the **current** document:

```ts
undone = command.undo(this.doc_);
```

Three MCP test harnesses passed the **previous** document instead:

```ts
const prev = current;
current = command.execute(current);
undoStack.push({ undo: () => command.undo(prev), ... });   // wrong document
```

### Measured consequence

A split's undo did not remove the two fragments. It re-applied "restore the parent" on
top of the document that never left that state:

```
[probe] before    : ["audio-clip-1@0+4"]
[probe] after     : ["audioClip-b9d0...@0+2","audioClip-ef5f...@2+2"]
[probe] undone    : ["audio-clip-1@0+4"]              <- correct, real store
[probe] undo(prev): ["audio-clip-1@0+4","audio-clip-1@0+4"]   <- harness shape
```

Two entries, **one id** - a document `normalizeProject` does not prune, so it would
have persisted.

`tests/mcp-preset-bank-warm.test.ts` had the same capture bug **plus** a second one:
`undo: () => { undoStack.pop()?.undo(); }` **discards the return value**, so its `undo()`
could not change the document at all.

### Attribution, and why this is not a product defect

The first instinct is "MCP undo is broken". Measurement killed that: the probe ran the
identical command through the real `ProjectStore` and got the correct single-clip restore.
**The product was correct the whole time.** The defect was in three test files, so the
exposure is _evidence_, not user data - any MCP test asserting undo through those
harnesses was asserting a fiction, and none does today (all 133 pass after the fix).

### Fix

All three harnesses now mirror `ProjectStore`: both terminals are called with the
document **current at call time**, and the preset-bank harness assigns undo's result
back. Changed: `tests/mcp-tools.test.ts`, `tests/mcp-idempotency.test.ts`,
`tests/mcp-preset-bank-warm.test.ts`.

### Regression coverage

`tests/mcp-undo-harness-fidelity.test.ts` - 4 specs, written so the _broken_ shape is
pinned too:

- **CONTROL** - the product undo is correct through the real `ProjectStore`;
- the corrected harness observes a real undo;
- **FALSIFICATION** - the committed harness shape demonstrably produces the duplicate id
  (asserted _on purpose_, so the claim stays re-derivable);
- undo -> redo round-trips, and the two fragments carry **distinct** ids.

---

## §D - Prioritized backlog (deliverable 7)

Ordered by user-visible blast radius / effort. **Nothing here was implemented** - the
objective is explicit that a missing optional feature gets recommended, not silently
built.

### P1 - correctness / data integrity

| #   | Item                                                                                                                        | Impact                                                                                                                                 | Effort                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **Take-lane click suppression is a timing bet** (wave 1 #10) - a bare boolean + `setTimeout(0)`, no pointer/target identity | A comp-range drag can be swallowed by the following click, discarding the range the user just drew                                     | S - needs the identity token, then a Playwright repro to confirm |
| 2   | **`crossfadeAudioClips` writes fades on a locked clip**                                                                     | The lock contract names move/resize/trim/split/slip/stretch/delete; fades are deliberately outside it. **Product decision, not a bug** | S - one `assertClipEditable` if the answer is "yes"              |
| 3   | **Toolbar `DUP`/`DEL` act on the active clip; keyboard acts on the whole selection** (wave 10)                              | With a 2-clip selection the toolbar removes one. Both self-consistent - it is a convention                                             | S - align them or label them                                     |
| 4   | **Waveform canvas does not re-render on resize** (wave 2)                                                                   | Drawn window stays correct, resolution goes soft                                                                                       | S - DPR-aware redraw on **zoom only**, never per resize frame    |
| 5   | **`wfAchievableCents` exists but nothing in the UI calls it** (wave 17)                                                     | Below 0.5 Hz the wow&flutter readout overstates what the buffer can deliver                                                            | XS                                                               |

### P2 - missing capability (MCP parity, §B2)

| #   | Item                                                                                                        | Impact                                                                                               | Effort |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| 6   | No `splitArrangementClipAtTick` on MCP                                                                      | An agent cannot split a scene clip - the one verb wave 1 verified as deliberately unsnapped          | S      |
| 7   | No ripple variants on MCP                                                                                   | An agent's delete never closes the gap the UI's `RIPPLE` toggle produces. Silent semantic divergence | M      |
| 8   | No clipboard ops on MCP                                                                                     | No copy/cut/paste for an agent                                                                       | M      |
| 9   | ~9 audio verbs absent (slip, stretch, consolidate, strip silence, slice, crossfade, duplicate, mute, nudge) | See §B2                                                                                              | M      |

### P3 - hardening / unverified

| #   | Item                                                                                                                                               | Impact                                                                                                           | Effort                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 10  | **Grid-OFF and Shift-suspend measured indistinguishable from grid-ON** (wave 13)                                                                   | If real, snap cannot be turned off for scene clips. Unexplained, unproven, **not called a defect**               | M - needs a marker-free fixture |
| 11  | Ten inline px->beat conversions with three rounding policies in `ArrangementPanel.tsx`                                                             | Agree today; a snap-threshold fix in one place would diverge silently from the rest                              | L - architectural, human review |
| 12  | Mid-drag horizontal scroll                                                                                                                         | The lane's rect moves, so conversion follows; whether a drag should _freeze_ its scroll origin is a product call | S once decided                  |
| 13  | Untested tools from §A (groups, loop, scene reassign, slip, stretch, consolidate, strip, slice, crossfade, clip mute, duplicate-audio, take lanes) | 13 of 42 inventory rows have **no** audit evidence                                                               | M - one spec each               |

### P4 - architecture / owner decisions

| #   | Item                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | Boot watchdog landed in wave 16; what remains is the §20 surface shown when the app genuinely cannot start                              |
| 15  | Six e2e specs import `/src/*.ts` from inside the page (67 call sites) and therefore **have never validated a production build**         |
| 16  | The in-app Browser control channel timed out at its 275 s ceiling repeatedly (waves 6-10); Playwright is the working driver on this box |

---

## §E - Manual GUI + listening checklist (deliverable 5)

Everything below is **NOT VERIFIED** and cannot be settled by jsdom or by a headless
assertion. Each line names the gesture and the observable.

| #   | Check                                             | How                                                        | What "pass" means                                                    |
| --- | ------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Take-lane comp drag then click (item 1)           | Record a take, drag a comp range, release, click inside it | The range survives; `setActiveAudioTake` does not overwrite it       |
| 2   | Crossfade on a locked clip (item 2)               | Lock two clips, press `X` over them                        | Decide the contract, then confirm the behaviour matches it           |
| 3   | Toolbar vs keyboard on a multi-selection (item 3) | Select 2 clips, press toolbar `DEL`; undo; press `Delete`  | Both understood by the user, or they agree                           |
| 4   | Fade handles at extreme zoom                      | Bounce a zone, zoom to 8x, drag a fade to each clip edge   | No handle escapes the clip box; no 1-px dead zone                    |
| 5   | **Listening**: fade + crossfade shapes            | Bounce a zone, set fadeIn 0.5 s, fadeOut 2 s               | No click at either edge; crossfade smooth, not a dip                 |
| 6   | **Listening**: ripple tail spacing                | Build a gapped arrangement, ripple-delete the first clip   | The gaps are audibly preserved, not collapsed                        |
| 7   | **Listening**: wow & flutter below 0.5 Hz         | Sweep the rate under 0.5 Hz                                | The readout does not promise more than the buffer delivers (item 5)  |
| 8   | **Listening**: split during playback              | Play, split a clip under the playhead                      | No orphaned voice; the engine restarts the frozen source             |
| 9   | Grid OFF / Shift-suspend (item 10)                | Marker-free fixture, drag far from every edge              | The clip lands where the pointer is, un-snapped                      |
| 10  | Unload recovery                                   | Edit, close the tab within 800 ms, reopen                  | `Recover` restores the edit; no duplicate offer after a clean save   |
| 11  | Long-session soak                                 | 30 min of edit + play                                      | No heap growth; no listener accumulation (wave 5 measured 10 cycles) |
| 12  | Mobile / narrow viewport editing                  | 390x844, touch a clip                                      | Hit targets >= 44 px; no overlay eats a press (the D14/D15 class)    |

---

## Wave 18 gates - what actually ran

| gate                                                                                 | result                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/mcp-edit-parity.test.ts` (new, 12 specs)                                      | **12 passed**                                                                                                                                        |
| `tests/mcp-undo-harness-fidelity.test.ts` (new, 4 specs)                             | **4 passed**                                                                                                                                         |
| `tests/mcp-tools` + `mcp-idempotency` + `mcp-preset-bank-warm` after the harness fix | **133 passed** - nothing depended on the wrong behaviour                                                                                             |
| falsification, D22                                                                   | `mcp-undo-harness-fidelity` asserts the _broken_ harness shape produces `["audio-clip-1","audio-clip-1"]`, and the corrected shape produces one clip |
| `npx prettier --check` on the four touched files                                     | run in the commit that lands this section                                                                                                            |
| `npx tsc --noEmit`                                                                   | run in the commit that lands this section                                                                                                            |

**Not run in this wave:** `npm run build`, `npm run test:expectations`,
`npm run drift:check`, `npm run test:browser`, `npm run test:e2e` - each reads
repo-wide state that concurrent sessions hold dirty (see the final sweep above), and a
red from them would say nothing about this work. They remain the merge owner's gates.
