import { describe, expect, it } from "vitest";
import { buildClipIndexById, buildCompTakeOrderIndex } from "../../src/ui/arrangement/clip-indexes";
import { pickVisibleClips } from "../../src/ui/arrangement/windowing";
import {
  arrangementSecondsBetweenTicks,
  arrangementSecondsBetweenTicksInSpans,
  buildArrangementSpans,
} from "../../src/project-model/scene-time";
import { BAR_TICKS } from "../../src/project-model/types";

/**
 * THE ARRANGEMENT'S PER-CLIP INDEXES (performance-cliff audit, findings C-3/C-4).
 *
 * The defect: the arrangement render asked the SAME question once per visible
 * clip, and each question scanned the whole document.
 *
 *   - "which take of the group is this comp clip sliced from?" rebuilt a `Set`
 *     over EVERY audio clip, per visible clip.
 *   - "how long is this clip in wall-clock seconds?" rebuilt the whole scene
 *     span map (a filter, a `scenes.find` per clip and a sort), per visible clip.
 *   - the windowing memo's forced pass walked EVERY clip of the document on
 *     every render, whether or not a gesture was running.
 *
 * The fix is ADR 0063's pattern: build the index once, outside the loop, and
 * invalidate it by identity.
 *
 * The gate below is a COUNT, not a millisecond. It does not care how busy the
 * machine is and it does not need a browser. Every count assertion is paired
 * with a POSITIVE CONTROL that proves the simulation is live: the pre-fix
 * implementation is reproduced verbatim in this file and must be the loud
 * baseline the fix beats.
 */

// ---------------------------------------------------------------------------
// POSITIVE CONTROL — the PRE-FIX implementations, verbatim.
// ---------------------------------------------------------------------------

interface TakeClip {
  id: string;
  takeGroupId?: string;
  takeId?: string;
  compSourceTakeId?: string;
}

interface TakeGroup {
  id: string;
  compTakeId?: string;
}

/**
 * The pre-fix comp-source take number: per visible clip, a `Set` over every
 * audio clip in the document.
 */
function preFixCompTakeNumber(
  clip: TakeClip,
  audioClips: readonly TakeClip[],
  takeGroups: readonly TakeGroup[],
): number {
  const clipTakeGroup = clip.takeGroupId ? takeGroups.find((group) => group.id === clip.takeGroupId) : undefined;
  return clip.compSourceTakeId
    ? Array.from(
        new Set(
          audioClips
            .filter(
              (candidate) =>
                candidate.takeGroupId === clip.takeGroupId &&
                candidate.takeId &&
                candidate.takeId !== clipTakeGroup?.compTakeId,
            )
            .map((candidate) => candidate.takeId!),
        ),
      ).indexOf(clip.compSourceTakeId) + 1
    : 0;
}

/**
 * The pre-fix windowing pick: the window scan stops early, but the FORCED pass
 * — the one that keeps a live gesture's clip mounted — walks the whole list.
 */
function preFixPick(
  list: readonly { id: string; startBar: number; lengthBars: number }[],
  firstBar: number,
  lastBar: number,
  forced: ReadonlySet<string>,
): { clip: { id: string; startBar: number; lengthBars: number }; index: number }[] {
  const out: { clip: { id: string; startBar: number; lengthBars: number }; index: number }[] = [];
  const taken = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    const clip = list[i]!;
    if (clip.startBar > lastBar) break; // sorted by startBar
    if (clip.startBar + clip.lengthBars >= firstBar) {
      out.push({ clip, index: i });
      taken.add(i);
    }
  }
  for (let i = 0; i < list.length; i++) {
    const clip = list[i]!;
    if (!taken.has(i) && forced.has(clip.id)) out.push({ clip, index: i });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** An array that counts how many of its ELEMENTS are read. */
function countingArray<T>(items: T[]): { list: T[]; reads: () => number } {
  let reads = 0;
  const target = items as unknown as T[];
  const proxy = new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(t, prop, recv);
    },
  });
  return { list: proxy, reads: () => reads };
}

// ---------------------------------------------------------------------------
// The fixtures.
// ---------------------------------------------------------------------------

const TAKE_GROUPS: TakeGroup[] = [
  { id: "g1", compTakeId: "comp-1" },
  { id: "g2", compTakeId: "comp-2" },
];

/**
 * The document's audio clips. Note the two traps the index has to survive:
 * `a3` repeats `a1`'s take id (a clip can have several segments of one take),
 * and `a4` IS the comp take (it must be excluded from the numbering).
 */
const AUDIO_CLIPS: TakeClip[] = [
  { id: "a1", takeGroupId: "g1", takeId: "pass-1" },
  { id: "a2", takeGroupId: "g1", takeId: "pass-2" },
  { id: "a3", takeGroupId: "g1", takeId: "pass-1" },
  { id: "a4", takeGroupId: "g1", takeId: "comp-1" },
  { id: "a7", takeGroupId: "g1", takeId: "pass-3" },
  { id: "a5", takeGroupId: "g2", takeId: "pass-9" },
  { id: "a6", takeId: "pass-loose" },
];

/** The clips the arrangement actually draws — the ones that asked the question. */
const COMP_CLIPS: TakeClip[] = [
  { id: "c1", takeGroupId: "g1", compSourceTakeId: "pass-1" },
  { id: "c2", takeGroupId: "g1", compSourceTakeId: "pass-2" },
  { id: "c3", takeGroupId: "g1", compSourceTakeId: "pass-3" },
  { id: "c4", takeGroupId: "g1", compSourceTakeId: "not-a-take" },
  { id: "c5", takeGroupId: "g2", compSourceTakeId: "pass-9" },
  { id: "c6", compSourceTakeId: "pass-loose" },
  { id: "c7", takeGroupId: "g1" },
];

const SCENE_CLIPS = [
  { sceneId: "s1", startBar: 0, lengthBars: 4 },
  { sceneId: "s2", startBar: 4, lengthBars: 4 },
  { sceneId: "s1", startBar: 8, lengthBars: 4 },
];

const SCENES = [
  { id: "s1", bpm: 120 },
  { id: "s2", bpm: 90 },
];

const PROJECT_BPM = 120;

// ---------------------------------------------------------------------------
// The gates.
// ---------------------------------------------------------------------------

describe("the comp-source take number is an index, not a scan per clip", () => {
  it("answers EXACTLY what the pre-fix scan answered", () => {
    const index = buildCompTakeOrderIndex(AUDIO_CLIPS, TAKE_GROUPS);

    const expected = COMP_CLIPS.map((clip) => preFixCompTakeNumber(clip, AUDIO_CLIPS, TAKE_GROUPS));

    // POSITIVE CONTROL: the fixture must produce a NON-TRIVIAL answer set. If
    // every number were 0 the comparison below would pass for free.
    expect(expected, "the fixture must exercise real numbering").toContain(2);
    expect(expected, "the fixture must exercise the not-found answer").toContain(0);
    expect(Math.max(...expected), "the fixture must exercise a number above 1").toBeGreaterThan(1);

    for (const [i, clip] of COMP_CLIPS.entries()) {
      expect(index.numberOf(clip.takeGroupId, clip.compSourceTakeId), `clip ${clip.id}`).toBe(expected[i]!);
    }
  });

  it("finds the take group the same way the pre-fix `find` did", () => {
    const index = buildCompTakeOrderIndex(AUDIO_CLIPS, TAKE_GROUPS);
    for (const clip of COMP_CLIPS) {
      const preFix = clip.takeGroupId ? TAKE_GROUPS.find((group) => group.id === clip.takeGroupId) : undefined;
      expect(index.groupOf(clip.takeGroupId), `group of ${clip.id}`).toEqual(preFix);
    }
  });

  it("keeps the FIRST take group when the document has a duplicate id", () => {
    const duplicated: TakeGroup[] = [
      { id: "g1", compTakeId: "first" },
      { id: "g1", compTakeId: "second" },
    ];
    const index = buildCompTakeOrderIndex(AUDIO_CLIPS, duplicated);
    // `Array.prototype.find` returns the FIRST match — the index must agree.
    expect(index.groupOf("g1")?.compTakeId).toBe("first");
  });
});

describe("the scene span map is built once and walked per clip", () => {
  it("answers EXACTLY what the pre-fix per-clip rebuild answered", () => {
    const spans = buildArrangementSpans(SCENE_CLIPS, SCENES, PROJECT_BPM, BAR_TICKS);

    // A grid of questions across the pinned scene and the gaps.
    const queries: [number, number][] = [
      [0, BAR_TICKS],
      [0, BAR_TICKS * 4],
      [BAR_TICKS * 3, BAR_TICKS * 5],
      [BAR_TICKS * 4, BAR_TICKS * 8],
      [BAR_TICKS * 8, BAR_TICKS * 12],
      [BAR_TICKS * 6, BAR_TICKS * 2],
      [BAR_TICKS, BAR_TICKS],
    ];

    for (const [from, to] of queries) {
      const preFix = arrangementSecondsBetweenTicks(SCENE_CLIPS, SCENES, from, to, PROJECT_BPM, BAR_TICKS);
      const now = arrangementSecondsBetweenTicksInSpans(spans, from, to, PROJECT_BPM);
      expect(now, `ticks ${from}..${to}`).toBeCloseTo(preFix, 9);
    }
  });

  it("really integrates the PINNED tempo — a project-tempo-only map would be a different number", () => {
    const spans = buildArrangementSpans(SCENE_CLIPS, SCENES, PROJECT_BPM, BAR_TICKS);
    // Four bars inside the 90 BPM scene.
    const pinned = arrangementSecondsBetweenTicksInSpans(spans, BAR_TICKS * 4, BAR_TICKS * 8, PROJECT_BPM);
    const atProjectTempo = (BAR_TICKS * 4 * 60) / (PROJECT_BPM * 480);
    // POSITIVE CONTROL: the pinned scene must move the answer, otherwise the
    // comparison above is comparing a number with itself.
    expect(pinned, "the pinned scene must change the wall-clock length").not.toBeCloseTo(atProjectTempo, 6);
    expect(pinned).toBeCloseTo((BAR_TICKS * 4 * 60) / (90 * 480), 9);
  });

  it("keeps the sign of a reversed question", () => {
    const spans = buildArrangementSpans(SCENE_CLIPS, SCENES, PROJECT_BPM, BAR_TICKS);
    const forward = arrangementSecondsBetweenTicksInSpans(spans, BAR_TICKS, BAR_TICKS * 5, PROJECT_BPM);
    const backward = arrangementSecondsBetweenTicksInSpans(spans, BAR_TICKS * 5, BAR_TICKS, PROJECT_BPM);
    expect(backward).toBeCloseTo(-forward, 9);
  });
});

describe("the window's forced pass is a lookup, not a walk over the document", () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `c-${i}`, startBar: i, lengthBars: 1 }));

  it("reads the document ONCE for the index, then never again for the forced pass", () => {
    const { list, reads } = countingArray(items);

    const indexById = buildClipIndexById(list);
    const readsAfterIndex = reads();

    // The window covers the first six bars; the gesture owns the LAST clip.
    const out = pickVisibleClips(list, indexById, 0, 5, new Set(["c-999"]));
    const forcedReads = reads() - readsAfterIndex;

    expect(out.length, "the window clips plus the forced clip must be rendered").toBe(7);
    expect(out[out.length - 1]!.clip.id, "the forced clip must be the last one").toBe("c-999");

    // POSITIVE CONTROL: the pre-fix forced pass read EVERY clip of the
    // document, on every render.
    const control = countingArray(items);
    preFixPick(control.list, 0, 5, new Set(["c-999"]));
    expect(control.reads(), "the pre-fix forced pass must be the loud baseline").toBeGreaterThanOrEqual(1000);

    expect(forcedReads, "the forced pass must not read the document").toBeLessThan(20);
  });

  it("returns EXACTLY what the pre-fix pick returned", () => {
    const indexById = buildClipIndexById(items);
    for (const forced of [new Set<string>(), new Set(["c-999"]), new Set(["c-3", "c-500"])]) {
      const preFix = preFixPick(items, 0, 5, forced);
      const now = pickVisibleClips(items, indexById, 0, 5, forced);
      expect(now.map((entry) => [entry.clip.id, entry.index])).toEqual(
        preFix.map((entry) => [entry.clip.id, entry.index]),
      );
    }
  });

  it("keeps the index's FIRST match, like `Array.prototype.find`", () => {
    const duplicated = [
      { id: "x", startBar: 0, lengthBars: 1 },
      { id: "x", startBar: 1, lengthBars: 1 },
    ];
    const index = buildClipIndexById(duplicated);
    expect(index.get("x")!.index, "the first match wins").toBe(0);
    expect(index.get("x")!.clip).toBe(duplicated[0]!);
  });
});
