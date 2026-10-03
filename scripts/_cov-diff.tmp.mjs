import { readFileSync } from "node:fs";
const gen = readFileSync("src/presets/preset-loudness.generated.ts", "utf8");
const test = readFileSync("tests/preset-loudness-audit.test.ts", "utf8");
const measured = new Set([...gen.matchAll(/"([^"]+)": -?[\d.]+/g)].map((m) => m[1]));
const factorySrc = readFileSync("src/presets/factory.ts", "utf8");
console.log("generated map size:", measured.size);
// which factory preset ids are missing from the map
const ids = [...factorySrc.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
console.log("factory ids missing from map:", ids.filter((id) => !measured.has(id) && id !== "factory.piano.real").slice(0, 8));
