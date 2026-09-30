// ═══════════════════════════════════════════════════════════
// verify-all — the one-command consolidation harness.
//
// Runs every release gate SEQUENTIALLY (a loaded machine is the enemy of
// timing-sensitive browser/E2E checks — never parallelize these), times
// each one, and writes a consolidated JSON + Markdown report. Exit code
// reflects the BLOCKING gates; advisory gates (documented owner-gate
// baselines) report without failing the run.
//
//   npm run verify:all                      # everything below
//   npm run verify:all -- --only unit,browser
//   npm run verify:all -- --skip build,e2e
//   npm run verify:all -- --engines all     # chromium+firefox+webkit
//
// Gates (default order = cheapest-fail-first):
//   typecheck   tsc --noEmit                       (blocking)
//   unit        vitest run                          (blocking)
//   browser     real-browser verifier @chromium     (blocking; PORT 5299 —
//               5199 stays free so Playwright e2e can own/reuse it)
//   factory     factory-preset audio QA             (blocking)
//   e2e         Playwright smoke (5 scenarios)      (blocking)
//   build       production build + bundle budgets   (blocking)
//   audit       npm audit --omit=dev                (blocking)
//   format      prettier --check                    (ADVISORY — the
//               documented pre-existing deviation baseline is an open
//               owner gate; the count is recorded, the run stays green)
// ═══════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = process.env.VERIFY_REPORT_DIR || resolve(root, ".zcode/verify");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BROWSER_PORT = process.env.VERIFY_BROWSER_PORT || "5299";
const ENGINES = (() => {
  const raw = argValue("--engines");
  if (raw)
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return (process.env.KYX_BROWSER_ENGINE || "chromium").split(",");
})();

function args() {
  const out = { only: null, skip: new Set() };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) out.only = new Set(argv[++i].split(","));
    if (argv[i] === "--skip" && argv[i + 1]) argv[++i].split(",").forEach((s) => out.skip.add(s.trim()));
  }
  return out;
}

function argValue(flag) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

const IS_WIN = process.platform === "win32";

const GATES = [
  {
    id: "typecheck",
    label: "Strict typecheck (tsc --noEmit)",
    blocking: true,
    cmd: (npm) => [npm, "run", "typecheck"],
  },
  {
    id: "unit",
    label: "Full Vitest suite",
    blocking: true,
    cmd: (npm) => [npm, "run", "test"],
    // Vitest is heavy on collect; give it room on a shared machine.
    timeoutMs: 45 * 60 * 1000,
  },
  {
    id: "browser",
    label: `Real-browser verifier (${ENGINES.join("+")})`,
    blocking: true,
    cmd: (npm) => [npm, "run", "test:browser"],
    env: { KYX_BROWSER_ENGINE: ENGINES.join(","), PORT: BROWSER_PORT },
    timeoutMs: 30 * 60 * 1000,
  },
  {
    id: "factory",
    label: "Factory preset audio QA (audibility + loudness map)",
    blocking: true,
    cmd: (npm) => [npm, "run", "test:browser:factory-presets"],
    env: { PORT: String(Number(BROWSER_PORT) + 1) },
    timeoutMs: 20 * 60 * 1000,
  },
  {
    id: "e2e",
    label: "Playwright smoke (landing→studio, panels, generate, persistence, shortcuts)",
    blocking: true,
    cmd: (npm) => [npm, "run", "test:e2e:smoke"],
    timeoutMs: 15 * 60 * 1000,
  },
  {
    id: "build",
    label: "Production build + bundle budgets (prebuild worklets incl.)",
    blocking: true,
    cmd: (npm) => [npm, "run", "build"],
    timeoutMs: 20 * 60 * 1000,
  },
  {
    id: "audit",
    label: "npm audit --omit=dev",
    blocking: true,
    cmd: (npm) => [npm, "audit", "--omit=dev"],
    timeoutMs: 5 * 60 * 1000,
  },
  {
    id: "format",
    label: "Prettier check (ADVISORY — documented pre-existing baseline)",
    blocking: false,
    cmd: (npm) => [npm, "run", "format:check"],
    timeoutMs: 5 * 60 * 1000,
  },
];

function runGate(gate) {
  const npm = IS_WIN ? "npm.cmd" : "npm";
  const started = Date.now();
  const env = { ...process.env, ...(gate.env ?? {}) };
  const res = spawnSync(gate.cmd(npm)[0], gate.cmd(npm).slice(1), {
    cwd: root,
    env,
    encoding: "utf8",
    shell: IS_WIN, // npm.cmd needs a shell on Windows
    timeout: gate.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  // Full output goes to disk per gate - the JSON tail is for the console,
  // the file is for failure attribution after the fact.
  const outPath = resolve(REPORT_DIR, `gate-${gate.id}-${STAMP}.log`);
  try {
    const NL = String.fromCharCode(10);
    writeFileSync(outPath, (res.stdout || "") + NL + NL + "[stderr]" + NL + (res.stderr || ""), "utf8");
  } catch {
    /* disk issues must not mask the gate result */
  }
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  const exitCode = res.status ?? (res.error ? -1 : 0);
  const tail = (res.stdout || "").split("\n").filter(Boolean).slice(-12).join("\n");
  const errTail = (res.stderr || "").split("\n").filter(Boolean).slice(-8).join("\n");
  return {
    id: gate.id,
    label: gate.label,
    blocking: gate.blocking,
    status: exitCode === 0 ? "pass" : timedOut ? "timeout" : "fail",
    exitCode,
    durationMs,
    output: outPath,
    summary: summarize(gate.id, res.stdout || "", exitCode),
    tail,
    errTail,
  };
}

/** Pull the one number that matters per gate out of its output. */
function summarize(id, stdout, exitCode) {
  if (exitCode === 0) {
    const m = {
      unit: stdout.match(/Tests\s+(\d+ passed[^\n]*)/),
      browser: stdout.match(/(\d+\/\d+ checks passed)/),
      factory: stdout.match(/(\d+\/\d+)[^\n]*presets[^\n]*/i),
      e2e: stdout.match(/(\d+ passed[^\n]*)/),
    }[id];
    if (m) return m[1];
  }
  const failLine = stdout
    .split("\n")
    .reverse()
    .find((l) => /\bfailed\b|\bFAIL\b|checks passed|Errors/i.test(l));
  return failLine ? failLine.trim().slice(0, 200) : "";
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// ── main ──
const selected = args();
mkdirSync(REPORT_DIR, { recursive: true });
const stamp = STAMP;
console.log(`[verify-all] ${GATES.length} gates · engines=${ENGINES.join("+")} · report → ${REPORT_DIR}`);
console.log(`[verify-all] machine: ${process.platform} node ${process.version} · start ${stamp}\n`);

const results = [];
for (const gate of GATES) {
  if (selected.only && !selected.only.has(gate.id)) {
    console.log(`── ${gate.id.padEnd(10)} SKIP (--only)`);
    continue;
  }
  if (selected.skip.has(gate.id)) {
    console.log(`── ${gate.id.padEnd(10)} SKIP (--skip)`);
    continue;
  }
  console.log(`── ${gate.id.padEnd(10)} ${gate.label}`);
  const r = runGate(gate);
  results.push(r);
  const mark = r.status === "pass" ? "PASS" : r.status === "timeout" ? "TIMEOUT" : r.blocking ? "FAIL" : "ADV-FAIL";
  console.log(`   ${mark} · ${fmtDuration(r.durationMs)}${r.summary ? ` · ${r.summary}` : ""}\n`);
}

const blockingFails = results.filter((r) => r.blocking && r.status !== "pass");
const advisoryFails = results.filter((r) => !r.blocking && r.status !== "pass");
const report = {
  startedAt: stamp,
  node: process.version,
  platform: process.platform,
  engines: ENGINES,
  browserPort: BROWSER_PORT,
  summary: {
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    blockingFailed: blockingFails.length,
    advisoryFailed: advisoryFails.length,
    totalDurationMs: results.reduce((a, r) => a + r.durationMs, 0),
    verdict: blockingFails.length === 0 ? "GREEN" : "RED",
  },
  gates: results,
};
const jsonPath = resolve(REPORT_DIR, `verify-all-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

// Markdown mirror (human review / PR comment material)
const md = [
  `# verify-all — ${stamp}`,
  ``,
  `**Verdict: ${report.summary.verdict}** · ${report.summary.passed}/${report.summary.total} gates passed · total ${fmtDuration(report.summary.totalDurationMs)}`,
  ``,
  `| Gate | Status | Duration | Note |`,
  `| --- | --- | --- | --- |`,
  ...results.map(
    (r) =>
      `| ${r.id} | ${r.status === "pass" ? "✅" : r.blocking ? "❌" : "⚠️"} ${r.status} | ${fmtDuration(r.durationMs)} | ${r.summary || ""} |`,
  ),
  ``,
  ...results
    .filter((r) => r.status !== "pass")
    .map((r) => `## ${r.id} (${r.status})\n\n\`\`\`\n${r.tail || r.errTail}\n\`\`\`\n`),
].join("\n");
const mdPath = resolve(REPORT_DIR, `verify-all-${stamp}.md`);
writeFileSync(mdPath, md, "utf8");

console.log(`[verify-all] ${report.summary.verdict} · report: ${mdPath}`);
if (advisoryFails.length)
  console.log(`[verify-all] advisory (non-blocking): ${advisoryFails.map((r) => r.id).join(", ")}`);
process.exit(blockingFails.length === 0 ? 0 : 1);
