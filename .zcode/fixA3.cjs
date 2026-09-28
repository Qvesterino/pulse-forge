const fs = require("node:fs");
const path = "src/services.ts";
let src = fs.readFileSync(path, "utf8");

// Undo the wrong import the previous patch made.
src = src.replace(
  `import { ensureCuratedLayer, warmSemanticModel } from "./sample-library/curated";`,
  `import { ensureCuratedLayer } from "./sample-library/curated";`,
);

// Add the correct import next to the other ai/ imports.
const anchor = `import { AudioEngine }`;
if (!src.includes(anchor)) {
  console.error("FAIL: AudioEngine import anchor not found");
  process.exit(1);
}
if (!src.includes("warmSemanticModel } from \"./ai/semantic/semantic-client\"")) {
  src = src.replace(
    anchor,
    `import { warmSemanticModel } from "./ai/semantic/semantic-client";\n${anchor}`,
  );
}

fs.writeFileSync(path, src, "utf8");

const lines = src.split("\n");
lines.forEach((l, i) => {
  if (l.includes("warmSemanticModel") || l.includes('from "./ai/semantic')) {
    console.log(`${i + 1}: ${l.trim()}`);
  }
});
