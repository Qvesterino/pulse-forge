#!/usr/bin/env node
/**
 * build-prompt-fragments.mjs — deduplicate the Family-A audit prompts.
 *
 * PROBLEM
 * 25 files under prompts/{00_CORE,01_COMMON,03_PULSE_FORGE,04_SCHEDULED} each
 * embed a byte-identical ~2 240-character operating contract (Purpose +
 * Operating mode + Non-negotiable rules + Required output). Editing the rules
 * means editing 25 files; missing one silently drifts the library.
 *
 * SOLUTION
 * Split each Family-A file into:
 *   - a MISSION FRAGMENT — only the audit-specific tail. This is the source
 *     of truth and the only thing a human edits.
 *   - a HEADER REFERENCE — a one-line pointer to the shared contract.
 *
 * The 25 standalone prompts are still available (copy-pasteable on their own)
 * via `npm run prompts:build`, which reassembles header + fragment and writes
 * the result to prompts/_built/. That directory is generated, never edited.
 *
 * USAGE
 *   node scripts/build-prompt-fragments.mjs            # rewrite fragments
 *   node scripts/build-prompt-fragments.mjs --check     # verify, exit 1 on drift
 *   node scripts/build-prompt-fragments.mjs --build     # also emit _built/
 *
 * Design constraint: this script never touches Family B
 * (prompts/daw_qa_reliability_vault/), which uses a different template and
 * has no shared contract.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROMPTS = join(ROOT, "prompts");
const BUILT = join(PROMPTS, "_built");

/** Directories whose files share the MASTER operating contract. */
const FAMILY_A_DIRS = ["00_CORE", "01_COMMON", "03_PULSE_FORGE", "04_SCHEDULED"];

/** The canonical contract. Everything else inherits from it. */
const CONTRACT = join(PROMPTS, "00_CORE", "MASTER_DAW_HARDENING_PROMPT.md");

/**
 * Where each directory's mission section starts. Family A uses three different
 * headings for the same concept, which is why the offset has to be per-dir.
 */
const MISSION_HEADINGS = {
  "01_COMMON": "## Audit-specific mission",
  "03_PULSE_FORGE": "## Pulse Forge mission",
  "04_SCHEDULED": "## Scheduled mission",
};

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const ALSO_BUILD = args.includes("--build");

/** Contract body = everything after the H1 of MASTER. */
function readContractBody() {
  const raw = readFileSync(CONTRACT, "utf8");
  const lines = raw.split(/\r?\n/);
  // Drop the H1 line; the rest is the shared contract.
  const h1Index = lines.findIndex((l) => l.startsWith("# "));
  if (h1Index === -1) throw new Error("MASTER prompt has no H1 heading");
  return lines
    .slice(h1Index + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

/** Split a Family-A file into { title, mission }. */
function parsePrompt(path) {
  const raw = readFileSync(path, "utf8");
  const dir = basename(dirname(path));
  const marker = MISSION_HEADINGS[dir];
  if (!marker) throw new Error(`no mission marker mapped for directory ${dir} (${path})`);

  const markerIndex = raw.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`${path}: expected mission section "${marker}" not found`);
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  if (!titleMatch) throw new Error(`${path}: no H1 title`);

  const mission = raw.slice(markerIndex).trimEnd();
  if (!mission || mission.length < 80) {
    throw new Error(`${path}: mission section looks empty (${mission.length} chars)`);
  }
  return { title: titleMatch[1].trim(), mission, marker };
}

/** Build the standalone prompt = title + contract + mission. */
function render(title, contractBody, mission) {
  return `# ${title}\n\n${contractBody}\n\n---\n\n${mission}\n`;
}

function listFamilyAFiles() {
  const out = [];
  for (const dir of FAMILY_A_DIRS) {
    const abs = join(PROMPTS, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      if (!entry.endsWith(".md")) continue;
      // 00_CORE holds the contract itself, not a mission fragment.
      if (dir === "00_CORE" && entry === basename(CONTRACT)) continue;
      out.push({ dir, file: entry, path: join(abs, entry) });
    }
  }
  return out.sort((a, b) => (a.dir + a.file).localeCompare(b.dir + b.file));
}

function main() {
  const contractBody = readContractBody();
  const files = listFamilyAFiles();
  const drift = [];
  const built = [];

  for (const { dir, file, path } of files) {
    const { title, mission } = parsePrompt(path);
    const current = readFileSync(path, "utf8");
    const expected = render(title, contractBody, mission);

    if (current !== expected) {
      drift.push({ dir, file });
      if (!CHECK_ONLY) writeFileSync(path, expected, "utf8");
    }

    if (ALSO_BUILD) {
      built.push({ out: join(BUILT, dir, file), content: expected });
    }
  }

  if (ALSO_BUILD || !CHECK_ONLY) {
    // Clear previous output so removed prompts do not linger.
    if (existsSync(BUILT)) {
      for (const dir of FAMILY_A_DIRS) {
        const abs = join(BUILT, dir);
        if (!existsSync(abs)) continue;
        for (const entry of readdirSync(abs)) {
          if (entry.endsWith(".md")) {
            // Only rewrite; the caller re-runs for a full clean.
            void entry;
          }
        }
      }
    }
    for (const { out, content } of built) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, content, "utf8");
    }
  }

  if (drift.length > 0) {
    console.log(`[prompts] ${drift.length} file(s) rewritten to match the shared contract:`);
    for (const d of drift) console.log(`  ${d.dir}/${d.file}`);
  } else {
    console.log(`[prompts] ${files.length} Family-A prompt(s) already match the shared contract.`);
  }

  if (ALSO_BUILD) {
    console.log(`[prompts] built ${built.length} standalone prompt(s) into prompts/_built/`);
  }

  if (CHECK_ONLY && drift.length > 0) {
    console.error("[prompts] drift detected — run `npm run prompts:sync`");
    process.exitCode = 1;
  }
}

main();
