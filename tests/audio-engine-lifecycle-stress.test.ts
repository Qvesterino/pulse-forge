import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { SampleBank } from "../src/sample-library/factory";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createDrumTrack } from "../src/commands/commands";
import type { DrumPad, ProjectDocument } from "../src/project-model/types";

/**
 * ENGINE LIFECYCLE STRESS GATE (engine audit 2026-10-18)
 *
 * The audit checklist's hardest item: repeated initialize → process → teardown
 * → reinitialize on ONE engine instance. The measured contract:
 *
 *   - the LIVE graph (tracks/groups/returns maps) is rebuilt to the same node
 *     count on every cycle — same-context re-init and cross-context swaps
 *     neither accumulate strips nor leak them,
 *   - after a context swap the OLD context has ZERO edges into its destination
 *     (no audio path survives a device change / contextlost recovery),
 *   - voices created while processing are gone after teardown,
 *   - a re-entrant setProject while a sync is pending COALESCES: only the
 *     latest document lands, and the map sizes match it.
 *
 * The navigable mock records every connection so the "dead destination" and
 * "stable strip count" invariants are asserted structurally, not by ear.
 */

interface MockNode {
  connections: Set<MockNode>;
}

function param(initial = 0) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(v: number) {
      value = v;
    },
    setTargetAtTime(v: number) {
      if (!Number.isFinite(v)) throw new TypeError(`setTargetAtTime(${v})`);
      value = v;
    },
    setValueAtTime(v: number) {
      if (!Number.isFinite(v)) throw new TypeError(`setValueAtTime(${v})`);
      value = v;
    },
    linearRampToValueAtTime(v: number) {
      if (!Number.isFinite(v)) throw new TypeError(`linearRamp(${v})`);
      value = v;
    },
    exponentialRampToValueAtTime(v: number) {
      if (!Number.isFinite(v)) throw new TypeError(`expRamp(${v})`);
      value = v;
    },
    setValueCurveAtTime() {},
    cancelScheduledValues() {},
    cancelAndHoldAtTime() {},
  };
}

function makeCtx(sampleRate = 48000) {
  const created: MockNode[] = [];
  const make = (): MockNode & Record<string, unknown> => {
    const node = {
      connections: new Set<MockNode>(),
      gain: param(1),
      pan: param(0),
      connect(destination?: MockNode) {
        if (destination && typeof destination === "object") node.connections.add(destination);
        return node;
      },
      disconnect(destination?: MockNode) {
        if (destination === undefined) node.connections.clear();
        else node.connections.delete(destination);
      },
    } as MockNode & Record<string, unknown>;
    created.push(node as MockNode);
    return node;
  };
  const ctx = {
    created,
    state: "running",
    currentTime: 1,
    sampleRate,
    onstatechange: null as (() => void) | null,
    createGain: make,
    createStereoPanner: make,
    createAnalyser: () =>
      Object.assign(make(), {
        fftSize: 0,
        channelCount: 2,
        channelCountMode: "explicit",
        getFloatTimeDomainData() {},
        getByteFrequencyData() {},
      }),
    createDelay: () => Object.assign(make(), { delayTime: param(0) }),
    createDynamicsCompressor: () =>
      Object.assign(make(), {
        reduction: 0,
        threshold: param(0),
        knee: param(0),
        ratio: param(1),
        attack: param(0),
        release: param(0),
      }),
    createBiquadFilter: () => Object.assign(make(), { type: "lowpass", frequency: param(440), Q: param(1) }),
    createChannelSplitter: make,
    createChannelMerger: make,
    createWaveShaper: () => Object.assign(make(), { oversample: "none", curve: null }),
    createConvolver: () => Object.assign(make(), { buffer: null, normalize: true }),
    createConstantSource: () => Object.assign(make(), { offset: param(0), start() {}, stop() {} }),
    createOscillator: () =>
      Object.assign(make(), {
        type: "sine",
        frequency: param(440),
        detune: param(0),
        start() {},
        stop() {},
        onended: null,
      }),
    createBufferSource: () =>
      Object.assign(make(), {
        buffer: null,
        playbackRate: param(1),
        detune: param(0),
        start() {},
        stop() {},
        onended: null,
      }),
    createBuffer: (channels: number, len: number, rate: number) => ({
      length: len,
      sampleRate: rate,
      numberOfChannels: channels,
      duration: len / rate,
      getChannelData: () => new Float32Array(len),
      copyToChannel() {},
    }),
    decodeAudioData: async () => ({
      duration: 1,
      sampleRate,
      numberOfChannels: 2,
      length: sampleRate,
      getChannelData: () => new Float32Array(sampleRate),
      copyToChannel() {},
    }),
    audioWorklet: { addModule: async () => {} },
    destination: make(),
  };
  return ctx;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Internals {
  trackNodes: Map<string, Record<string, unknown>>;
  groupNodes: Map<string, Record<string, unknown>>;
  returnNodes: Map<string, Record<string, unknown>>;
}

function sizes(engine: AudioEngine) {
  const internals = engine as unknown as Internals;
  return {
    tracks: internals.trackNodes.size,
    groups: internals.groupNodes.size,
    returns: internals.returnNodes.size,
  };
}

/** AudioNode-ish values owned by the strip maps (rate/context independent). */
function liveStripNodes(engine: AudioEngine): number {
  const internals = engine as unknown as Internals;
  let count = 0;
  for (const map of [internals.trackNodes, internals.groupNodes, internals.returnNodes]) {
    for (const nodes of map.values()) {
      for (const value of Object.values(nodes)) {
        if (value && typeof value === "object" && "connections" in (value as object)) count += 1;
      }
    }
  }
  return count;
}

function attachPadBank(engine: AudioEngine, doc: ProjectDocument, ctx: ReturnType<typeof makeCtx>) {
  const drum = doc.tracks.find((t) => t.kind === "drum");
  const pad = drum && drum.kind === "drum" ? (drum.pads[0] as DrumPad) : null;
  if (!pad) return null;
  const bank = new SampleBank();
  bank.add(pad.assetId ?? "stress-pad", ctx.createBuffer(1, 4800, ctx.sampleRate) as unknown as AudioBuffer);
  engine.attachBank(bank);
  return { drum: drum!.id, pad };
}

describe("engine lifecycle stress gate", () => {
  it("stays structurally stable across init → process → teardown → reinit cycles", async () => {
    const ctxA = makeCtx(48000);
    const ctxB = makeCtx(44100);
    const engine = new AudioEngine();

    engine.useContext(ctxA as unknown as AudioContext);
    const doc = createProjectFromTemplate("house");
    engine.setProject(doc);
    await flush();
    await flush();
    const first = { sizes: sizes(engine), nodes: liveStripNodes(engine) };
    expect(first.sizes, "the first sync must build the document's strips").toEqual({
      tracks: 3,
      groups: 0,
      returns: 3,
    });

    // PROCESS with valid events (a sampled pad needs its buffer in the bank).
    const target = attachPadBank(engine, doc, ctxA);
    const instrument = doc.tracks.find((t) => t.kind === "instrument");
    expect(instrument, "house must seed an instrument track").toBeDefined();
    engine.noteOn(instrument!.id, 60, 0.8, ctxA.currentTime + 0.01, 0.2);
    if (target) engine.trigger(target.drum, target.pad, ctxA.currentTime + 0.01, 0.9);
    await flush();
    engine.stopVoicesForOwner("all");
    await flush();

    // Same-context teardown/reinit twice.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      engine.useContext(ctxA as unknown as AudioContext);
      engine.setProject(createProjectFromTemplate("house"));
      await flush();
      await flush();
      expect(sizes(engine), `cycle ${cycle} changed the strip set`).toEqual(first.sizes);
      expect(liveStripNodes(engine), `cycle ${cycle} leaked strip nodes`).toBe(first.nodes);
    }

    // Cross-context swap (a 44.1 kHz device after 48 kHz).
    engine.useContext(ctxB as unknown as AudioContext);
    engine.setProject(createProjectFromTemplate("house"));
    await flush();
    await flush();
    expect(sizes(engine)).toEqual(first.sizes);
    expect(liveStripNodes(engine), "the swapped graph differs from a fresh build").toBe(first.nodes);

    // The old context must be fully detached from its destination.
    const oldDestination = ctxA.destination as unknown as MockNode;
    const edgesIntoOld = ctxA.created.reduce(
      (total, node) => total + (node.connections.has(oldDestination) ? 1 : 0),
      0,
    );
    expect(edgesIntoOld, "a node still feeds the dead context's destination").toBe(0);
    expect(engine.voiceCount, "voices survived teardown").toBe(0);
  });

  it("survives 24 process → dispose → reinitialize cycles across sample rates", async () => {
    const engine = new AudioEngine();
    const doc = createProjectFromTemplate("house");
    const instrument = doc.tracks.find((track) => track.kind === "instrument");
    expect(instrument, "house must seed an instrument track").toBeDefined();

    let ctx = makeCtx(44100);
    engine.useContext(ctx as unknown as AudioContext);
    engine.setProject(doc);
    await flush();
    await flush();
    const target = attachPadBank(engine, doc, ctx);
    expect(target, "house must provide a sample-backed stress pad").not.toBeNull();
    const expectedSizes = sizes(engine);
    const expectedNodes = liveStripNodes(engine);
    expect(expectedSizes.tracks).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 24; cycle += 1) {
      engine.noteOn(instrument!.id, 60 + (cycle % 12), 0.8, ctx.currentTime + 0.01, 0.1);
      engine.trigger(target!.drum, target!.pad, ctx.currentTime + 0.01, 0.9);
      await flush();
      expect(engine.voiceCount, `cycle ${cycle} did not create a voice`).toBeGreaterThan(0);

      engine.dispose();
      expect(engine.context, `cycle ${cycle} retained its disposed context`).toBeNull();
      expect(sizes(engine), `cycle ${cycle} retained graph maps`).toEqual({ tracks: 0, groups: 0, returns: 0 });
      expect(engine.voiceCount, `cycle ${cycle} retained voices`).toBe(0);
      const edgesIntoDisposedDestination = ctx.created.reduce(
        (total, node) => total + (node.connections.has(ctx.destination as unknown as MockNode) ? 1 : 0),
        0,
      );
      expect(edgesIntoDisposedDestination, `cycle ${cycle} retained an output edge`).toBe(0);

      ctx = makeCtx([48000, 96000, 44100][cycle % 3]!);
      engine.useContext(ctx as unknown as AudioContext);
      await flush();
      await flush();
      expect(sizes(engine), `cycle ${cycle} did not rebuild the project strips`).toEqual(expectedSizes);
      expect(liveStripNodes(engine), `cycle ${cycle} changed the live graph size`).toBe(expectedNodes);
    }

    engine.dispose();
    expect(engine.voiceCount).toBe(0);
    expect(engine.context).toBeNull();
  });

  it("keeps a same-context live output sink through graph rebuilds and releases it on dispose", () => {
    const globals = globalThis as unknown as { AudioContext?: unknown };
    const RealAudioContext = globals.AudioContext;
    class StubAudioContext {
      constructor() {
        Object.assign(this, makeCtx());
      }
    }
    globals.AudioContext = StubAudioContext;
    const engine = new AudioEngine();
    try {
      const ctx = new StubAudioContext();
      engine.useContext(ctx as unknown as AudioContext);
      const sink = { context: ctx } as unknown as AudioNode;
      engine.setLiveAudioOutputSink(sink);
      const chain = (
        engine as unknown as { masterChain: { monitorLowpass: MockNode; liveOutputSink: AudioNode | null } }
      ).masterChain;
      expect(chain.monitorLowpass.connections.has(sink as unknown as MockNode)).toBe(true);

      engine.useContext(ctx as unknown as AudioContext);
      expect(chain.liveOutputSink).toBe(sink);
      expect(chain.monitorLowpass.connections.has(sink as unknown as MockNode)).toBe(true);

      engine.dispose();
      expect(chain.liveOutputSink).toBeNull();
    } finally {
      engine.dispose();
      if (RealAudioContext === undefined) delete globals.AudioContext;
      else globals.AudioContext = RealAudioContext;
    }
  });

  it("coalesces a re-entrant setProject: only the latest document lands", async () => {
    const ctx = makeCtx();
    const engine = new AudioEngine();
    engine.useContext(ctx as unknown as AudioContext);

    const first = createProjectFromTemplate("house");
    const second = createDrumTrack(first).execute(first);
    engine.setProject(first);
    engine.setProject(second); // re-entrant while the first body is pending
    await flush();
    await flush();

    const internals = engine as unknown as Internals & { doc: ProjectDocument | null };
    expect(internals.doc?.tracks.length).toBe(second.tracks.length);
    expect(internals.trackNodes.size, "the map must match the surviving document").toBe(
      second.tracks.filter((t) => t.kind !== "group").length,
    );
  });

  it("the swapped-to graph is built entirely from the new context (no retained old nodes)", async () => {
    const ctxA = makeCtx(48000);
    const ctxB = makeCtx(44100);
    const engine = new AudioEngine();
    engine.useContext(ctxA as unknown as AudioContext);
    engine.setProject(createProjectFromTemplate("house"));
    await flush();
    await flush();
    engine.useContext(ctxB as unknown as AudioContext);
    engine.setProject(createProjectFromTemplate("house"));
    await flush();
    await flush();

    const oldNodes = new Set<MockNode>(ctxA.created);
    const internals = engine as unknown as Internals & { masterChain: Record<string, unknown> };
    const live: MockNode[] = [];
    for (const map of [internals.trackNodes, internals.groupNodes, internals.returnNodes]) {
      for (const nodes of map.values()) {
        for (const value of Object.values(nodes)) {
          if (value && typeof value === "object" && "connections" in (value as object)) live.push(value as MockNode);
        }
      }
    }
    for (const value of Object.values(internals.masterChain)) {
      if (value && typeof value === "object" && "connections" in (value as object)) live.push(value as MockNode);
    }
    expect(live.length, "the live graph did not build — the probe measured nothing").toBeGreaterThan(20);
    const retained = live.filter((node) => oldNodes.has(node));
    expect(retained, "the live graph retains nodes created on the swapped-out context").toEqual([]);
  });

  it("closes an engine-created context on swap and NEVER a caller's context", async () => {
    const globals = globalThis as unknown as { AudioContext?: unknown };
    const RealAudioContext = globals.AudioContext;
    // The real engine-created path: ensureContext() does `new AudioContext()`.
    // The stub carries the full navigable mock so the graph builds on it and
    // `isLiveAudioContext` (instanceof) recognises it.
    class StubAudioContext {
      close = vi.fn(async () => {
        (this as unknown as { state: string }).state = "closed";
      });
      constructor() {
        Object.assign(this, makeCtx());
      }
    }
    globals.AudioContext = StubAudioContext;
    try {
      const engine = new AudioEngine();
      const owned = engine.ensureContext();
      expect(owned).toBeInstanceOf(StubAudioContext);

      const external = makeCtx() as unknown as { close: ReturnType<typeof vi.fn> };
      external.close = vi.fn();
      engine.useContext(external as unknown as AudioContext);

      expect(
        (owned as unknown as { close: ReturnType<typeof vi.fn> }).close,
        "the replaced engine-created context was not closed — audio thread + device handle leak",
      ).toHaveBeenCalledTimes(1);
      expect(external.close, "a caller-owned context must never be closed").not.toHaveBeenCalled();

      // A second external swap closes neither external context.
      const external2 = makeCtx() as unknown as { close: ReturnType<typeof vi.fn> };
      external2.close = vi.fn();
      engine.useContext(external2 as unknown as AudioContext);
      expect(external.close).not.toHaveBeenCalled();
      expect(external2.close).not.toHaveBeenCalled();
      await flush();
    } finally {
      if (RealAudioContext === undefined) delete globals.AudioContext;
      else globals.AudioContext = RealAudioContext;
    }
  });

  it("a context swap clears the offline-render lock (reused-engine safety)", () => {
    const ctx = makeCtx();
    const engine = new AudioEngine();
    engine.useContext(ctx as unknown as AudioContext);
    const internals = engine as unknown as { offlineExactPdc: boolean; offlineRenderLocked: boolean };
    // A render would leave both set; a reused engine must not keep them.
    internals.offlineExactPdc = true;
    internals.offlineRenderLocked = true;

    engine.useContext(makeCtx() as unknown as AudioContext);

    expect(internals.offlineRenderLocked, "syncPdc would stay locked forever on live audio").toBe(false);
    expect(internals.offlineExactPdc, "live PDC writes would stay sample-exact (no glide)").toBe(false);
  });

  it("counts close failures for the diagnostics panel (no silent leak)", async () => {
    const globals = globalThis as unknown as { AudioContext?: unknown };
    const RealAudioContext = globals.AudioContext;
    class RejectingAudioContext {
      close = vi.fn(async () => {
        throw new DOMException("already closing", "InvalidStateError");
      });
      constructor() {
        Object.assign(this, makeCtx());
      }
    }
    globals.AudioContext = RejectingAudioContext;
    try {
      const engine = new AudioEngine();
      engine.ensureContext();
      engine.useContext(makeCtx() as unknown as AudioContext);
      await flush();
      expect(
        engine.getDiagnostics().contextCloseFailures,
        "a failed close must stay observable instead of silently leaking the audio thread",
      ).toBe(1);
    } finally {
      if (RealAudioContext === undefined) delete globals.AudioContext;
      else globals.AudioContext = RealAudioContext;
    }
  });

  it("dispose() releases the graph, closes only an owned context and stays reusable", async () => {
    const globals = globalThis as unknown as { AudioContext?: unknown };
    const RealAudioContext = globals.AudioContext;

    // Caller-owned context: never closed, but the graph is fully released.
    const external = makeCtx() as unknown as { close: ReturnType<typeof vi.fn> };
    external.close = vi.fn();
    const engine = new AudioEngine();
    engine.useContext(external as unknown as AudioContext);
    engine.setProject(createProjectFromTemplate("house"));
    await flush();
    expect(sizes(engine).tracks).toBeGreaterThan(0);

    engine.dispose();
    expect(external.close, "dispose must never close a caller-owned context").not.toHaveBeenCalled();
    expect(engine.context).toBeNull();
    expect(sizes(engine)).toEqual({ tracks: 0, groups: 0, returns: 0 });
    expect(() => engine.dispose(), "dispose is idempotent").not.toThrow();
    // Reusable: a later boot rebuilds from the kept document.
    engine.useContext(makeCtx() as unknown as AudioContext);
    await flush();
    expect(sizes(engine).tracks, "the engine could not be reused after dispose").toBeGreaterThan(0);

    // Engine-created context: closed exactly once, even across a second dispose.
    class OwnedAudioContext {
      close = vi.fn(async () => {});
      constructor() {
        Object.assign(this, makeCtx());
      }
    }
    globals.AudioContext = OwnedAudioContext;
    try {
      const ownedEngine = new AudioEngine();
      const owned = ownedEngine.ensureContext();
      ownedEngine.dispose();
      expect((owned as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
      expect(ownedEngine.context).toBeNull();
      ownedEngine.dispose();
      expect((owned as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    } finally {
      if (RealAudioContext === undefined) delete globals.AudioContext;
      else globals.AudioContext = RealAudioContext;
    }
    await flush();
  });

  it("NEGATIVE: a teardown before any context is a no-op, not a crash", () => {
    const engine = new AudioEngine();
    // The lifecycle API must be callable before boot (services wire lazily).
    expect(() => engine.setProject(createProjectFromTemplate("house"))).not.toThrow();
    expect(engine.context).toBeNull();
    expect(engine.voiceCount).toBe(0);
  });
});

/**
 * A FAILING DISPOSE MUST NOT STRAND THE REST OF THE GRAPH.
 *
 * `syncProject()` walks the graph in a fixed order: dead strips, then dead
 * instrument runtimes, then dead returns, then the live ones. The disposal of
 * a dead instrument runtime used to run INLINE and UNGUARDED, while every
 * other dispose in the engine (the FX runtimes, the instrument helper, the
 * context swap) wrapped the call in a try/catch.
 *
 * A runtime whose `dispose()` throws therefore aborted `syncProject()` at that
 * point. Everything AFTER it in the same walk never ran:
 *
 *   - the dead return buses were never disposed, so a DELETED bus kept its
 *     nodes in the graph and kept passing audio to the master,
 *   - a newly added return was never created at all.
 *
 * The failure was silent: `setProject()` catches a thrown body and logs it,
 * so the studio looked alive while the graph drifted away from the document.
 */
describe("instrument-runtime disposal isolation", () => {
  interface InstrumentInternals {
    instruments: Map<string, { runtime: { dispose: () => void; panic: () => void } }>;
    returnNodes: Map<string, Record<string, unknown>>;
  }

  function internalsOf(engine: AudioEngine): InstrumentInternals {
    return engine as unknown as InstrumentInternals;
  }

  async function buildHouse() {
    const ctx = makeCtx();
    const engine = new AudioEngine();
    engine.useContext(ctx as unknown as AudioContext);
    const doc = createProjectFromTemplate("house");
    engine.setProject(doc);
    await flush();
    return { ctx, engine, doc };
  }

  it("a dead instrument track whose runtime throws on dispose does not abort the rest of the sync", async () => {
    const { engine, doc } = await buildHouse();
    const internals = internalsOf(engine);

    const instrument = doc.tracks.find((t) => t.kind === "instrument");
    expect(instrument, "the house template must carry an instrument track").toBeTruthy();
    const state = internals.instruments.get(instrument!.id);
    expect(state, "the engine must own a runtime for the instrument track").toBeTruthy();

    // A runtime that refuses to die. The engine's own contract — asserted for
    // every other dispose in the file — is that a failing dispose must not
    // strand the rest of the channel.
    state!.runtime.dispose = () => {
      throw new Error("instrument runtime dispose failed");
    };

    const deadReturn = doc.returns[0].id;
    const liveReturn = doc.returns[1].id;
    const next: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.filter((t) => t.id !== instrument!.id),
      returns: doc.returns.filter((r) => r.id !== deadReturn),
    };

    engine.setProject(next);
    await flush();

    // 1. The dead runtime is still FORGOTTEN — the throw must not skip the
    //    bookkeeping, or the track's nodes leak for the rest of the session.
    expect(internals.instruments.has(instrument!.id), "the dead runtime must be forgotten").toBe(false);
    // 2. The sync CONTINUED past the throw: the deleted return bus is out of
    //    the graph. Before the fix this loop never ran, and the bus kept
    //    feeding the master.
    expect(internals.returnNodes.has(deadReturn), "a deleted return bus must leave the graph").toBe(false);
    // 3. NEGATIVE CONTROL: a return that was NOT deleted is still wired.
    expect(internals.returnNodes.has(liveReturn), "a surviving return bus must stay in the graph").toBe(true);
  });

  it("a healthy instrument runtime IS disposed when its track is deleted (the control for the spec above)", async () => {
    const { engine, doc } = await buildHouse();
    const internals = internalsOf(engine);

    const instrument = doc.tracks.find((t) => t.kind === "instrument");
    const state = internals.instruments.get(instrument!.id);
    expect(state).toBeTruthy();

    let disposed = false;
    const original = state!.runtime.dispose.bind(state!.runtime);
    state!.runtime.dispose = () => {
      disposed = true;
      original();
    };

    engine.setProject({ ...doc, tracks: doc.tracks.filter((t) => t.id !== instrument!.id) });
    await flush();

    expect(disposed, "deleting a track must dispose its instrument runtime").toBe(true);
    expect(internals.instruments.has(instrument!.id)).toBe(false);
  });

  it("a runtime that throws on panic does not silence the stop for the runtimes after it", async () => {
    const { engine } = await buildHouse();
    const internals = internalsOf(engine);

    // Use the engine's OWN map order, not the document's: the panic walks the
    // map, so the throwing runtime has to be the one it reaches FIRST.
    const ids = [...internals.instruments.keys()];
    expect(ids.length, "the house template must carry more than one instrument track").toBeGreaterThan(1);
    const first = internals.instruments.get(ids[0]!);
    const second = internals.instruments.get(ids[1]!);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    first!.runtime.panic = () => {
      throw new Error("instrument runtime panic failed");
    };
    let secondPanicked = false;
    const original = second!.runtime.panic.bind(second!.runtime);
    second!.runtime.panic = () => {
      secondPanicked = true;
      original();
    };

    engine.panic();

    // A Stop that leaves a voice ringing is a broken Stop: `panic()` is the
    // "everything off, now" reset, and the runtimes after the throwing one
    // must still be silenced.
    expect(secondPanicked, "a throwing runtime must not stop the panic from reaching the others").toBe(true);
  });
});
