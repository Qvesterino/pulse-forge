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

## Gates

| Gate                                                           | Result                                              |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `npm run typecheck`                                            | **EXIT 0**                                          |
| `npm run format:check` (all touched files)                     | **All matched files use Prettier code style!**      |
| Targeted suites (12 files, clip + gesture + selection + audio) | **133 passed / 0 failed**                           |
| `npm run build`                                                | **EXIT 0** — `✓ built in 1m 2s`, `[size-budget] OK` |

Build budget output as measured:

```
entry: 249 KB (budget 1070)          DAW JS chunks: 3464 KB (budget 3500)
optional on-demand runtimes: 640 KB  (budget 650)   optional codecs: 166 KB (budget 170)
optional Audiotool Nexus: 713 KB (budget 750)        optional QMR HUD: 1078 KB (budget 1600)
core worklets: 131 KB (budget 150)   landing route: 160 KB on-demand across 5 chunks (budget 600)
```

### Documentation drift corrected along the way

`AGENTS.md` stated the DAW JS budget as **3170 KB** in two places (§4 and §7). The
enforcing value is `TOTAL_BUDGET_KB = 3500` in `scripts/check-bundle-size.mjs:85`, and the
measured build is 3464 KB. The doc was stale — and stale in the dangerous direction,
reading as though there were 290 KB of headroom that does not exist. Both occurrences
corrected to 3500 KB.

### Shared working tree — two files belong to another session

`src/mcp/tools.ts` and `tests/sample-license-gate.test.ts` were being written by a
parallel agent while this audit ran (`git status` shows `M` and `??` respectively,
with timestamps advancing during this session's own test runs). Neither has any
relation to any file above. `tools.ts` briefly produced a parse error mid-write (an
unterminated template literal) which cleared once that session finished its edit;
`sample-license-gate.test.ts:24` still reports `TS7053`.

Both were left untouched — a repo-wide `tsc --noEmit` cannot pass while another
session holds a file in a non-compiling state, and editing their work would risk
destroying it. The typecheck row above is scoped to the files this audit changed.
