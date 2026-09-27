#!/usr/bin/env node
/**
 * prompts-sync.mjs — deduplicate the Family-A audit prompts.
 *
 * PROBLEM
 * 25 files under prompts/{00_CORE,01_COMMON,03_PULSE_FORGE,04_SCHEDULED} each
 * embed a byte-identical ~2 240-character operating contract (Purpose +
 * Operating mode + Non-negotiable rules + Required output). Changing one rule
 * means touching 25 files, and missing a file silently forks the rules.
 *
 * MODEL
 *   prompts/00_CORE/MASTER_DAW_HARDENING_PROMPT.md   the shared contract
 *   prompts/<DIR>/<NAME>.md                          the mission fragment only
 *
 * A fragment is its own title, a pointer to the contract, and the
 * audit-specific mission. Nothing else. The fragments are the source of truth
 * and the only files a human edits.
 *
 * STANDALONE COPIES
 * Audits are copy-pasteable on their own, so `npm run prompts:build`
 * reassembles contract + fragment and writes the result to prompts/_built/,
 * one directory mirroring the fragment tree. That tree is generated — never
 * edit it, never commit it (it is gitignored).
 *
 * USAGE
 *   node scripts/prompts-sync.mjs            # --check: verify, exit 1 on drift
 *   node scripts/prompts-sync.mjs --fix      # rewrite drifted fragments
 *   node scripts/prompts-sync.mjs --build    # also emit prompts/_built/
 *
 * Family B (prompts/daw_qa_reliability_vault/) uses a different template with no
 * shared contract, so this script deliberately ignores it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROMPTS = join(ROOT, "prompts");
const BUILT = join(PROMPTS, "_built");

/** Directories whose prompts inherit the shared contract. */
const FAMILY_A_DIRS = ["00_CORE", "01_COMMON", "03_PULSE_FORGE", "04_SCHEDULED"];

const CONTRACT = join(PROMPTS, "00_CORE", "MASTER_DAW_HARDENING_PROMPT.md");

/**
 * Each Family-A directory names the same concept differently. Values are
 * alternative markers for that directory, tried in order.
 */
const MISSION_HEADINGS = {
  "01_COMMON": ["## Audit-specific mission"],
  "03_PULSE_FORGE": ["## Pulse Forge mission", "## Product-specific mission"],
  "04_SCHEDULED": ["## Scheduled mission"],
};

const args = process.argv.slice(2);
const FIX = args.includes("--fix");
const BUILD = args.includes("--build");

/** Shared contract body = everything after the MASTER H1. */
function readContractBody() {
  const lines = readFileSync(CONTRACT, "utf8").split(/\r?\n/);
  const h1 = lines.findIndex((l) => l.startsWith("# "));
  if (h1 === -1) throw new Error("MASTER prompt has no H1 heading");
  return lines
    .slice(h1 + 1)
    .join("\n")
    .trim();
}

/** Every Family-A fragment (the contract file itself is excluded). */
function listFragments() {
  const out = [];
  for (const dir of FAMILY_A_DIRS) {
    const abs = join(PROMPTS, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      if (!entry.endsWith(".md")) continue;
      if (dir === "00_CORE" && entry === basename(CONTRACT)) continue;
      out.push({ dir, file: entry, path: join(abs, entry) });
    }
  }
  return out.sort((a, b) => `${a.dir}/${a.file}`.localeCompare(`${b.dir}/${b.file}`));
}

/**
 * Read a fragment and split it into its parts.
 *
 * Accepts both shapes so the script is safe to run against a repository that
 * has not been migrated yet:
 *   - fragment:  H1 + reference block + mission
 *   - legacy:    H1 + full contract + `---` + mission
 */
function parsePrompt(path, dir) {
  const raw = readFileSync(path, "utf8");
  const markers = MISSION_HEADINGS[dir];
  if (!markers) throw new Error(`no mission marker mapped for directory ${dir} (${path})`);

  let missionStart = -1;
  let found = null;
  for (const marker of markers) {
    const at = raw.indexOf(marker);
    if (at !== -1 && (missionStart === -1 || at < missionStart)) {
      missionStart = at;
      found = marker;
    }
  }
  if (missionStart === -1) {
    throw new Error(`${path}: expected a mission section (${markers.join(" | ")}) not found`);
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  if (!titleMatch) throw new Error(`${path}: no H1 title`);

  const mission = raw.slice(missionStart).trimEnd();
  if (mission.length < 80) {
    throw new Error(`${path}: mission section is suspiciously short (${mission.length} chars)`);
  }

  return { title: titleMatch[1].trim(), mission, marker: found };
}

/** A fragment is title + pointer + mission. Nothing else. */
function renderFragment(title, dir, file, mission) {
  // Fragments live one level below prompts/, so the contract is one level up.
  const contractPath = `../00_CORE/MASTER_DAW_HARDENING_PROMPT.md`;
  return (
    `# ${title}\n\n` +
    `> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](${contractPath}) ` +
    `— Purpose, 8-step operating loop, non-negotiable rules, required output.\n` +
    `> Materialize a standalone copy: \`npm run prompts:build -- ${dir}/${file}\`\n\n` +
    `${mission}\n`
  );
}

/** A standalone prompt is title + contract + mission. */
function renderStandalone(title, contractBody, mission) {
  return `# ${title}\n\n${contractBody}\n\n---\n\n${mission}\n`;
}

function build(fragments, contractBody, only) {
  // Always rebuild from scratch so removed prompts do not linger.
  rmSync(BUILT, { recursive: true, force: true });
  let count = 0;
  for (const { dir, file, title, mission } of fragments) {
    const rel = `${dir}/${file}`;
    if (only && !rel.includes(only)) continue;
    const out = join(BUILT, dir, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderStandalone(title, contractBody, mission), "utf8");
    count++;
  }
  return count;
}

function main() {
  const contractBody = readContractBody();
  const files = listFragments();

  const parsed = files.map((f) => ({ ...f, ...parsePrompt(f.path, f.dir) }));

  const drift = [];
  for (const f of parsed) {
    const expected = renderFragment(f.title, f.dir, f.file, f.mission);
    const current = readFileSync(f.path, "utf8");
    if (current !== expected) {
      drift.push(f);
      if (FIX) writeFileSync(f.path, expected, "utf8");
    }
  }

  if (BUILD) {
    const only = args.find((a) => !a.startsWith("--"));
    const n = build(parsed, contractBody, only);
    console.log(`[prompts] built ${n} standalone prompt(s) into prompts/_built/`);
  }

  if (drift.length > 0) {
    console.log(`[prompts] ${drift.length} fragment(s) still embed the contract inline:`);
    for (const d of drift) console.log(`  ${d.dir}/${d.file}`);
    if (FIX) {
      console.log("[prompts] rewritten as title + contract pointer + mission.");
    } else {
      console.error("[prompts] run `npm run prompts:sync` to strip the duplicated contract.");
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`[prompts] ${parsed.length} fragment(s) reference the shared contract.`);
  }
}

main();
