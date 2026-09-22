/**
 * GOAL 06 — domain golden harness.
 *
 * The single source of truth for the domain-level parity fixtures in
 * `tests/domain-goldens/*.json`. Builders COMPUTE the cases (input →
 * operation → expected) deterministically; the capture script writes them
 * (`npm run goldens:capture`), the runner test recomputes and compares.
 * Capture and replay share THIS code, so they can never drift.
 *
 * Determinism contract (documented for foreign implementations):
 *  - ids: built inside `useDeterministicIds()` (sequential `prefix-test-N`);
 *  - volatile timestamps: `canonicalize` replaces every ISO-8601 string
 *    with "<ts>" — wall-clock time must never leak into a fixture;
 *  - numbers: rounded to 6 decimals, negative zero normalized to 0;
 *  - everything else is the exact observable output of the current engine.
 *
 * A future Kotlin/Swift implementation consumes the JSON files directly:
 * every case is `input → operation → expected`, no host framework required.
 */
import { commandHarness, deterministicTestDoc, drumTrackOf, instTrackOf, activePatternOf } from "../fixtures/doc";
import { resetDeterministicIds, useDeterministicIds } from "../../src/shared/ids";
import {
  defaultInstrumentParams,
  clampInstrumentParam,
  INSTRUMENT_META,
  INSTRUMENT_ORDER,
  syncRateHz,
} from "../../src/instruments/definitions";
import { defaultParamsOf, clampEffectParam, EFFECT_META } from "../../src/effects/definitions";
import { midiToFreq } from "../../src/project-model/types";
import { snapToScale, isInScale } from "../../src/project-model/scales";
import { swingOffsetTicks, drumHitsInWindow } from "../../src/project-model/groove";
import { valueAt } from "../../src/project-model/automation";
import { normalizeProject } from "../../src/project-model/schema";
import {
  setStepVelocityCommand,
  toggleStep,
  addNote,
  moveNote,
  resizeNote,
  quantizeNotes,
  setGroove,
  addArrangementClip,
  setBpm,
} from "../../src/commands/commands";
import { Transport } from "../../src/transport/Transport";
import { Scheduler } from "../../src/scheduler/Scheduler";
import { encodeShareCode, decodeShareCode } from "../../src/export/shareCode";
import { writeMidiFile } from "../../src/midi/midiFile";
import { mulberry32 } from "../../src/shared/rng";
import { humanizeVelocities, randomizeVelocities } from "../../src/shared/velocityFx";
import type { ProjectDocument } from "../../src/project-model/types";

export interface GoldenCase {
  name: string;
  operation: string;
  input: unknown;
  expected: unknown;
}

export interface GoldenFamily {
  file: string;
  meta: Record<string, string>;
  cases: GoldenCase[];
}

// ── canonicalization ─────────────────────────────────────────────────────

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Deep-canonicalize: ISO strings → "<ts>", numbers → 6 dp, -0 → 0. */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "number") {
    if (Object.is(value, -0)) return 0;
    return Math.round(value * 1e6) / 1e6;
  }
  if (typeof value === "string") return ISO_LIKE.test(value) ? "<ts>" : value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function familyMeta(kind: string, note: string): Record<string, string> {
  return { kind, note, campaign: "GOAL 06", ids: "useDeterministicIds (prefix-test-N)", time: "canonicalized to <ts>" };
}

// ── param-math ───────────────────────────────────────────────────────────

function edgeProbes(min: number, max: number): number[] {
  return [min - 100, min, (min + max) / 2, max, max + 100];
}

function buildParamMath(): GoldenFamily {
  const cases: GoldenCase[] = [];

  cases.push({
    name: "instrument defaults (all kinds)",
    operation: "instrumentDefaults",
    input: null,
    expected: INSTRUMENT_ORDER.map((kind) => ({ kind, defaults: canonicalize(defaultInstrumentParams(kind)) })),
  });
  cases.push({
    name: "effect defaults (all types)",
    operation: "effectDefaults",
    input: null,
    expected: Object.keys(EFFECT_META).map((type) => ({
      type,
      defaults: canonicalize(defaultParamsOf(type as keyof typeof EFFECT_META)),
    })),
  });

  for (const kind of INSTRUMENT_ORDER) {
    const first = INSTRUMENT_META[kind].params[0]!;
    cases.push({
      name: `clampInstrumentParam ${kind}:${first.id}`,
      operation: "clampInstrumentParam",
      input: { kind, paramId: first.id, probes: edgeProbes(first.min, first.max) },
      expected: edgeProbes(first.min, first.max).map((value) => clampInstrumentParam(kind, first.id, value)),
    });
  }

  for (const param of EFFECT_META.compressor.params) {
    cases.push({
      name: `clampEffectParam compressor:${param.id}`,
      operation: "clampEffectParam",
      input: { type: "compressor", paramId: param.id, probes: edgeProbes(param.min, param.max) },
      expected: edgeProbes(param.min, param.max).map((value) => clampEffectParam("compressor", param.id, value)),
    });
  }

  cases.push({
    name: "syncRateHz division table @120bpm",
    operation: "syncRateHz",
    input: { bpm: 120, selections: [0, 1, 2, 3, 4, 5, 6, -1, 99] },
    expected: [0, 1, 2, 3, 4, 5, 6, -1, 99].map((selection) => syncRateHz(selection, 120)),
  });

  cases.push({
    name: "midiToFreq semitone table (0..127)",
    operation: "midiToFreq",
    input: null,
    expected: Array.from({ length: 128 }, (_, pitch) => canonicalize(midiToFreq(pitch))),
  });

  for (const key of ["C Major", "A Natural Minor", "F# Natural Minor"] as const) {
    const probes = [59, 59.5, 60, 61, 62.4, 63, 64, 65, 66];
    cases.push({
      name: `snapToScale ${key}`,
      operation: "snapToScale",
      input: { key, pitches: probes },
      expected: {
        snapped: probes.map((pitch) => snapToScale(pitch, key)),
        inScale: probes.map((pitch) => isInScale(pitch, key)),
      },
    });
  }

  cases.push({
    name: "swingOffsetTicks table",
    operation: "swingOffsetTicks",
    input: { swings: [0, 0.25, 0.5, 1, 1.5], steps: [0, 1, 2, 3, 4, 5, 6, 7] },
    expected: [0, 0.25, 0.5, 1, 1.5].map((swing) =>
      [0, 1, 2, 3, 4, 5, 6, 7].map((step) => canonicalize(swingOffsetTicks(step, swing))),
    ),
  });

  const curves: Array<{ points: Array<{ tick: number; value: number }>; probes: number[] }> = [
    {
      points: [
        { tick: 0, value: 0.2 },
        { tick: 960, value: 0.8 },
      ],
      probes: [0, 240, 480, 960, 1200],
    },
    { points: [{ tick: 480, value: 1 }], probes: [0, 480, 900] },
    { points: [], probes: [0, 100] },
  ];
  cases.push({
    name: "automation valueAt curve shapes",
    operation: "automationValueAt",
    input: { curves },
    expected: curves.map((curve) => curve.probes.map((tick) => canonicalize(valueAt(curve.points, tick)))),
  });

  return {
    file: "param-math.json",
    meta: familyMeta("param-math", "pure parameter math: defaults, clamps, tables"),
    cases,
  };
}

// ── transport-time ───────────────────────────────────────────────────────

function buildTransportTime(): GoldenFamily {
  let clock = 100;
  const transport = new Transport({ now: () => clock }, 120);
  const steps: Array<{ op: string; args?: Record<string, unknown>; positionAfter: unknown }> = [];
  const record = (op: string, args?: Record<string, unknown>): void => {
    steps.push({ op, ...(args ? { args } : {}), positionAfter: canonicalize(transport.position) });
  };

  transport.setBpm(120);
  record("setBpm", { bpm: 120 });
  transport.play(0);
  record("play", { fromTick: 0 });
  clock += 1;
  record("advance1s");
  clock += 0.5;
  record("advance0.5s");
  transport.seek(1920);
  record("seek", { tick: 1920 });
  clock += 0.25;
  record("advance0.25s");
  transport.pause();
  record("pause");
  clock += 2;
  record("advanceWhilePaused");
  transport.play();
  record("resume");
  clock += 1;
  record("advance1sAfterResume");
  transport.setLoop(true, 0, 3840);
  record("setLoop", { start: 0, end: 3840 });
  clock += 2;
  record("advance2sInLoop");
  transport.stop();
  record("stop");
  clock += 1;
  record("advanceAfterStop");

  return {
    file: "transport-time.json",
    meta: familyMeta("transport-time", "Transport timeline math with an injected manual clock (bpm 120)"),
    cases: [
      {
        name: "play/seek/pause/resume/loop/stop position table",
        operation: "transportSequence",
        input: { clockStart: 100, sequence: steps.map((s) => s.op) },
        expected: steps,
      },
    ],
  };
}

// ── command-transforms ───────────────────────────────────────────────────

function buildCommandTransforms(): GoldenFamily {
  // Commands mint ids (addNote, arrangement clips…) — the whole builder runs
  // inside ONE deterministic-id scope (deterministicTestDoc restores the
  // previous mode in its finally, so ids after it are random again).
  const restoreIds = useDeterministicIds();
  resetDeterministicIds();
  try {
    return buildCommandTransformsInner();
  } finally {
    restoreIds();
  }
}

function buildCommandTransformsInner(): GoldenFamily {
  const cases: GoldenCase[] = [];
  const base = deterministicTestDoc();

  {
    const h = commandHarness(base);
    const drum = drumTrackOf(h.doc);
    h.run(toggleStep(h.doc, drum.pads[0]!.id, 0));
    h.run(toggleStep(h.doc, drum.pads[0]!.id, 4));
    h.run(setStepVelocityCommand(h.doc, drum.pads[0]!.id, 0, 0.42));
    cases.push({
      name: "step toggles + velocity set",
      operation: "commandSequence",
      input: { commands: ["toggleStep(pad0,0)", "toggleStep(pad0,4)", "setStepVelocity(pad0,0,0.42)"] },
      expected: { rows: canonicalize(activePatternOf(h.doc).rows) },
    });
  }

  {
    const h = commandHarness(base);
    const inst = instTrackOf(h.doc);
    h.run(addNote(h.doc, inst.id, { pitch: 60, start: 0, duration: 120, velocity: 0.9 }));
    h.run(addNote(h.doc, inst.id, { pitch: 64, start: 240, duration: 240, velocity: 0.7 }));
    const noteId = activePatternOf(h.doc).notes[inst.id]![0]!.id;
    h.run(moveNote(h.doc, inst.id, noteId, { start: 480, pitch: 67 }));
    h.run(resizeNote(h.doc, inst.id, noteId, 360));
    cases.push({
      name: "note add/move/resize",
      operation: "commandSequence",
      input: { commands: ["addNote(60@0)", "addNote(64@240)", "moveNote(n0→480,67)", "resizeNote(n0→360)"] },
      expected: { notes: canonicalize(activePatternOf(h.doc).notes) },
    });
  }

  {
    const h = commandHarness(base);
    const inst = instTrackOf(h.doc);
    h.run(addNote(h.doc, inst.id, { pitch: 60, start: 97, duration: 100, velocity: 0.8 }));
    h.run(addNote(h.doc, inst.id, { pitch: 67, start: 383, duration: 120, velocity: 0.6 }));
    h.run(quantizeNotes(h.doc, inst.id, undefined, 120, 1));
    cases.push({
      name: "quantizeNotes to 16th grid",
      operation: "commandSequence",
      input: { commands: ["addNote(60@97)", "addNote(67@383)", "quantizeNotes(all,grid=120,strength=1)"] },
      expected: { notes: canonicalize(activePatternOf(h.doc).notes) },
    });
  }

  {
    const h = commandHarness(base);
    const drum = drumTrackOf(h.doc);
    for (const step of [0, 2, 4, 6]) h.run(toggleStep(h.doc, drum.pads[0]!.id, step));
    h.run(setGroove(h.doc, { swing: 0.5 }));
    const pattern = activePatternOf(h.doc);
    const hits = drumHitsInWindow(h.doc, pattern, 0, 0, 3840);
    cases.push({
      name: "setGroove swing 0.5 + drumHitsInWindow",
      operation: "commandSequence",
      input: { commands: ["toggleStep(pad0,even steps)", "setGroove(swing=0.5)", "drumHitsInWindow(0..2bars)"] },
      expected: { groove: canonicalize(h.doc.groove), hits: canonicalize(hits) },
    });
  }

  {
    const h = commandHarness(base);
    const scene = h.doc.scenes[0]!.id;
    h.run(addArrangementClip(h.doc, scene, 0, 2));
    let overlapError: string | null = null;
    try {
      h.run(addArrangementClip(h.doc, scene, 1, 2));
    } catch (err) {
      overlapError = err instanceof Error ? err.message : String(err);
    }
    h.run(setBpm(h.doc, 140));
    cases.push({
      name: "arrangement clip + overlap rejection + bpm",
      operation: "commandSequence",
      input: {
        commands: ["addArrangementClip(scene0,bar0,2)", "addArrangementClip(scene0,bar1,2)!", "setBpm(140)"],
      },
      expected: { clips: canonicalize(h.doc.arrangement.clips), overlapError, bpm: canonicalize(h.doc.bpm) },
    });
  }

  return {
    file: "command-transforms.json",
    meta: familyMeta("command-transforms", "deterministic doc + scripted commands → canonical project state"),
    cases,
  };
}

// ── serialization ────────────────────────────────────────────────────────

/** Canonical (id- and time-stable) doc used by every encode case. */
export function canonicalShareDoc(): ProjectDocument {
  return JSON.parse(JSON.stringify(canonicalize(normalizeProject(deterministicTestDoc())))) as ProjectDocument;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildSerialization(decodeGoldens: Array<{ label: string; code: string }>): GoldenFamily {
  const cases: GoldenCase[] = [];
  const doc = canonicalShareDoc();

  cases.push({
    name: "share code encode (canonical doc)",
    operation: "encodeShareCode",
    input: { note: "decode pins live in decode-goldens.json — never regenerate them" },
    expected: { code: encodeShareCode(doc) },
  });

  cases.push({
    name: "MIDI write (drum + instrument pattern)",
    operation: "writeMidiFile",
    input: { division: 480, bpm: 120 },
    expected: (() => {
      const base = deterministicTestDoc();
      const pattern = activePatternOf(base);
      const drum = drumTrackOf(base);
      const inst = instTrackOf(base);
      const drumNotes = (pattern.rows[drum.pads[0]!.id] ?? [])
        .map((velocity, step) => ({ velocity, step }))
        .filter((hit) => hit.velocity > 0)
        .map((hit) => ({
          pitch: 36,
          startTick: hit.step * 120,
          endTick: hit.step * 120 + 120,
          velocity: hit.velocity,
        }));
      const instNotes = (pattern.notes[inst.id] ?? []).map((note) => ({
        pitch: note.pitch,
        startTick: note.start,
        endTick: note.start + note.duration,
        velocity: note.velocity,
      }));
      const bytes = writeMidiFile({
        division: 480,
        bpm: 120,
        tracks: [
          { channel: 9, name: "drums", notes: drumNotes },
          { channel: 0, name: "lead", notes: instNotes },
        ],
      });
      return { byteLength: bytes.length, hex: hex(bytes) };
    })(),
  });

  for (const { label, code } of decodeGoldens) {
    const decoded = decodeShareCode(code);
    cases.push({
      name: `decode golden share code: ${label} (backward compatibility)`,
      operation: "decodeShareCode",
      input: { code },
      expected: { doc: decoded ? canonicalize(decoded) : null },
    });
  }

  return {
    file: "serialization.json",
    meta: familyMeta("serialization", "share code encode/decode + MIDI byte parity"),
    cases,
  };
}

// ── scheduler-plan ───────────────────────────────────────────────────────

interface PlannedEvent {
  kind: string;
  detail: string;
  when: number;
  velocity?: number;
}

function buildSchedulerPlan(): GoldenFamily {
  const h = commandHarness(deterministicTestDoc());
  const drum = drumTrackOf(h.doc);
  for (const step of [0, 3, 6, 9]) h.run(toggleStep(h.doc, drum.pads[0]!.id, step));
  h.run(setGroove(h.doc, { swing: 0.3 }));
  const doc = h.doc;

  const INTERVAL_MS = 25;
  let audioTime = 200;
  const events: PlannedEvent[] = [];
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "pattern" as const,
    trigger: (trackId, pad, when, velocity) => {
      events.push({
        kind: "trigger",
        detail: `${trackId}:${pad.id}`,
        when: Math.round(when * 1e6) / 1e6,
        velocity,
      });
    },
    noteOn: () => undefined,
    metronomeClick: () => undefined,
    applyAutomation: () => undefined,
    applyPatternLaunch: () => undefined,
  });
  const transport = new Transport({ now: () => audioTime }, doc.bpm);
  transport.setBpm(doc.bpm);
  transport.play(0);
  scheduler.start();
  for (let i = 0; i < 4; i++) {
    audioTime += INTERVAL_MS / 1000;
    void (scheduler as unknown as { tick: () => void }).tick?.();
  }
  scheduler.stop();

  return {
    file: "scheduler-plan.json",
    meta: familyMeta("scheduler-plan", "headless scheduler: recorded trigger events for a deterministic swung pattern"),
    cases: [
      {
        name: "4 windows over a swung drum pattern",
        operation: "schedulerPlan",
        input: { intervalMs: INTERVAL_MS, windows: 4, patternSteps: [0, 3, 6, 9], swing: 0.3, bpm: doc.bpm },
        expected: { events: canonicalize(events) },
      },
    ],
  };
}

// ── registry ─────────────────────────────────────────────────────────────

// ── velocity-fx ──────────────────────────────────────────────────────────

function buildVelocityFx(): GoldenFamily {
  // GOAL 09: velocityFx is seedable — the UI keeps Math.random (creative
  // rolls, values baked into commands); the golden family pins the seeded
  // contract (same rng stream → same output).
  const current = [0, 0.5, 0.8, 0, 1, 0.3, 0.62];
  const roll = randomizeVelocities(current, 0.45, 1, mulberry32(1234));
  const human = humanizeVelocities(current, 0.12, mulberry32(5678));
  return {
    file: "velocity-fx.json",
    meta: familyMeta("velocity-fx", "seeded velocity effects (mulberry32 1234/5678) — silence-preserving"),
    cases: [
      {
        name: "randomizeVelocities seeded (silence preserved, [min,max] range)",
        operation: "randomizeVelocities",
        input: { current, min: 0.45, max: 1, seed: 1234 },
        expected: { out: canonicalize(roll) },
      },
      {
        name: "humanizeVelocities seeded (±amount, floor 0.05)",
        operation: "humanizeVelocities",
        input: { current, amount: 0.12, seed: 5678 },
        expected: { out: canonicalize(human) },
      },
    ],
  };
}

export function buildFamilies(decodeGoldens: Array<{ label: string; code: string }>): GoldenFamily[] {
  return [
    buildParamMath(),
    buildTransportTime(),
    buildCommandTransforms(),
    buildSerialization(decodeGoldens),
    buildSchedulerPlan(),
    buildVelocityFx(),
  ];
}
