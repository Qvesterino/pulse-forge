import { describe, it, expect, beforeEach } from "vitest";
import { executeMcpTool, MCP_TOOLS, resetMcpCheckpoints, type McpToolContext } from "../src/mcp/tools";
import { setMatchEqReference } from "../src/intent/match-eq";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * REFERENCE CONDITIONING SURFACING (complement to the reference-mix wave) —
 * the MATCH EQ + loudness conditioning lives in the intent panel; this
 * makes its installed state VISIBLE to agents through kyx_state
 * subject:reference, read-only. The conditioning itself is the sibling
 * wave's work — this never mutates it.
 */

function makeCtx(): McpToolContext {
  useDeterministicIds();
  resetDeterministicIds();
  resetMcpCheckpoints();
  const store = new ProjectStore(createProjectFromTemplate("house"));
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  };
}

/** A few seconds of band-ish noise at real amplitude — plausible enough for
 * hasMatchEqReference(); loudness plausibility is the conditioning wave's
 * own gate and not this test's subject. */
function syntheticPcm(seconds = 3): Float32Array {
  const out = new Float32Array(16000 * seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    phase += 0.05;
    out[i] = 0.5 * Math.sin(phase) + 0.2 * Math.sin(phase * 3.7);
  }
  return out;
}

beforeEach(() => {
  setMatchEqReference(null);
});

describe("kyx_state reference subject", async () => {
  it("no reference loaded → honest pointer to the MATCH REF flow", async () => {
    const result = await executeMcpTool(makeCtx(), "kyx_state", { subject: "reference" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("no reference loaded");
    expect(result.text).toContain("MATCH REF");
  });

  it("reference installed → tone + level conditioning state is visible", async () => {
    setMatchEqReference(syntheticPcm());
    const result = await executeMcpTool(makeCtx(), "kyx_state", { subject: "reference" });
    expect(result.text).toContain("reference conditioning installed");
    expect(result.text).toContain("MATCH EQ curve installed");
    // the level half is either a real trim or an honest decline — never invented
    expect(result.text).toMatch(/loudness trim ([-+]\d+(\.\d+)? dB|\bdeclined\b)/);
  });

  it("the reference subject is documented in the kyx_state schema enum", async () => {
    const state = MCP_TOOLS.find((tool) => tool.name === "kyx_state")!;
    const schema = state.inputSchema as unknown as { properties: { subject: { enum: string[] } } };
    expect(schema.properties.subject.enum).toContain("reference");
  });
});
