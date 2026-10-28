# ADR 0079 — A frame is one history entry: an undo inside it takes the whole frame back

Date: 2026-10-28 · Status: Accepted (shipped) · Scope: undo history, undo frames, project store

## Context

Audit finding **F-22** (STATE_DIVERGENCE_HUNTER_REPORT.md §4/F-22) named one mechanism:
**`ProjectStore.undo()` never consults `frameCommands`, while `endUndoFrame()` builds the compound command from
`frameCommands`** — which still contains the command the undo just gave back.

The audit was careful: it did not claim a reproduced defect. It ran the scenario (§5.7 T9), saw the frame's single
Ctrl+Z restore the baseline **exactly**, and wrote the finding down as _"Hypothesis — NOT REPRODUCED"_. It then
narrowed the hazard to a specific recipe:

> the hazard is real in the _mechanism_ but it needs a **value-addressed** command … **and** a duplicate point to
> remove twice (F-07). That combination was not exercised here.

That narrowing was written before **F-07 shipped**. F-07 did two things that close both halves of the recipe:

- the automation point's undo re-anchors on the point's **ID** (`reanchorPointIndex`, `src/commands/automation.ts:67`),
  so it is idempotent — a second application removes nothing; and
- `addAutomationPoint` refuses an identical `(tick, value)` at the **command boundary**
  (`src/commands/automation.ts:219`), so the duplicate the recipe needs cannot be authored.

So the _named recipe_ is dead. It would have been easy — and wrong — to close the finding on that basis. **The
recipe was never the defect; the mechanism was.** Re-measured against today's tree, with no recipe at all:

| #   | Scenario                                                              | Measured result                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1  | legacy frame, 3 commands, **undo inside the frame**, seal, redo, redo | **RESURRECTION + DUPLICATE.** The frame's redo re-applied the command the user had undone inside the frame, and the _next_ redo applied it **a second time** — the lane ended up with **four** points, **two of them at `2880@0.3`**.                        |
| L2  | legacy frame, **redo inside the frame**                               | **NOT REPRODUCED.** The redo branch is already dead by then (`beginUndoFrame` clears it, every command clears it), so the redo did nothing. The audit's "a redone command loses its history entry" hypothesis was **not** confirmed and is not claimed here. |
| O1  | **owned** frame (MCP batch), undo inside the frame                    | **Correct.** The batch is undone as ONE history entry, nothing is resurrected, redo restores it exactly once. This is the reference behaviour.                                                                                                               |

L1 is the defect. O1 is what the same user action already did correctly on the other frame kind — the two paths
were never supposed to differ.

### Why L1 happens, exactly

1. The frame keeps its own command list (`frameCommands`) **and** the undo stack is the real history.
2. `undo()` pops a stack entry the frame owns and pushes it onto the redo stack — **without telling the frame**.
3. At the seal, `finishUndoFrame` builds the compound from `frameCommands` — which still wraps the undone command —
   and pops `grew = undoStack.length − frameOpenDepth` entries. The compound therefore covers **more commands than
   it owns stack entries**.
4. The compound's `execute` re-applies the undone command → **resurrection** on the frame's redo.
5. The undone command is _also_ on the redo stack → the next redo replays it → **the command is applied twice**.

Step 5 is why the damage is a **duplicate**, not just a surprise: the second application is not a new command, it is
a replay of the captured `ins` delta — so the duplicate guard at the command boundary **never saw it**. The guard
protects the command boundary; the frame's double-apply bypasses that boundary entirely. The normaliser then
re-issued a fresh id for the copy (`pt-lane-<laneId>-3`), so the document held two _distinct_ entities at one
tick/value — precisely the ambiguity F-07 removed from the command layer.

### The precedent was already in the codebase

`jumpTo` seals the frame **first**, and its comment names this exact failure:

> Audit 09 D1: seal an open record frame FIRST — jumping rewinds the stack below `frameOpenDepth`, which corrupted
> the disarm bookkeeping (the compound wrapped commands already undone by the jump, and **redo executed them a
> second time**).

The hazard was known, documented and fixed for the jump path. `undo()` — the path a human actually takes — had no
such seal. That is the whole finding.

## Decision

**`undo()` seals the open frame before it pops.** One line, in the same place and the same shape as `jumpTo`:

```ts
undo(): void {
  this.sealOwnedUndoFrame();
  if (this.frameCommands) this.endUndoFrame();
  const command = this.undoStack.pop();
  …
}
```

The consequences of that line are the decision:

- **The frame is ONE history entry.** An undo inside it takes the whole frame back — which is exactly what the
  owned (MCP batch) frame already did (O1), and what the user gets anyway if they release the gesture first.
- **The compound covers exactly the stack entries it owns.** The seal happens _before_ the pop, so `grew` is
  measured against an unmutated stack. No more compound-wraps-more-commands-than-it-owns.
- **The redo stack holds one entry, not two.** The undone command is inside the compound; it is not also a
  standalone redo entry. The double application cannot happen.
- **The legacy frame and the owned frame now have one contract.** The gate test asserts their parity directly.

A frame that owns nothing yet simply dissolves; the undo then pops the entry from before the frame, which is what
the key press asked for. A frame whose gesture is still open (a live MIDI take, a drag) is closed by the undo, and
the gesture's remaining writes continue as ordinary entries — a change of granularity, never a lost or duplicated
edit.

### What was deliberately NOT changed

- **`redo()` was left alone.** After the fix, the redo stack cannot be non-empty while a legacy frame is open:
  `beginUndoFrame` clears it, every command clears it, and an inner undo now seals the frame. L2 measured this
  path and found nothing to repair.
- **`YDocStore` was left alone.** The collab store's frame is a yjs `stopCapturing` seam with no command list, so
  the mechanism does not exist there.
- **The command layer was left alone.** F-07's id-anchored undo and the duplicate guard are correct; they were
  never what failed.

## Consequences

- **The undo inside a frame is now honest in both directions.** Undo takes the whole pass back; redo brings it back
  exactly once. No point, note or effect is resurrected and none is duplicated.
- **The two frame kinds agree.** The gate test asserts the legacy frame and the owned MCP frame reach the same
  document and the same stack depth after the same user action.
- **A gesture interrupted by Ctrl+Z is closed, not corrupted.** The live take keeps recording as ordinary entries
  after the undo; the take's earlier notes are one undoable entry, as the frame promised.
- **The finding is downgraded from "the compound may resurrect a command" to "the compound no longer can".** The
  audit's recipe stays unnecessary: the defect reproduces with three ordinary commands and one key press.

## Alternatives rejected

- **Reconcile the frame instead of sealing it** (drop the undone command from `frameCommands`). Rejected: the
  frame's stack bookkeeping is `grew = undoStack.length − frameOpenDepth`, and the inner undo reduces that count —
  so a reconciled frame builds its compound from more commands than it owns entries, which is the very mismatch
  that caused the defect. Making the bookkeeping exact means tracking which stack entries the frame owns, and
  every coalesced / no-op command changes that count. A seal achieves the same correctness with one line and no
  new state.
- **Make the automation point's undo value-addressed again** (the audit's implied recipe). Rejected: F-07's
  id-anchored undo is the better mechanism; the audit's recipe was a way to _reach_ the defect, not a way to
  _fix_ it. Re-introducing value addressing would trade a correct identity for a way of hitting a bug.
- **Guard the duplicate at the document level** (reject a second point at one tick/value in the normaliser).
  Rejected: it would hide the double-apply instead of removing it, and it would punish a legitimate document that
  arrived with two points at one tick from an older build. The duplicate never had to exist.
- **Seal the frame on every history operation, including `redo()`.** Rejected as unnecessary: after the fix the
  redo stack is provably empty during an open legacy frame (L2 measured it), so a redo seal would only close a live
  gesture for nothing.

## Verification

- `tests/undo-frame-inner-undo.test.ts` (5 specs, new) — the frame is sealed by the undo; the undo takes the whole
  frame back; the redo restores it **exactly once** with no duplicated `(tick, value)`; the legacy frame and the
  owned MCP frame reach the same document and stack depth; undo-all → baseline and redo-all → final survive an
  inner undo; the gesture's own `endUndoFrame()` afterwards adds no second entry.
- **Falsified**: removing the seal line turns **all five** specs red, each on its own claim (the frame stays open,
  the points are not reverted, the parity breaks, the round-trip restores a duplicate) — not on a missing symbol.
- `tests/store-undo-frame.test.ts`, `tests/undo-redo-audit.test.ts`, `tests/commands-edge-cases.test.ts`,
  `tests/midi-pattern-recorder.test.ts`, `tests/recording-audit.test.ts` — green.
