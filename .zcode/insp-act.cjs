const fs = require("node:fs");
const src = fs.readFileSync("src/intent/production.ts", "utf8");
const i = src.indexOf("export interface ProductionAction");
console.log(src.slice(i, i + 420));
const j = src.indexOf("sidechain");
const k = src.indexOf("type: \"sidechain\"");
console.log("--- any existing sidechain action? ---");
console.log(k === -1 ? "none in planner" : src.slice(k - 260, k + 320));
