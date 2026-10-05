import { describe, expect, it } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { destructiveCheckpointName, routeIsDestructive } from "../src/intent/route-guard";
import { parseCheckpointIntent } from "../src/intent/studio-words";
import { parseExactIntent } from "../src/intent/exact";
import { restoreIntentCheckpoint, saveIntentCheckpoint } from "../src/intent/checkpoints";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * DESTRUCTIVE-INTENT SAFETY NET (signal-flow audit re-run 2026-10).
 *
 * The MCP layer gated destructive routes behind an explicit unlock, but the
 * in-app Intent Bar executed removeTrack / deleteClip / scene-remove /
 * effect-remove immediately — the bounded undo stack (256) evicts the
 * pre-delete state in a long session. The Intent Bar now consults the SAME
 * routeIsDestructive predicate (shared module — the UI must not import the
 * lazy MCP surface), saves a durable checkpoint first, and a "restore
 * checkpoint" ask brings the state back as one undoable snapshot.
 */

function exactPlan(text: string) {
  const doc = testDoc();
  const route = routeIntentText(text, doc);
  if (route.kind !== "exact") throw new Error(`expected exact, got ${route.kind}`);
  return route.plan;
}

describe("routeIsDestructive (shared MCP + Intent Bar predicate)", () => {
  it("exact removeTrack is destructive; mute/gain plans are not", () => {
    expect(routeIsDestructive({ kind: "exact", plan: exactPlan("remove the bass track") })).toBe(true);
    expect(routeIsDestructive({ kind: "exact", plan: exactPlan("mute the drums") })).toBe(false);
    expect(routeIsDestructive({ kind: "exact", plan: exactPlan("pan the bass left 30") })).toBe(false);
  });

  it("clips deleteClip and effectIntent remove are destructive; copies are not", () => {
    expect(
      routeIsDestructive({
        kind: "clips",
        ops: [{ op: "deleteClip", clipId: "c1" } as never],
      }),
    ).toBe(true);
    expect(
      routeIsDestructive({
        kind: "clips",
        ops: [{ op: "copyClip", clipId: "c1", toBar: 4 } as never],
      }),
    ).toBe(false);
    expect(
      routeIsDestructive({
        kind: "effectIntent",
        intent: { direction: "remove", effectType: "reverb", detected: [] } as never,
      }),
    ).toBe(true);
    expect(
      routeIsDestructive({
        kind: "effectIntent",
        intent: { direction: "more", effectType: "reverb", detected: [] } as never,
      }),
    ).toBe(false);
  });

  it("compound inherits destructiveness from its parts", () => {
    const part = parseExactIntent("remove the bass track");
    expect(part).not.toBeNull();
    expect(
      routeIsDestructive({
        kind: "compound",
        parts: [
          { kind: "exact", plan: { ops: part!.ops } as never },
          { kind: "effect", intent: { direction: "more", effectType: "reverb", detected: [] } as never },
        ],
      }),
    ).toBe(true);
  });

  it("checkpoint names are stable and readable in both surfaces", () => {
    expect(destructiveCheckpointName({ kind: "exact", plan: exactPlan("remove the bass track") })).toBe(
      "auto-before-remove-track",
    );
    expect(
      destructiveCheckpointName({
        kind: "clips",
        ops: [{ op: "deleteClip", clipId: "c1" } as never],
      }),
    ).toBe("auto-before-delete-clip");
  });
});

describe("parseCheckpointIntent (restore ask)", () => {
  it("matches EN + SK restore asks, with and without a name", () => {
    expect(parseCheckpointIntent("restore checkpoint")).toEqual({ action: "restore", name: null });
    expect(parseCheckpointIntent("obnoviť checkpoint")).toEqual({ action: "restore", name: null });
    expect(parseCheckpointIntent("restore the checkpoint auto-before-remove-track")).toEqual({
      action: "restore",
      name: "auto-before-remove-track",
    });
  });

  it("declines everything else (no silent restore)", () => {
    expect(parseCheckpointIntent("restore the mix")).toBeNull();
    expect(parseCheckpointIntent("checkpoint")).toBeNull();
    expect(parseCheckpointIntent("undo")).toBeNull();
  });
});

describe("intent checkpoints (session map; IDB is best-effort)", () => {
  const doc = (): ProjectDocument => ({ ...testDoc(), id: "ckpt-project" }) as ProjectDocument;

  it("save + named restore round-trip through the session map (no IDB needed)", async () => {
    const d = doc();
    const name = await saveIntentCheckpoint("auto-before-remove-track", d);
    expect(name).toBe("auto-before-remove-track");
    const restored = await restoreIntentCheckpoint("ckpt-project", "auto-before-remove-track");
    expect(restored).not.toBeNull();
    expect(restored!.doc.tracks.map((t) => t.id).join()).toBe(d.tracks.map((t) => t.id).join());
  });

  it("unnamed restore picks the newest checkpoint for the project", async () => {
    const d = doc();
    await saveIntentCheckpoint("auto-before-delete-clip", d);
    await new Promise((r) => setTimeout(r, 5));
    const newer = { ...d, bpm: 150 } as ProjectDocument;
    await saveIntentCheckpoint("auto-before-remove-track", newer);
    const restored = await restoreIntentCheckpoint("ckpt-project");
    expect(restored!.name).toBe("auto-before-remove-track");
    expect(restored!.doc.bpm).toBe(150);
  });

  it("checkpoints are project-scoped (another project restores nothing)", async () => {
    await saveIntentCheckpoint("auto-before-remove-track", doc());
    expect(await restoreIntentCheckpoint("some-other-project")).toBeNull();
  });

  it("the snapshot-restore lands as ONE undoable command (mirror of MCP restore)", async () => {
    const { snapshot } = await import("../src/commands/core");
    const before = doc();
    await saveIntentCheckpoint("auto-before-remove-track", before);
    const damaged = { ...before, bpm: 999 } as ProjectDocument; // normalize clamps to 300, fine for the contract
    const restored = (await restoreIntentCheckpoint("ckpt-project", "auto-before-remove-track"))!;
    const command = snapshot("restoreIntentCheckpoint", "Restore checkpoint", damaged, restored.doc);
    const next = command.execute(damaged);
    expect(next.tracks.map((t) => t.id).join()).toBe(before.tracks.map((t) => t.id).join());
    const rolledBack = command.undo(next);
    expect(rolledBack.bpm).toBe(damaged.bpm);
  });
});
