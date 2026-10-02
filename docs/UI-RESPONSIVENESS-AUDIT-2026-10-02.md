# UI RESPONSIVENESS AUDIT — 2026-10-02 (Audit 16)

Interaction-responsiveness audit of the KYX / Pulse Forge UI. Scope is the
gesture and viewport layer: clip drag/trim, control dragging, panel resize,
zoom, scroll and the browser-resize path.

**One defect class accounted for all four confirmed defects.** It is recorded
here as a single rule because fixing it in one place would have left the other
three live, and because the codebase already contains the correct pattern
elsewhere — which is what made the inconsistency provable rather than argued.

---

## 0. THE DEFECT CLASS: a drag's live value stored in React state

`pointermove` is a **CONTINUOUS** event in React 18. Its `setState` is
scheduled at `ContinuousEventPriority` and flushed from a Scheduler macrotask
— _not_ synchronously at the end of the event. `pointerup` is **DISCRETE**.

A fast gesture can therefore deliver `pointerup` while the final `pointermove`
state is still uncommitted. The release handler is the closure from the last
_committed_ render, so it reads a value the pointer never reached. Two failure
modes, both demonstrated below:

- **Stale commit** — the press has committed, the final move has not. The
  gesture lands short by up to one frame of movement.
- **Swallowed commit** — the guard that decides _whether_ to commit compares
  the stale value against the original, finds no difference, and writes
  **nothing at all**. The user drags, releases, and nothing happens.

### The rule

> A gesture's live value is **event data**, not **render data**. The value a
> release commits must be read from something the event itself wrote — a ref.
> State stays the render authority for the live preview.

### Why this was provable rather than speculative

The correct pattern already exists in this same codebase, twice:

- `PianoRoll.tsx` keeps drag deltas in `dragRef.current` and commits from the ref.
- `ArrangementPanel.tsx:4830` (warp pins) carries the comment _"Recompute from
  the release event — the preview state may lag a fast flick by one batched
  render"_, and recomputes.

The three defects below are the sites that did **not** follow that rule. A fix
in `controls.tsx` alone would have left the arrangement panel broken, which is
exactly the trap this audit avoided.

---

## 1. FINDINGS

### D1 — `Slider` / `DragNumber` drop or stale the release (HIGH)

`src/ui/controls.tsx`. The drag's live value lived in `dragValue` / `edit`
**state**, and `handlePointerUp` read it from the handler closure.

These two controls are the highest-leverage file in the UI: **78 `Slider` and
32 `DragNumber` usage sites** across the mixer, every plugin panel and the mod
matrix. One defect here is many defects in the product.

- Stale frame → the knob commits a value the pointer never reached.
- Press still pending → `if (dragValue === null) return` swallows the gesture
  entirely and **nothing is written to the document**.

### D2 — arrangement clip drag/trim commits the previous frame (HIGH)

`src/ui/ArrangementPanel.tsx`. `onClipPointerUp` read `drag` and `multiDrag`
from state while reading the gesture _mode_ from `dragRef.current` — the same
object, two sources of truth.

### D3 — audio-clip fade / gain / stretch / trim commit **nothing** (HIGH)

`src/ui/ArrangementPanel.tsx`, `onAudioPointerUp`. Same class, worse blast
radius: seven gesture modes (move, resize, stretch, trimStart, trimEnd, fadeIn,
fadeOut, gain) commit from four state values.

For `fadeIn` / `fadeOut` / `gain` the release is guarded by
`Math.abs(preview - original) > 0.005`. A stale preview still holds the
original, the guard compares a value with itself, and **the whole gesture
commits nothing** — the user drags a fade, releases, and the clip does not
change.

### D4 — dock resize wrote `localStorage` once per pointermove (MEDIUM)

`src/ui/dockLayout.ts` + `src/ui/App.tsx`. `useDockLayout` persisted inside an
effect keyed on `state`, and `startDockResize` calls `setDock` on **every**
`pointermove`. `localStorage.setItem` is synchronous and main-thread blocking,
so a 120 Hz mouse performed ~120 serialising writes per second on the thread
that renders the DAW. Measured: **40 pointermoves → 40 storage writes.**

### D5 — a persisted dock outlived the viewport (MEDIUM)

The dock ceiling is `window.innerHeight * 0.7`, but it was read during render
and only ever applied at load. Shrinking the window after a dock was sized on a
tall display left it un-clamped. Measured: a **560 px dock on a 600 px-tall
window**, starving the sequencer above it.

### Verified healthy — no action taken

- **Playhead / meter cadence.** `playhead.ts` throttles every hook behind
  change-detection (`if (next !== last)`) on the shared `rafLoop` bus, and
  `rafLoop.tick` removes a throwing consumer instead of killing the chain.
- **Piano-roll note drag** and **warp-pin drag** — already ref-based, i.e. they
  already follow the rule. These are the reason D1–D3 read as inconsistencies
  rather than as a house style.
- **Step-grid virtualization** (`Sequencer.tsx` `colWindow`) and
  **pitch-window virtualization** (`PianoRoll.tsx` `prView`) — both window to
  the visible range with overscan, and both fall back to "render everything"
  when width is 0 so tests and first paint stay correct.
- **Narrow-layout reactivity.** `useStepsLabelPx` re-windows on the 760 px
  breakpoint via a `matchMedia` change listener; `TopBar` uses a `ResizeObserver`.
- **High DPI.** All eight canvas surfaces scale by `window.devicePixelRatio`.
- **Zoom.** Ctrl+wheel handlers are non-passive native listeners with a
  scroll-anchor correction (`zoomAnchorRef`); the anchor is a stored value
  rather than a layout read.

---

## 2. FIXES

All small, local, reversible. No architectural change.

| File                          | Change                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/controls.tsx`         | `dragValueRef` / `editRef` mirror the live value; the release reads the ref. `setDrag` / `setEditValue` write through to both.                                          |
| `src/ui/ArrangementPanel.tsx` | `dragLiveRef` / `multiDragLiveRef` plus four audio refs (`audioDragLiveRef`, `audioFadeLiveRef`, `audioGainLiveRef`, `audioStretchLiveRef`) with write-through setters. |
| `src/ui/dockLayout.ts`        | Persist debounced to 200 ms, flushed on unmount and `pagehide`. Added a `maxInner` effect that re-clamps the height.                                                    |
| `src/ui/App.tsx`              | `viewportMax` became state fed by a `resize` listener, so the ceiling is live.                                                                                          |

**Abort paths clear the refs, not just the state.** All three cancel routes
(`onClipPointerCancel`, `onAudioPointerCancel`, `cancelAllArrangementGestures`)
reset the refs too — a ref that outlives a cancel would leak the old value into
the _next_ drag's release. In `cancelAllArrangementGestures` (a `useCallback`
with `[]` deps) the refs are written directly, since only refs and `setState`
are identity-stable.

**Behaviour deliberately preserved:** the drag still previews from state every
frame, still commits exactly once, still honours click-to-set and the
double-click reset, and the dock still tracks the pointer with no dropped
frames — only its _persistence_ is deferred.

---

## 3. TESTS ADDED

`tests/ui/ui-responsiveness.test.tsx` — **18 specs**, all failing against the
pre-fix code where they target a defect.

| Group                 | Covers                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Slider                | multi-move release, one-frame release, stale-frame release, click-to-set                        |
| DragNumber            | multi-move release, one-frame release, stale-frame release                                      |
| Arrangement clip drag | multi-move, stale-frame release, Escape-cancel leaves no stale ref                              |
| Audio-clip fade       | one-frame release, multi-move                                                                   |
| Dock resize           | write coalescing, persist-on-settle, unmount flush, viewport re-clamp, `clampDockHeight` bounds |

**Falsification was performed, not assumed.** Each fix was reverted in place
and the suite re-run:

- Revert `dockLayout.ts` → `expected 560 to be less than or equal to 420`
  (the un-clamped dock), 40 storage writes, 2 writes where 1 was expected.
- Revert the `ArrangementPanel` release to the state read → **exactly 1** test
  flips (the stale-frame release). The control tests stayed green, which is the
  discrimination that matters.
- Revert the audio release to the state read → **exactly 1** test flips.

### Harness corrections made during the audit

Three of my first assertions were wrong and the **product was right**. Recorded
because each would otherwise have been reported as a defect:

1. `DragNumber` committed `1` for a 180 px drag — correct (0.4/px × 180 px
   saturates a 0..1 range); my expected `0.72` was nonsense.
2. Dock reached `248` — correct (start 208 + 40 px); I had assumed it started
   at 400.
3. Clip travelled 13 bars, not 9 — `BASE_BAR_WIDTH` is **30**, not 48, and the
   grab bar at x=40 is 1, not 0.

---

## 4. VERIFICATION

| Command                                              | Result                                       |
| ---------------------------------------------------- | -------------------------------------------- |
| `npx vitest run tests/ui/ui-responsiveness.test.tsx` | **18/18 passed**                             |
| `npx vitest run tests/ui` (full UI suite)            | **116 files / 830 tests passed**             |
| `npx vitest run tests/ui/controls.test.tsx`          | **30/30 passed** (no regression)             |
| `npx tsc --noEmit`                                   | clean for all 5 touched files                |
| `npx prettier --check` on all touched files          | `All matched files use Prettier code style!` |

---

## 5. REMAINING RISKS

1. **`tests/ui/OnboardingHint.test.tsx` fails typecheck at HEAD** — 6 errors
   (`afterEach` used but not imported; two unused bindings; three spread
   errors). **Pre-existing and untouched by this audit**: `git status` shows
   the file unmodified, and `git show HEAD:` reproduces the same defect. It
   means the repo's typecheck gate was already red, so "typecheck clean" is
   only claimable per-file, not repo-wide. Not fixed here — it is outside the
   audited area and belongs to whoever owns that surface.
2. **The dock re-clamp is one-way.** Shrinking the window clamps the dock and
   the shrunken value becomes the new setting; growing the window back does
   **not** restore the previous size. Preserving the unclamped preference would
   need extra state. Chosen deliberately as the smaller, reversible option.
3. **Persistence is now deferred by up to 200 ms.** A tab killed inside that
   window still loses the last layout; `pagehide` + unmount flushes cover the
   ordinary paths.
4. **One-frame staleness is reproduced, not timing-measured.** The tests pin
   the _condition_ (release and final move in one commit batch) and its
   consequence. They do not assert a real-device event ordering, which would
   need a browser-level harness. `npm run test:browser` is the right gate for
   that and was not run here.
5. **Audio-clip `trimEnd` and `gain` have no dedicated stale-frame spec.** The
   fix is shared across all seven modes and the fade path is covered, but
   `trimEnd` in particular has no direct test of the release commit.
6. **`getBoundingClientRect()` per `pointermove`** (clip drag, intensity lane,
   warp pins) is a forced layout read interleaved with React's style writes.
   Caching the rect at gesture start would remove it, but the rect legitimately
   changes if the container reflows mid-drag, so this was left alone — it is a
   measured-performance question, not a demonstrated defect.
