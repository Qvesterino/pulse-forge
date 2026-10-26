/**
 * audit-path-shapes.mjs — find citations whose PATH SHAPE is impossible.
 *
 * The repair script that fixed the frontier citations used bare-filename
 * search strings ("schema.ts:62"). Two defects follow from that:
 *
 *   1. NON-IDEMPOTENT: a pair whose replacement CONTAINS its own search
 *      string ("src/project-model/schema.ts:62" -> "src/project-model/
 *      src/project-model/schema.ts:62") re-prefixes on every second run.
 *   2. MIS-TARGETED: a bare filename hits the wrong file when the same
 *      basename exists under a path that was ALREADY qualified
 *      ("src/effects/types.ts:11-16" -> "src/effects/src/project-model/
 *      types.ts:11-16").
 *
 * Both produce a path that cannot exist on disk. The citation verifier
 * masked them, because a path that does not resolve falls back to a
 * basename match and still "finds" a file with the right content.
 *
 * This auditor is STRICT: it reports any cited path that (a) repeats a
 * directory segment immediately, or (b) does not exist on disk.
 *
 * Run: node docs/frontier/_research/audit-path-shapes.mjs
 * Exit:  0 = no impossible path shape, 1 = at least one found.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const FRONTIER = path.join(ROOT, "docs", "frontier", "aaw");
const REPOS = [
  { name: "KYX", dir: ROOT },
  { name: "ZYVO", dir: "D:\\VocalForge_DAW" },
];

/** A cited path: optional dirs, a filename, optional :line or :line-line. */
const CITATION = /`([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_]+)(?::(\d+)(?:-(\d+))?)?`/g;

/** Directory segments that repeat immediately: a/a, b/b. */
function repeatsSegment(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === parts[i - 1] && parts[i] !== "." && parts[i] !== "..") return parts[i];
  }
  return null;
}

/**
 * Every tracked file in every repo, relative to its repo root, indexed ONCE.
 * A cited path is "on disk" when it equals a relative path, or when it is
 * the TAIL of one (the docs cite "src/ai/..." meaning KYX/src/ai/...).
 */
function buildIndex() {
  const bySuffix = new Map();
  for (const repo of REPOS) {
    const base = repo.dir;
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(base, full).replace(/\\/g, "/");
        if (!bySuffix.has(rel)) bySuffix.set(rel, full);
      }
    }
  }
  return bySuffix;
}

const INDEX = buildIndex();

/**
 * The repo's own top-level directories. A cited token is a REPOSITORY path
 * only when it starts with one of them — otherwise it is a HuggingFace model
 * id ("LiquidAI/LFM2.5-Audio-1.5B"), a URL, or a relative fragment, and none
 * of those can be checked for existence on disk.
 */
const REPO_TOP_DIRS = new Set();
for (const rel of INDEX.keys()) {
  const slash = rel.indexOf("/");
  if (slash > 0) REPO_TOP_DIRS.add(rel.slice(0, slash));
}

function isRepoPath(cited) {
  const first = cited.replace(/\\/g, "/").split("/").filter(Boolean)[0];
  if (!first) return false;
  if (/^[a-z]+:\/\//i.test(cited)) return false; // a URL
  return REPO_TOP_DIRS.has(first);
}

/** Does a cited path exist in EITHER repo (as given, or as a path suffix)? */
function resolveInRepo(cited) {
  const normalized = cited.replace(/\\/g, "/").replace(/^\.\//, "");
  if (INDEX.has(normalized)) return INDEX.get(normalized);
  for (const [rel, full] of INDEX) {
    if (rel.endsWith("/" + normalized)) return full;
  }
  return null;
}

const problems = [];
let citations = 0;

for (const file of readdirSync(FRONTIER).filter((f) => f.endsWith(".md"))) {
  const filePath = path.join(FRONTIER, file);
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    CITATION.lastIndex = 0;
    let match;
    while ((match = CITATION.exec(line)) !== null) {
      const cited = match[1];
      if (!cited.includes("/") && !cited.includes("\\")) continue; // bare filename
      if (!isRepoPath(cited)) continue; // a model id or a URL, not a repo path
      citations++;
      const repeated = repeatsSegment(cited);
      if (repeated) {
        problems.push({
          file,
          line: index + 1,
          kind: "REPEATED-SEGMENT",
          detail: `segment "${repeated}" repeats — the path cannot exist`,
          cited,
        });
        continue;
      }
      const resolved = resolveInRepo(cited);
      if (!resolved) {
        problems.push({ file, line: index + 1, kind: "NOT-ON-DISK", detail: "no such file in either repo", cited });
      }
    }
  });
}

console.log(`docs scanned: ${readdirSync(FRONTIER).filter((f) => f.endsWith(".md")).length}`);
console.log(`path-shaped citations checked: ${citations}`);
console.log(`impossible path shapes: ${problems.length}`);
for (const p of problems) {
  console.log(`  [${p.kind}] ${p.file}:${p.line} — ${p.cited} — ${p.detail}`);
}
if (problems.length > 0) {
  console.log("\nIMPOSSIBLE PATH SHAPES FOUND");
  process.exitCode = 1;
} else {
  console.log("\nEVERY CITED PATH SHAPE IS POSSIBLE");
}
