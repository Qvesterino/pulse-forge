import { FACTORY_PRESETS } from "./src/presets/factory";
import { FACTORY_PRESET_GAIN_DB } from "./src/presets/preset-loudness.generated";
import { readFileSync } from "node:fs";
const test = readFileSync("tests/preset-loudness-audit.test.ts", "utf8");
const block = test.slice(test.indexOf("const KNOWN_CLAMPED = ["), test.indexOf("];", test.indexOf("const KNOWN_CLAMPED = [")));
const pinned = [...block.matchAll(/"(factory\.[a-z.]+)"/g)].map((m) => m[1]);
const clamped = FACTORY_PRESETS.filter((p) => Math.abs(FACTORY_PRESET_GAIN_DB[p.id] ?? 0) >= 17.95).map((p) => p.id);
console.log("new clamp-hits:", clamped.filter((id) => !pinned.includes(id)).join(",") || "none");
console.log("stale pins:", pinned.filter((id) => !clamped.includes(id)).join(",") || "none");
