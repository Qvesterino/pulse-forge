import { readFileSync, writeFileSync } from "node:fs";
const p = "docs/CURRENT-STATE.md";
const lines = readFileSync(p, "utf8").split("\n");
const i = lines.findIndex((l) => l.includes("primary Add Effect choices"));
if (i < 0) { console.error("anchor not found"); process.exit(1); }
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
lines[i] = `| ${pad("└─ primary Add Effect choices", 52)}| ${pad("15", 6)} | \`CORE_EFFECT_ORDER\` — the Add Effect select used to open with 43 entries across 11 optgroups, which made "which one do I want" a scroll instead of a glance. It now opens on 15, three per area: TONE \`eq\`/\`msEq\`/\`multiband\`; DYNAMICS \`compressor\`/\`limiter\`/\`gate\`; CHARACTER \`saturation\`/\`tapeSat\`/\`drumBuss\`; MOVEMENT \`haasWidener\`/\`chorus\`/\`tremolo\`; SPACE \`delay\`/\`reverb\`/\`duckDelay\`. Equal-height groups keep the select reading as a grid. Mastering suites (ZENIT, APEX, SPAN, TIDE, PRUD) and specialty motion (stutter, comb, vowel) and spectral tools (PORTAL, granularFreeze) keep their own "MORE ..." optgroups one layer down. Nothing is removed: \`ADDITIONAL_EFFECT_GROUPS\` derives from \`!DEVICE_MENU_EFFECTS\`, so all 56 stay discoverable exactly once, and \`CORE\` + \`FLAGSHIP\` + \`MORE\` is what FxAddPopover and the mixer batch bar enumerate. History: 33 → 37 (the four fundamentals were behind the second layer) → 15.`;
writeFileSync(p, lines.join("\n"), "utf8");
console.log("rewritten:", lines[i].slice(0, 100));
