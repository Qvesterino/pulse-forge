import { readFileSync, writeFileSync } from "node:fs";
const p = "docs/CURRENT-STATE.md";
let t = readFileSync(p, "utf8");
const m = t.match(/(\| \*\*Vitest spec files\*\*\s*\| )\*\*(950|951|952|953|954|955|956|957|958|959|960|961|962|963|964|965|966|967|968|969|970)\*\*/);
if (!m) { console.error("anchor not found"); process.exit(1); }
t = t.replace(m[0], m[1] + "**965**");
writeFileSync(p, t, "utf8");
console.log("was", m[2], "-> 965");
