const fs = require("node:fs");
const src = fs.readFileSync("src/effects/definitions.ts", "utf8");
const re = /type:\s*"([a-zA-Z0-9]+)"/g;
const types = [...new Set([...src.matchAll(re)].map(m=>m[1]))].sort();
console.log("TYPES (" + types.length + "):\n" + types.join(", "));
