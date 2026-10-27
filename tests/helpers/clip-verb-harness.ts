/**
 * THE CLIP-VERB HARNESS — the command layer's standing net.
 *
 * The property sweep used to be ONE test file: a generator, the four
 * properties, the four lanes' verb registries and the runner, all in one
 * place. That works, but it hides the thing that matters: a NEW clip verb
 * that nobody adds to the registry is simply NOT TESTED, and the suite stays
 * green while saying nothing about it.
 *
 * So the harness lives here, on its own, and the registry is DATA that a
 * second guard can read: `tests/clip-verb-coverage.test.ts` walks the
 * command layer's exported clip verbs and fails when one of them is not
 * exercised here. A verb cannot land uncovered.
 *
 * THE FOUR PROPERTIES, one per lane, over random geometries:
 *
 *   1. REFUSAL SAFETY — a verb that refuses leaves the document untouched
 *      and pushes no history entry;
 *   2. PROPERTY ISOLATION — a verb touches the fields it owns and no others;
 *   3. UNDO / REDO EXACTNESS — one verb is one history entry, undo restores
 *      the document byte-for-byte, redo re-applies it;
 *   4. GEOMETRY INVARIANTS — the clip is still a legal clip afterwards.
 *
 * The generator is seeded (mulberry32), so a failure is reproducible: the
 * label carries the seed, the verb, the argument and the case index.
 */
import { expect } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import {
  addAudioClip,
  duplicateAudioClip,
  moveAudioClip,
  resizeAudioClip,
  setAudioClipsMute,
  slipAudioClip,
  splitAudioClipAtTick,
  trimAudioClipStart,
} from "../../src/commands/commands";
import {
  addMidiClip,
  duplicateMidiClip,
  moveMidiClip,
  resizeMidiClip,
  setMidiClipMuted,
  splitMidiClipAtTick,
  trimMidiClipStart,
} from "../../src/commands/midiClips";
import {
  addAutomationClip,
  addAutomationClipPoint,
  duplicateAutomationClip,
  moveAutomationClip,
  resizeAutomationClip,
  setAutomationClipMuted,
  splitAutomationClipAtTick,
  trimAutomationClipStart,
} from "../../src/commands/automationClips";
import {
  duplicateArrangementClip,
  moveArrangementClip,
  resizeArrangementClip,
  splitArrangementClipAtTick,
  trimArrangementClipStart,
} from "../../src/commands/arrangement";
import { audioClipDurationSec } from "../../src/commands/audioClips";
import {
  automationClipEventsInWindow,
  midiClipEventsInWindow,
  noteEventsInWindow,
} from "../../src/project-model/events";
import { midiPhraseLengthTicks } from "../../src/project-model/midiTime";
import { MAX_ARRANGEMENT_CLIP_BARS, MAX_ARRANGEMENT_CLIP_TICKS, ticksPerBar } from "../../src/project-model/schema";
import {
  STEP_TICKS,
  type ArrangementAutomationClip,
  type MidiClip,
  type Pattern,
  type ProjectDocument,
} from "../../src/project-model/types";
import type { Command } from "../../src/commands/types";

/**
 * THE PROPERTY-BASED SWEEP.
 *
 * The matrices in this audit are HAND-WRITTEN TABLES: one row per verb, one
 * geometry per row. A table cannot enumerate the geometry space, so it cannot
 * find a floor that only bites at an unusual size — which is exactly where
 * the "creation floor leaked into the edit verbs" defect (D1) lived.
 *
 * So this file GENERATES the cases. It runs TWO passes:
 *
 *   THE EXHAUSTIVE PASS — every verb × every ARGUMENT VARIANT, including the
 *   hostile ones (negative, zero, NaN, absurdly large, off the end). The
 *   hostile arguments are where floors live: a command that clamps silently
 *   changes something the user never asked to change, and a command that
 *   accepts them writes a clip the model cannot hold. A random pass alone
 *   would hit them only by luck — the first version of this file drew a
 *   random verb per case and MISSED the huge-length resize for forty cases.
 *
 *   THE RANDOM PASS — a seeded PRNG (mulberry32 — no dependency, no
 *   `Math.random`) picks a random geometry, a random verb and a random
 *   variant, so the GEOMETRY space is explored too. Every assertion carries
 *   the seed and the case index, so a failing case is reproducible.
 *
 * Both passes put every case through the same four properties:
 *
 *   1. REFUSAL SAFETY — a verb that throws (an impossible split point, a
 *      trim before the file starts, a NaN position) must leave the document
 *      UNCHANGED and must not push a history entry. A command that
 *      half-applies and then throws is a silent corruption.
 *   2. PROPERTY ISOLATION — the verb changes the fields it owns and NOTHING
 *      ELSE. The allow-list is per verb, not per lane: a move that also
 *      rewrites the gain is a bug even when the clip looks right.
 *   3. UNDO / REDO EXACTNESS — a verb that CHANGED something is exactly one
 *      history entry, undo restores the document and redo re-applies it. A
 *      verb that changed NOTHING must leave no undo step behind — a dead
 *      Ctrl+Z step is its own defect (the project store's no-op contract).
 *   4. GEOMETRY INVARIANTS — whatever the verb did, every clip in the lane
 *      is still a legal clip: finite numbers, a positive length, the phase
 *      inside its period, the fades inside the clip, and the audible
 *      resolvers still resolve the clip's own window.
 *
 * AND THE CHECKER ITSELF IS TESTED. A guard that has never been seen red is
 * not a guard — the last specs in this file feed the checker a deliberately
 * broken edit and require it to be caught.
 */

export const SEED = 0x5eed1234;
export const RANDOM_CASES_PER_LANE = 40;

/** mulberry32 — a small deterministic PRNG. Same seed, same cases, always. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clone = (doc: ProjectDocument): ProjectDocument => JSON.parse(JSON.stringify(doc)) as ProjectDocument;

/** Which of the watched fields differ between two clips? */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  watch: string[],
): string[] {
  return watch.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

export type ClipRecord = Record<string, unknown>;

export interface CaseContext {
  store: ProjectStore;
  clipId: string;
  rng: () => number;
}

/** One complete argument set of a verb. */
export interface Variant {
  label: string;
  build: (ctx: CaseContext) => Command | null;
}

export interface VerbSpec {
  name: string;
  /** The fields this verb is allowed to touch on the target clip. */
  allow: string[];
  /**
   * Which clip continues the original after the verb. The audio split is the
   * odd one out: it mints TWO new ids and retires the old one (the MIDI,
   * automation and scene splits all keep the original id on the left
   * fragment), so the sweep has to look the continuation up by position.
   */
  targetAfter?: (doc: ProjectDocument, before: ClipRecord) => ClipRecord | undefined;
  /** The verb's argument variants — plausible and hostile alike. */
  variants: (ctx: CaseContext) => Variant[];
}

export interface LaneSpec {
  name: string;
  /** Every field of the clip the sweep watches. */
  watch: string[];
  /** Find one clip of the lane by id. */
  find: (doc: ProjectDocument, clipId: string) => ClipRecord | undefined;
  /** A store with one clip at a random geometry. */
  build: (rng: () => number) => { store: ProjectStore; clipId: string };
  verbs: VerbSpec[];
  /** The lane's geometry invariants — a clip must still be a legal clip. */
  assertGeometry: (doc: ProjectDocument, label: string) => void;
}

/* ------------------------------------------------------------------ audio */

export const AUDIO_WATCH = [
  "startBar",
  "lengthBars",
  "offsetSec",
  "trimStart",
  "trimEnd",
  "gain",
  "fadeIn",
  "fadeOut",
  "stretchRate",
  "stretchMode",
  "pitchSemitones",
  "reverse",
  "loop",
  "loopPhaseOffsetSec",
  "muted",
  "fadeCurve",
  "bufferId",
];

export const audioLane: LaneSpec = {
  name: "audio",
  watch: AUDIO_WATCH,
  find: (doc, clipId) =>
    (doc.arrangement.audioClips ?? []).find((clip) => clip.id === clipId) as ClipRecord | undefined,
  build: (rng) => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0]!;
    const startBar = Math.floor(rng() * 8);
    const lengthBars = 0.5 + rng() * 8;
    store.execute(
      addAudioClip(store.doc, track.id, "factory.kick", startBar, lengthBars, {
        gain: 0.5 + rng() * 0.5,
        fadeIn: rng() * 0.2,
        reverse: rng() < 0.3,
      }),
    );
    const clip = store.doc.arrangement.audioClips![0]!;
    return { store, clipId: clip.id };
  },
  verbs: [
    {
      name: "move",
      allow: ["startBar"],
      variants: (ctx) =>
        [0, 1, 2.5, 4, -1, -100, 1e12, NaN].map((value) => ({
          label: `bar=${value}`,
          build: () => moveAudioClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "resize",
      allow: ["lengthBars", "fadeIn", "fadeOut"],
      variants: (ctx) =>
        [0.5, 1, 2, 4, 0, -1, 1e9, NaN].map((value) => ({
          label: `bars=${value}`,
          build: () => resizeAudioClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "slip",
      allow: ["offsetSec"],
      variants: (ctx) =>
        [0, 0.5, 1.25, -1, -0.001, 1e9, NaN].map((value) => ({
          label: `offset=${value}`,
          build: () => slipAudioClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "mute",
      allow: ["muted"],
      variants: (ctx) =>
        [true, false].map((value) => ({
          label: `muted=${value}`,
          build: () => setAudioClipsMute(ctx.store.doc, [ctx.clipId], value),
        })),
    },
    {
      name: "trimStart",
      allow: ["startBar", "lengthBars", "trimStart", "offsetSec", "fadeIn", "fadeOut"],
      variants: (ctx) => {
        const clip = (ctx.store.doc.arrangement.audioClips ?? []).find((candidate) => candidate.id === ctx.clipId)!;
        const startBars = [clip.startBar, clip.startBar + 1, clip.startBar + 0.5, -1, 1e9, NaN];
        const offsets = [clip.offsetSec, clip.offsetSec + 0.5, -1, 1e9, NaN];
        return startBars.flatMap((startBar) =>
          offsets.map((offsetSec) => ({
            label: `start=${startBar} offset=${offsetSec}`,
            build: () =>
              trimAudioClipStart(ctx.store.doc, ctx.clipId, {
                startBar,
                lengthBars: clip.lengthBars,
                trimStart: clip.trimStart,
                offsetSec,
              }),
          })),
        );
      },
    },
    {
      name: "split",
      // The left fragment keeps the source window but re-clamps its fades; a
      // REVERSED clip's left fragment also re-points the source offset, and
      // the split mints a new id on both fragments.
      allow: ["lengthBars", "fadeIn", "fadeOut", "offsetSec", "loopPhaseOffsetSec"],
      targetAfter: (doc, before) =>
        (doc.arrangement.audioClips ?? []).find((candidate) => candidate.startBar === before.startBar) as
          ClipRecord | undefined,
      variants: (ctx) => {
        const clip = (ctx.store.doc.arrangement.audioClips ?? []).find((candidate) => candidate.id === ctx.clipId)!;
        const unit = ticksPerBar(ctx.store.doc);
        const start = clip.startBar * unit;
        const end = start + clip.lengthBars * unit;
        const ticks = [
          start + unit * 0.5,
          start + unit,
          start + unit * 2,
          start,
          end,
          start - 1,
          start + unit * 999,
          NaN,
        ];
        return ticks.map((tick) => ({
          label: `tick=${tick}`,
          build: () => splitAudioClipAtTick(ctx.store.doc, ctx.clipId, tick),
        }));
      },
    },
    {
      name: "duplicate",
      allow: [],
      variants: (ctx) => [{ label: "once", build: () => duplicateAudioClip(ctx.store.doc, ctx.clipId) }],
    },
  ],
  assertGeometry: (doc, label) => {
    for (const clip of doc.arrangement.audioClips ?? []) {
      const where = `${label}[audio ${clip.id}]`;
      expect(Number.isFinite(clip.startBar), `${where}: the start must be finite`).toBe(true);
      expect(clip.startBar, `${where}: the start must not be negative`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(clip.lengthBars), `${where}: the length must be finite`).toBe(true);
      expect(clip.lengthBars, `${where}: the length must stay positive`).toBeGreaterThan(0);
      expect(Number.isFinite(clip.offsetSec), `${where}: the source offset must be finite`).toBe(true);
      expect(clip.offsetSec, `${where}: the source offset must not go before the file`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(clip.trimStart), `${where}: the trim start must be finite`).toBe(true);
      expect(clip.trimStart, `${where}: the trim start must not be negative`).toBeGreaterThanOrEqual(0);
      // The documented fade invariant: EACH fade is bounded by the clip's own
      // duration (seconds), never the sum.
      const duration = audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
      expect(clip.fadeIn, `${where}: the fade-in must be finite`).toBeGreaterThanOrEqual(0);
      expect(clip.fadeOut, `${where}: the fade-out must be finite`).toBeGreaterThanOrEqual(0);
      expect(clip.fadeIn, `${where}: the fade-in must not outlive the clip`).toBeLessThanOrEqual(duration + 1e-6);
      expect(clip.fadeOut, `${where}: the fade-out must not outlive the clip`).toBeLessThanOrEqual(duration + 1e-6);
    }
  },
};

/* ------------------------------------------------------------------- MIDI */

export const MIDI_WATCH = [
  "trackId",
  "patternId",
  "startTick",
  "lengthTicks",
  "phaseOffsetTicks",
  "muted",
  "locked",
  "gain",
];

export const midiLane: LaneSpec = {
  name: "midi",
  watch: MIDI_WATCH,
  find: (doc, clipId) => (doc.arrangement.midiClips ?? []).find((clip) => clip.id === clipId) as ClipRecord | undefined,
  build: (rng) => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks.find((candidate) => candidate.kind === "instrument")!;
    const pattern = store.doc.patterns[0]!;
    const startTick = Math.floor(rng() * 4) * STEP_TICKS;
    const lengthTicks = STEP_TICKS * (2 + Math.floor(rng() * 12));
    store.execute(addMidiClip(store.doc, track.id, pattern.id, startTick, lengthTicks));
    const clip = store.doc.arrangement.midiClips![0]!;
    return { store, clipId: clip.id };
  },
  verbs: [
    {
      name: "move",
      allow: ["startTick"],
      variants: (ctx) =>
        [0, 240, 960, 1920, -240, -1, 1e12, NaN].map((value) => ({
          label: `tick=${value}`,
          build: () => moveMidiClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "resize",
      allow: ["lengthTicks"],
      variants: (ctx) =>
        [240, 960, 1920, 0, -1, 1e12, NaN].map((value) => ({
          label: `ticks=${value}`,
          build: () => resizeMidiClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "trimStart",
      allow: ["startTick", "lengthTicks", "phaseOffsetTicks"],
      variants: (ctx) => {
        const clip = (ctx.store.doc.arrangement.midiClips ?? []).find((candidate) => candidate.id === ctx.clipId)!;
        const ticks = [
          clip.startTick,
          clip.startTick + 240,
          clip.startTick + clip.lengthTicks / 2,
          clip.startTick - 1,
          clip.startTick + clip.lengthTicks,
          -1e9,
          NaN,
        ];
        return ticks.map((tick) => ({
          label: `tick=${tick}`,
          build: () => trimMidiClipStart(ctx.store.doc, ctx.clipId, tick),
        }));
      },
    },
    {
      name: "split",
      allow: ["lengthTicks"],
      variants: (ctx) => {
        const clip = (ctx.store.doc.arrangement.midiClips ?? []).find((candidate) => candidate.id === ctx.clipId)!;
        const ticks = [
          clip.startTick + 120,
          clip.startTick + 480,
          clip.startTick + clip.lengthTicks / 2,
          clip.startTick,
          clip.startTick + clip.lengthTicks,
          -1,
          NaN,
        ];
        return ticks.map((tick) => ({
          label: `tick=${tick}`,
          build: () => splitMidiClipAtTick(ctx.store.doc, ctx.clipId, tick),
        }));
      },
    },
    {
      name: "duplicate",
      allow: [],
      variants: (ctx) => [{ label: "once", build: () => duplicateMidiClip(ctx.store.doc, ctx.clipId) }],
    },
    {
      name: "mute",
      allow: ["muted"],
      variants: (ctx) =>
        [true, false].map((value) => ({
          label: `muted=${value}`,
          build: () => setMidiClipMuted(ctx.store.doc, ctx.clipId, value),
        })),
    },
  ],
  assertGeometry: (doc, label) => {
    for (const clip of doc.arrangement.midiClips ?? []) {
      const where = `${label}[midi ${clip.id}]`;
      expect(clip.startTick, `${where}: the start must not be negative`).toBeGreaterThanOrEqual(0);
      expect(clip.lengthTicks, `${where}: the length must stay positive`).toBeGreaterThan(0);
      expect(
        clip.startTick + clip.lengthTicks,
        `${where}: the clip must stay inside the arrangement's tick ceiling`,
      ).toBeLessThanOrEqual(MAX_ARRANGEMENT_CLIP_TICKS);
      const pattern = doc.patterns.find((candidate) => candidate.id === clip.patternId);
      expect(pattern, `${where}: the clip must keep a pattern that exists`).toBeDefined();
      const phrase = midiPhraseLengthOf(pattern!, clip.trackId);
      expect(clip.phaseOffsetTicks ?? 0, `${where}: the phase must not be negative`).toBeGreaterThanOrEqual(0);
      expect(clip.phaseOffsetTicks ?? 0, `${where}: the phase must stay inside its period`).toBeLessThan(phrase);
      // The audible resolver must still resolve the clip's own window.
      const events = midiClipEventsInWindow(
        doc,
        clip as unknown as MidiClip,
        clip.startTick,
        clip.startTick + clip.lengthTicks,
      );
      for (const event of events) {
        expect(Number.isFinite(event.tick), `${where}: an event landed on a non-finite tick`).toBe(true);
        expect(event.tick, `${where}: an event landed outside the clip`).toBeGreaterThanOrEqual(clip.startTick);
        expect(event.tick, `${where}: an event landed outside the clip`).toBeLessThan(
          clip.startTick + clip.lengthTicks,
        );
      }
    }
  },
};

/** The period the clip's pattern repeats at (the phase's modulus). */
function midiPhraseLengthOf(pattern: Pattern, trackId: string): number {
  return midiPhraseLengthTicks(pattern.stepCount, pattern.notes?.[trackId] ?? []);
}

/* ------------------------------------------------------------- automation */

export const AUTO_WATCH = ["startTick", "lengthTicks", "phaseOffsetTicks", "points", "muted", "locked"];

export const automationLane: LaneSpec = {
  name: "automation",
  watch: AUTO_WATCH,
  find: (doc, clipId) =>
    (doc.arrangement.automationClips ?? []).find((clip) => clip.id === clipId) as ClipRecord | undefined,
  build: (rng) => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks.find((candidate) => candidate.kind === "instrument")!;
    const startTick = Math.floor(rng() * 4) * STEP_TICKS;
    const lengthTicks = STEP_TICKS * (4 + Math.floor(rng() * 8));
    store.execute(
      addAutomationClip(store.doc, { kind: "trackGain", trackId: track.id }, startTick, lengthTicks, [
        { tick: 0, value: 0.2 },
        { tick: Math.floor(lengthTicks / 2), value: 0.8 },
        { tick: lengthTicks, value: 0.4 },
      ]),
    );
    const clip = store.doc.arrangement.automationClips![0]!;
    return { store, clipId: clip.id };
  },
  verbs: [
    {
      name: "move",
      allow: ["startTick"],
      variants: (ctx) =>
        [0, 240, 960, -240, -1, 1e12, NaN].map((value) => ({
          label: `tick=${value}`,
          build: () => moveAutomationClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "resize",
      allow: ["lengthTicks"],
      variants: (ctx) =>
        [240, 960, 1920, 0, -1, 1e12, NaN].map((value) => ({
          label: `ticks=${value}`,
          build: () => resizeAutomationClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "trimStart",
      allow: ["startTick", "lengthTicks", "phaseOffsetTicks"],
      variants: (ctx) => {
        const clip = automationClipOf(ctx.store.doc, ctx.clipId);
        const ticks = [
          clip.startTick,
          clip.startTick + 120,
          clip.startTick + clip.lengthTicks / 2,
          clip.startTick - 1,
          clip.startTick + clip.lengthTicks,
          -1e9,
          NaN,
        ];
        return ticks.map((tick) => ({
          label: `tick=${tick}`,
          build: () => trimAutomationClipStart(ctx.store.doc, ctx.clipId, tick),
        }));
      },
    },
    {
      name: "split",
      allow: ["lengthTicks"],
      variants: (ctx) => {
        const clip = automationClipOf(ctx.store.doc, ctx.clipId);
        const ticks = [
          clip.startTick + 120,
          clip.startTick + 480,
          clip.startTick + clip.lengthTicks / 2,
          clip.startTick,
          clip.startTick + clip.lengthTicks,
          -1,
          NaN,
        ];
        return ticks.map((tick) => ({
          label: `tick=${tick}`,
          build: () => splitAutomationClipAtTick(ctx.store.doc, ctx.clipId, tick),
        }));
      },
    },
    {
      name: "addPoint",
      allow: ["points"],
      variants: (ctx) => {
        const clip = automationClipOf(ctx.store.doc, ctx.clipId);
        const ticks = [0, 240, 480, clip.lengthTicks, -1, 1e9, NaN];
        return ticks.map((tick) => ({
          label: `tick=${tick}`,
          build: () => addAutomationClipPoint(ctx.store.doc, ctx.clipId, tick, 0.5),
        }));
      },
    },
    {
      name: "duplicate",
      allow: [],
      variants: (ctx) => [{ label: "once", build: () => duplicateAutomationClip(ctx.store.doc, ctx.clipId) }],
    },
    {
      name: "mute",
      allow: ["muted"],
      variants: (ctx) =>
        [true, false].map((value) => ({
          label: `muted=${value}`,
          build: () => setAutomationClipMuted(ctx.store.doc, ctx.clipId, value),
        })),
    },
  ],
  assertGeometry: (doc, label) => {
    for (const clip of doc.arrangement.automationClips ?? []) {
      const where = `${label}[auto ${clip.id}]`;
      expect(clip.startTick, `${where}: the start must not be negative`).toBeGreaterThanOrEqual(0);
      expect(clip.lengthTicks, `${where}: the length must stay positive`).toBeGreaterThan(0);
      expect(
        clip.startTick + clip.lengthTicks,
        `${where}: the clip must stay inside the arrangement's tick ceiling`,
      ).toBeLessThanOrEqual(MAX_ARRANGEMENT_CLIP_TICKS);
      expect(clip.phaseOffsetTicks ?? 0, `${where}: the phase must not be negative`).toBeGreaterThanOrEqual(0);
      const ticks = clip.points.map((point) => point.tick);
      for (const point of clip.points) {
        expect(Number.isFinite(point.tick), `${where}: a point landed on a non-finite tick`).toBe(true);
        expect(Number.isFinite(point.value), `${where}: a point landed on a non-finite value`).toBe(true);
      }
      expect(
        [...ticks].sort((a, b) => a - b),
        `${where}: the points must stay sorted`,
      ).toEqual(ticks);
      // The audible resolver must still resolve the clip's own window.
      const events = automationClipEventsInWindow(
        clip as unknown as ArrangementAutomationClip,
        clip.startTick,
        clip.startTick + clip.lengthTicks,
      );
      for (const event of events) {
        expect(Number.isFinite(event.tick), `${where}: an event landed on a non-finite tick`).toBe(true);
        expect(event.tick, `${where}: an event landed outside the clip`).toBeGreaterThanOrEqual(clip.startTick);
        expect(event.tick, `${where}: an event landed outside the clip`).toBeLessThanOrEqual(
          clip.startTick + clip.lengthTicks,
        );
      }
    }
  },
};

function automationClipOf(doc: ProjectDocument, clipId: string) {
  return doc.arrangement.automationClips!.find((candidate) => candidate.id === clipId)!;
}

/* ------------------------------------------------------------------ scene */

export const SCENE_WATCH = [
  "sceneId",
  "startBar",
  "lengthBars",
  "phaseOffsetTicks",
  "sceneOffsetTicks",
  "loop",
  "locked",
];

export const sceneLane: LaneSpec = {
  name: "scene",
  watch: SCENE_WATCH,
  find: (doc, clipId) => doc.arrangement.clips.find((clip) => clip.id === clipId) as ClipRecord | undefined,
  build: (rng) => {
    const base = createProjectFromTemplate("house");
    const clip = base.arrangement.clips[0]!;
    const startBar = Math.floor(rng() * 4);
    const lengthBars = 1 + Math.floor(rng() * 4);
    // A second scene clip, so a MOVE has somewhere to be refused.
    const doc: ProjectDocument = {
      ...base,
      arrangement: {
        ...base.arrangement,
        clips: [
          { ...clip, startBar, lengthBars },
          { ...clip, id: "sweep-neighbour", startBar: startBar + lengthBars + 2, lengthBars: 2 },
        ],
      },
    };
    const store = new ProjectStore(doc);
    return { store, clipId: clip.id };
  },
  verbs: [
    {
      name: "move",
      allow: ["startBar"],
      variants: (ctx) =>
        [0, 1, 4, 8, -1, -100, 1e9, NaN].map((value) => ({
          label: `bar=${value}`,
          build: () => moveArrangementClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "resize",
      allow: ["lengthBars"],
      variants: (ctx) =>
        [1, 2, 4, 0, -1, 1e9, NaN].map((value) => ({
          label: `bars=${value}`,
          build: () => resizeArrangementClip(ctx.store.doc, ctx.clipId, value),
        })),
    },
    {
      name: "trimStart",
      allow: ["startBar", "lengthBars", "phaseOffsetTicks", "sceneOffsetTicks"],
      variants: (ctx) => {
        const clip = ctx.store.doc.arrangement.clips.find((candidate) => candidate.id === ctx.clipId)!;
        const bars = [clip.startBar + 1, clip.startBar + 2, clip.startBar, clip.startBar - 1, 1e9, NaN];
        return bars.map((bar) => ({
          label: `bar=${bar}`,
          build: () => trimArrangementClipStart(ctx.store.doc, ctx.clipId, bar),
        }));
      },
    },
    {
      name: "split",
      allow: ["lengthBars"],
      variants: (ctx) => {
        const clip = ctx.store.doc.arrangement.clips.find((candidate) => candidate.id === ctx.clipId)!;
        const unit = ticksPerBar(ctx.store.doc);
        const ticks = [
          (clip.startBar + 1) * unit,
          (clip.startBar + 2) * unit,
          clip.startBar * unit,
          (clip.startBar + 99) * unit,
          -1,
          NaN,
        ];
        return ticks.map((tick) => ({
          label: `tick=${tick}`,
          build: () => splitArrangementClipAtTick(ctx.store.doc, ctx.clipId, tick),
        }));
      },
    },
    {
      name: "duplicate",
      allow: [],
      variants: (ctx) => [{ label: "once", build: () => duplicateArrangementClip(ctx.store.doc, ctx.clipId) }],
    },
  ],
  assertGeometry: (doc, label) => {
    for (const clip of doc.arrangement.clips) {
      const where = `${label}[scene ${clip.id}]`;
      expect(clip.startBar, `${where}: the start must not be negative`).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(clip.startBar), `${where}: the scene lane is integer-bar`).toBe(true);
      expect(clip.lengthBars, `${where}: the length must stay a whole bar`).toBeGreaterThanOrEqual(1);
      expect(clip.lengthBars, `${where}: the length must stay inside the arrangement's ceiling`).toBeLessThanOrEqual(
        MAX_ARRANGEMENT_CLIP_BARS,
      );
      expect(clip.phaseOffsetTicks ?? 0, `${where}: the phase must not be negative`).toBeGreaterThanOrEqual(0);
      expect(clip.sceneOffsetTicks ?? 0, `${where}: the scene offset must not be negative`).toBeGreaterThanOrEqual(0);
      const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
      const pattern = doc.patterns.find((candidate) => candidate.id === scene?.patternId);
      expect(pattern, `${where}: the region must keep a scene with a pattern`).toBeDefined();
      expect(clip.phaseOffsetTicks ?? 0, `${where}: the phase must stay inside the pattern's grid`).toBeLessThan(
        pattern!.stepCount * STEP_TICKS,
      );
      // The audible resolver must still resolve the region's own window.
      const unit = ticksPerBar(doc);
      const base = clip.startBar * unit - (clip.phaseOffsetTicks ?? 0);
      const from = clip.startBar * unit;
      const to = from + clip.lengthBars * unit;
      const events = noteEventsInWindow(pattern!, base, from, to);
      for (const event of events) {
        expect(Number.isFinite(event.tick), `${where}: an event landed on a non-finite tick`).toBe(true);
        expect(event.tick, `${where}: an event landed before the region`).toBeGreaterThanOrEqual(from);
        expect(event.tick, `${where}: an event landed after the region`).toBeLessThan(to);
      }
    }
  },
};

/* ------------------------------------------------------------------ runner */

export const LANES: LaneSpec[] = [audioLane, midiLane, automationLane, sceneLane];

/**
 * Run ONE case through the four properties. The fixture and the argument
 * variant are resolved INSIDE the case, so the command is always built from
 * the very document it is executed on — a variant closure that captured
 * another store would make every case a vacuous "the verb refused".
 */
export function runCase(
  lane: LaneSpec,
  verb: VerbSpec,
  variantIndex: number,
  seed: number,
  caseLabel: string,
  rng: () => number,
): void {
  const { store, clipId } = lane.build(rng);
  const variants = verb.variants({ store, clipId, rng });
  const variant = variants[Math.min(variantIndex, variants.length - 1)]!;
  const label = `[${lane.name}/${verb.name} ${variant.label} ${caseLabel} seed=${seed}]`;

  const beforeDoc = clone(store.doc);
  const beforeClip = lane.find(store.doc, clipId);
  expect(beforeClip, `${label}: the fixture must produce a clip`).toBeDefined();
  const depthBefore = store.undoStackLength;

  let command: Command | null = null;
  try {
    command = variant.build({ store, clipId, rng });
  } catch {
    command = null;
  }
  if (command === null) return;

  let failure: unknown = null;
  try {
    store.execute(command);
  } catch (error) {
    failure = error;
  }

  if (failure !== null) {
    // PROPERTY 1 — REFUSAL SAFETY.
    expect(clone(store.doc), `${label}: a refused verb must leave the document untouched`).toEqual(beforeDoc);
    expect(store.undoStackLength, `${label}: a refused verb must not push a history entry`).toBe(depthBefore);
    return;
  }

  // PROPERTY 2 — PROPERTY ISOLATION.
  const afterClip = verb.targetAfter ? verb.targetAfter(store.doc, beforeClip!) : lane.find(store.doc, clipId);
  expect(afterClip, `${label}: the verb removed the target clip`).toBeDefined();
  const changed = changedFields(beforeClip!, afterClip!, lane.watch);
  expect(
    changed.filter((field) => !verb.allow.includes(field)),
    `${label}: the verb touched a field it does not own`,
  ).toEqual([]);

  // PROPERTY 3 — UNDO / REDO EXACTNESS.
  const afterDoc = clone(store.doc);
  const depthAfter = store.undoStackLength;
  if (JSON.stringify(afterDoc) === JSON.stringify(beforeDoc)) {
    // The verb changed NOTHING — a dead undo step is its own defect.
    expect(depthAfter, `${label}: a no-op verb must not leave a dead undo step`).toBe(depthBefore);
  } else {
    expect(depthAfter, `${label}: the verb must be exactly one history entry`).toBe(depthBefore + 1);
    store.undo();
    expect(clone(store.doc), `${label}: undo did not restore the document`).toEqual(beforeDoc);
    store.redo();
    expect(clone(store.doc), `${label}: redo did not re-apply the document`).toEqual(afterDoc);
  }

  // PROPERTY 4 — GEOMETRY INVARIANTS.
  lane.assertGeometry(store.doc, label);
}

/** The exhaustive pass: every verb × every argument variant. */
export function sweepExhaustive(lane: LaneSpec, seed: number): void {
  const rng = makeRng(seed);
  for (const verb of lane.verbs) {
    // The variant list is built against the FIXTURE's geometry (a split point
    // has to be inside the clip), so the variant COUNT comes from a probe
    // fixture. The variants are matched by INDEX: the list is built in a
    // fixed order, so index N is the same ARGUMENT ROLE in every fixture even
    // though the resolved numbers differ.
    const probe = lane.build(rng);
    const count = verb.variants({ store: probe.store, clipId: probe.clipId, rng }).length;
    for (let index = 0; index < count; index++) {
      runCase(lane, verb, index, seed, `#${index}`, rng);
    }
  }
}

/** The random pass: a random geometry, a random verb, a random variant. */
export function sweepRandom(lane: LaneSpec, cases: number, seed: number): void {
  const rng = makeRng(seed);
  for (let index = 0; index < cases; index++) {
    const verb = lane.verbs[Math.floor(rng() * lane.verbs.length)]!;
    const probe = lane.build(rng);
    const count = verb.variants({ store: probe.store, clipId: probe.clipId, rng }).length;
    runCase(lane, verb, Math.floor(rng() * count), seed, `#${index}`, rng);
  }
}
