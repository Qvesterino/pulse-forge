import { describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { computeDocDelta, applyDocDelta } from "../src/commands/docDelta";
import { mulberry32 } from "../src/shared/rng";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * Guard for the entity-array ORDER REPLAY inside `computeDocDelta`.
 *
 * The replay used to locate the item each step refers to with a linear
 * `sim.findIndex` per element of the target list — O(n²) over a list of n
 * entities. `snapshot()` computes the forward AND the backward delta, so every
 * command that touched one entity of a long list paid that twice.
 *
 * Two independent guards live here:
 *
 *  1. BEHAVIOUR — the ops the current implementation emits must be exactly the
 *     ops the pre-fix algorithm emitted. The pre-fix algorithm is re-implemented
 *     below (the oracle) rather than trusted, so a rewrite that changed the op
 *     sequence would be caught instead of silently altering undo/redo.
 *
 *  2. COMPLEXITY — the number of times the delta engine reads an entity's
 *     `id` is counted through a getter. The scan read `id` once per candidate
 *     per step (O(n²) reads); the indexed replay reads it O(n) times. Counting
 *     reads rather than milliseconds makes the guard independent of machine
 *     load, which is what a wall-clock budget in CI would not be.
 */

interface LegacyOrderOp {
  k: "ins" | "move" | "del";
  index?: number;
  id?: string;
  toIndex?: number;
}

/**
 * The pre-fix replay, verbatim: a linear `findIndex` per element.
 * Mirrors `diffEntityArray`'s steps 2 and 3 in `src/commands/docDelta.ts`.
 */
function legacyOrderReplay(aIds: string[], bIds: string[]): LegacyOrderOp[] {
  const ops: LegacyOrderOp[] = [];
  const bSet = new Set(bIds);
  // Step 2 — removals, in a's order.
  for (const id of aIds) {
    if (!bSet.has(id)) ops.push({ k: "del", id });
  }
  // Step 3 — the replay.
  const sim = aIds.filter((id) => bSet.has(id)).map((id) => ({ id }));
  for (let i = 0; i < bIds.length; i++) {
    const id = bIds[i];
    const current = sim.findIndex((entry) => entry.id === id);
    if (current === -1) {
      ops.push({ k: "ins", index: i });
      sim.splice(Math.min(i, sim.length), 0, { id });
      continue;
    }
    if (current !== i) {
      ops.push({ k: "move", id, toIndex: i });
      const [moved] = sim.splice(current, 1);
      sim.splice(Math.min(i, sim.length), 0, moved);
    }
  }
  return ops;
}

/**
 * Both documents are built from ONE template instance. `createProjectFromTemplate`
 * mints fresh ids per call, so two separate calls would differ in every entity
 * and the delta would report changes outside the list under test.
 */
function baseDoc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function withTracks(base: ProjectDocument, tracks: Record<string, unknown>[]): ProjectDocument {
  return { ...base, tracks } as unknown as ProjectDocument;
}

/**
 * The ops the delta emits for the entity list, projected to the fields that
 * carry the ORDER. Nothing outside the track list may be touched: the fixture
 * shares every other entity by reference, so any other op would mean the
 * delta walked into unrelated state.
 */
function orderOps(before: ProjectDocument, after: ProjectDocument): LegacyOrderOp[] {
  const ops = computeDocDelta(before, after).ops;
  for (const op of ops) {
    expect(op.path[0]).toBe("tracks");
  }
  return ops.map((op) => {
    if (op.k === "ins") return { k: "ins", index: op.index };
    if (op.k === "move") return { k: "move", id: op.id, toIndex: op.toIndex };
    if (op.k === "del") return { k: "del", id: (op.path[1] as { id: string }).id };
    throw new Error(`unexpected op ${op.k} on the entity list`);
  });
}

describe("docDelta entity-array order replay", () => {
  it("emits the same ops as the pre-fix linear-scan replay (behaviour unchanged)", () => {
    const rand = mulberry32(0x51ee7);
    const n = 60;
    for (let round = 0; round < 40; round++) {
      const ids = Array.from({ length: n }, (_, i) => `t-${i}`);
      const next = [...ids];
      // A random permutation, sometimes with a removal and an addition.
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      if (round % 3 === 0 && next.length > 4) next.splice(Math.floor(rand() * next.length), 1);
      if (round % 3 === 1) next.push(`added-${round}`);

      const base = baseDoc();
      const before = withTracks(base, ids.map((id) => ({ id, name: id })));
      const after = withTracks(base, next.map((id) => ({ id, name: id })));

      expect(orderOps(before, after)).toEqual(legacyOrderReplay(ids, next));
    }
  });

  it("round-trips a reordered entity list through applyDocDelta", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `t-${i}`);
    const next = [...ids].reverse();
    const base = baseDoc();
    const before = withTracks(base, ids.map((id) => ({ id, name: id })));
    const after = withTracks(base, next.map((id) => ({ id, name: id })));
    const ops = computeDocDelta(before, after).ops;
    const restored = applyDocDelta(before, ops) as unknown as { tracks: { id: string }[] };
    expect(restored.tracks.map((t) => t.id)).toEqual(next);
  });

  it("does not scan the entity list linearly per element", () => {
    const n = 300;
    const base = baseDoc();
    const tracks = Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, name: `Track ${i}` }));

    // Same entities, one moved to the front: the shape a single drag produces.
    const moved = [tracks[n - 1], ...tracks.slice(0, n - 1)];
    const before = withTracks(base, tracks);
    const after = withTracks(base, moved);

    // The pre-fix replay located each step's item with `sim.findIndex` — one
    // linear scan of the entity list per element, i.e. O(n²) scans. Counting
    // the scans is deterministic and independent of machine load, which a
    // wall-clock budget would not be. A CONSTANT number of scans is fine; a
    // number that grows with the list length is the defect.
    const findIndex = vi.spyOn(Array.prototype, "findIndex");
    try {
      computeDocDelta(before, after);
      const scans = findIndex.mock.calls.length;
      expect(scans).toBeLessThan(10);
    } finally {
      findIndex.mockRestore();
    }
  });
});
