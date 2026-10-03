import { readFileSync } from "node:fs";
const gen = readFileSync("src/presets/preset-loudness.generated.ts", "utf8");
const test = readFileSync("tests/preset-loudness-audit.test.ts", "utf8");
const gains = {};
for (const m of gen.matchAll(/"([^"]+)": (-?[\d.]+)/g)) gains[m[1]] = Number(m[2]);
const inv = test.match(/const KNOWN_CLAMPED = \[([\s\S]*?)\];/);
if (!inv) { console.log("NO INVENTORY FOUND"); process.exit(0); }
const known = [...inv[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
const actual = Object.entries(gains).filter(([, g]) => Math.abs(g) >= 18).map(([id]) => id).sort();
console.log("known-only:", known.filter((id) => !actual.includes(id)));
console.log("actual-only:", actual.filter((id) => !known.includes(id)));
