# RISK CLOSURE PLAN — UI Responsiveness (audit 16)

Follow-up to `UI-RESPONSIVENESS-AUDIT-2026-10-16.md`.
Author: Mavis · Date: 2026-10-18 · Rev: `c2853c03` (the fix) + this plan.

The original report closed with five "Remaining Risks". Before planning any
work against them, each claim was **re-measured on 2026-10-18**. Three of the
five turned out to be wrong — two of them wrong *in the auditor's own
report*. That is recorded here rather than quietly dropped, because a risk
list that contains false risks is worse than no risk list.

---

## 1. Verification pass — what the risks actually are

| # | Risk as reported on 2026-10-16 | Verified status on 2026-10-18 | Evidence |
|---|---|---|---|
| 1 | `format:check` is red at HEAD; foreign unformatted files must not be reformatted | **FALSE — dissolved.** The HEAD baseline of both files is Prettier-clean. `npx prettier --check src tests` reports "All matched files use Prettier code style!". The warning was caused by **one line I added** (122 chars), which was already fixed. The "pre-existing at HEAD" claim came from a PowerShell `Out-File` round-trip that mangled em-dashes and made a diff look like noise. | `git show HEAD:src/ui/SkrutkaPanel.tsx` written via node (no `Out-File`) → Prettier clean; `prettier --check src tests` → clean |
| 2 | 13 typecheck errors in the parallel session's files | **RESOLVED — by them, not by me.** `npx tsc --noEmit` now exits 0. | `tsc --noEmit` → 0 errors |
| 3 | "Browser verification is not possible in this environment" | **FALSE — dissolved.** `playwright@1.62.1` + `playwright-core` are installed and chromium/firefox/webkit binaries are present. All three launch and render. | `chromium: OK v151.0.7922.34`, `firefox: OK v153.0`, `webkit: OK v26.5` |
| 4 | F3 (no canvas DPR test) and F5 (export prep on main thread) unmeasured | **STILL OPEN.** No defect has ever been demonstrated for either. | — |
| 5 | No visual/interaction regression proof during the drag | **STILL OPEN** — and now closable for real, because risk 3 was false. | — |

**What actually remains: two open items (4, 5), not five.**

The load-bearing correction is risk 3. It was asserted without running
anything — the same failure mode as the six earlier audit findings in this
project where a harness "reported clean". The fix is verified in jsdom and by
falsification, but **no real browser has ever seen the fixed gesture run**.

---

## 2. Phase 1 — real-browser drag proof (closes risk 5)

**Deliverable:** `scripts/verify-drag-responsiveness-browser.mjs`
+ `src/browser-checks-drag-responsiveness.ts`

**Pattern to copy:** `scripts/verify-live-editing.mjs` — vite server
in-process, chromium headless, an in-page module imported via
`page.evaluate(() => import("/src/..."))`. This is the established repo
convention for "prove it on the real stack", and it needs **no production
code change**.

**Selectors (verified present):**
- `canvas.skrutka-viz` — Skrutka delay curve
- `canvas.rezonans-viz` — Rezonans formant
- `canvas.ozvena-pad` — Ozvena blend pad

**What it measures:**
1. Install an rAF-delta recorder and a `PerformanceObserver('longtask')`.
2. 60 rAF-paced real `page.mouse.move()` events per canvas (press, drag, release).
3. Report p50 / p95 / max frame interval + count of long tasks > 50 ms.

**Two requirements that are not optional — they are what stops this test from
being a tautology:**

- **Positive control (liveness).** A clean frame profile proves nothing if the
  panel never processed the drag. The check MUST assert the gesture landed:
  the panel's value readout moved (e.g. `aria-valuenow` on `canvas.ozvena-pad`),
  the drawn geometry changed, and the gesture closed as one undo frame.
- **Control gesture (relative budget).** A parameter slider drag
  (`src/ui/controls.tsx` `dragValueRef` write-through) *does* write the
  document per pointermove, by design. Running it on the same document gives
  a known-expensive reference. The canvas drags — which now write once —
  must be measurably no worse than it. If a canvas were still writing per
  move, this comparison fails.

**Pass criteria (to be calibrated on first measurement, then frozen):**
- zero long tasks during the canvas drags
- p95 frame interval inside budget
- canvas drag ≤ control-gesture cost

**Deliberately not done:** a `window.__kyxDocWrites` counter. It would give a
crisper number, and there is precedent (`window.__kyxIntentFailures` in
`src/intent/failure-log.ts`), but frame timing measures the symptom the user
actually feels and costs zero production bytes. Revisit only if timing turns
out to be too noisy to gate on.

---

## 3. Phase 2 — DPR (closes risk 4a) — **measure first, guard second**

There is no evidence of a DPR defect. Writing a failing test first would be
manufacturing work.

1. Render each of the three canvases at `devicePixelRatio` 1 / 2 / 3.
2. Compare `canvas.width` against `getBoundingClientRect().width * DPR`, and
   confirm the 2D context is scaled rather than drawing at 1× into a 2× buffer.
3. **If a mismatch appears** → that is a real blur defect; write the guard and
   report the visual defect.
4. **If everything matches** → record the measurements in the audit doc and
   close F3 as *measured healthy*, with the numbers as evidence.

Either outcome is a legitimate close. Both are worth more than "no test exists".

---

## 4. Phase 3 — export main-thread (closes risk 4b) — measure first

1. Same harness; attach the long-task observer around export preparation on a
   heavy document (the 240-clip shape used in the audit's scaling estimate).
2. If preparation produces long tasks or visibly blocks input → the fix is a
   chunked/worker preparation step, and it needs its own ADR per invariant 8.
3. If it does not → record as measured and close F5.

---

## 5. Phase 4 — governance

Once Phase 1 exists, add it to the test gate table in `AGENTS.md` §6 and
register the seam in `tests/seam-manifest.json` (rule: a seam is COVERED only
with both a `seamEvent` and a `negativeSpec`).

---

## 6. Recommended order

1. **Phase 0** — correct the three false claims in the audit document (minutes,
   prevents wrong claims from being trusted downstream).
2. **Phase 1** — real-browser drag proof. Highest value: it is the only layer
   where the actual fix has never been observed.
3. **Phase 2 / 3** — measurement-only sweeps; cheap, and they close F3/F5 with
   evidence instead of with a test written to match whatever is true.
4. **Phase 4** — governance.

## 7. Explicitly out of scope

- Timeline auto-scroll (F4) — a missing **feature**, not a defect.
- A new rAF gate on top of the fix — the document-write count already dropped
  from ~2N to 1 per gesture; a frame gate would add latency without reducing
  writes.
- Reformatting files this audit did not touch.