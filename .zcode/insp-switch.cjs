const fs = require("node:fs");
const src = fs.readFileSync("src/intent/production.ts", "utf8");
const i = src.indexOf("switch (goal.concept)");
console.log(src.slice(i - 900, i + 2200));
