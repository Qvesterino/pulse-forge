const fs = require("node:fs");
const src = fs.readFileSync("src/effects/definitions.ts", "utf8");
// find each effect's params array ids
for (const type of ["autofilter","phaser","chorus","reversefx","bitcrusher","vinyl","haasWidener","sidechain","svFilter","freqShifter","comb","chorusDelayBuss","duckingDelay","tapeSat"]) {
  const re = new RegExp("const " + type + "Params[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];");
  const m = re.exec(src);
  if (!m) { console.log(type + " -> NOT FOUND"); continue; }
  const ids = [...m[1].matchAll(/id:\s*"([^"]+)"/g)].map(x => x[1]);
  console.log(type + ": " + ids.join(", "));
}
