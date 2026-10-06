# AUDIT 17 — UI WRITE COMPLETENESS & WRITE BUDGET, 2026-10-06

Does a value the user changes actually get written — and does the app spend
undo history on changes it did not need to make.

This is the sibling of Audit 16 (when a gesture commits) and of the Audit 15
static pass (what a commit costs). Where audit 16 asked _when does the release
fire_, this asks _what lands, and what gets silently reverted on the way_.

---

## 1. FINDINGS

### W1 — a whole-doc-pinned command silently reverts unrelated changes (HIGH, confirmed, fixed)

`src/commands/effectInstances.ts`, `addEffectWithLandingCommand`:

```ts
execute: () => next; // ignores the doc the store hands it
undo: () => doc; // ignores it too
```

`ProjectStore.execute` calls `command.execute(this.doc_)` — it deliberately
hands every command the **current** document, so a command applies its delta on
top of whatever is there now. Every sibling in the barrel honours that.
This one discarded the argument and returned a snapshot taken when the command
was **constructed**.

Measured, not argued:

```
BPM was 124 before the add; the add silently reverted a change it never saw.
expected 124 to be 140
```

A React commit handler closes over the render-scoped `doc`, so the hazard is not
hypothetical — `EffectRack.tsx:99` calls
`addEffectWithLandingCommand(doc, track.id, type, landing, insertAt)` with
exactly that captured `doc`. Clicking "+ Reverb" after a remote collab edit, or
after any change that has not yet re-rendered, returns those changes to their
previous value with no error and no undo entry for them.

The team already knows this hazard: `groove.ts:178` and `project.ts:287` each
carry a comment warning that `execute: () => next` reverts concurrent changes.
This command kept the shape — and unlike `core.ts:58` (a **dev-only** fallback
that fires only when the delta verifier catches a bug), it was unconditional.

`undo: () => doc` had the same defect in the other direction: undoing the
effect also reverted every change made before the effect was added.

### W2 — grep cannot answer "does it actually write" (METHOD FINDING)

The obvious approach does not work, and knowing that is worth recording.

A scanner over all `src/ui/*.tsx` classified **379** control handlers
(`onCommit` / `onChange` / `onPreview`): 212 reach the store, **167 do not**.
A second pass asked which of those local states ever reaches an `execute(...)`
call in the same file: **111 "never written"**. Neither number is a defect
count — they are almost entirely export-dialog settings (`sampleRate`,
`format`, `bitDepth`), generate-dialog parameters (`genre`, `seed`,
`stepCount`) and ephemeral UI state (which track is armed, which device is
selected). Those are _supposed_ to stay local.

The two "highest-signal" tiers the scanner produced were both dominated by
noise, because **whether a value belongs in the project document is product
intent, and no regex knows intent**. The scanner was deleted rather than
polished, because a scanner with a 0.8 false-positive rate teaches the next
reader nothing and gets ignored.

What the structural checks _could_ establish, and did:

- No UI code writes `store.doc` directly — the `store.execute` funnel holds.
- The 39 command modules export no duplicate names, so the barrel cannot shadow
  one module with another.
- **Every** whole-doc pin in the command tree is now accounted for: two are
  documented warnings, one is a dev-only verified fallback, and one was W1.

That is the finding that mattered, and grep found it in one query once the
question was asked correctly.

### W3 — write budget: a gesture costs one entry, but a no-op write still costs one (LOW, documented)

Budget as measured:

| Gesture                                  | Undo entries |
| ---------------------------------------- | ------------ |
| A slider drag (many frames, one release) | **1**        |
| Two committed values                     | 2            |

The per-frame cost that Audit 16 removed is what made this a real budget
question at all: with the live drag value in state, a drag could have written a
history entry per frame.

**A remaining no-op write, quantified rather than fixed.** `Slider`'s release
calls `onCommit` unconditionally, so pressing and releasing without moving —
when the value is already what you pressed on — spends an undo step and a
history diff for a change that did not happen. `DragNumber` already guards this
(`if (final !== quantize(startValue.current))`), so the two controls in the same
file disagree. Left alone deliberately: click-to-set is an intentional feature,
the guard belongs at the store boundary rather than in each control, and
changing it would alter documented behaviour for a cost nobody has measured.

### W4 — `coalesceKey` exists but is used once (INFORMATIONAL)

Exactly **one** command in the 39-module tree sets `coalesceKey`. That is
correct given audit 16's result — gestures commit once on release, so there is
nothing to coalesce. Recorded so that a future gesture-driven command that does
write per frame knows the mechanism is there.

---

## 2. FIXES

One file, `src/commands/effectInstances.ts`. The landing fold now runs lazily
against the document the store supplies:

```ts
const applyLanding = (d: ProjectDocument): ProjectDocument => {
  let next = add.execute(d);
  for (const [paramId, value] of Object.entries(landing)) { … }
  return next;
};
return { …, execute: (d) => applyLanding(d), undo: (d) => add.undo(d) };
```

The effect **id** is still pinned at construction — that is required, because
undo and redo must address the same instance. Only the **base** moved from the
closure to the argument, which is the entire fix. `addEffect` already worked
this way, so the change reuses the correct sibling rather than inventing a
mechanism. The deliberately-absent `applyToYDoc` fast path is untouched, so the
collab fallback behaviour is unchanged.

## 3. TESTS ADDED

`tests/ui/ui-write-completeness.test.ts` — 5 specs.

| Spec                                                                 | Covers                                       |
| -------------------------------------------------------------------- | -------------------------------------------- |
| does not revert a BPM change that landed after the command was built | W1 execute                                   |
| still adds the effect                                                | guards against "fixing" the pin into a no-op |
| undoing the effect does not wipe work done BEFORE it                 | W1 undo                                      |
| a slider drag costs exactly one undo entry                           | W3 budget                                    |
| re-writing the held value still costs an entry                       | W3 no-op, quantified                         |

**Falsified.** With the fix reverted, **2 of 3** W1 specs fail. The third — that
the effect is actually added with its landing param — correctly still passes,
because it is a control, not a detector. That asymmetry is the discrimination.

Two harness errors of mine, recorded because both would have shipped confident
nonsense:

1. The first W1 test used `B1.ReverbMix` as a reverb landing param. Reverb's
   params are flat (`decay`, `predelay`, `tone`, `damping`). The product
   **correctly skipped** the unknown id; the test was wrong.
2. The first undo spec passed a _fresh_ `store.doc`, so the pin was harmless and
   the test passed **against the bug**. Reproducing the React case requires
   building the command from a deliberately stale reference — which is now what
   the test does, with a comment saying why.

## 4. VERIFICATION

| Command                                                          | Result                                           |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| `npx vitest run tests/ui/ui-write-completeness.test.ts`          | **5/5 passed**                                   |
| Falsification (pin restored)                                     | **2 of 3 failed**, control spec correctly passed |
| `npx vitest run tests/commands tests/undo-redo.test.ts tests/ui` | **1089 passed, 0 assertion failures**            |
| `npx tsc --noEmit` on touched files                              | clean                                            |
| `npx prettier --check`                                           | `All matched files use Prettier code style!`     |

The single failing _file_ in that suite was `tests/ui/__measure-window.test.tsx`
— a transient probe from the parallel session, which no longer existed when I
checked it. It is not in this audit's output and not mine.

## 5. REMAINING RISKS

1. **Coverage is by mechanism, not by control.** 379 handlers were scanned, but
   the confirmation is structural (no direct doc writes, no barrel shadowing,
   every whole-doc pin accounted for) plus one end-to-end chain. It is _not_ a
   claim that all 125 `onCommit` sites were individually exercised. A
   per-control commit test suite would close that, and is the obvious next
   increment — but 125 hand-written specs would rot faster than they catch.
2. **Persistence was not the layer tested.** These specs assert `store.doc`.
   That a committed value survives autosave to IndexedDB and a reload is a
   separate chain (`ProjectRepository` → `SaveLifecycle`) and is only covered
   by existing round-trip specs, not by anything added here.
3. **W3's no-op write is still there**, now quantified. Fixing it properly means
   a store-boundary guard, which changes documented click-to-set behaviour.
4. **Collab interaction is inferred, not exercised.** W1's real-world trigger is
   a remote edit landing between render and click. The test reproduces the
   _condition_ deterministically with a stale base; it does not run a Yjs
   session.
