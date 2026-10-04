import { describe, expect, it } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { isFactoryPresetsWarm } from "../src/presets/factory-loader";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE COLD-BANK CONTRACT - the factory preset bank is a lazy chunk
 * (presets/factory is ~130 KB and nothing needs it at boot), so it is only
 * readable after `warmFactoryPresets()`. The MCP tool layer is itself an
 * entry surface: a headless host, a relay, a batch call or a test calls
 * `executeMcpTool` directly and must never depend on the UI having warmed
 * the bank first.
 *
 * This file deliberately lives in its OWN module graph (vitest isolates test
 * files), so the bank is genuinely COLD on the first call — which is exactly
 * the state the regression used to hide: `kyx_tracks loadPreset` reached
 * `resolvePresetByName` -> `factoryPresets()` and threw
 * "factory preset bank not warmed".
 *
 * The assertions below pin the ordering: the bank must be cold when the test
 * starts (proving the scenario is real) and warm once the tool has answered.
 */

function makeCtx(doc: ProjectDocument): McpToolContext {
  let current = doc;
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const labels: string[] = [];
  return {
    getDoc: () => current,
    execute: (command) => {
      const prev = current;
      current = command.execute(current);
      labels.push(command.label);
      undoStack.push({ undo: () => command.undo(prev), redo: () => command.execute(current) });
    },
    undo: () => {
      undoStack.pop()?.undo();
    },
    redo: () => {},
    undoStackLength: () => undoStack.length,
    historyLabels: () => [...labels],
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
  };
}

describe("mcp lazy factory bank — the tool layer warms its own bank", () => {
  it("starts COLD so this suite really covers the unwarmed path", () => {
    expect(isFactoryPresetsWarm()).toBe(false);
  });

  it("kyx_tracks loadPreset resolves and applies a preset from a cold bank", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_tracks", {
      op: "loadPreset",
      presetName: "Warm Sub",
      family: "bass",
    });

    expect(result.isError).toBeFalsy();
    expect(result.mutated).toBe(true);
    // The verification read-back, not a dispatch echo: the bank is quoted by
    // NAME, which is only possible when the lazy lookup actually happened.
    expect(result.text).toContain("Warm Sub");
    expect(isFactoryPresetsWarm()).toBe(true);
  });

  it("kyx_tracks listPresets enumerates the bank from a cold bank", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_tracks", { op: "listPresets", family: "bass" });

    expect(result.isError).toBeFalsy();
    expect(result.data?.total).toBeGreaterThan(0);
    expect(String(result.text)).toMatch(/factory presets/);
  });

  it("an unknown preset name is still an honest unknown, not a bank failure", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_tracks", {
      op: "loadPreset",
      presetName: "Definitely Not A Real Preset",
      family: "bass",
    });

    expect(result.mutated).toBe(false);
    expect(result.text).toContain("unknown preset");
    // The suggestion list proves the bank was readable, not just reachable.
    expect(result.text).toContain("listPresets");
  });

  it("kyx_state mixer reports preset NAMES on strips that carry one", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    // Load a preset first so at least one strip carries a presetId.
    await executeMcpTool(ctx, "kyx_tracks", { op: "loadPreset", presetName: "Warm Sub", family: "bass" });
    const result = await executeMcpTool(ctx, "kyx_state", { subject: "mixer" });

    expect(result.isError).toBeFalsy();
    // Name resolution, not the raw presetId fallback.
    expect(String(result.text)).toMatch(/preset=Warm Sub/);
  });
});
