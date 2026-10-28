import { describe, expect, it } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * F-06 — kyx_intent's paramIntent branch must read the state back.
 *
 * The read-back chain used to cover production / effectIntent / preset and
 * printed "verification: applied" for every other kind - so a named-knob ask
 * was reported as applied with NO verification at all. The param branch now
 * runs paramReadbackReport and answers with a structured envelope
 * (moved / added / unchanged / skipped); these specs pin that contract.
 */

function makeCtx(store: ProjectStore): McpToolContext {
  return withAgentWriter({
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
    allowDestructive: () => true,
  });
}

describe("kyx_intent paramIntent read-back", () => {
  it("an absolute named-knob set answers with the read-back envelope, not a bare 'applied'", async () => {
    const store = new ProjectStore(testDoc());
    const result = await executeMcpTool(makeCtx(store), "kyx_intent", {
      instruction: "set delay time to 375 ms on the 808",
    });
    expect(result.isError).toBeFalsy();
    expect(result.mutated).toBe(true);
    expect(result.text).toMatch(/read-back: /);
    expect(result.text).toMatch(/read-back confirms the value|read-back found no value change/);
    const data = result.data as { status?: string; added?: unknown[]; moved?: unknown[] };
    expect(["applied", "partial", "no_value_moved"]).toContain(data.status);
    expect(data.added?.length ?? 0 + (data.moved?.length ?? 0)).toBeGreaterThan(0);
  });

  it("F-18: an add-case entry names the landed param and value, not just the track", async () => {
    // delay.time's registry default IS 375 ms, so a fresh "set … to 375 ms"
    // add lands exactly at the default — the very case where the read-back
    // used to say only "added 808" and the agent never learned WHICH param
    // landed at WHICH value.
    const store = new ProjectStore(testDoc());
    const result = await executeMcpTool(makeCtx(store), "kyx_intent", {
      instruction: "set delay time to 375 ms on the 808",
    });
    expect(result.isError).toBeFalsy();
    expect(result.mutated).toBe(true);
    const data = result.data as { added?: string[]; moved?: string[] };
    const addition = (data.added ?? []).find((entry) => /808/.test(entry));
    expect(addition, "the add must land in the added bucket").toBeDefined();
    expect(addition).toMatch(/delay\.time/);
    expect(addition).toMatch(/375/);
    expect(String(result.text)).toMatch(/delay\.time=375/);
  });

  it("a relative named-knob ask reports the move naming the param and its unit", async () => {
    const store = new ProjectStore(testDoc());
    const first = await executeMcpTool(makeCtx(store), "kyx_intent", {
      instruction: "set reverb decay to 2 s on the 808",
    });
    expect(first.isError).toBeFalsy();
    const second = await executeMcpTool(makeCtx(store), "kyx_intent", {
      instruction: "make the reverb decay a bit longer on the 808",
    });
    expect(second.isError).toBeFalsy();
    expect(second.mutated).toBe(true);
    expect(second.text).toMatch(/read-back: /);
    expect(second.text).toMatch(/decay\b/);
  });
});
