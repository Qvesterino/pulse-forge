// ═══════════════════════════════════════════════════════════
// generate-mcp-mirrors — the MCP tool/resource surface has THREE copies:
//
//   src/mcp/tools.ts          ← SOURCE OF TRUTH (TypeScript)
//   desktop/mcp-tool-defs.cjs ← CJS mirror (desktop transport)
//   server/mcp-core.mjs       ← ESM mirror (web transport hub)
//
// The mirrors are GENERATED — hand-editing them is a bug. After changing
// the tool surface, run:
//
//   npm run gen:mcp-mirrors          # regenerate both mirrors
//   npm run verify:mcp-mirrors       # --check: exit 1 on drift
//
// verify:all runs the --check gate, so drift can never land.
//
// ═══════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
// tsx runs this script, so importing the TS source directly is fine.
import { MCP_TOOLS, MCP_RESOURCES } from "../src/mcp/tools.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const gen = (defs) => defs.map((t) => "  " + JSON.stringify(t, null, 2).replace(/\n/g, "\n  ")).join(",\n");

const TOOL_BODY = gen(MCP_TOOLS);
const RESOURCE_BODY = gen(MCP_RESOURCES);

function apply(defsBody, resBody) {
  const out = [];
  for (const filePath of ["desktop/mcp-tool-defs.cjs", "server/mcp-core.mjs"]) {
    const abs = resolve(root, filePath);
    let s = readFileSync(abs, "utf8");
    const start = s.indexOf("const MCP_TOOL_DEFS = [") + "const MCP_TOOL_DEFS = [".length;
    const end = s.indexOf("\n];", start);
    if (end < 0) throw new Error(`${filePath}: MCP_TOOL_DEFS close not found`);
    s = s.slice(0, start) + "\n" + defsBody + s.slice(end);
    if (s.includes("const MCP_RESOURCE_DEFS = [")) {
      const rstart = s.indexOf("const MCP_RESOURCE_DEFS = [") + "const MCP_RESOURCE_DEFS = [".length;
      const rend = s.indexOf("\n];", rstart);
      s = s.slice(0, rstart) + "\n" + resBody + s.slice(rend);
    }
    out.push({ filePath, abs, content: s });
  }
  return out;
}

const results = apply(TOOL_BODY, RESOURCE_BODY);

if (check) {
  const normalizeLineEndings = (source) => source.replace(/\r\n/g, "\n");
  const formattedResults = await Promise.all(
    results.map(async (r) => {
      const config = (await resolveConfig(r.abs)) ?? {};
      return { ...r, content: await format(r.content, { ...config, filepath: r.abs }) };
    }),
  );
  const drifted = formattedResults.filter(
    (r) => normalizeLineEndings(readFileSync(r.abs, "utf8")) !== normalizeLineEndings(r.content),
  );
  if (drifted.length > 0) {
    console.error(`[gen:mcp-mirrors] DRIFT detected in: ${drifted.map((d) => d.filePath).join(", ")}`);
    console.error("[gen:mcp-mirrors] Run `npm run gen:mcp-mirrors` and commit the result.");
    process.exit(1);
  }
  console.log("[gen:mcp-mirrors] mirrors in sync with src/mcp/tools.ts ✓");
} else {
  for (const r of results) writeFileSync(r.abs, r.content);
  // mirrors are committed prettier-formatted — normalize right away
  spawnSync("npx", ["-y", "prettier", "--write", ...results.map((r) => r.abs)], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log(`[gen:mcp-mirrors] regenerated ${results.map((r) => r.filePath).join(", ")}`);
}
