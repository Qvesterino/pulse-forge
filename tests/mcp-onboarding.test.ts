import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeMcpTool, MCP_RESOURCES, type McpToolContext } from "../src/mcp/tools";
import { MCP_VOCAB_TEXT } from "../src/mcp/onboarding";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { isMixIntentText, parseMixIntent } from "../src/intent/route";
import { parseProductionIntent, PRODUCTION_CONCEPTS } from "../src/intent/production";
import { parseComplaintIntent } from "../src/intent/complaints";
import { parseStepEditIntent } from "../src/intent/sound-words";
import { parseSectionRequests } from "../src/intent/sections";
import { routeIntentText } from "../src/intent/route";

/**
 * AGENT ONBOARDING RESOURCES (Fáza A, docs/AGENTIC-DAW-PLAN.md) — the
 * playbook + vocab resources exist, serve non-trivial text, and the VOCAB
 * is PINNED against the LIVE parsers: if a parser changes its vocabulary,
 * these samples fail and the kyx://vocab document gets updated with it.
 */

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeCtx(): McpToolContext {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  };
}

describe("agent onboarding resources", () => {
  it("resources/list advertises playbook + vocab (7 URIs total)", () => {
    const uris = MCP_RESOURCES.map((resource) => resource.uri);
    expect(uris).toContain("kyx://playbook");
    expect(uris).toContain("kyx://vocab");
    expect(uris).toHaveLength(7);
  });

  it("both resources read non-trivial text without mutating", () => {
    const ctx = makeCtx();
    const playbook = executeMcpTool(ctx, "__kyx_resource", { uri: "kyx://playbook" });
    expect(playbook.mutated).toBe(false);
    expect(playbook.text).toContain("PRODUCER PLAYBOOK");
    expect(playbook.text).toContain("TOKEN ECONOMY");
    expect(playbook.text).toContain("kyx_batch");

    const vocab = executeMcpTool(ctx, "__kyx_resource", { uri: "kyx://vocab" });
    expect(vocab.mutated).toBe(false);
    expect(vocab.text).toContain("INTENT VOCABULARY");
    expect(vocab.text).toContain("PRODUCTION CONCEPTS");
    expect(vocab.text.length).toBeGreaterThan(2000);
    // compactness contract: the agent loads these EVERY session
    expect(playbook.text.length).toBeLessThan(8000);
    expect(vocab.text.length).toBeLessThan(8000);
  });

  it("desktop mirror resource defs match the TS source exactly", () => {
    const defs = require_(path.join(ROOT, "desktop/mcp-tool-defs.cjs")) as {
      MCP_RESOURCE_DEFS: typeof MCP_RESOURCES;
    };
    expect(defs.MCP_RESOURCE_DEFS).toEqual(MCP_RESOURCES);
  });

  it("web hub resource defs match the TS source exactly", () => {
    const hub = require_(path.join(ROOT, "server/mcp-core.mjs")) as {
      MCP_RESOURCE_DEFS: typeof MCP_RESOURCES;
    };
    expect(hub.MCP_RESOURCE_DEFS).toEqual(MCP_RESOURCES);
  });
});

describe("vocab pin — document samples must parse with the LIVE parsers", () => {
  it("mix profile samples", () => {
    expect(isMixIntentText("more reverb, punchier drums")).toBe(true);
    const parsed = parseMixIntent("darker");
    expect(parsed).not.toBeNull();
    expect(isMixIntentText("viac dozvuku")).toBe(true);
    // "bez pumpy" parses as pump-off but needs a trigger phrase for the gate
    expect(parseMixIntent("bez pumpy").overrides.pump).toBe("off");
  });

  it("production concept samples", () => {
    const deeper = parseProductionIntent("make the bass deeper");
    expect(deeper).not.toBeNull();
    expect(deeper?.goals.some((goal) => goal.concept === "deeper")).toBe(true);
    expect(parseProductionIntent("warmer 808 please")).not.toBeNull();
  });

  it("complaint samples", () => {
    const harsh = parseComplaintIntent("the lead is harsh");
    expect(harsh).not.toBeNull();
    expect(parseComplaintIntent("no punch in the drums")).not.toBeNull();
  });

  it("step edit + sound swap samples", () => {
    const step = parseStepEditIntent("remove the kick on beat 3 of bar 2");
    expect(step).not.toBeNull();
    expect(step?.family).toBe("kick");
    expect(step?.action).toBe("remove");
  });

  it("section samples", () => {
    const sections = parseSectionRequests("16-bar intro and drop twice");
    expect(sections).not.toBeNull();
    expect(sections?.requests.length).toBeGreaterThan(0);
  });

  it("routing sanity: mixer words route to mix, generation words stay generation", () => {
    const doc = createProjectFromTemplate("house");
    expect(routeIntentText("more reverb please", doc).kind).toBe("mix");
    expect(routeIntentText("dark rolling techno at 140", doc).kind).toBe("pattern");
    expect(routeIntentText("mute the drums", doc).kind).not.toBe("pattern");
  });

  it("the vocab doc names every live production concept", () => {
    // anti-drift the other direction: new concepts must land in the doc
    for (const concept of PRODUCTION_CONCEPTS) {
      expect(MCP_VOCAB_TEXT).toContain(concept);
    }
  });
});
