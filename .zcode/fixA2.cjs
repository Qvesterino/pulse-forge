const fs = require("node:fs");
const path = "src/services.ts";
let src = fs.readFileSync(path, "utf8");

const anchor = `  void ensureCuratedLayer(bank);`;

if (!src.includes(anchor)) {
  console.error("FAIL: ensureCuratedLayer anchor not found");
  process.exit(1);
}

if (src.includes("warmSemanticModel")) {
  console.log("OK: already wired");
  process.exit(0);
}

const replacement = `${anchor}
  // Warm the semantic embedding model (semantic escape hatch, fix A).
  // 88% of library grooves are outside PRIOR_STYLE_VOCAB, so the v3 channel
  // is what keeps generated drums off the template fallback — but its FIRST
  // call pays the whole ~118 MB load inside the request budget. Priming here
  // overlaps that load with project opening, so the first real intent finds
  // the model already resident. Fire-and-forget: boot never blocks on it, and
  // the helper no-ops on a device that has opted out via the embed flag or the
  // mobile deviceMemory guard.
  warmSemanticModel();`;

// Add the import next to the other lazy/best-effort helpers.
const importAnchor = `import { ensureCuratedLayer }`;
if (src.includes(importAnchor)) {
  src = src.replace(importAnchor, `import { ensureCuratedLayer, warmSemanticModel }`);
} else {
  // Fall back to inserting a standalone import after the last import line.
  const lastImport = src.lastIndexOf("\nimport ");
  const endOfLine = src.indexOf("\n", lastImport + 1);
  src =
    src.slice(0, endOfLine + 1) +
    `import { warmSemanticModel } from "./ai/semantic/semantic-client";\n` +
    src.slice(endOfLine + 1);
}

src = src.replace(anchor, replacement);
fs.writeFileSync(path, src, "utf8");
console.log("OK: warmSemanticModel wired into createCoreServices");
