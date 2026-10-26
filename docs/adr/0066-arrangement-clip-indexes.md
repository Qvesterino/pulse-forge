# ADR 0066 — The arrangement's clip indexes are built per LIST, invalidated by list identity

Date: 2026-10-26 · Status: Accepted (shipped) · Scope: arrangement render, scene time

## Context

The performance-cliff audit (`docs/PERFORMANCE_CLIFF_DETECTOR_REPORT.md`, findings **C-3** and
**C-4**) found the arrangement panel asking the same question once per **visible** clip, with each
question scanning the whole document.

- `compSourceTakeNumber` rebuilt a `Set` over **every** audio clip in the document, and looked up
  the clip's take group with a `find` over the groups — **per visible audio clip**.
- `arrangementSecondsBetweenTicks` rebuilt the **whole scene span map** (a filter over every scene
  clip, a `scenes.find` per clip and a sort) — **per visible audio clip**, just to learn the
  wall-clock length of that one clip.
- The windowing memo's **forced pass** — the one that keeps the clips a live gesture owns mounted —
  walked **every clip of the document** on every render, even when the gesture set was empty. The
  window scan beside it could stop early (the list is sorted by `startBar`); the forced pass had no
  way to stop.

The panel commits on every `pointermove` during a drag, so this was paid per mouse move.

**This is the mechanism ADR 0063 introduced, applied one level down.** ADR 0063's rule is: _if you
touch items in a loop, build the index once, outside the loop, and invalidate it by identity._ What
ADR 0063 did not say is which identity.

## Decision

**The arrangement's per-clip indexes are built once per clip LIST, and the list's identity is the
version signal.**

1. **The indexes live next to the panel, not in the document index.** `src/ui/arrangement/clip-indexes.ts`
   owns `buildClipIndexById()` (id → clip, first match wins) and `buildCompTakeOrderIndex()` (the
   comp-source take numbering plus the take-group lookup). `src/ui/arrangement/windowing.ts` owns
   `pickVisibleClips()`, whose forced pass is a **lookup per forced clip** instead of a walk over the
   document.
2. **The scene span map is a separate, explicit object.** `src/project-model/scene-time.ts` gains
   `buildArrangementSpans()` (build once) and `arrangementSecondsBetweenTicksInSpans()` (walk an
   already-built map). `arrangementSecondsBetweenTicks()` **keeps its exact signature** as the
   convenience form — it is the shared contract with the audio-comp command
   (`compAudioTakeRange`), and split/trim math must not be able to diverge from the render's math.
3. **The panel holds them in `useMemo`, keyed on the list's identity.** `clips` and `audioClips`
   are **sorted copies** of the document's collections, so their identity is what changes: the
   indexes are rebuilt when the list changes, not when the panel re-renders.
4. **First match wins, exactly like the scans they replace.** `Array.prototype.find` returns the
   first match; `new Map(items.map(i => [i.id, i]))` keeps the last. A document with a duplicate id
   would otherwise get a different answer from the index than from the scan.
5. **The comp-take index reads the ORIGINAL `arrangement.audioClips`, not the sorted copy.** The
   take NUMBER is the order the takes appear in the document; the sorted copy is a drawing order.
6. **The span map is built from the SORTED copy**, so that two scene clips with the same start bar
   resolve their tempo identically to the render that draws them.
7. **The gesture handlers share the map.** `beginAudioDrag` and the trim gesture used to rebuild the
   span map on every `pointermove` of the drag; they now walk the same map the render built.

## Consequences

- **The render's per-clip cost drops from O(document) to O(1).** The measurement is in
  `scripts/bench-hotpath.ts` cases **P.3** and **P.4**: the arrangement render over 2000 audio and
  400 scene clips with 60 visible clips went from **6.8–10.5 ms to 0.39–0.50 ms** across three
  runs (16–21×), and the forced pass over 4000 clips from **0.38–0.42 ms to 0.014–0.028 ms**
  (15–27×).
- **The index build is paid once per clip-list change — and that is a real cost.** Case **P.5**
  measures the amortised trade honestly: 20 renders over one 4000-clip list, with the index build
  charged to the first of them, is **2.8–4.7× faster** than 20 walks of the list. The break-even
  depends on the ratio of renders to edits, which is a property of how the panel is used, not
  something this ADR can assert. At one render per edit the index would be a loss; the panel
  re-renders many times per edit, so it is a win.
- **The span walk stopped allocating.** The old code built two arrays per step and spread them into
  `Math.min(...)`, which is a call-stack overflow once the arrangement grows past ~100k spans. The
  walk now finds the next boundary with a scan over the sorted spans and no allocation.
- **The indexes are derived data.** Nothing writes through them; the project model owns the truth
  (invariant 1). They are a lookup, not a second source of truth.
- **A stale index is possible in principle, and impossible in practice here — by construction, not
  by discipline.** The indexes are `useMemo`s over the panel's own sorted copies, which are fresh
  arrays on every list change. Nothing in `src/` mutates a clip array in place. This is now a
  stated invariant rather than an accident.
- **The panel got three more `useMemo`s and one more module.** The cost of this pattern is visible
  surface area: a future contributor must know that `clipSecPerBar` reads a shared map, not a
  fresh one.

## Alternatives considered

- **Rely on C-2 (the pixel viewport quantum) to shrink W.** Rejected: the quantum makes the panel
  re-render less often, but W is still 50+ visible audio clips at the default zoom, and the cost was
  O(W × N) — a smaller W does not remove the multiplication.
- **Build the index per render.** Rejected: that is O(N) per render again — the same order as the
  forced-pass walk it replaces. The whole point is to build it once per **list**.
- **Extend ADR 0063's document-level `WeakMap` to the clip lists.** Rejected: the panel's lists are
  **sorted copies**, not the document's collections. A `WeakMap` keyed by the document cannot see
  that a copy changed; keying it by the copy would be a `WeakMap` with one live entry, i.e. a
  `useMemo` with extra steps.
- **Virtualise the arrangement.** Still the right long-term answer for the DOM (§9's backlog), and
  orthogonal: this ADR removes the super-linear **computation**, not the node count.
- **Memoize per clip id instead of per list.** Rejected: the map IS the memo, and a per-id cache
  would have to be invalidated the same way with more moving parts.

## Verification

- `tests/ui/arrangement-render-indexes.test.ts` — the **oracle** gate (9 assertions). The pre-fix
  implementations are copied into the test verbatim and the indexes must answer exactly like them:
  the take number, the take-group lookup, the wall-clock length over a grid of questions, and the
  windowed pick. Every count assertion has a **positive control** — the pre-fix forced pass is
  replayed against a counting proxy and must read the whole document.
- `tests/ui/arrangement-render-index-gate.test.tsx` — the **count** gate on the real panel. The
  index builders are counted by a module mock: the span map and the take index must each be built
  **exactly once**, and the per-call rebuild form must be called **zero** times — while the number
  of visible clips grows 6×. The gate was verified to have teeth: with the pre-fix code restored it
  fails with _"expected 39 to be +0"_ (39 = the number of visible audio clips).
- `scripts/bench-hotpath.ts` cases **P.3**, **P.4**, **P.5** — the permanent A/B, same V8, same
  heap, interleaved rounds. P.3 and P.5 **assert that both sides return the same number** before
  they are compared, so a faster-but-different answer can never be reported as a win.
