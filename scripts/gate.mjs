/**
 * gate.mjs — ONE command that runs every UI gate against a FROZEN build.
 *
 * WHY A FROZEN BUILD
 * -------------------
 * The gates used to run against `npm run dev`. On a shared working tree that
 * is a measurement of somebody else's in-flight work: on 2026-10-20 a parallel
 * session's edit to `src/transport/Transport.ts` (a duplicated `const MIN_BPM`,
 * which is a PARSE error) took down every gate at once, twice, with a
 * "HARNESS_ERROR" that had nothing to do with the measurement.
 *
 * `vite preview` over `dist` measures a build, not a moving target. It also
 * removes vite's dependency-optimizer race, which had been killing runs with
 * "optimized dependencies changed. reloading" landing after the project opened.
 *
 * EXIT CODES (the project's contract, applied to the aggregate)
 * -----------------------------------------------------------
 *   0 = every gate ran and every gate held
 *   1 = a gate ran and FAILED its checks
 *   2 = a gate could not run at all (HARNESS_ERROR — nothing was measured).
 *       This is deliberately distinct from 1: "the harness broke" is not
 *       "the shell is wrong", and a CI that cannot tell them apart trains
 *       people to ignore it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const EXIT_FAILED = 1;
const EXIT_HARNESS_ERROR = 2;

/** A gate: a name, what it measures, and how to run it. */
const GATES = [
  {
    name: "proportion",
    what: "the shell's proportions across viewports (and the coarse-pointer pass)",
    tool: "vite-node",
    args: (url) => ["scripts/ui-proportion.mjs", "--url", url, "--touch"],
  },
  {
    name: "typography",
    what: "the declared type roles actually took effect",
    tool: "node",
    args: (url) => ["scripts/typography-audit.mjs", url],
  },
  {
    name: "material",
    what: "the declared control family actually took the material",
    tool: "node",
    args: (url) => ["scripts/material-audit.mjs", url],
  },
  {
    name: "state-matrix",
    what: "each interaction state looks the way it is declared to look",
    tool: "vite-node",
    args: (url) => ["scripts/state-matrix.mts", "--url", url, "--gate"],
  },
];

/**
 * How to run a local tool.
 *
 * NOT `node_modules/.bin/*.cmd` with `shell: false`: Windows refuses to spawn
 * a `.cmd` shim that way (`spawn EINVAL`), and the fix would be to route
 * through cmd.exe — which the repo forbids. The real entry points are plain
 * JS files, so the running interpreter runs them directly. Cross-platform,
 * no shell, no shim.
 */
const TOOLS = {
  node: () => ({ cmd: process.execPath, prefix: [] }),
  vite: () => ({ cmd: process.execPath, prefix: [join(ROOT, "node_modules", "vite", "bin", "vite.js")] }),
  "vite-node": () => ({ cmd: process.execPath, prefix: [join(ROOT, "node_modules", "vite-node", "vite-node.mjs")] }),
};

/** Resolve a local tool to { cmd, prefix }. */
function bin(name) {
  const tool = TOOLS[name];
  if (!tool) {
    throw new Error(`unknown tool "${name}"`);
  }
  const { cmd, prefix } = tool();
  for (const p of prefix) {
    if (!existsSync(p)) throw new Error(`missing tool entry point: ${p}`);
  }
  return { cmd, prefix };
}

async function waitForPort(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function freePort(start) {
  for (let p = start; p < start + 40; p += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(900) });
      void res;
      continue; // something answers here
    } catch {
      return p; // nothing answers
    }
  }
  return start;
}

/** Run one gate and report its exit code. */
function runGate(gate, url) {
  const { cmd, prefix } = bin(gate.tool);
  const args = [...prefix, ...gate.args(url)];
  console.log(`\n${"=".repeat(72)}\n== ${gate.name}: ${gate.what}\n${"=".repeat(72)}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: false });
  if (res.error) {
    console.error(`HARNESS_ERROR: could not start ${cmd}: ${res.error.message}`);
    return EXIT_HARNESS_ERROR;
  }
  return res.status ?? EXIT_HARNESS_ERROR;
}

// ---- the preview server ------------------------------------------------------

const urlIndex = argv.indexOf("--url");
const externalUrl = urlIndex >= 0 ? argv[urlIndex + 1] : null;
const portIndex = argv.indexOf("--port");
const wantedPort = portIndex >= 0 ? Number(argv[portIndex + 1]) : 5291;

let preview = null;
let url = externalUrl;

if (!url) {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    console.error(
      "HARNESS_ERROR: no dist/index.html. Run `npm run build` first, or pass --url to point the gates at a running server.",
    );
    process.exit(EXIT_HARNESS_ERROR);
  }
  const port = await freePort(wantedPort);
  console.log(`starting vite preview on port ${port} ...`);
  const { cmd, prefix } = bin("vite");
  preview = spawn(cmd, [...prefix, "preview", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  preview.stdout.on("data", (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on("data", (d) => process.stderr.write(`[preview] ${d}`));

  const stop = () => {
    if (preview && !preview.killed) {
      preview.kill();
      preview = null;
    }
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(EXIT_HARNESS_ERROR);
  });

  if (!(await waitForPort(port))) {
    console.error("HARNESS_ERROR: vite preview never answered on its port.");
    stop();
    process.exit(EXIT_HARNESS_ERROR);
  }
  url = `http://127.0.0.1:${port}`;
  console.log(`preview up at ${url}`);
}

// ---- run every gate ----------------------------------------------------------

const results = [];
for (const gate of GATES) {
  const code = runGate(gate, url);
  results.push({ name: gate.name, code });
}

if (preview) {
  preview.kill();
  preview = null;
}

// ---- verdict -----------------------------------------------------------------

console.log(`\n${"=".repeat(72)}\n== gate summary\n${"=".repeat(72)}`);
for (const r of results) {
  const verdict = r.code === 0 ? "PASS" : r.code === EXIT_HARNESS_ERROR ? "HARNESS_ERROR" : "FAIL";
  console.log(`  ${verdict.padEnd(13)} ${r.name}`);
}

const harnessErrors = results.filter((r) => r.code === EXIT_HARNESS_ERROR);
const failures = results.filter((r) => r.code !== 0 && r.code !== EXIT_HARNESS_ERROR);

if (harnessErrors.length) {
  console.error(
    `\n${harnessErrors.length} gate(s) could not run — nothing was measured: ${harnessErrors.map((r) => r.name).join(", ")}`,
  );
  process.exit(EXIT_HARNESS_ERROR);
}
if (failures.length) {
  console.error(`\n${failures.length} gate(s) FAILED: ${failures.map((r) => r.name).join(", ")}`);
  process.exit(EXIT_FAILED);
}
console.log(`\nall ${results.length} gates passed`);
process.exit(0);
