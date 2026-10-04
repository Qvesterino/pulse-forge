import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { MCP_TOOLS, MCP_RESOURCES } from "../src/mcp/tools";
// @ts-expect-error — the ESM mirror ships no .d.ts; its DATA shape is the
// very thing this gate asserts against the TS source.
import { MCP_TOOL_DEFS as HUB_TOOL_DEFS, MCP_RESOURCE_DEFS as HUB_RESOURCE_DEFS } from "../server/mcp-core.mjs";

/**
 * MCP MIRROR SYNC GATE — the tool/resource surface has THREE copies:
 *
 *   src/mcp/tools.ts          ← SOURCE OF TRUTH (TypeScript)
 *   desktop/mcp-tool-defs.cjs ← CJS mirror (desktop transport)
 *   server/mcp-core.mjs       ← ESM mirror (web transport hub)
 *
 * The mirrors are GENERATED (npm run gen:mcp-mirrors) — hand-editing them
 * is a bug. This gate compares the PARSED DATA (names, descriptions,
 * schemas) across all three copies, so formatting is free but content
 * drift fails. Regenerate after any change to the tool surface.
 */

const require_ = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopModule = require_(resolve(root, "desktop/mcp-tool-defs.cjs")) as {
  MCP_TOOL_DEFS: typeof MCP_TOOLS;
  MCP_RESOURCE_DEFS: typeof MCP_RESOURCES;
};

const toMirror = (tool: (typeof MCP_TOOLS)[number]) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema != null ? { outputSchema: tool.outputSchema } : {}),
});
const toResource = (resource: (typeof MCP_RESOURCES)[number]) => ({
  uri: resource.uri,
  name: resource.name,
  description: resource.description,
  mimeType: resource.mimeType,
});

const TOOL_SHAPED = MCP_TOOLS.map(toMirror);
const RESOURCE_SHAPED = MCP_RESOURCES.map(toResource);

describe("mcp mirror sync gate", () => {
  it("desktop mirror tools + resources equal the TS source (data, order-sensitive)", () => {
    expect(desktopModule.MCP_TOOL_DEFS.map(toMirror)).toEqual(TOOL_SHAPED);
    expect(desktopModule.MCP_RESOURCE_DEFS.map(toResource)).toEqual(RESOURCE_SHAPED);
  });

  it("server hub tools + resources equal the TS source (data, order-sensitive)", () => {
    expect(HUB_TOOL_DEFS.map(toMirror)).toEqual(TOOL_SHAPED);
    expect(HUB_RESOURCE_DEFS.map(toResource)).toEqual(RESOURCE_SHAPED);
  });

  it("every mirror entry is unique (no duplicated defs from partial merges)", () => {
    for (const list of [
      desktopModule.MCP_TOOL_DEFS,
      HUB_TOOL_DEFS,
      desktopModule.MCP_RESOURCE_DEFS,
      HUB_RESOURCE_DEFS,
    ]) {
      const names = (list as Array<Record<string, unknown>>).map((entry) =>
        typeof entry.name === "string" ? entry.name : String(entry.uri),
      );
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
