// replicate the test's inventory computation vs the generated map
import { readFileSync } from "node:fs";
const gen = readFileSync("src/presets/preset-loudness.generated.ts", "utf8");
const inventorySrc = readFileSync("tests/preset-loudness-audit.test.ts", "utf8");
const gains: Record<string, number> = {};
for (const m of gen.matchAll(/"([^"]+)": (-?[\d.]+)/g)) gains[m[1]] = Number(m[2]);
const CLAMP = 10; // guess: clampPresetGainDb range — read real file below
