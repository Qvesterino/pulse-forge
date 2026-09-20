// One-off: split src/styles.css into section-aligned chunks (<=1000 lines)
// under src/styles/. Cuts only at top-level rule boundaries and preserves the
// original cascade order byte-exactly — the round-trip assertion below is the
// proof that specificity resolution is unchanged.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = "src/styles.css";
const OUT_DIR = "src/styles";
const MAX_LINES = 1000;

const text = readFileSync(SRC, "utf8");

// ── 1. scan top-level blocks (comment- and string-aware state machine) ──
const blocks = [];
let depth = 0;
let blockStart = 0;
let inComment = false;
let inString = null;
let escape = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  const n = text[i + 1];
  if (inComment) {
    if (c === "*" && n === "/") {
      inComment = false;
      i++;
    }
    continue;
  }
  if (inString) {
    if (escape) escape = false;
    else if (c === "\\") escape = true;
    else if (c === inString) inString = null;
    continue;
  }
  if (c === "/" && n === "*") {
    inComment = true;
    i++;
    continue;
  }
  if (c === '"' || c === "'") {
    inString = c;
    continue;
  }
  if (c === "{") depth++;
  else if (c === "}") {
    depth--;
    if (depth < 0) throw new Error(`stray '}' at index ${i}`);
    if (depth === 0) {
      blocks.push([blockStart, i + 1]);
      blockStart = i + 1;
    }
  }
}
if (depth !== 0 || inComment || inString) throw new Error("unbalanced file");
blocks.push([blockStart, text.length]); // tail after the last rule

const countNl = (s) => (s.match(/\n/g) || []).length;

// ── 2. group blocks into named segments at `/* ---------- X ---------- */` ──
const HEADER = /^\/\*\s*-+\s*(.+?)\s*-+\s*\*\/$/;
const segments = [];
for (const [s, e] of blocks) {
  const lead = text.slice(s, e).replace(/^\s+/, "");
  const nlIdx = lead.indexOf("\n");
  const firstLine = (nlIdx === -1 ? lead : lead.slice(0, nlIdx)).trim();
  const m = HEADER.exec(firstLine);
  if (m || segments.length === 0) segments.push({ name: m ? m[1] : "base", blocks: [] });
  segments[segments.length - 1].blocks.push([s, e]);
}

const slug = (name) =>
  name
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

// ── 3. pack segments greedily into chunks, hard cap MAX_LINES ──
const chunks = [];
let cur = null;
let curLines = 0;
for (const seg of segments) {
  if (!cur) {
    cur = { name: seg.name, blocks: [] };
    chunks.push(cur);
    curLines = 0;
  }
  const segLines = seg.blocks.reduce((a, [s, e]) => a + countNl(text.slice(s, e)), 0);
  if (curLines > 0 && curLines + segLines > MAX_LINES) {
    cur = { name: seg.name, blocks: [] };
    chunks.push(cur);
    curLines = 0;
  }
  if (curLines + segLines <= MAX_LINES) {
    cur.blocks.push(...seg.blocks);
    curLines += segLines;
  } else {
    // single section over the cap: split internally at block boundaries
    for (const [s, e] of seg.blocks) {
      const l = countNl(text.slice(s, e));
      if (curLines > 0 && curLines + l > MAX_LINES) {
        cur = { name: seg.name, blocks: [] };
        chunks.push(cur);
        curLines = 0;
      }
      cur.blocks.push([s, e]);
      curLines += l;
    }
  }
}

// ── 4. write files + index, assert byte-exact round-trip ──
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR);
const used = new Map();
const imports = [];
let out = "";
let n = 0;
for (const ch of chunks) {
  n++;
  let label = slug(ch.name) || "section";
  const seen = used.get(label) ?? 0;
  used.set(label, seen + 1);
  if (seen > 0) label += `-${seen + 1}`;
  const file = `${String(n).padStart(2, "0")}-${label}.css`;
  const body = ch.blocks.map(([s, e]) => text.slice(s, e)).join("");
  writeFileSync(join(OUT_DIR, file), body);
  out += body;
  imports.push(`@import "./${file}";`);
  const lines = countNl(body) + (body.endsWith("\n") ? 0 : 1);
  console.log(`${file}  (${lines} lines, starts at: ${ch.name})`);
}
if (out !== text) throw new Error("ROUND-TRIP MISMATCH — concatenated output differs from source!");
writeFileSync(
  join(OUT_DIR, "index.css"),
  "/* Cascade entry — split from src/styles.css (12 579 lines) by scripts/split-styles.mjs.\n" +
    "   Files are imported in the ORIGINAL cascade order; reordering changes\n" +
    "   specificity resolution, so treat the sequence below as load-bearing. */\n" +
    imports.join("\n") +
    "\n",
);
console.log(`OK: ${n} files + index.css, round-trip byte-exact`);
