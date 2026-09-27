const fs = require("node:fs");
const src = fs.readFileSync("src/effects/definitions.ts", "utf8");
for (const n of ["pumpParams","sidechainParams"]) {
  const m = new RegExp("const " + n + "[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];").exec(src);
  if (!m) { console.log(n + " NOT FOUND"); continue; }
  console.log(n.replace("Params","") + ": " + [...m[1].matchAll(/id:\s*"([^"]+)"/g)].map(x=>x[1]).join(", "));
}
const r = fs.readFileSync("src/effects/registry.ts","utf8");
const i = r.indexOf('type: "sidechain"');
console.log("--- sidechain sidechainSource param? ---");
console.log(/sidechainSource|sidechainTrackId/.test(r) ? "YES - sidechain wiring exists in registry" : "NO");
