import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";

const ROOT = "D:/VocalForge_DAW/plugins/ozvena/src";
const starts = ["core/ozvenaProcessor.ts"];
const seen = new Set();
const queue = [...starts];
const external = new Set();

while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    external.add("MISSING: " + rel);
    continue;
  }
  const src = readFileSync(abs, "utf8");
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1].replace(/\.js$/, ".ts");
    const target = resolve(dirname(abs), spec).split("\\").join("/");
    const relTarget = target.slice(ROOT.length + 1);
    if (relTarget.startsWith("..")) {
      external.add("ESCAPES: " + relTarget);
      continue;
    }
    if (/^(ui|v2)\//.test(relTarget)) {
      external.add("DEFERRED: " + relTarget);
      continue;
    }
    queue.push(relTarget);
  }
  for (const em of src.matchAll(/from\s+["']([^."][^"']*)["']/g)) external.add(em[1]);
}

console.log("CLOSURE (" + seen.size + " files):");
for (const f of [...seen].sort()) console.log("  " + f);
console.log("EXTERNAL/DEFERRED:");
for (const e of [...external].sort()) console.log("  " + e);
