import { describe, it, expect } from "vitest";
import { morphPatterns } from "../src/intent/morph";
import { pushGhost, listGhosts, getGhost, removeGhost, clearGhosts, GHOST_CAP } from "../src/intent/versions";
import type { NoteEvent, Pattern } from "../src/project-model/types";

let noteSeq = 0;
function note(pitch: number, start: number, duration: number, velocity: number): NoteEvent {
  noteSeq += 1;
  return { id: `n${noteSeq}`, pitch, start, duration, velocity };
}

function pattern(name: string, rows: Record<string, number[]>, notes: NoteEvent[] = [], stepCount = 16): Pattern {
  const byId: Pattern["notes"] = {};
  for (const n of notes) byId[n.id] = [n];
  return { id: `p-${name}`, name, stepCount, rows, notes: byId };
}

function rowValues(p: Pattern, pad: string): number[] {
  return p.rows[pad] ?? [];
}

function noteList(p: Pattern): NoteEvent[] {
  return Object.values(p.notes).flat();
}

describe("morphPatterns (ghost crossfade)", () => {
  const a = pattern("A", { kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }, [note(60, 0, 2, 0.4)]);
  const b = pattern("B", { kick: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] }, [note(60, 0, 4, 0.8)]);

  it("endpoints reproduce their side exactly", () => {
    const atA = morphPatterns(a, b, 0);
    const atB = morphPatterns(a, b, 1);
    expect(atA).not.toBeNull();
    expect(atB).not.toBeNull();
    expect(rowValues(atA!, "kick")).toEqual(rowValues(a, "kick"));
    expect(rowValues(atB!, "kick")).toEqual(rowValues(b, "kick"));
    const notesA = noteList(atA!);
    expect(notesA).toHaveLength(1);
    expect([notesA[0].pitch, notesA[0].start, notesA[0].duration, notesA[0].velocity]).toEqual([60, 0, 2, 0.4]);
    const notesB = noteList(atB!);
    expect([notesB[0].duration, notesB[0].velocity]).toEqual([4, 0.8]);
  });

  it("midpoints interpolate rows and matched notes", () => {
    const mid = morphPatterns(a, b, 0.5)!;
    // kick steps where A=0,B=1 → 0.5; where both 1 → 1
    expect(rowValues(mid, "kick")[2]).toBe(0.5);
    expect(rowValues(mid, "kick")[0]).toBe(1);
    const [n] = noteList(mid);
    expect(n.duration).toBe(3);
    expect(n.velocity).toBe(0.6);
    expect(mid.name).toContain("50%");
  });

  it("unmatched notes switch at the midpoint", () => {
    const sparse = pattern("S", {}, [note(62, 4, 2, 0.9)]);
    const empty = pattern("E", {}, []);
    expect(noteList(morphPatterns(sparse, empty, 0.25)!)).toHaveLength(1);
    expect(noteList(morphPatterns(sparse, empty, 0.75)!)).toHaveLength(0);
    expect(noteList(morphPatterns(empty, sparse, 0.25)!)).toHaveLength(0);
    expect(noteList(morphPatterns(empty, sparse, 0.75)!)).toHaveLength(1);
  });

  it("unions pads across sides", () => {
    const withHat = pattern("H", { hat: new Array<number>(16).fill(1) });
    const noHat = pattern("N", { kick: new Array<number>(16).fill(1) });
    const mid = morphPatterns(withHat, noHat, 0.5)!;
    expect(rowValues(mid, "hat")[0]).toBe(0.5);
    expect(rowValues(mid, "kick")[0]).toBe(0.5);
  });

  it("refuses mismatched step counts", () => {
    expect(morphPatterns(a, pattern("C", {}, [], 32), 0.5)).toBeNull();
  });

  it("never aliases inputs and mints fresh ids", () => {
    const rowsBefore = JSON.stringify(a.rows);
    const out = morphPatterns(a, b, 0.5)!;
    expect(out.id).not.toBe(a.id);
    expect(out.id).not.toBe(b.id);
    const ids = noteList(out).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    out.rows["kick"]![0] = 999;
    expect(JSON.stringify(a.rows)).toBe(rowsBefore);
  });

  it("clamps t and treats NaN as A", () => {
    expect(rowValues(morphPatterns(a, b, -5)!, "kick")).toEqual(rowValues(a, "kick"));
    expect(rowValues(morphPatterns(a, b, 42)!, "kick")).toEqual(rowValues(b, "kick"));
    expect(rowValues(morphPatterns(a, b, Number.NaN)!, "kick")).toEqual(rowValues(a, "kick"));
  });
});

describe("ghost version stack", () => {
  function ghostPattern(name: string, fill: number): Pattern {
    return pattern(name, { kick: new Array<number>(16).fill(fill) });
  }

  it("push/list/get/remove/clear round-trip", () => {
    clearGhosts();
    const g = pushGhost(ghostPattern("take", 1), "V1 · take", "dark trap");
    expect(listGhosts()).toHaveLength(1);
    expect(getGhost(g.id)).toBe(g);
    expect(g.prompt).toBe("dark trap");
    removeGhost(g.id);
    expect(listGhosts()).toHaveLength(0);
    expect(getGhost(g.id)).toBeNull();
    pushGhost(ghostPattern("x", 0), "a", null);
    clearGhosts();
    expect(listGhosts()).toHaveLength(0);
  });

  it("dedupes consecutive identical content", () => {
    clearGhosts();
    const first = pushGhost(ghostPattern("take", 1), "V1", null);
    const second = pushGhost(ghostPattern("take-copy", 1), "V2", null);
    expect(second).toBe(first);
    expect(listGhosts()).toHaveLength(1);
  });

  it("caps at GHOST_CAP, newest survive", () => {
    clearGhosts();
    for (let i = 0; i < GHOST_CAP + 4; i++) {
      pushGhost(ghostPattern(`take${i}`, i % 2), `V${i}`, null);
    }
    const list = listGhosts();
    expect(list).toHaveLength(GHOST_CAP);
    expect(list[list.length - 1].label).toBe(`V${GHOST_CAP + 3}`);
  });
});
