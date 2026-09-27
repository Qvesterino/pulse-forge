const fs = require("node:fs");
const src = fs.readFileSync("src/effects/definitions.ts", "utf8");
const types = [...new Set([...src.matchAll(/id:\s*"([a-zA-Z0-9]+)"\s*,\s*name:/g)].map(m=>m[1]))];
console.log("ALL EFFECT TYPES:\n" + types.join("\n"));
