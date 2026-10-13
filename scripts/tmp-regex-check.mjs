import { readFileSync } from "node:fs";

// 1. What does route.ts on disk ACTUALLY contain?
const route = readFileSync("src/intent/route.ts", "utf8");
console.log("route has energickejs:", route.includes("energickejs"));
console.log("route has pokojnejs:", route.includes("pokojnejs"));

// 2. The exact regex line, extracted and executed against the probe.
const line = route.split("\n").find((l) => l.includes("REVISE_ENERGY_MORE ="));
console.log("line:", JSON.stringify(line));
const rx = new RegExp(line.split("= ")[1].replace(/;\s*$/, ""));
console.log("test energetickejsie:", rx.test(" energetickejsie "));

// 3. Codepoints of the probe text (homoglyph check).
const probe = "energetickejsie";
console.log("probe codes:", [...probe].slice(0, 6).map((c) => c.codePointAt(0).toString(16)).join(" "));
