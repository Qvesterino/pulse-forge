import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { setBpm, setProjectName } from "../src/commands/commands";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { Scheduler } from "../src/scheduler/Scheduler";
import { ProjectStore } from "../src/store/ProjectStore";
import { Transport } from "../src/transport/Transport";

/** Regression coverage for the final release-hardening pass. */

const AUDIO_ENGINE_PATH = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");
const SCHEDULER_PATH = resolve(process.cwd(), "src/scheduler/Scheduler.ts");
const PROJECT_STORE_PATH = resolve(process.cwd(), "src/store/ProjectStore.ts");

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function sliceFunction(source: string, signature: RegExp): string {
  const start = source.search(signature);
  if (start < 0) return "";
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return "";
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

describe("release hardening — scheduler", () => {
  it("refuses a stale active pattern without silently scheduling another pattern", () => {
    const doc = createDefaultProject();
    const broken = { ...doc, activePatternId: "missing-pattern" };
    const events: string[] = [];
    let audioTime = 10;
    const transport = new Transport({ now: () => audioTime }, doc.bpm);
    const scheduler = new Scheduler({
      getProject: () => broken,
      getTransport: () => transport,
      getAudioTime: () => audioTime,
      getMode: () => "pattern",
      trigger: () => events.push("drum"),
      noteOn: () => events.push("note"),
      applyAutomation: () => {},
      applyPatternLaunch: () => {},
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      transport.play(0);
      scheduler.start();
      audioTime += 0.25;
      scheduler["tick"]();
      expect(events).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(scheduler.stats.lastHorizonTick).toBeGreaterThan(0);
    } finally {
      scheduler.stop();
      error.mockRestore();
    }
  });

  it("song-mode cache invalidates only when the project reference changes", () => {
    const source = readFile(SCHEDULER_PATH);
    expect(source).toMatch(/songCacheProject/);
    expect(source).toMatch(/songClipsCache/);
    expect(source).toMatch(/songScenesByIdCache/);
    expect(source).toMatch(/songPatternsByIdCache/);
    expect(source).toMatch(/if\s*\(\s*this\.songCacheProject\s*===\s*doc\s*\)/);
  });
});

describe("release hardening — AudioEngine lifecycle", () => {
  it("disposes and removes a stale instrument runtime idempotently", () => {
    const engine = new AudioEngine();
    const dispose = vi.fn();
    const instruments = (engine as unknown as { instruments: Map<string, { runtime: { dispose: () => void } }> })
      .instruments;
    instruments.set("track-1", { runtime: { dispose } });
    const disposeRuntime = (engine as unknown as { disposeInstrumentRuntime: (id: string) => void })
      .disposeInstrumentRuntime;

    disposeRuntime.call(engine, "track-1");
    disposeRuntime.call(engine, "track-1");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(instruments.has("track-1")).toBe(false);
  });

  it("wires role conversion cleanup into syncProject and snapshots voices during choke", () => {
    const source = readFile(AUDIO_ENGINE_PATH);
    const syncProject = sliceFunction(source, /syncProject\(doc:\s*ProjectDocument\)/);
    expect(syncProject).toMatch(/track\.kind\s*!==\s*"instrument"\)\s*this\.disposeInstrumentRuntime\(track\.id\)/);
    const choke = sliceFunction(source, /choke\(trackId:\s*string/);
    expect(choke).toMatch(/for\s*\(\s*const\s+voice\s+of\s+\[\.\.\.this\.voices\]/);
    // Frozen tracks rebuild an EMPTY effect chain (the freeze render already
    // contains the FX). The call gained an ownerId first argument when
    // rebuildFxChain was made owner-aware — the pinned invariant is the [].
    expect(syncProject).toMatch(
      /rebuildFxChain\(track\.id,\s*\[\],\s*nodes\.input,\s*nodes\.panner,\s*nodes\.fx\)/,
    );
  });
});

describe("release hardening — ProjectStore", () => {
  it("keeps the coalesced history diff for the whole gesture", () => {
    const store = new ProjectStore(createDefaultProject());
    const before = store.doc;
    store.execute({
      type: "gesture-name",
      label: "Gesture",
      coalesceKey: "gesture",
      execute: (doc) => ({ ...doc, name: "Gesture" }),
      undo: () => before,
    });
    store.execute({
      type: "gesture-bpm",
      label: "Gesture",
      coalesceKey: "gesture",
      execute: (doc) => ({ ...doc, bpm: 132 }),
      undo: () => before,
    });
    expect(store.undoStackLength).toBe(1);
    expect(store.history[0].diff?.changed).toBeGreaterThanOrEqual(2);
    store.undo();
    expect(store.doc.name).toBe(before.name);
    expect(store.doc.bpm).toBe(before.bpm);
  });

  it("normalizes an invalid active pattern at the plain-store boundary", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore({ ...doc, activePatternId: "missing-pattern" });
    expect(store.doc.activePatternId).toBe(store.doc.patterns[0].id);
    expect(store.doc).toEqual(normalizeProject({ ...doc, activePatternId: "missing-pattern" }));
  });

  it("reuses cached history diffs and invalidates them after mutation", () => {
    const source = readFile(PROJECT_STORE_PATH);
    expect(source).toMatch(/diffCache\s*=\s*new Map/);
    const store = new ProjectStore(createDefaultProject());
    store.execute(setBpm(store.doc, 130));
    const first = store.history[0].diff;
    expect(store.history[0].diff).toBe(first);
    store.execute(setProjectName(store.doc, "Changed"));
    expect(store.history[0].diff).not.toBe(first);
  });
});
