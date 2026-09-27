const fs = require("node:fs");
const src = fs.readFileSync("src/effects/definitions.ts", "utf8");
for (const name of ["svFilterParams","reverseSwellParams","eqParams","bassBussParams","flangerParams","pitchShiftParams","stutterParams","ringModParams","utilityParams"]) {
  const re = new RegExp("const " + name + "[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];");
  const m = re.exec(src);
  if (!m) { console.log(name + " -> NOT FOUND"); continue; }
  const ids = [...m[1].matchAll(/id:\s*"([^"]+)"/g)].map(x => x[1]);
  console.log(name.replace("Params","") + ": " + ids.join(", "));
}
