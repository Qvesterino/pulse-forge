import { canonicalize } from "./tests/domain-goldens/harness";
import { deterministicTestDoc } from "./tests/fixtures/doc";
import { normalizeProject } from "./src/project-model/schema";
import { encodeShareCode, decodeShareCode } from "./src/export/shareCode";

const doc = JSON.parse(JSON.stringify(canonicalize(normalizeProject(deterministicTestDoc())))) as never;
const code = encodeShareCode(doc);
const decoded = decodeShareCode(code) as { doc: unknown };

function diff(a: unknown, b: unknown, path: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { console.log(`${path}: LEN ${a.length} vs ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (typeof a === "object" && a && typeof b === "object" && b) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  console.log(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

const clean = JSON.parse(readFileSync("/dev/stdin", "utf8") || "{}");
void clean;
diff({ marker: "clean" }, { marker: "organ" }, "root");
void decoded;
