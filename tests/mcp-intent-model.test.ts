import { describe, it, expect, afterEach } from "vitest";
import { executeMcpToolAsync, type McpToolContext } from "../src/mcp/tools";
import { setIntentModelProvider, type IntentModelProvider } from "../src/intent/model-resolver";
import { clearIntentMiningLog, readIntentMiningLog } from "../src/intent/failure-log";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE INTENT MODEL SERVES MCP — P1+P2 of the 100% push. The deterministic
 * layer answers first; exactly the asks it cannot execute fall to the
 * registered local model through the SAME executor (destructive gate and
 * verification read-backs included). Every hit/miss/clarify feeds the
 * failure-mining log, so agent asks grow the next corpus round.
 */

function fakeProvider(responses: Record<string, unknown>): IntentModelProvider {
  return {
    id: "fake-intent",
    version: "test",
    async generate(instruction: string) {
      const hit = responses[instruction];
      if (hit != null) return JSON.stringify(hit);
      throw new Error("no canned response");
    },
  };
}

function makeCtx(doc: ProjectDocument, options: { allowDestructive?: boolean } = {}): McpToolContext {
  let current = doc;
  return {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
    },
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

afterEach(() => {
  setIntentModelProvider(null);
  clearIntentMiningLog();
});

describe("kyx_intent model fallback over MCP", () => {
  it("deterministic hit does NOT consult the model", async () => {
    let consulted = false;
    setIntentModelProvider({
      id: "spy",
      version: "test",
      async generate() {
        consulted = true;
        return '{"kind":"transport","action":"stop"}';
      },
    });
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = await executeMcpToolAsync(ctx, "kyx_intent", { instruction: "mute the drums" });
    expect(consulted).toBe(false);
    expect(r.mutated).toBe(true);
    expect(r.text).not.toContain("🤖");
    expect(readIntentMiningLog()).toHaveLength(0);
  });

  it("deterministic miss + model hit → executes the model route with the 🤖 marker", async () => {
    setIntentModelProvider(
      fakeProvider({
        "make the low end feel like a warm blanket": {
          kind: "fader",
          targets: ["bass"],
          pads: [],
          direction: "down",
          amount: "subtle",
        },
      }),
    );
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = await executeMcpToolAsync(ctx, "kyx_intent", {
      instruction: "make the low end feel like a warm blanket",
    });
    expect(r.mutated).toBe(true);
    expect(r.text).toContain("🤖 local model");
    // mining: the hit + what kind it mapped to
    const events = readIntentMiningLog();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "model-hit", routeKind: "fader" });
  });

  it("model-miss falls back to the deterministic answer and logs the miss", async () => {
    setIntentModelProvider(fakeProvider({})); // everything throws
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = await executeMcpToolAsync(ctx, "kyx_intent", { instruction: "flibber the wibber" });
    expect(r.mutated).toBe(false);
    expect(r.text).not.toContain("🤖");
    const events = readIntentMiningLog();
    expect(events.some((event) => event.outcome === "model-miss")).toBe(true);
  });

  it("clarify with no model logs the clarify (reason included)", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    await executeMcpToolAsync(ctx, "kyx_intent", { instruction: "more compression" });
    const events = readIntentMiningLog();
    const clarify = events.find((event) => event.outcome === "clarify");
    expect(clarify).toBeDefined();
    expect(clarify?.reason).toContain("compressor");
  });

  it("a model DESTRUCTIVE route still passes the allow gate (the model never bypasses safety)", async () => {
    setIntentModelProvider(
      fakeProvider({
        "delete the chords track entirely": {
          kind: "arrange",
          ops: [{ op: "remove", role: "chords" }],
        },
      }),
    );
    const gated = makeCtx(createProjectFromTemplate("house"));
    const refused = await executeMcpToolAsync(gated, "kyx_intent", {
      instruction: "delete the chords track entirely",
    });
    expect(refused.mutated).toBe(false);
    expect(refused.text.toLowerCase()).toContain("destructive");

    const allowed = makeCtx(createProjectFromTemplate("house"), { allowDestructive: true });
    const executed = await executeMcpToolAsync(allowed, "kyx_intent", {
      instruction: "delete the chords track entirely",
    });
    expect(executed.mutated).toBe(true);
  });

  it("empty instruction stays an honest no-op", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = await executeMcpToolAsync(ctx, "kyx_intent", { instruction: "   " });
    expect(r.text).toContain("empty instruction");
  });
});
