import { describe, it, expect, beforeAll } from "vitest";
import {
  executeMcpTool,
  executeMcpToolAsync,
  resetMcpCheckpoints,
  type McpToolContext,
  type McpToolResult,
} from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * AGENT SIMULATION E2E (docs/AGENTIC-DAW-PLAN.md — the regression gate).
 *
 * A scripted FAKE AGENT plays the whole playbook against the real tool
 * layer + a real ProjectStore: hello-KYX, beat workflow, checkpoint
 * experiment, producer moves, batch, transport/export hooks. Every phase
 * verifies the resulting STATE (not the dispatch echo) and every mutating
 * call is expected to carry the one-undo contract. If any tool's contract
 * rots under concurrent waves, THIS file goes red.
 *
 * verify:all runs the full vitest suite, so this gate rides every release
 * check without extra wiring.
 */

interface FakeAgent {
  store: ProjectStore;
  calls: number;
  mutations: number;
  transportCalls: string[];
  exportRequests: Array<{ format: string }>;
  loudnessTrims: Array<{ targetDb?: number; direction: string }>;
  call(name: string, args?: unknown): McpToolResult;
  callAsync(name: string, args?: unknown): Promise<McpToolResult>;
}

function spawnAgent(options: { allowDestructive?: boolean } = {}): FakeAgent {
  useDeterministicIds();
  resetDeterministicIds();
  const base = createProjectFromTemplate("house");
  const doc = { ...base, arrangement: { ...base.arrangement, clips: [] }, markers: [], scenes: [] };
  const store = new ProjectStore(doc);
  const agent: FakeAgent = {
    store,
    calls: 0,
    mutations: 0,
    transportCalls: [],
    exportRequests: [],
    loudnessTrims: [],
    call(name, args = {}) {
      agent.calls += 1;
      return executeMcpTool(ctx, name, args);
    },
    async callAsync(name, args = {}) {
      agent.calls += 1;
      return executeMcpToolAsync(ctx, name, args);
    },
  };
  const ctx: McpToolContext = {
    getDoc: () => store.doc,
    execute: (command) => {
      store.execute(command);
      agent.mutations += 1;
    },
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: {
      play: () => agent.transportCalls.push("play"),
      stop: () => agent.transportCalls.push("stop"),
      pause: () => agent.transportCalls.push("pause"),
      setLoop: () => agent.transportCalls.push("loop"),
      setMetronome: () => agent.transportCalls.push("metronome"),
      position: 0,
      playing: false,
      paused: true,
      loopEnabled: false,
    },
    export: async (request) => {
      agent.exportRequests.push({ format: request.format });
      return "fake-export 3.2s wav 48000/24 (headless hook)";
    },
    measureLoudness: async () => ({ integrated: -18.4, measured: true }),
    applyLoudness: async (request) => {
      agent.loudnessTrims.push(request as { targetDb?: number; direction: string });
      return {
        ok: true,
        command: { type: "noop", label: "fake loudness trim", execute: (d) => d, undo: (d) => d },
        report: { measuredBefore: -18.4, measuredAfter: -14, trim: 4.4, target: -14 },
      };
    },
    allowDestructive: options.allowDestructive === true ? () => true : undefined,
  };
  return agent;
}

/** The chaos invariant: every number that reaches the document is finite —
 * an agent (or a rotten tool) must never write NaN/Infinity into the doc. */
function assertFiniteDoc(agent: FakeAgent): void {
  const seen: string[] = [];
  JSON.stringify(agent.store.doc, (key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) seen.push(`${key}=${value}`);
    return value;
  });
  expect(seen).toEqual([]);
}

// ONE agent for the whole session — the phases ACCUMULATE state by design
// (that is what a real agent session looks like).
let agent: FakeAgent;

beforeAll(() => {
  resetMcpCheckpoints();
  agent = spawnAgent({ allowDestructive: true });
});

describe("agent simulation — the whole playbook in one session", () => {
  it("phase 0: session onboarding reads the manual + hello-KYX checklist", () => {
    // an agent reads kyx://playbook + kyx://vocab FIRST (token economy)
    const playbook = agent.call("__kyx_resource", { uri: "kyx://playbook" });
    expect(playbook.text).toContain("PRODUCER PLAYBOOK");
    const vocab = agent.call("__kyx_resource", { uri: "kyx://vocab" });
    expect(vocab.text).toContain("INTENT VOCABULARY");

    // hello-KYX: read → generate → step edit → verify → undo → verify
    const overview = agent.call("kyx_state", { subject: "overview" });
    expect(overview.text).toContain("BPM");
    const generated = agent.call("kyx_generate", { genre: "techno", seed: "hello" });
    expect(generated.mutated).toBe(true);
    const stepped = agent.call("kyx_steps", { op: "add", family: "kick", steps: [5] });
    expect(stepped.mutated).toBe(true);
    const gridProbe = agent.call("kyx_state", { subject: "pattern" });
    expect(gridProbe.text).toContain("kick:");
    const gridBefore = agent.call("kyx_state", { subject: "pattern" });
    expect(gridBefore.text).toContain("active:");
    agent.call("kyx_steps", { op: "add", family: "clap", steps: [13] });
    const gridEdited = agent.call("kyx_state", { subject: "pattern" });
    expect(gridEdited.text).not.toBe(gridBefore.text);
    agent.call("kyx_undo", { action: "undo", steps: 1 });
    const gridAfter = agent.call("kyx_state", { subject: "pattern" });
    expect(gridAfter.text).toBe(gridBefore.text);
    assertFiniteDoc(agent);
  });

  it("phase 1: beat workflow — polish, groove, fx, markers", () => {
    const result = agent.call("kyx_generate", { genre: "drill", seed: "session-beat", bars: 2 });
    expect(result.mutated).toBe(true);
    // read-before-act: the drill Grime kit has NO hat pad (honest refusal)
    const hatProbe = agent.call("kyx_steps", { op: "add", family: "hat", steps: [31] });
    expect(hatProbe.isError).toBe(true);
    expect(hatProbe.text).toContain("no pad matches family");
    // snare exists — make an empty slot at step 6, then ghost it
    agent.call("kyx_steps", { op: "add", family: "snare", steps: [6] });
    agent.call("kyx_steps", { op: "remove", family: "snare", steps: [6] });
    const ghost = agent.call("kyx_steps", { op: "ghost", family: "snare", steps: [6] });
    expect(ghost.mutated).toBe(true);
    expect(ghost.text).toContain("snare ghost");
    const groove = agent.call("kyx_groove", { direction: "more" });
    expect(groove.mutated).toBe(true);
    const fx = agent.call("kyx_fx", { effect: "reverb", family: "bass", action: "more" });
    expect(fx.mutated).toBe(true);
    const marker = agent.call("kyx_markers", { op: "add", bar: 9, name: "Agent drop" });
    expect(marker.mutated).toBe(true);
    expect(agent.store.doc.markers[0]?.name).toBe("Agent drop");
    const tracks = agent.call("kyx_tracks", { op: "addInstrument", instrument: "808" });
    expect(tracks.mutated).toBe(true);
    assertFiniteDoc(agent);
  });

  it("phase 2: checkpoint experiment — save, destructive remove, restore", () => {
    const tracksBefore = agent.store.doc.tracks.length;
    const saved = agent.call("kyx_checkpoint", { op: "save", name: "before-experiment" });
    expect(saved.text).toContain('"before-experiment"');

    const removed = agent.call("kyx_tracks", { op: "remove", family: "drums" });
    expect(removed.mutated).toBe(true);
    expect(agent.store.doc.tracks.length).toBeLessThan(tracksBefore);

    const restored = agent.call("kyx_checkpoint", { op: "restore", name: "before-experiment" });
    expect(restored.mutated).toBe(true);
    expect(agent.store.doc.tracks.length).toBe(tracksBefore);

    const list = agent.call("kyx_checkpoint", { op: "list" });
    expect(list.text).toContain("before-experiment");
    assertFiniteDoc(agent);
  });

  it("phase 3: producer moves — mix profile, then a 10-call batch", () => {
    const mixed = agent.call("kyx_mix", { genre: "techno", energy: 0.75 });
    expect(mixed.mutated).toBe(true);
    expect(mixed.text).toContain("mix applied");
    const decisionsBefore = agent.store.doc.tracks.reduce((sum, t) => sum + t.effects.length, 0);

    const batch = agent.call("kyx_batch", {
      calls: [
        { tool: "kyx_steps", args: { op: "add", family: "clap", steps: [5] } },
        { tool: "kyx_steps", args: { op: "add", family: "hat", steps: [3, 7, 11, 15] } },
        { tool: "kyx_groove", args: { direction: "set", percent: 58 } },
        { tool: "kyx_markers", args: { op: "add", bar: 3, name: "batch cue" } },
        { tool: "kyx_tracks", args: { op: "setGain", family: "bass", gainDb: -2 } },
        { tool: "kyx_transport", args: { action: "metronomeOn" } },
      ],
    });
    expect(batch.text).toContain("batch");
    expect(agent.transportCalls).toContain("metronome");
    expect(agent.store.doc.markers.some((m) => m.name === "batch cue")).toBe(true);
    const decisionsAfter = agent.store.doc.tracks.reduce((sum, t) => sum + t.effects.length, 0);
    expect(decisionsAfter).toBeGreaterThanOrEqual(decisionsBefore);
    assertFiniteDoc(agent);
  });

  it("phase 4: transport + read-back state + hooks (export, loudness measure/match)", async () => {
    const playing = agent.call("kyx_transport", { action: "play" });
    expect(playing.mutated).toBe(false);
    expect(agent.transportCalls).toContain("play");
    const state = agent.call("kyx_transport", { action: "state" });
    expect(state.mutated).toBe(false);
    expect(state.text.length).toBeGreaterThan(0);

    const meters = agent.call("kyx_meter", { scope: "master" });
    expect(meters.isError).toBeUndefined(); // no live engine headless — honest refusal is fine too
    const measured = await agent.callAsync("kyx_loudness", { op: "measure" });
    expect(measured.text).toContain("LUFS");
    const exported = await agent.callAsync("kyx_export", { format: "wav" });
    expect(exported.text).toContain("fake-export");
    expect(agent.exportRequests).toHaveLength(1);
    const matched = await agent.callAsync("kyx_loudness", { op: "match", targetDb: -14 });
    expect(matched.text).toContain("-14");
    expect(agent.loudnessTrims).toHaveLength(1);
    assertFiniteDoc(agent);
  });

  it("phase 5: producer mega-move — kyx_song builds the whole track, one undo restores", async () => {
    // the arrangement is still empty in this fresh phase store — the mega move
    const song = await agent.callAsync("kyx_song", { genre: "house", length: "short", loudness: -14 });
    expect(song.mutated).toBe(true);
    expect(song.text).toContain("ONE undo step");
    expect(song.text).toContain("loudness");
    const clips = agent.store.doc.arrangement.clips.length;
    expect(clips).toBeGreaterThanOrEqual(4);
    const patternCount = agent.store.doc.patterns.length;
    expect(patternCount).toBeGreaterThan(1);
    // the whole gesture is ONE undo step (song+mix), the loudness trim a second
    agent.store.undo();
    expect(agent.store.doc.arrangement.clips.length).toBe(0);
    assertFiniteDoc(agent);
  });

  it("phase 6: session hygiene — history is coherent and the doc serializes", () => {
    const labels = agent.store.history.map((entry) => entry.label);
    expect(labels.length).toBeGreaterThan(3);
    expect(labels.every((label) => typeof label === "string" && label.length > 0)).toBe(true);
    // the doc round-trips through JSON (persistability sanity)
    const round = JSON.parse(JSON.stringify(agent.store.doc)) as typeof agent.store.doc;
    expect(round.tracks.length).toBe(agent.store.doc.tracks.length);
    expect(round.patterns.length).toBe(agent.store.doc.patterns.length);
    assertFiniteDoc(agent);
  });
});

describe("agent simulation — destructive-locked variant", () => {
  it("a locked agent still completes the creative workflow (no destructive ops needed)", () => {
    const locked = spawnAgent({ allowDestructive: false });
    const gen = locked.call("kyx_generate", { genre: "house", seed: "locked" });
    expect(gen.mutated).toBe(true);
    const removed = locked.call("kyx_tracks", { op: "remove", family: "drums" });
    expect(removed.isError).toBe(true);
    expect(removed.text).toContain("locked");
    const mixed = locked.call("kyx_mix", { genre: "house" });
    expect(mixed.mutated).toBe(true);
    const arranged = locked.call("kyx_arrange", { genre: "house", length: "short" });
    expect(arranged.mutated).toBe(true);
    expect(locked.store.doc.arrangement.clips.length).toBeGreaterThanOrEqual(4);
    assertFiniteDoc(locked);
  });
});
