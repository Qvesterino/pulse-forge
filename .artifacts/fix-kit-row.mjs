import { readFileSync, writeFileSync } from "node:fs";
const p = "docs/CURRENT-STATE.md";
let t = readFileSync(p, "utf8");
const before = t;
t = t.replace(
  /Locked by `tests\/effects-essential-kit\.test\.ts` \(\d+\/\d+\) \+ `scripts\/verify-essential-kit\.mjs` \(\d+\/\d+ Chromium\)\./,
  "Locked by `tests/effects-essential-kit.test.ts` (24/24) + `scripts/verify-essential-kit.mjs` (18/18 Chromium, run via `npx vite-node` so the DOM menu is compared against the live `EFFECT_META` count rather than a literal).",
);
if (t === before) { console.log("KIT row: no change needed or not found"); } else { console.log("KIT row updated"); }
writeFileSync(p, t, "utf8");
