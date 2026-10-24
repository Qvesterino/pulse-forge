import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { moveArrangementClip, splitArrangementClipAtTick, trimArrangementClipStart } from "../src/commands/arrangement";
import { noteEventsInWindow, patternBaseTickForClip, sceneBaseTickForClip } from "../src/project-model/events";
import { computeSceneIntensity } from "../src/project-model/intensity";
import { midiPhraseLengthTicks } from "../src/project-model/midiTime";
import { ticksPerBar } from "../src/project-model/schema";
import { STEP_TICKS, type ArrangementClip, type NoteEvent, type ProjectDocument } from "../src/project-model/types";

/**
 * THE AUDIBLE LEG OF THE SCENE LANE.
 *
 * A scene clip is a WINDOW on a scene, and the scene carries TWO contents
 * that run on TWO different clocks:
 *
 *   - the scene's PATTERN, which LOOPS — the phase wraps, because the pattern
 *     repeats;
 *   - the scene's INTENSITY curve, which does NOT loop — the offset grows,
 *     because the curve is a one-way ramp.
 *
 * The scene-clip matrix (`tests/scene-clip-edit-matrix.test.ts`) pins that
 * ARITHMETIC: what the phase becomes, which fields a verb owns, whether undo
 * restores the document. It cannot tell whether the clip PLAYED the pattern
 * its phase points at — a document can hold a perfect phase and still
 * schedule the wrong notes.
 *
 * THE ORACLE IS THE SHARED RESOLVER, NOT A PRIVATE COPY. The scene's audible
 * content is `patternBaseTickForClip` + `noteEventsInWindow` (plus
 * `drumHitsInWindow` for the drums), and BOTH playback paths use exactly
 * those:
 *
 *   src/scheduler/Scheduler.ts    patternBaseTickForClip -> schedulePatternWindow
 *   src/rendering/renderer.ts     patternBaseTickForClip -> noteEventsInWindow
 *
 * So an assertion about their output is an assertion about WHAT THE USER
 * HEARS, live and in the export.
 *
 * THE FIXTURE SPEAKS. Every note of the fixture pattern has its own pitch, so
 * an event list can be read as a melody: pitch 60 is the first note, 62 the
 * second, 64 the third, 65 the fourth. A leg that could only say "some notes
 * played" could not tell a continuation from a restart.
 *
 * TWO PERIODS, AND THE SCENE LANE NAMES THE WRONG ONE. This is the finding
 * this file measures (D4 in the audit):
 *
 *   - the DRUMS repeat at the step GRID (`pattern.stepCount * STEP_TICKS`);
 *   - the MELODY repeats at the PHRASE (`midiPhraseLengthTicks`), which is
 *     longer as soon as one note outlives the grid;
 *   - the scene clip's phase is wrapped against the GRID.
 *
 * The MIDI lane had exactly this defect and was repaired in wave 1 (F4): its
 * phase wraps against the PHRASE. The scene lane still wraps against the
 * grid. While the metrical bar is a whole number of grid steps, the two
 * periods agree well enough for the content to ride along. When they do not
 * (a 12-step scene pattern in 4/4, or a 16-step pattern in 6/8), the phase
 * advance re-seats the pattern's step 0 somewhere else, and the scene's
 * content slides inside the region — measurably, and audibly at the seam.
 */

const TRACKED_NOTES: NoteEvent[] = [
  { id: "s1", pitch: 60, start: 0, duration: 240, velocity: 0.8 },
  { id: "s2", pitch: 62, start: 480, duration: 240, velocity: 0.8 },
  { id: "s3", pitch: 64, start: 960, duration: 960, velocity: 0.8 },
];

/**
 * The 16-step fixture. The third note ends at 1920 — exactly the grid — and
 * the fourth outlives it, so the phrase is longer than the grid and the two
 * periods cannot be told apart.
 */
const GRID_NOTES: NoteEvent[] = [
  ...TRACKED_NOTES,
  // The last note ENDS at 2400 — past the 1920-tick grid.
  { id: "s4", pitch: 65, start: 1200, duration: 1200, velocity: 0.8 },
];

interface SceneFixture {
  store: ProjectStore;
  clipId: string;
  sceneId: string;
  patternId: string;
  trackId: string;
}

/**
 * The house template's scene clip, with the scene's pattern replaced by a
 * controlled one (fixed pitches, known lengths). The house scene itself is
 * kept — only its pattern is swapped — so the fixture rides on a scene that
 * the normalizer already accepts.
 */
function storeWithScenePattern(stepCount: number, notes: NoteEvent[]): SceneFixture {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((candidate) => candidate.kind === "instrument")!;
  const clip = base.arrangement.clips[0]!;
  const scene = base.scenes.find((candidate) => candidate.id === clip.sceneId)!;
  const doc: ProjectDocument = {
    ...base,
    patterns: base.patterns.map((candidate) =>
      candidate.id === scene.patternId
        ? { ...candidate, stepCount, rows: { [track.id]: [] }, notes: { [track.id]: notes } }
        : candidate,
    ),
  };
  const store = new ProjectStore(doc);
  return { store, clipId: clip.id, sceneId: scene.id, patternId: scene.patternId, trackId: track.id };
}

const clipOf = (doc: ProjectDocument, id: string): ArrangementClip =>
  doc.arrangement.clips.find((candidate) => candidate.id === id)!;

/** The step grid of the clip's scene pattern — the period the DRUMS repeat at. */
function gridTicks(doc: ProjectDocument, clipId: string): number {
  const clip = clipOf(doc, clipId);
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId)!;
  const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId)!;
  return pattern.stepCount * STEP_TICKS;
}

/** The period the clip's scene MELODY repeats at. */
function phraseTicks(doc: ProjectDocument, clipId: string): number {
  const clip = clipOf(doc, clipId);
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId)!;
  const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId)!;
  const notes = Object.values(pattern.notes ?? {}).flat();
  return midiPhraseLengthTicks(pattern.stepCount, notes);
}

/** The attacks the clip actually plays, as (absolute tick, pitch) pairs. */
function sceneAttacks(doc: ProjectDocument, clipId: string): Array<[number, number]> {
  const clip = clipOf(doc, clipId);
  const barUnit = ticksPerBar(doc);
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId)!;
  const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId)!;
  const base = patternBaseTickForClip(clip, barUnit);
  const from = clip.startBar * barUnit;
  const to = from + clip.lengthBars * barUnit;
  return noteEventsInWindow(pattern, base, from, to).map((event) => [event.tick, event.note.pitch] as [number, number]);
}

/** The same attacks, measured from the clip's own start. */
function relativeAttacks(doc: ProjectDocument, clipId: string): Array<[number, number]> {
  const start = clipOf(doc, clipId).startBar * ticksPerBar(doc);
  return sceneAttacks(doc, clipId).map(([tick, pitch]) => [tick - start, pitch] as [number, number]);
}

/**
 * The pitch SOUNDING at an absolute tick — the last attack at or before it
 * whose note has not ended yet. This is the ear's oracle: an attack list
 * alone cannot say whether a note is still ringing.
 */
function soundingAt(doc: ProjectDocument, clipId: string, tick: number): number | null {
  const clip = clipOf(doc, clipId);
  const barUnit = ticksPerBar(doc);
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId)!;
  const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId)!;
  const base = patternBaseTickForClip(clip, barUnit);
  const from = clip.startBar * barUnit;
  const to = from + clip.lengthBars * barUnit;
  const events = noteEventsInWindow(pattern, base, from, to);
  let sounding: number | null = null;
  for (const event of events) {
    if (event.tick > tick) break;
    if (tick < event.tick + event.note.duration) sounding = event.note.pitch;
  }
  return sounding;
}

describe("the scene lane — what the clip actually PLAYS", () => {
  it("a scene clip plays its scene's pattern from its phase", () => {
    const { store, clipId } = storeWithScenePattern(16, GRID_NOTES);
    const attacks = sceneAttacks(store.doc, clipId);
    expect(attacks.length, "the scene's pattern must play notes").toBeGreaterThan(0);
    // The base is the clip's start MINUS its phase: the pattern's tick 0 sits
    // at the clip's start when the phase is 0.
    const clip = clipOf(store.doc, clipId);
    const barUnit = ticksPerBar(store.doc);
    const base = patternBaseTickForClip(clip, barUnit);
    expect(base, "an untrimmed clip plays the pattern from its first tick").toBe(clip.startBar * barUnit);
    expect(attacks[0], "the pattern's first note is the region's first attack").toEqual([clip.startBar * barUnit, 60]);
  });

  it("a split hands the right fragment the continued phase, and the fragments tile the original's attacks", () => {
    const { store, clipId } = storeWithScenePattern(16, GRID_NOTES);
    const original = sceneAttacks(store.doc, clipId);
    const barUnit = ticksPerBar(store.doc);
    const clip = clipOf(store.doc, clipId);
    const splitTick = (clip.startBar + 2) * barUnit;

    store.execute(splitArrangementClipAtTick(store.doc, clipId, splitTick));
    const fragments = [...store.doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    expect(fragments.length, "the scene clip must split into two").toBe(2);
    const left = fragments[0]!;
    const right = fragments[1]!;

    expect(right.phaseOffsetTicks ?? 0, "the right half continues the pattern's phase, wrapped modulo the grid").toBe(
      (2 * barUnit) % gridTicks(store.doc, clipId),
    );
    expect(right.sceneOffsetTicks ?? 0, "the right half continues the intensity curve").toBe(2 * barUnit);

    const played = [...sceneAttacks(store.doc, left.id), ...sceneAttacks(store.doc, right.id)];
    expect(played, "the fragments must tile the original's attacks — no gap, no double").toEqual(original);
  });

  it("the scene's INTENSITY curve does not loop: a trim continues it, it does not restart it", () => {
    const { store, clipId } = storeWithScenePattern(16, GRID_NOTES);
    const clip = clipOf(store.doc, clipId);
    const scene = store.doc.scenes.find((candidate) => candidate.id === clip.sceneId)!;
    const barUnit = ticksPerBar(store.doc);
    // A scene with a curve, so the offset is observable.
    const withCurve: ProjectDocument = {
      ...store.doc,
      scenes: store.doc.scenes.map((candidate) =>
        candidate.id === scene.id
          ? {
              ...candidate,
              intensityCurve: [
                { offset: 0, value: 0.2 },
                { offset: barUnit * 8, value: 0.9 },
              ],
            }
          : candidate,
      ),
    };
    const intensityAt = (doc: ProjectDocument, tick: number): number => {
      const current = clipOf(doc, clipId);
      const currentScene = doc.scenes.find((candidate) => candidate.id === current.sceneId)!;
      const base = sceneBaseTickForClip(current, barUnit);
      return computeSceneIntensity(currentScene, base, tick);
    };

    const before = intensityAt(withCurve, clip.startBar * barUnit);
    store.execute(trimArrangementClipStart(store.doc, clipId, clip.startBar + 1));
    const trimmed = clipOf(store.doc, clipId);
    const after = intensityAt(store.doc, trimmed.startBar * barUnit);

    expect(trimmed.sceneOffsetTicks, "the scene offset grows").toBe(barUnit);
    expect(
      after,
      "the trimmed clip's intensity continues the curve one bar further along — it must not restart",
    ).toBeGreaterThan(before);
  });

  it("the scene lane refuses an overlapping placement, so the notes can never double", () => {
    const { store, clipId } = storeWithScenePattern(16, GRID_NOTES);
    const clip = clipOf(store.doc, clipId);
    const before = sceneAttacks(store.doc, clipId);

    // A SECOND scene clip right after the first one, so the overlap has
    // somewhere to land.
    const withNeighbour: ProjectDocument = {
      ...store.doc,
      arrangement: {
        ...store.doc.arrangement,
        clips: [
          ...store.doc.arrangement.clips,
          {
            id: "clip-neighbour",
            sceneId: clip.sceneId,
            startBar: clip.startBar + clip.lengthBars,
            lengthBars: 2,
          } as ArrangementClip,
        ],
      },
    };
    const neighbourStart = withNeighbour.arrangement.clips[1]!.startBar;
    const lane = new ProjectStore(withNeighbour);

    // Moving the first clip ONTO the second one would double every note.
    expect(() => lane.execute(moveArrangementClip(lane.doc, clipId, neighbourStart))).toThrow();
    expect(sceneAttacks(lane.doc, clipId), "the refused move left the notes single").toEqual(before);
  });
});

describe("the scene lane — the phase and the notes must name the same tick", () => {
  it("a trim advances the phase modulo the step GRID, and the region's content rides along", () => {
    const { store, clipId } = storeWithScenePattern(16, GRID_NOTES);
    const barUnit = ticksPerBar(store.doc);
    const grid = gridTicks(store.doc, clipId);
    const phrase = phraseTicks(store.doc, clipId);
    expect(phrase, "the fixture's melody must outlive the grid, or the test proves nothing").toBeGreaterThan(grid);

    const before = sceneAttacks(store.doc, clipId);
    const beforeRelative = relativeAttacks(store.doc, clipId);

    store.execute(trimArrangementClipStart(store.doc, clipId, 1));
    const trimmed = clipOf(store.doc, clipId);
    const after = sceneAttacks(store.doc, clipId);

    expect(
      trimmed.phaseOffsetTicks ?? 0,
      "the phase is wrapped against the grid — which is the grid, not the phrase",
    ).toBe(barUnit % grid);
    expect(
      relativeAttacks(store.doc, clipId),
      "the region's content rides along: the same melody, the same place inside the region",
    ).toEqual(beforeRelative);
    expect(
      after.map(([tick]) => tick),
      "the absolute attacks moved with the region — by exactly the trim",
    ).toEqual(before.map(([tick]) => tick + barUnit));
  });

  it("the trim cuts the note that was sustaining across the trim point — the window decides", () => {
    const { store, clipId } = storeWithScenePattern(16, GRID_NOTES);
    const barUnit = ticksPerBar(store.doc);
    const sustaining = GRID_NOTES[3]!;
    expect(
      sustaining.start + sustaining.duration,
      "the fixture's note must sustain across the trim point, or the test proves nothing",
    ).toBeGreaterThan(barUnit);
    expect(sustaining.start, "and it must attack before it").toBeLessThan(barUnit);

    expect(
      soundingAt(store.doc, clipId, barUnit),
      "before the trim, the sustaining note is the one you hear at the trim point",
    ).toBe(sustaining.pitch);

    store.execute(trimArrangementClipStart(store.doc, clipId, 1));
    expect(
      soundingAt(store.doc, clipId, barUnit),
      "after the trim, the sustain is gone — the region starts with the next attack instead",
    ).not.toBe(sustaining.pitch);
    expect(
      sceneAttacks(store.doc, clipId).some(([tick, pitch]) => tick === sustaining.start && pitch === sustaining.pitch),
      "the sustaining note's attack is outside the new window, so it is never re-attacked",
    ).toBe(false);
  });
});

/**
 * D4 — THE OPEN FINDING.
 *
 * The scene clip's phase wraps against the step GRID, but the scene's melody
 * repeats at its PHRASE. While the metrical bar is a whole number of grid
 * steps, the phase advance keeps the region's content in place. When it is
 * not, the phase advance re-seats the pattern's step 0 inside the region and
 * the content slides — the region's downbeat loses the pattern's downbeat.
 *
 * The MIDI lane had this defect and was repaired in wave 1 (F4): its phase
 * wraps against the phrase. The scene lane still wraps against the grid.
 *
 * THIS SPEC PINS THE CURRENT BEHAVIOUR, not the desired one. It is the
 * executable form of the finding: if the scene lane's phase is ever wrapped
 * against the pattern's full repeat period (the least common multiple of the
 * grid and the phrase), this spec goes RED — which is exactly when the audit
 * report should be updated.
 */
describe("D4 (open) — the scene lane's phase names the GRID, but the melody repeats at the PHRASE", () => {
  it("a split of a scene whose grid does not divide the bar plays a DIFFERENT note at the seam", () => {
    const { store, clipId } = storeWithScenePattern(12, TRACKED_NOTES);
    const barUnit = ticksPerBar(store.doc);
    const grid = gridTicks(store.doc, clipId);
    const phrase = phraseTicks(store.doc, clipId);
    expect(phrase, "the melody must outlive the grid, or the periods cannot be told apart").toBeGreaterThan(grid);
    expect(
      barUnit % grid,
      "the metrical bar must NOT be a whole number of grid steps, or the finding cannot show itself",
    ).toBeGreaterThan(0);

    const original = sceneAttacks(store.doc, clipId);
    const clip = clipOf(store.doc, clipId);
    const seamTick = (clip.startBar + 2) * barUnit;

    store.execute(splitArrangementClipAtTick(store.doc, clipId, seamTick));
    const fragments = [...store.doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    const right = fragments[1]!;

    expect(
      right.phaseOffsetTicks ?? 0,
      "the right half's phase really did advance and wrap — the finding needs a moved phase",
    ).toBe((2 * barUnit) % grid);
    expect(
      right.phaseOffsetTicks ?? 0,
      "the phase must not be zero, or the test cannot tell the worlds apart",
    ).toBeGreaterThan(0);

    const originalAtSeam = original.find(([tick]) => tick === seamTick);
    const rightAtSeam = sceneAttacks(store.doc, right.id).find(([tick]) => tick === seamTick);
    expect(originalAtSeam?.[1], "the original played the pattern's first note at the seam").toBe(60);
    expect(
      rightAtSeam?.[1],
      "D4: the right half plays a DIFFERENT note at the seam — the phase re-seated the pattern",
    ).toBe(64);

    const played = [...sceneAttacks(store.doc, fragments[0]!.id), ...sceneAttacks(store.doc, right.id)];
    expect(played, "D4: the fragments do NOT tile the original's attacks — the seam changed the music").not.toEqual(
      original,
    );
  });

  it("the phase can never name the phrase's second grid — it is confined to the first one", () => {
    const { store, clipId } = storeWithScenePattern(12, TRACKED_NOTES);
    const barUnit = ticksPerBar(store.doc);
    const grid = gridTicks(store.doc, clipId);
    const phrase = phraseTicks(store.doc, clipId);
    expect(phrase, "the phrase must be longer than the grid for the confinement to be a loss").toBeGreaterThan(grid);

    // Where in its own phrase the region's melody starts: the region's start
    // measured against the pattern's cycle.
    const melodicPhase = (doc: ProjectDocument, id: string): number => {
      const current = clipOf(doc, id);
      const start = current.startBar * ticksPerBar(doc);
      const base = patternBaseTickForClip(current, ticksPerBar(doc));
      return (((start - base) % phrase) + phrase) % phrase;
    };

    expect(melodicPhase(store.doc, clipId), "an untouched region starts the melody at the phrase's beginning").toBe(0);

    store.execute(trimArrangementClipStart(store.doc, clipId, 1));
    const trimmed = clipOf(store.doc, clipId);
    expect(
      trimmed.phaseOffsetTicks ?? 0,
      "the control: the trim really did move the phase, or the confinement below would be vacuous",
    ).toBe((barUnit % grid) as number);
    expect(melodicPhase(store.doc, clipId), "the trim moves the melody inside the phrase").toBe(barUnit % grid);
    expect(melodicPhase(store.doc, clipId), "and it stays inside the phrase's FIRST grid").toBeLessThan(grid);

    store.execute(splitArrangementClipAtTick(store.doc, clipId, 2 * barUnit));
    const right = [...store.doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)[1]!;
    expect(
      melodicPhase(store.doc, right.id),
      "a split's right half also stays inside the phrase's first grid",
    ).toBeLessThan(grid);
    expect(phrase - grid, "the cost: this much melodic material can never start a region").toBeGreaterThan(0);
  });
});
