const fs = require("node:fs");
const src = fs.readFileSync("src/intent/production.ts", "utf8");
const i = src.indexOf("export const PRODUCTION_CONCEPTS");
console.log(src.slice(i, i + 420));
const j = src.indexOf("case \"stutter\"");
console.log("---- TAIL OF SWITCH ----");
console.log(src.slice(j, j + 900));
