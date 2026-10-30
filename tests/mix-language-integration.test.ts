import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { classifyPads } from "../src/assist/patternOps";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  applyAndVerifyMixPreview,
  clearMixPreviewLane,
  currentMixPreviewLane,
  formatMixPreview,
  previewMixIdea,
} from "../src/mcp/mix-preview";
import type { Services } from "../src/services";
import { executeMcpTool, executeMcpToolAsync } from "../src/mcp/tools";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

vi.mock("../src/rendering/renderer", () => ({
  throwIfAborted: () => undefined,
  renderProject: async () => ({
    numberOfChannels: 1,
    sampleRate: 44100,
    duration: 1,
    getChannelData: () => new Float32Array(44100).fill(0.01),
  }),
}));

function services() {
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((track) => track.kind === "drum")!;
  if (drum.kind !== "drum") throw new Error("missing drums");
  const kick = classifyPads(drum.pads).kicks[0];
  drum.pads = drum.pads.filter((pad) => !classifyPads([pad]).kicks.length || pad.id === kick.id);
  const bass = doc.tracks.find((track) => track.kind === "instrument" && track.instrument === "808")!;
  const store = new ProjectStore(doc);
  return { store, drum, kick, bass, service: { store, bank: {} } as unknown as Services };
}

afterEach(() => clearMixPreviewLane());

describe("language constraints end to end", () => {
  it("previews, discloses and applies a constrained bass mix without changing the kick track, then undoes", async () => {
    const { store, drum, bass, service } = services();
    const before = structuredClone(store.getDoc());
    const outcome = await previewMixIdea(service, { idea: "warmer bass, uprav len basu, kick nechaj tak" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(formatMixPreview(outcome)).toContain("Protect:");
    expect(formatMixPreview(outcome)).toContain("parent drum track");
    expect(outcome.lane.constraints).toEqual({
      allow: [["tracks", { id: bass.id }]],
      protect: [["tracks", { id: drum.id }]],
    });
    expect(store.getDoc()).toEqual(before);
    const applied = await applyAndVerifyMixPreview(service, outcome.lane);
    expect(applied.applied).toBe(true);
    expect(store.getDoc().tracks.find((track) => track.id === drum.id)).toEqual(
      before.tracks.find((track) => track.id === drum.id),
    );
    expect(store.getDoc().tracks.find((track) => track.id === bass.id)).not.toEqual(
      before.tracks.find((track) => track.id === bass.id),
    );
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.getDoc()).toEqual(before);
  });

  it("asks for a choice before arming a preview when multiple kicks match", async () => {
    const { store, service } = services();
    const doc = structuredClone(store.getDoc());
    const drum = doc.tracks.find((track) => track.kind === "drum")!;
    if (drum.kind !== "drum") throw new Error("missing drums");
    const kick = classifyPads(drum.pads).kicks[0];
    drum.pads.push({ ...kick, id: "kick-second", name: "Kick second" });
    const ambiguous = { ...service, store: new ProjectStore(doc) } as Services;
    const result = await previewMixIdea(ambiguous, { idea: "warmer bass, keep kick" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("kick-second");
    expect(currentMixPreviewLane()).toBeNull();
  });

  it("refuses to apply after the project revision changes", async () => {
    const { store, service } = services();
    const outcome = await previewMixIdea(service, { idea: "warmer bass, keep kick" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);
    const before = store.getDoc();
    store.execute({
      type: "test",
      label: "Change project",
      execute: (doc) => ({ ...doc, name: "changed" }),
      undo: () => before,
    });
    const result = await applyAndVerifyMixPreview(service, outcome.lane);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("changed after preview");
    expect(store.undoStackLength).toBe(1);
  });

  it("routes protected language through MCP preview and prevents the direct intent bypass", async () => {
    const { store, service, drum } = services();
    const execute = vi.fn((command) => store.execute(command));
    const ctx = withAgentWriter({
      getDoc: () => store.getDoc(),
      getRevision: () => store.getRevision(),
      execute,
      undo: () => store.undo(),
      redo: () => store.redo(),
      undoStackLength: () => store.undoStackLength,
      historyLabels: () => [],
      isMicRecordingActive: () => false,
      transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
      mixPreview: (request, signal) => previewMixIdea(service, request, signal),
    });
    const text = "warmer bass, keep kick";
    const preview = await executeMcpToolAsync(ctx, "kyx_mix_idea", { idea: text, preview: true });
    expect(preview.data).toMatchObject({
      proposal: { constraints: { status: "declared", rules: { protect: [["tracks", { id: drum.id }]] } } },
    });
    expect(preview.mutated).toBe(false);
    const direct = await executeMcpTool(ctx, "kyx_intent", { instruction: text });
    expect(direct.text).toContain("kyx_mix_idea");
    expect(direct.isError).toBe(true);
    const dryRun = await executeMcpTool(ctx, "kyx_intent", { instruction: text, dry_run: true });
    expect(dryRun.isError).toBe(true);
    expect(dryRun.text).toContain("kyx_mix_idea");
    const exact = await executeMcpTool(ctx, "kyx_intent", { instruction: "mute kick, keep kick" });
    expect(exact.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
