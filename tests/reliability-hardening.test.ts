import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";
import {
  addArrangementClip,
  addMidiCcMapping,
  deleteTrack,
  setActivePattern,
  setPadSynth,
  toggleStep,
} from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { computeRenderTicks } from "../src/rendering/renderer";
import { BAR_TICKS } from "../src/project-model/types";
import { SnapshotRepository } from "../src/persistence/SnapshotRepository";
import { SampleBank } from "../src/sample-library/factory";
import { UserSampleRepository, type UserSampleAsset } from "../src/persistence/UserSampleRepository";
import { openDb, STORE_META, STORE_SNAPSHOT_INDEX, STORE_SNAPSHOTS, tx } from "../src/persistence/db";

/**
 * Regression tests for the reliability / self-audit hardening pass.
 *
 * Two flavors, following the repo's established conventions:
 *  1. Behavioral tests (commands + persistence run for real against
 *     fake-indexeddb / the real command functions).
 *  2. Source-grep pins for the Web Audio engine and worklet processors
 *     (same rationale as tests/audio-engine-lifecycle.test.ts: the engine
 *     needs a live BaseAudioContext, so structural fixes are pinned by
 *     asserting the hardened call sites survive refactors).
 */

/* ------------------------------------------------------------------ */
/* 1. deleteTrack undo must restore cross-references                   */
/* ------------------------------------------------------------------ */

describe("deleteTrack — cross-reference undo integrity", () => {
  function fixture(): { doc: ProjectDocument; victimId: string; keeperId: string } {
    let doc = createDefaultProject();
    const keeper = doc.tracks.find((t) => t.kind === "drum") ?? doc.tracks[0];
    const victim = doc.tracks.find((t) => t.id !== keeper.id);
    if (!victim) throw new Error("fixture needs two tracks");
    const midi = doc.midi ?? {
      enabled: false,
      deviceId: "",
      drumChannel: 0,
      instrumentChannel: 0,
      ccMappings: [],
      drumNoteMap: [],
      pitchBendRange: 2,
    };
    // Keeper's first effect sidechains to the victim track.
    doc = normalizeProject({
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === keeper.id && "effects" in t && t.effects.length > 0
          ? { ...t, effects: t.effects.map((e, i) => (i === 0 ? { ...e, sidechainTrackId: victim.id } : e)) }
          : t,
      ),
      midi: {
        ...midi,
        ccMappings: [],
        drumNoteMap: victim.kind === "drum" ? [{ midiNote: 36, padId: victim.pads[0].id }] : [],
      },
    });
    return { doc, victimId: victim.id, keeperId: keeper.id };
  }

  it("undo restores sidechainTrackId pruned by the delete (was: permanent loss via normalize)", () => {
    const { doc, victimId, keeperId } = fixture();
    const keeperEffect = doc.tracks.find((t) => t.id === keeperId);
    const fxId = "effects" in keeperEffect! ? keeperEffect.effects[0]?.id : undefined;
    if (!fxId) return; // template without effects — test vacuously

    const cmd = deleteTrack(doc, victimId);
    // The store applies: execute → normalizeProject (this is where the
    // sidechain ref used to be pruned OUTSIDE the captured delta).
    const applied = normalizeProject(cmd.execute(doc));
    const appliedFx = (applied.tracks.find((t) => t.id === keeperId) as { effects?: Array<{ id: string; sidechainTrackId?: string }> })
      .effects?.find((e) => e.id === fxId);
    expect(appliedFx?.sidechainTrackId, "delete must drop the sidechain ref").toBeUndefined();

    const restored = normalizeProject(cmd.undo(applied));
    const restoredFx = (restored.tracks.find((t) => t.id === keeperId) as { effects?: Array<{ id: string; sidechainTrackId?: string }> })
      .effects?.find((e) => e.id === fxId);
    expect(restoredFx?.sidechainTrackId, "undo must restore the sidechain ref").toBe(victimId);
  });

  it("undo restores MIDI ccMappings and drumNoteMap entries lost to the delete", () => {
    const { doc, victimId, keeperId } = fixture();
    // A CC mapping targeting the keeper track (survives the delete itself,
    // proving undo does not eat UNRELATED mappings) and one targeting the
    // victim (removed with the track, restored by undo).
    const keeperCmd = addMidiCcMapping(doc, 20, { kind: "trackGain", trackId: keeperId }, 0, 1);
    const withKeeperMapping = normalizeProject(keeperCmd.execute(doc));
    const victimCmd = addMidiCcMapping(withKeeperMapping, 21, { kind: "trackGain", trackId: victimId }, 0, 1);
    const withBoth = normalizeProject(victimCmd.execute(withKeeperMapping));
    expect(withBoth.midi?.ccMappings.length).toBe(2);

    const cmd = deleteTrack(withBoth, victimId);
    const applied = normalizeProject(cmd.execute(withBoth));
    expect(applied.midi?.ccMappings.map((m) => m.ccNumber)).toEqual([20]);

    const restored = normalizeProject(cmd.undo(applied));
    expect(restored.midi?.ccMappings.map((m) => m.ccNumber).sort()).toEqual([20, 21]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Step commands pin the pattern                                    */
/* ------------------------------------------------------------------ */

describe("toggleStep — pattern-pinned undo", () => {
  it("undo restores the step in the pattern that was edited, not the apply-time active one", () => {
    const doc = createDefaultProject();
    const patternA = doc.patterns[0];
    const patternB = doc.patterns[1] ?? doc.patterns[0];
    const drum = doc.tracks.find((t) => t.kind === "drum");
    if (!drum || patternA.id === patternB.id) return;
    const padId = drum.pads[0].id;

    const base = normalizeProject(setActivePattern(doc, patternA.id).execute(doc));
    const cmd = toggleStep(base, padId, 0, 0.8);
    let d = cmd.execute(base); // writes step 0 in pattern A
    expect(d.patterns.find((p) => p.id === patternA.id)?.rows[padId]?.[0]).toBeCloseTo(0.8);

    // User switches pattern, THEN hits Ctrl+Z.
    d = setActivePattern(d, patternB.id).execute(d);
    d = cmd.undo(d);

    const restoredA = d.patterns.find((p) => p.id === patternA.id);
    const untouchedB = d.patterns.find((p) => p.id === patternB.id);
    expect(restoredA?.rows[padId]?.[0] ?? 0, "undo clears the edited pattern's step").toBe(0);
    expect(untouchedB?.rows[padId]?.[0] ?? 0, "undo must not write into the now-active pattern").toBe(0);
    expect(d.activePatternId).toBe(patternB.id);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Former whole-doc commands are delta snapshots                    */
/* ------------------------------------------------------------------ */

describe("setPadSynth — concurrent-edit safety", () => {
  it("execute does not revert unrelated edits made after the command was built", () => {
    const doc = createDefaultProject();
    const drum = doc.tracks.find((t) => t.kind === "drum");
    if (!drum) return;
    const padId = drum.pads[0].id;

    // Command is BUILT from `doc` (a render-captured snapshot)…
    const cmd = setPadSynth(doc, padId, { type: "kick", decay: 0.4, tone: 2200, snap: 0.4, body: 0.6 });
    // …but by dispatch time the live doc moved on (a concurrent rename).
    const live = { ...doc, name: "renamed-after-build" };

    const applied = cmd.execute(live);
    expect(applied.name, "concurrent edit must survive").toBe("renamed-after-build");
    const appliedDrum = applied.tracks.find((t) => t.kind === "drum");
    const pad = appliedDrum?.kind === "drum" ? appliedDrum.pads.find((p) => p.id === padId) : undefined;
    expect(pad?.synth?.type, "the pad change must still apply").toBe("kick");
  });
});

/* ------------------------------------------------------------------ */
/* 4. SnapshotRepository — cross-session seq uniqueness                */
/* ------------------------------------------------------------------ */

describe("SnapshotRepository — seq survives reload", () => {
  beforeEach(async () => {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE_SNAPSHOTS, STORE_SNAPSHOT_INDEX], "readwrite");
      t.objectStore(STORE_SNAPSHOTS).clear();
      t.objectStore(STORE_SNAPSHOT_INDEX).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  });

  it("a new session's first snapshot does not orphan an old session's snapshot", async () => {
    const doc = createDefaultProject();
    // Session 1: two snapshots. Session 2 (new instance — the counter used
    // to restart at 0 and steal session 1's first index key).
    const repo1 = new SnapshotRepository();
    const s1 = await repo1.save("projX", doc, "s1");
    const s2 = await repo1.save("projX", doc, "s2");
    const repo2 = new SnapshotRepository();
    // seq is wall-clock based and per-INSTANCE: without this gap, s2 (same-ms
    // increment inside repo1) and s3 (repo2's fresh Date.now seed) can share a
    // seq value, and the rebuilt index tie-break (stable sort over IDB getAll
    // order = random id suffixes) then decides "newest" arbitrarily. The real
    // guarantee being tested is ordering for saves that do NOT share a
    // millisecond across instances — give the clock room to move.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const s3 = await repo2.save("projX", doc, "s3");
    // Session 3 rebuilds purely from the durable index.
    const repo3 = new SnapshotRepository();
    const list = await repo3.list("projX");

    // All three must remain discoverable after a reload (pre-fix: s1's index
    // key was overwritten → orphaned full doc, invisible and unprunable).
    expect(new Set(list.map((snap) => snap.label))).toEqual(new Set(["s1", "s2", "s3"]));
    // The newest is deterministic even when saves share a millisecond
    // (within one instance seq is strictly monotonic).
    expect(list[0]?.label).toBe("s3");

    // The durable index holds entries for all three ids.
    const db = await openDb();
    const entries = await tx<string[]>(db, STORE_SNAPSHOT_INDEX, "readonly", (store) => store.getAll());
    const values = entries.filter((value) => typeof value === "string");
    expect(values).toContain(s1.id);
    expect(values).toContain(s2.id);
    expect(values).toContain(s3.id);
  });

  it("prune after a reload evicts completely — no orphaned full-doc rows", async () => {
    const doc = createDefaultProject();
    const repo1 = new SnapshotRepository();
    const s1 = await repo1.save("projY", doc, "s1");
    const repo2 = new SnapshotRepository();
    const s2 = await repo2.save("projY", doc, "s2");
    const s3 = await repo2.save("projY", doc, "s3");

    const repo3 = new SnapshotRepository();
    await repo3.list("projY"); // rebuild from durable index
    await repo3.prune("projY", 2);

    const repo4 = new SnapshotRepository();
    const list = await repo4.list("projY");
    // Exactly two survive; the newest always survives.
    expect(list.length).toBe(2);
    expect(list.map((snap) => snap.id)).toContain(s3.id);
    expect(list[0]?.label).toBe("s3");
    const survivorLabels = new Set(list.map((snap) => snap.label));
    expect(survivorLabels.has("s1") || survivorLabels.has("s2")).toBe(true);
    // Whichever snapshot was evicted must be FULLY gone — primary row and
    // index entries (pre-fix: the stolen index key made prune delete the
    // wrong row's index entry and the orphaned doc leaked forever).
    const evicted = [s1, s2].filter((snap) => !survivorLabels.has(snap.label))[0] ?? s1;
    expect(await repo4.get(evicted.id)).toBeNull();
    // And no snapshot id remains reachable through any leftover index entry.
    const db = await openDb();
    const entries = await tx<string[]>(db, STORE_SNAPSHOT_INDEX, "readonly", (store) => store.getAll());
    expect(entries).not.toContain(evicted.id);
  });
});

/* ------------------------------------------------------------------ */
/* 5. db.tx — synchronous throw must roll the transaction back         */
/* ------------------------------------------------------------------ */

describe("tx() — sync-throw atomicity", () => {
  it("a run() that throws after issuing a put does not leave the put committed", async () => {
    const db = await openDb();
    const key = `hardening:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await tx(db, STORE_META, "readwrite", (store) => store.put("sentinel", key));

    await expect(
      tx(
        db,
        STORE_META,
        "readwrite",
        (store) => {
          store.put("clobbered", key);
          throw new Error("sync boom");
        },
      ),
    ).rejects.toThrow("sync boom");

    const after = await tx<string>(db, STORE_META, "readonly", (store) => store.get(key) as IDBRequest<string>);
    expect(after, "the pre-throw put must be rolled back, not auto-committed").toBe("sentinel");
  });
});

/* ------------------------------------------------------------------ */
/* 6. UserSampleRepository — overwrite rollback                        */
/* ------------------------------------------------------------------ */

describe("UserSampleRepository — save rollback", () => {
  it("a failed audio write on overwrite restores the previous metadata row", async () => {
    const repo = new UserSampleRepository();
    const asset: UserSampleAsset = {
      id: `userSample.hardening.${Date.now()}`,
      name: "original",
      fileName: "original.wav",
      category: "Custom",
      duration: 1,
      sampleRate: 48000,
      channels: 1,
      createdAt: new Date().toISOString(),
    };
    await repo.save(asset, new Blob([new Uint8Array([1, 2, 3])]));

    // Overwrite with new metadata whose AUDIO write fails (a function is
    // not structured-cloneable → the put throws inside the transaction).
    const updated = { ...asset, name: "renamed" };
    await expect(repo.save(updated, (() => {}) as unknown as Blob)).rejects.toThrow();

    const list = await repo.list();
    const row = list.find((a) => a.id === asset.id);
    expect(row, "the previously-good metadata row must survive the failed overwrite").toBeDefined();
    expect(row?.name).toBe("original");
  });
});

/* ------------------------------------------------------------------ */
/* 7. Offline renderer — export content boundaries                     */
/* ------------------------------------------------------------------ */

describe("renderer — export content correctness", () => {
  it("computeRenderTicks covers audio clips placed past the last scene clip", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(addArrangementClip(store.doc, doc.scenes[0].id, 4, 4)); // bars 4..8
    const withTailClip = {
      ...store.doc,
      arrangement: {
        ...store.doc.arrangement,
        audioClips: [
          // Outro vocal clip at bars 10..14 — beyond every scene clip.
          { id: "ac1", trackId: "t1", startBar: 10, lengthBars: 4 } as never,
        ],
      },
    };
    expect(computeRenderTicks(withTailClip, "song")).toBe(14 * BAR_TICKS);
  });

  it("pattern-mode export excludes arrangement audio clips (live parity)", () => {
    // The live scheduler plays audioClips only in the song branch; the
    // offline renderer must match or the export contains audio the user
    // never hears in pattern playback.
    const source = readFileSync(resolve(process.cwd(), "src/rendering/renderer.ts"), "utf8");
    expect(source.indexOf('options.mode === "song" && doc.arrangement.audioClips')).toBeGreaterThan(0);
  });

  it("renderProject honours an aborted signal BEFORE the un-abortable render begins", async () => {
    // The cancel button used to do nothing until startRendering() resolved;
    // the curated-layer wait (up to 2s) + worklet load + graph build are
    // seconds of setup during which an abort must fail fast with AbortError.
    class StubOfflineAudioContext {
      constructor(public channels: number, public length: number, public sampleRate: number) {}
    }
    const globalRef = globalThis as { OfflineAudioContext?: unknown };
    const hadOac = "OfflineAudioContext" in globalRef;
    const previousOac = globalRef.OfflineAudioContext;
    globalRef.OfflineAudioContext = StubOfflineAudioContext;
    try {
      const { renderProject } = await import("../src/rendering/renderer");
      const controller = new AbortController();
      controller.abort();
      await expect(
        renderProject(createDefaultProject(), {} as never, {
          mode: "song",
          sampleRate: 44_100,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      if (hadOac) globalRef.OfflineAudioContext = previousOac;
      else delete globalRef.OfflineAudioContext;
    }
  });
});

/* ------------------------------------------------------------------ */
/* 8. Engine + worklet source-grep pins (audio-context-dependent)      */
/* ------------------------------------------------------------------ */

const SRC = {
  engine: resolve(process.cwd(), "src/audio-engine/AudioEngine.ts"),
  renderer: resolve(process.cwd(), "src/rendering/renderer.ts"),
  bank: resolve(process.cwd(), "src/sample-library/factory.ts"),
  services: resolve(process.cwd(), "src/services.ts"),
  stockDelay: resolve(process.cwd(), "src/audio-worklets/stock-delay-node.ts"),
  chorus: resolve(process.cwd(), "src/audio-worklets/chorus-node.ts"),
  kaskadaNode: resolve(process.cwd(), "src/audio-worklets/kaskada-node.ts"),
  granular: resolve(process.cwd(), "src/audio-worklets/granular-voice-processor.js"),
  wtvoice: resolve(process.cwd(), "src/audio-worklets/wtvoice-processor.js"),
  kwmeter: resolve(process.cwd(), "src/audio-worklets/kwmeter-processor.js"),
  limiter: resolve(process.cwd(), "src/audio-worklets/limiter-processor.js"),
  sidechainNode: resolve(process.cwd(), "src/audio-worklets/sidechain-node.ts"),
};

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function functionBody(source: string, signature: RegExp): string {
  const start = source.search(signature);
  if (start < 0) return "";
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return "";
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

describe("AudioEngine — hardening pins (source-grep)", () => {
  it("panic() hard-stops one-shot sources on the LIVE-context path (clips/cues keep playing past Stop)", () => {
    const body = functionBody(read(SRC.engine), /panic\(\)\s*:\s*void\s*\{/);
    expect(body).not.toBe("");
    expect(body).toContain("this.stopOneShotSources()");
    // The call must be in the live-context branch: after the `const ctx` guard,
    // i.e. after stopPreview() (the no-context early return also calls it, so
    // assert ≥2 occurrences of the stop call within panic()).
    expect(body.match(/this\.stopOneShotSources\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("syncProject creates return nodes BEFORE groups wire sends", () => {
    const source = read(SRC.engine);
    const returnsLoop = source.indexOf("for (const ret of doc.returns)");
    const groupsLoop = source.indexOf("// Create/update group nodes");
    expect(returnsLoop).toBeGreaterThan(0);
    expect(groupsLoop).toBeGreaterThan(0);
    expect(returnsLoop, "returns must be ensured before group syncSends()").toBeLessThan(groupsLoop);
  });

  it("transportStarted and pushSyncBpm reach group and return chains", () => {
    const source = read(SRC.engine);
    const ts = functionBody(source, /transportStarted\(/);
    expect(ts).toContain("this.groupNodes.values()");
    expect(ts).toContain("this.returnNodes.values()");
    const bpm = functionBody(source, /private pushSyncBpm\(/);
    expect(bpm).toContain("this.groupNodes.values()");
    expect(bpm).toContain("this.returnNodes.values()");
  });

  it("pushSyncBpm threads `when` to runtimes and only change-guards live pushes (offline scene-BPM seam)", () => {
    const source = read(SRC.engine);
    const bpm = functionBody(source, /private pushSyncBpm\(/);
    // Scheduled (offline) pushes must reach runtimes even for a repeated BPM
    // value — each push carries its own window time.
    expect(bpm).toContain("when === undefined && this.syncedBpm === bpm");
    expect(bpm).toContain("rt.syncBpm?.(bpm, when)");
    expect(bpm).toContain("inst.runtime.syncBpm?.(bpm, when)");
  });

  it("offline renderer schedules each window's scene BPM at its own start time", () => {
    const source = read(SRC.renderer);
    expect(source).toContain("engine.setEffectiveBpm(window.bpm ?? null, timeAt(window.from))");
  });

  it("offline renderer awaits bounded user-sample readiness next to the curated layer", () => {
    const source = read(SRC.renderer);
    expect(source).toContain("await userSamplesReadyWithin(bank, 4000)");
    expect(source).toContain("await curatedReadyWithin(bank, 2000)");
  });

  it("AudioParam-backed syncBpm runtimes schedule with `when ?? currentTime`", () => {
    for (const path of [SRC.stockDelay, SRC.chorus, SRC.kaskadaNode]) {
      const source = read(path);
      expect(source.includes("when ?? ctx.currentTime") || source.includes("(bpm, when) =>"), path).toBe(true);
    }
  });

  it("triggerAudioClip disconnects the un-started primary source on the warp-segment path", () => {
    const source = read(SRC.engine);
    const warp = source.indexOf("if (warpSegs) {");
    expect(warp).toBeGreaterThan(0);
    const segmentStart = source.indexOf("const segSource = ctx.createBufferSource()", warp);
    const between = source.slice(warp, segmentStart > 0 ? segmentStart : warp + 2000);
    expect(between).toContain("source.disconnect()");
  });

  it("previewAssetSynced tracks its source as a preview voice (cancellable by stopPreview/panic)", () => {
    const body = functionBody(read(SRC.engine), /previewAssetSynced\(/);
    expect(body).toContain("previewVoices.add(voice)");
  });
});

describe("Worklet processors — RT-safety pins (source-grep)", () => {
  it("granular + wavetable voices compact dead voices per BLOCK, allocation-free", () => {
    for (const path of [SRC.granular, SRC.wtvoice]) {
      const source = read(path);
      expect(source, `${path}: per-sample .filter must be gone`).not.toContain("this.voices = this.voices.filter");
      expect(source, `${path}: in-place compaction must exist`).toContain("this.voices.length = w");
    }
  });

  it("kwmeter rebases integratedStart when the 1h cap splices the history", () => {
    expect(read(SRC.kwmeter)).toContain("this.integratedStart - 18000");
  });

  it("kwmeter integratedLoudness is allocation-free (no blocks/filter/reduce arrays)", () => {
    const body = functionBody(read(SRC.kwmeter), /integratedLoudness\(\)\s*\{/);
    expect(body).not.toContain(".filter(");
    expect(body).not.toContain("blocks.push");
  });

  it("limiter defines applyKnee OUTSIDE the per-sample loop", () => {
    const source = read(SRC.limiter);
    const hoist = source.indexOf("const applyKnee = (peak)");
    const sampleLoop = source.indexOf("for (let i = 0; i < len; i++, this.step++)");
    expect(hoist).toBeGreaterThan(0);
    expect(sampleLoop).toBeGreaterThan(0);
    expect(hoist).toBeLessThan(sampleLoop);
  });

  it("sidechain-node tracks and detaches the previous sidechain source", () => {
    const source = read(SRC.sidechainNode);
    expect(source).toContain("sidechainSource.disconnect(workletNode, 0, 1)");
    // The dead-code disconnect of an edge that never existed must be gone as
    // a CALL (comment text may still mention it).
    expect(source).not.toMatch(/^\s*input\.disconnect\(workletNode/m);
  });
});

describe("SampleBank arrival hook (GOAL 06 — worklet sample re-upload)", () => {
  it("fires on FIRST arrival of an id, not on overwrites; unsubscribe works", () => {
    const bank = new SampleBank();
    const seen: string[] = [];
    const unsubscribe = bank.onSampleAdded((id) => seen.push(id));

    const buffer = new AudioBufferMock() as unknown as AudioBuffer;
    bank.add("user.take", buffer);
    bank.add("user.take", buffer); // overwrite — no second fire
    bank.add("factory.kick", buffer);
    expect(seen).toEqual(["user.take", "factory.kick"]);

    unsubscribe();
    bank.remove("user.take");
    bank.add("user.take", buffer); // the unsubscribed listener stays silent
    expect(seen).toEqual(["user.take", "factory.kick"]);

    // A fresh listener sees the RE-ARRIVAL (remove + add is a new first).
    const again: string[] = [];
    bank.onSampleAdded((id) => again.push(id));
    bank.add("user.take", buffer);
    expect(again).toEqual([]); // already present — overwrite, no fire
    bank.remove("user.take");
    bank.add("user.take", buffer);
    expect(again).toEqual(["user.take"]);
  });

  it("the engine re-pushes a newly arrived sample to waiting instruments and the renderer detaches", () => {
    const engineSource = read(SRC.engine);
    const attach = functionBody(engineSource, /attachBank\(bank: SampleBank\): void/);
    // The reload-race re-upload: bank arrival → setSample on matching states.
    expect(attach).toContain("bank.onSampleAdded");
    expect(attach).toContain("state.sampleId === id");
    expect(attach).toContain("state.runtime.setSample?.(id)");
    expect(engineSource).toContain("detachBank(): void");
    // Offline engines must release the subscription (shared bank outlives them).
    expect(read(SRC.renderer)).toContain("engine.detachBank()");
  });
});

describe("Collab offline-adopt safety net (GOAL 06)", () => {
  it("adopting a live room parks the pre-adopt local state as a snapshot", () => {
    const source = read(SRC.services);
    expect(source).toContain('"auto — before collab adopt"');
    // Snapshot BEFORE the adopt replaces the document, prune after (cap kept).
    const adoptIdx = source.indexOf("before collab adopt");
    const adoptCall = source.indexOf("adoptRemote()", adoptIdx);
    expect(adoptCall).toBeGreaterThan(0);
  });
});

class AudioBufferMock {
  length = 1;
  sampleRate = 44100;
}
