#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Citation verifier for the AAW frontier documents.
//
// WHY THIS EXISTS
// The frontier program cites repository facts as `path:line` — and a `file:line`
// is a CLAIM that a specific piece of code sits at a specific place. That claim
// rots the moment anything above it in the file changes. It already happened
// twice: the ZYVO show-lock wave and the auto-apply wiring shifted the cited
// lines, and the authorization work moved the allowlist into another file.
//
// This script checks every repository citation in docs/frontier/aaw/*.md:
//   1. the file still exists in one of the two repos (KYX or ZYVO);
//   2. the cited line range still fits inside it;
//   3. the cited range still contains its ANCHOR — the token that makes the
//      citation mean something (e.g. `SAFE_AUTO_APPLY_COMMANDS`).
//
// (3) is the part that catches a range that is in-bounds but now points at
// different code. A range that is merely in-bounds is not evidence.
//
// It also reports AMBIGUOUS citations (a bare filename that exists in more
// than one place) instead of guessing — a wrong guess is a false accusation.
//
// Usage: node docs/frontier/_research/verify-citations.mjs
// Exit 0 = every citation resolves; exit 1 = at least one is broken.
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontierDir = resolve(here, "..", "aaw");
const KYX_ROOT = resolve(here, "..", "..", "..");
const ZYVO_ROOT = "D:/VocalForge_DAW";

/**
 * Per-citation anchors: `path:start-end` -> a token that MUST appear inside
 * that exact range. A citation without an entry is only checked for
 * existence and bounds.
 */
const CITATION_ANCHORS = new Map([
  ["packages/agent-runtime/src/audioTools/toolExecution.ts:1141-1179", "autoApplyProposal"],
  ["packages/agent-runtime/src/audioTools/authorization.ts:85-106", "AUTO_APPLY_CAPABILITIES"],
  ["apps/vocalforge-daw/src/agentVoiceManager.ts:5671-5679", "NOT forwarded"],
  ["packages/command-core/src/registry.ts:51-58", "stopped being true"],
  ["packages/command-core/src/authorization.ts:112-115", "Draft-only"],
  // The same filename exists in BOTH repos; the content decides which one the
  // citation means (the ZYVO copy carries the "24 tools" claim).
  ["MCP_AI_CONTROL_MATRIX.md:61-61", "24 tools"],
]);

// Per-file anchors: any range inside this file must contain one of them.
const FILE_ANCHORS = new Map([
  [
    "packages/agent-runtime/src/audioTools/toolExecution.ts",
    ["SAFE_AUTO_APPLY_COMMANDS", "autoApplyProposal", "showLock"],
  ],
  ["packages/command-core/src/registry.ts", ["AcceptProposal", "authorization"]],
  ["apps/vocalforge-daw/src/agent/agentToolHost.ts", ["createAgentToolHost", "autoApplyProposal"]],
  ["apps/vocalforge-daw/src/agent/agentAutonomyState.ts", ["AUTO_APPLY_DEFAULT_LIMIT", "consumeAutoApply"]],
  ["apps/vocalforge-daw/src/liveShowLock.ts", ["liveShowLock", "perform"]],
]);

// Directories that are never the subject of a citation: stale worktrees,
// build output, caches.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "output",
  "scratch",
  ".wt-verify",
  ".wt-audit",
  ".kilo",
  ".turbo",
  "vendor",
]);

function indexRepo(root) {
  const byPath = new Map();
  const byBase = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const abs = join(dir, entry.name);
        const rel = relative(root, abs).replace(/\\/g, "/");
        byPath.set(rel, abs);
        if (!byBase.has(entry.name)) byBase.set(entry.name, []);
        byBase.get(entry.name).push({ abs, rel });
      }
    }
  };
  walk(root);
  return { byPath, byBase };
}

const KYX = indexRepo(KYX_ROOT);
const ZYVO = indexRepo(ZYVO_ROOT);

const lineCache = new Map();
function linesOf(absPath) {
  if (!lineCache.has(absPath)) {
    lineCache.set(absPath, readFileSync(absPath, "utf8").split("\n"));
  }
  return lineCache.get(absPath);
}

/** Candidate absolute paths for a citation's path token, in priority order. */
function candidates(rawPath) {
  const norm = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const out = [];
  for (const [index, repo] of [
    [KYX, "KYX"],
    [ZYVO, "ZYVO"],
  ]) {
    const direct = index.byPath.get(norm);
    if (direct) out.push({ abs: direct, repo });
    // a partial path like `command-core/src/index.ts` -> `packages/command-core/src/index.ts`
    for (const prefix of ["packages/", "apps/", "src/", "docs/"]) {
      const abs = index.byPath.get(prefix + norm);
      if (abs) out.push({ abs, repo });
    }
  }
  return out;
}

/** Bare filename: every file with that name in either repo. */
function baseCandidates(baseName) {
  const out = [];
  for (const [index, repo] of [
    [KYX, "KYX"],
    [ZYVO, "ZYVO"],
  ]) {
    for (const hit of index.byBase.get(baseName) ?? []) out.push({ abs: hit.abs, repo, rel: hit.rel });
  }
  return out;
}

const CITATION = /([A-Za-z0-9_\-./\\]+\.(?:ts|tsx|mjs|cjs|js|json|md|html|css|py|cc|h|mm|m)):(\d+)(?:-(\d+))?/g;

const docs = readdirSync(frontierDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => join(frontierDir, f));

const problems = [];
let checked = 0;

for (const doc of docs) {
  const docRel = relative(KYX_ROOT, doc).replace(/\\/g, "/");
  const text = readFileSync(doc, "utf8");
  const seen = new Set();
  for (const match of text.matchAll(CITATION)) {
    const [, rawPath, startStr, endStr] = match;
    const start = Number(startStr);
    const end = endStr ? Number(endStr) : start;
    const key = `${rawPath}:${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const hasSlash = rawPath.includes("/");
    const direct = candidates(rawPath);
    let pool = direct.length > 0 ? direct : baseCandidates(rawPath.replace(/\\/g, "/").split("/").pop());

    if (pool.length === 0) {
      problems.push({ kind: "UNRESOLVED", doc: docRel, citation: key, note: "file not found in either repo" });
      continue;
    }
    if (pool.length > 1 && !hasSlash) {
      // Ambiguous bare filename. Before reporting it, try to DISAMBIGUATE by
      // content: the anchor that makes the citation mean something decides
      // which file the author meant. Only a genuine tie is reported.
      const exactAnchor = CITATION_ANCHORS.get(`${rawPath.replace(/\\/g, "/")}:${start}-${end}`);
      if (exactAnchor) {
        const matching = pool.filter((c) => {
          const body = linesOf(c.abs);
          return (
            end <= body.length &&
            body
              .slice(start - 1, end)
              .join("\n")
              .includes(exactAnchor)
          );
        });
        if (matching.length === 1) {
          pool = matching;
        } else {
          problems.push({
            kind: "AMBIGUOUS",
            doc: docRel,
            citation: key,
            note: `${pool.length} files named "${rawPath.split("/").pop()}" and the anchor "${exactAnchor}" does not pick exactly one`,
          });
          continue;
        }
      } else {
        const fitting = pool.filter((c) => linesOf(c.abs).length >= end);
        if (fitting.length !== 1) {
          problems.push({
            kind: "AMBIGUOUS",
            doc: docRel,
            citation: key,
            note: `${pool.length} files named "${rawPath.split("/").pop()}" (${pool
              .slice(0, 3)
              .map((c) => `${c.repo}:${c.rel}`)
              .join(", ")}) — cite the full path`,
          });
          continue;
        }
        pool = fitting;
      }
    }

    const target = pool[0];
    const body = linesOf(target.abs);
    checked += 1;
    if (end > body.length) {
      problems.push({
        kind: "OUT-OF-BOUNDS",
        doc: docRel,
        citation: key,
        note: `${target.repo} file has ${body.length} lines; cited ${start}-${end}`,
      });
      continue;
    }

    // Anchor check: the exact citation first, then the whole-file anchors.
    const exact = CITATION_ANCHORS.get(`${rawPath.replace(/\\/g, "/")}:${start}-${end}`);
    const slice = body.slice(start - 1, end).join("\n");
    if (exact) {
      if (!slice.includes(exact)) {
        problems.push({
          kind: "ANCHOR-MISS",
          doc: docRel,
          citation: key,
          note: `${target.repo}: "${exact}" is not inside lines ${start}-${end} — the range drifted`,
        });
      }
      continue;
    }
    const fileAnchors = FILE_ANCHORS.get(rawPath.replace(/\\/g, "/"));
    if (fileAnchors && !fileAnchors.some((a) => slice.includes(a))) {
      problems.push({
        kind: "ANCHOR-MISS",
        doc: docRel,
        citation: key,
        note: `${target.repo}: none of [${fileAnchors.join(", ")}] appear in lines ${start}-${end}`,
      });
    }
  }
}

console.log(`docs scanned: ${docs.length}`);
console.log(`citations checked against source: ${checked}`);
console.log(`problems: ${problems.length}`);
for (const p of problems) console.log(`  [${p.kind}] ${p.doc} :: ${p.citation} — ${p.note}`);
if (problems.length > 0) process.exit(1);
console.log("ALL CITATIONS RESOLVE");
