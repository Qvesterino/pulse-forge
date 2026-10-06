/**
 * DRIFT CHECK — one command for every DERIVABLE artifact in the repo.
 *
 * The repo keeps deriving features into committed artifacts (MCP mirrors,
 * domain goldens, CURRENT-STATE counts) and the "feature landed, artifact
 * stale" class kept shipping: one session re-pinned 12 stale suites by hand
 * (CAMPAIGN_STATE 2026-10-06). This script regenerates each artifact with the
 * SAME npm command humans use, diffs against HEAD, and reports — turning the
 * whole class into a pre-commit gate.
 *
 * Sections:
 *   mcp-mirrors   npm run gen:mcp-mirrors  → desktop/mcp-tool-defs.cjs, server/mcp-core.mjs
 *   domain-goldens npm run goldens:capture → tests/domain-goldens/*.json
 *                 (decode-goldens.json preserved by the capture script's design)
 *   counts        live EFFECT_META / INSTRUMENT_META / TEMPLATES / spec-file
 *                 counts vs the **bold** numbers in docs/CURRENT-STATE.md
 *
 * Safety on the shared working tree (docs/MULTI-AGENT-GUARDRAILS.md): paths
 * that were ALREADY dirty before the run are SKIPPED, never restored — a
 * concurrent session's in-flight work is untouchable. Clean paths are
 * restored (git checkout --) after evaluation so the check leaves no trace.
 *
 * Modes:
 *   npm run drift:check        evaluate; exit 0 clean · 1 drift · 2 tool error
 *   npm run drift:bless        regenerate and LEAVE the new files in place
 *                              (the intentional-change workflow: review the
 *                              diff, then commit)
 *
 * NO shebang (imported by tests; shebang + CRLF breaks vite's transform —
 * see scripts/suite-expectations.mjs). Deterministic generators only: a
 * detected drift is re-verified by a second regeneration before reporting.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFECT_META } from "../src/effects/definitions";
import { INSTRUMENT_META } from "../src/instruments/definitions";
import { TEMPLATES } from "../src/project-model/templates";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");

export interface DriftFinding {
  section: string;
  path: string;
  kind: "stale-artifact" | "count-mismatch" | "skipped-dirty" | "flaky-generator";
  detail: string;
}

/** The second-column **bold** number of a CURRENT-STATE row, found by label. */
export function parseCountRow(markdown: string, label: string): number | null {
  const lines = markdown.split("\n");
  for (const line of lines) {
    if (!line.includes(`**${label}**`)) continue;
    const afterLabel = line.slice(line.indexOf(`**${label}**`) + `**${label}**`.length);
    const m = afterLabel.match(/\*\*(\d+)\*\*/);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/**
 * Restore-safety classification (guardrails: never touch a sibling's
 * in-flight work). "dirty" here means the artifact differed from HEAD BEFORE
 * the generator ran.
 */
export function restoreDecision(cleanBefore: boolean, differsFromHead: boolean): "skip" | "restore" | "keep-diff" {
  if (!cleanBefore) return "skip";
  return differsFromHead ? "keep-diff" : "restore";
}

/** Live spec-file count: tests/**\/*.test.{ts,tsx}, excluding tests/e2e/ (the
 * exact contract docs/CURRENT-STATE.md documents). */
export function countSpecFiles(root: string, dir = "tests"): number {
  let count = 0;
  const base = join(root, dir);
  for (const entry of readdirSync(base)) {
    const full = join(base, entry);
    if (statSync(full).isDirectory()) {
      if (dir === "tests" && entry === "e2e") continue;
      count += countSpecFiles(root, join(dir, entry));
    } else if (/\.test\.tsx?$/.test(entry)) {
      count += 1;
    }
  }
  return count;
}

export interface CountCheck {
  label: string;
  claimed: number | null;
  actual: number;
}

export function collectCountChecks(root: string): CountCheck[] {
  const markdown = readFileSync(join(root, "docs", "CURRENT-STATE.md"), "utf8");
  return [
    {
      label: "Effects",
      claimed: parseCountRow(markdown, "Effects"),
      actual: Object.keys(EFFECT_META).length,
    },
    {
      label: "Instruments",
      claimed: parseCountRow(markdown, "Instruments"),
      actual: Object.keys(INSTRUMENT_META).length,
    },
    {
      label: "Project templates",
      claimed: parseCountRow(markdown, "Project templates"),
      actual: TEMPLATES.length,
    },
    {
      label: "Vitest spec files",
      claimed: parseCountRow(markdown, "Vitest spec files"),
      actual: countSpecFiles(root),
    },
  ];
}

function gitContent(path: string): string | null {
  const res = spawnSync("git", ["show", `HEAD:${path}`], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64e6 });
  return res.status === 0 ? res.stdout : null;
}

function gitDirtyPaths(paths: string[]): Set<string> {
  const res = spawnSync("git", ["status", "--porcelain", "--", ...paths], { cwd: REPO_ROOT, encoding: "utf8" });
  const dirty = new Set<string>();
  if (res.status !== 0) return dirty;
  for (const line of res.stdout.split("\n")) {
    const path = line.slice(3).trim();
    if (path) dirty.add(path);
  }
  return dirty;
}

function restore(path: string): void {
  spawnSync("git", ["checkout", "--", path], { cwd: REPO_ROOT });
}

interface GeneratorSection {
  name: string;
  command: string[];
  ownedPaths: string[];
}

const GENERATORS: GeneratorSection[] = [
  {
    name: "mcp-mirrors",
    command: ["npm", "run", "gen:mcp-mirrors"],
    ownedPaths: ["desktop/mcp-tool-defs.cjs", "server/mcp-core.mjs"],
  },
  {
    name: "domain-goldens",
    command: ["npm", "run", "goldens:capture"],
    ownedPaths: [
      "tests/domain-goldens/command-transforms.json",
      "tests/domain-goldens/decode-goldens.json",
      "tests/domain-goldens/param-math.json",
      "tests/domain-goldens/scheduler-plan.json",
      "tests/domain-goldens/serialization.json",
      "tests/domain-goldens/transport-time.json",
      "tests/domain-goldens/velocity-fx.json",
    ],
  },
];

function runGenerator(command: string[]): { ok: boolean; output: string } {
  const res = spawnSync(command[0]!, command.slice(1), { cwd: REPO_ROOT, encoding: "utf8", shell: true });
  return { ok: res.status === 0, output: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

/** Regenerate, diff owned paths vs HEAD, classify, restore where safe.
 * Returns the findings and whether the section ran at all. */
export function evaluateGeneratorSection(section: GeneratorSection, bless: boolean): DriftFinding[] {
  const dirtyBefore = gitDirtyPaths(section.ownedPaths);
  const run = runGenerator(section.command);
  if (!run.ok) {
    return [
      {
        section: section.name,
        path: section.command.join(" "),
        kind: "flaky-generator",
        detail: "generator command failed",
      },
    ];
  }
  const findings: DriftFinding[] = [];
  const cleanPaths: string[] = [];
  const driftedPaths: string[] = [];
  for (const path of section.ownedPaths) {
    if (dirtyBefore.has(path)) {
      findings.push({
        section: section.name,
        path,
        kind: "skipped-dirty",
        detail: "path was already modified before the check — left untouched (shared-tree guardrail)",
      });
      continue;
    }
    cleanPaths.push(path);
    const worktree = readFileSync(join(REPO_ROOT, path), "utf8");
    const head = gitContent(path);
    if (head !== null && head !== worktree) driftedPaths.push(path);
  }

  // Stability re-verification: a real drift survives a second regeneration;
  // a flaky generator does not.
  const confirmedPaths: string[] = [];
  if (driftedPaths.length > 0 && !bless) {
    for (const path of cleanPaths) restore(path);
    runGenerator(section.command);
    for (const path of driftedPaths) {
      const second = readFileSync(join(REPO_ROOT, path), "utf8");
      const head = gitContent(path);
      if (head !== null && second === head) {
        findings.push({
          section: section.name,
          path,
          kind: "flaky-generator",
          detail: "first regeneration differed from HEAD, the second matched — non-deterministic generator",
        });
      } else {
        confirmedPaths.push(path);
      }
    }
  } else {
    confirmedPaths.push(...driftedPaths);
  }

  for (const path of confirmedPaths) {
    findings.push(
      bless
        ? {
            section: section.name,
            path,
            kind: "stale-artifact",
            detail: "regenerated in place (--bless) — review the diff, then commit",
          }
        : {
            section: section.name,
            path,
            kind: "stale-artifact",
            detail: "committed artifact is stale — run `npm run drift:bless`, review, commit",
          },
    );
  }

  // Final cleanup: restore every clean-before path the generator (or the
  // stability re-run) rewrote. The generator writes LF while an autocrlf
  // checkout has CRLF, so content-identical files still show as modified —
  // git checkout normalizes them back and leaves the tree untouched.
  if (!bless) for (const path of cleanPaths) restore(path);
  return findings;
}

function evaluateCountSection(): DriftFinding[] {
  return collectCountChecks(REPO_ROOT).flatMap((check): DriftFinding[] => {
    if (check.claimed === null) {
      return [
        {
          section: "counts",
          path: `docs/CURRENT-STATE.md:${check.label}`,
          kind: "count-mismatch",
          detail: "row not found in CURRENT-STATE",
        },
      ];
    }
    return check.claimed === check.actual
      ? []
      : [
          {
            section: "counts",
            path: `docs/CURRENT-STATE.md:${check.label}`,
            kind: "count-mismatch",
            detail: `CURRENT-STATE says ${check.claimed}, live code measures ${check.actual}`,
          },
        ];
  });
}

function main(argv: string[]): number {
  const bless = argv.includes("--bless");
  const findings: DriftFinding[] = [];
  for (const section of GENERATORS) {
    console.log(`[drift] section ${section.name} (${section.command.join(" ")})`);
    findings.push(...evaluateGeneratorSection(section, bless));
  }
  console.log("[drift] section counts (live code vs docs/CURRENT-STATE.md)");
  findings.push(...evaluateCountSection());

  const stale = findings.filter((f) => f.kind === "stale-artifact" || f.kind === "count-mismatch");
  const flaky = findings.filter((f) => f.kind === "flaky-generator");
  const skipped = findings.filter((f) => f.kind === "skipped-dirty");

  for (const f of stale) console.log(`✗ DRIFT [${f.section}] ${f.path}: ${f.detail}`);
  for (const f of flaky) console.log(`! FLAKY [${f.section}] ${f.path}: ${f.detail}`);
  for (const f of skipped) console.log(`~ SKIPPED [${f.section}] ${f.path}: ${f.detail}`);
  if (bless) console.log("bless mode: regenerated artifacts left in place — review and commit");
  if (stale.length === 0 && flaky.length === 0) console.log("✓ no drift — derivable artifacts match their generators");
  return stale.length > 0 ? 1 : flaky.length > 0 ? 2 : 0;
}

// CLI guard. vite-node FORKS a worker whose argv does NOT carry the script
// path (probe-verified: argv[1] is the vite-node binary, argv[2] undefined),
// so NO path-based guard can fire there. The reliable discriminator is the
// runner env: vitest sets VITEST=true (skip main — test imports must stay
// silent and side-effect-free), the drift:check vite-node run does not.
// Do NOT touch import.meta.url (vitest transforms it to a non-file URL —
// suite-expectations lesson).
const invokedAsScript = !process.env.VITEST;
if (invokedAsScript) {
  // exitCode (NOT process.exit) — exit() truncates pending stdout writes to
  // a pipe on Windows, which silently ate the whole report on the first run.
  process.exitCode = main(process.argv.slice(3));
}
