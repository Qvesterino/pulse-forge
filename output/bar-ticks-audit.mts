import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative } from "node:path";

const files = globSync("src/**/*.{ts,tsx}");
type Row = { file: string; line: number; text: string };
const rows: Row[] = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((text, i) => {
    if (/\bBAR_TICKS\b/.test(text)) rows.push({ file: f, line: i + 1, text: text.trim() });
  });
}

const bucket = (t: string): string => {
  if (/\bBAR_TICKS\s*\*/.test(t) || /\*\s*BAR_TICKS/.test(t)) return "MUL: bar * BAR_TICKS";
  if (/\+\s*BAR_TICKS/.test(t) || /BAR_TICKS\s*\+/.test(t)) return "ADD: offset arithmetic";
  if (/\bBAR_TICKS\b\s*[^=]/.test(t) && !/BAR_TICKS\s*\*|\*\s*BAR_TICKS/.test(t)) return "BARE: used without a bar index";
  if (/=\s*BAR_TICKS\s*;?$/.test(t)) return "ASSIGN: const BAR_TICKS = ...";
  return "OTHER";
};

const groups = new Map<string, Row[]>();
for (const r of rows) {
  const b = bucket(r.text);
  const list = groups.get(b) ?? [];
  list.push(r);
  groups.set(b, list);
}
console.log("=== BUCKETS (src only) ===");
for (const [b, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(list.length).padStart(4)}  ${b}`);
}
console.log("\n=== SAMPLE PER BUCKET ===");
for (const [b, list] of groups) {
  console.log(`\n--- ${b} (${list.length}) ---`);
  for (const r of list.slice(0, 6)) {
    console.log(`  ${r.file}:${r.line}  ${r.text.slice(0, 110)}`);
  }
}
console.log("\n=== FILES IN src ===", new Set(rows.map((r) => r.file)).size);
