const fs = require("node:fs");
const path = require("node:path");
function walk(d, out=[]) {
  for (const e of fs.readdirSync(d, {withFileTypes:true})) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name!=="node_modules") walk(p,out); }
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
for (const f of walk("src")) {
  const s = fs.readFileSync(f, "utf8");
  if (/PRIOR_STYLE_VOCAB\s*[:=]/.test(s) && !/import/.test(s.slice(0, s.indexOf("PRIOR_STYLE_VOCAB")))) {
    console.log("DEFINE:", f);
  }
  if (/GROOVE_LIBRARY\s*[:=]/.test(s) && !/import/.test(s.slice(0, s.indexOf("GROOVE_LIBRARY")))) {
    console.log("LIBRARY:", f);
  }
}
