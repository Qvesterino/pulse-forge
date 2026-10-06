import { describe, expect, it, beforeEach } from "vitest";
import { executeMcpTool, resetMcpUnsunoState, type McpToolContext } from "../src/mcp/tools";
import type { ProjectDocument } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./unsuno/golden-synth";

/**
 * kyx_unsuno — the track-to-project pipeline for agents. The pure pipeline
 * (transcription → unsunoCommand → restyle/regen → advisory) is pinned
 * elsewhere; these tests pin the AGENT CONTRACT: honest refusals without
 * capability/source, the build mutation, session-scoped similarity, and
 * the restyle/regen verbs.
 */

const SR = GOLDEN_SAMPLE_RATE;

function makeCtx(doc: ProjectDocument, options: { withLoader?: boolean; sample?: Float32Array } = {}): McpToolContext {
  let current = doc;
  const base = {
    getDoc: () => current,
    execute: (command: {
      execute: (d: ProjectDocument) => ProjectDocument;
      undo: (d: ProjectDocument) => ProjectDocument;
    }) => {
      const prev = current;
      current = command.execute(current);
      const undo = () => command.undo(prev);
      (base as { undo: () => void }).undo = () => {
        current = undo();
      };
    },
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 1,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: {
      play: () => undefined,
      stop: () => undefined,
      pause: () => undefined,
      setLoop: () => undefined,
      setMetronome: () => undefined,
    },
  } as unknown as McpToolContext;
  if (options.withLoader) {
    const sample = options.sample ?? new Float32Array(SR * 2);
    (base as { loadSampleMono: unknown }).loadSampleMono = async (sampleId: string) =>
      sampleId.startsWith("user.") ? { mono: sample, sampleRate: SR } : null;
  }
  return base;
}

describe("kyx_unsuno — agent surface", () => {
  beforeEach(() => {
    resetMcpUnsunoState();
  });

  it("transcribe without the load capability refuses honestly, nothing mutates", async () => {
    const doc = createProjectFromTemplate("house");
    const result = await executeMcpTool(makeCtx(doc), "kyx_unsuno", { action: "transcribe", sourceId: "user.x" });
    expect(result.mutated).toBe(false);
    expect(result.text).toMatch(/load user-sample audio/i);
  });

  it("transcribe builds the project from a user sample (one mutation) + reports layers", async () => {
    const doc = createProjectFromTemplate("house");
    const ctx = makeCtx(doc, { withLoader: true, sample: renderGoldenTrack(goldenTracks()[0]) });
    const result = await executeMcpTool(ctx, "kyx_unsuno", { action: "transcribe", sourceId: "user.house-1" });
    expect(result.mutated).toBe(true);
    expect(result.text).toMatch(/UN-SUNO built/i);
    const after = ctx.getDoc();
    expect(after.patterns.some((p) => p.name.startsWith("UN-SUNO"))).toBe(true);
    expect(after.bpm).toBe(126);
  });

  it("transcribe on silence refuses honestly (no tempo — nothing mutated)", async () => {
    const doc = createProjectFromTemplate("house");
    const ctx = makeCtx(doc, { withLoader: true, sample: new Float32Array(SR * 2) });
    const result = await executeMcpTool(ctx, "kyx_unsuno", { action: "transcribe", sourceId: "user.quiet" });
    expect(result.mutated).toBe(false);
    expect(result.text).toMatch(/no tempo/i);
  });

  it("similarity before transcribe refuses; after transcribe reports percent + disclaimer", async () => {
    const doc = createProjectFromTemplate("house");
    const ctx = makeCtx(doc, { withLoader: true, sample: renderGoldenTrack(goldenTracks()[0]) });
    const before = await executeMcpTool(ctx, "kyx_unsuno", { action: "similarity" });
    expect(before.text).toMatch(/session-scoped|transcribe first/i);
    await executeMcpTool(ctx, "kyx_unsuno", { action: "transcribe", sourceId: "user.house-1" });
    const verdict = await executeMcpTool(ctx, "kyx_unsuno", { action: "similarity" });
    expect(verdict.text).toMatch(/\d+ %/);
    expect(verdict.text).toMatch(/NIE je právna/i);
    expect(verdict.mutated).toBe(false);
  });

  it("restyle + regen mutate and report the artist", async () => {
    const doc = createProjectFromTemplate("house");
    const ctx = makeCtx(doc, { withLoader: true, sample: renderGoldenTrack(goldenTracks()[0]) });
    await executeMcpTool(ctx, "kyx_unsuno", { action: "transcribe", sourceId: "user.house-1" });
    const restyle = await executeMcpTool(ctx, "kyx_unsuno", { action: "restyle", artist: "travis scott" });
    expect(restyle.mutated).toBe(true);
    expect(restyle.text).toMatch(/travis scott/i);
    const regen = await executeMcpTool(ctx, "kyx_unsuno", { action: "regen", artist: "tech house" });
    expect(regen.mutated).toBe(true);
    const unknown = await executeMcpTool(ctx, "kyx_unsuno", { action: "regen", artist: "nikto taky 999" });
    expect(unknown.mutated).toBe(false);
    expect(unknown.text).toMatch(/unknown artist/i);
  }, 60_000);
});
