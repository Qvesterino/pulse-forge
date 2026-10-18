import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/mcp/tools";
import { toolAnnotations, toolRisk } from "../src/mcp/agentTrust";

/**
 * AGENT KIT — the pins.
 *
 * Two artifacts face outward (docs/AGENT-KIT.md, docs/mcp-manifest.json) and
 * both must stay true to the app: the manifest is deep-compared with the live
 * tool surface, and every `kyx_*` name the document mentions must exist as a
 * real tool. A document that drifts from the surface is worse than no document.
 */

interface AgentManifest {
  format: string;
  tools: Array<{ name: string; risk: string; annotations: Record<string, boolean> }>;
}

function readManifest(): AgentManifest {
  return JSON.parse(readFileSync("docs/mcp-manifest.json", "utf8")) as AgentManifest;
}

describe("agent kit — the manifest matches the live surface", () => {
  it("lists exactly the shipped tools, in order, with their risk and annotations", () => {
    const manifest = readManifest();
    expect(manifest.format).toBe("kyx-agent-manifest/1");
    expect(manifest.tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    for (const entry of manifest.tools) {
      expect(entry, `${entry.name} risk`).toMatchObject({
        risk: toolRisk(entry.name),
        annotations: toolAnnotations(entry.name),
      });
    }
  });

  it("pins the classes the kit describes: all four exist, and destructive is never read-only", () => {
    const manifest = readManifest();
    const risks = new Set(manifest.tools.map((tool) => tool.risk));
    for (const expected of ["read", "runtime", "mutate", "destructive"]) {
      expect(risks.has(expected), `no ${expected} tool in the manifest`).toBe(true);
    }
    for (const entry of manifest.tools) {
      if (entry.risk === "destructive") expect(entry.annotations.destructiveHint).toBe(true);
      if (entry.risk === "read") expect(entry.annotations.readOnlyHint).toBe(true);
    }
  });
});

describe("agent kit — the document cannot name tools that do not exist", () => {
  it("every kyx_* mentioned in the kit is a real tool", () => {
    const doc = readFileSync("docs/AGENT-KIT.md", "utf8");
    const mentioned = new Set(doc.match(/kyx_[a-z_]+/g) ?? []);
    expect(mentioned.size, "the kit must name real tools, not be empty").toBeGreaterThanOrEqual(5);
    const shipped = new Set(MCP_TOOLS.map((tool) => tool.name));
    for (const name of mentioned) {
      expect(shipped.has(name), `AGENT-KIT.md mentions ${name}, which is not a shipped tool`).toBe(true);
    }
  });

  it("states the enforcement contract the app actually implements", () => {
    const doc = readFileSync("docs/AGENT-KIT.md", "utf8");
    // The kit must say HOW to verify an effect change, not only that a session
    // can be reverted: kyx_meter scope:fx is the closed loop for inserts.
    for (const claim of [
      "pre-session checkpoint",
      "requestId",
      "dryRun",
      "destructiveHint",
      "REVERT SESSION",
      '"scope":"fx"',
    ]) {
      expect(doc, `the kit must state: ${claim}`).toContain(claim);
    }
  });
});
