/**
 * Golden review pack generator (goal doc Fáze 2 — human review aid).
 *
 * Renders every golden combo's candidates to WAV through the REAL engine
 * (pattern-mode offline render: full drum/instrument synthesis, FX, master
 * chain) so the human curator can JUDGE BY EAR, then record the preferred
 * order in scripts/data/intent-ranker-golden.json.
 *
 * Files are named NEUTRALLY (cand-<index>.wav) so listening is blind — the
 * mapping to seeds is only in LISTENING.md.
 *
 * Run: npx vite-node scripts/render-golden-review-pack.mjs
 * Output: public/golden-review/<combo>/<name>.wav + LISTENING.md
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5235;
const goldenPath = path.join(ROOT, "scripts", "data", "intent-ranker-golden.json");
// OUTSIDE public/ — review WAVs must not enter the PWA precache or the
// served bundle; the curator opens them from the filesystem.
const outRoot = path.join(ROOT, "golden-review");

const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
const dataset = JSON.parse(readFileSync(path.join(ROOT, "scripts", "data", "intent-ranker-dataset.json"), "utf8"));
const byGroupKey = new Map(dataset.groups.map((group) => [group.groupKey, group]));

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

// Browser harness (QA-1 fix): page.evaluate callbacks CANNOT contain
// import() — vite-node rewrites them to __vite_ssr_dynamic_import__, which
// does not exist in the browser. Instead we serve a tiny static module from
// the gitignored golden-review/ dir (Vite dev transforms its static imports
// natively, exactly like the app) and evaluate only plain function calls.
const harnessLines = [
  'import { createDefaultProject } from "/src/project-model/schema.ts";',
  'import { encodeWav } from "/src/rendering/wav.ts";',
  'import { renderProject } from "/src/rendering/renderer.ts";',
  'import { generatePattern } from "/src/ai/generator.ts";',
  'import { normalizeIntent } from "/src/intent/normalize.ts";',
  'import { planGeneration } from "/src/intent/plan.ts";',
  'import { generateFactoryBank } from "/src/sample-library/factory.ts";',
  "",
  "const bankPromise = generateFactoryBank();",
  "window.__renderCombo = async ({ candidateSeeds, genre, style }) => {",
  "  const bank = await bankPromise;",
  "  const out = [];",
  "  for (const seed of candidateSeeds) {",
  "    const intent = normalizeIntent({ genre, ...(style ? { style } : {}), seed, roles: ['drums', 'bass'] });",
  "    const baseDoc = createDefaultProject();",
  "    const plan = planGeneration(intent, baseDoc);",
  "    const pattern = generatePattern(baseDoc, plan.options);",
  "    const doc = { ...baseDoc, patterns: [pattern], activePatternId: pattern.id };",
  "    const buffer = await renderProject(doc, bank, { mode: 'pattern', sampleRate: 44100, tailSeconds: 0.6 });",
  "    const bytes = new Uint8Array(encodeWav(buffer, 16));",
  "    let binary = '';",
  "    const CHUNK = 0x8000;",
  "    for (let i = 0; i < bytes.length; i += CHUNK) {",
  "      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));",
  "    }",
  "    out.push({ seed, b64: btoa(binary) });",
  "  }",
  "  return out;",
  "};",
  "window.__ready = true;",
];
mkdirSync(outRoot, { recursive: true });
writeFileSync(path.join(outRoot, "harness.mjs"), harnessLines.join("\n"));
writeFileSync(
  path.join(outRoot, "harness.html"),
  '<!doctype html><html><body><script type="module" src="./harness.mjs"></scr' + "ipt></body></html>",
);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/golden-review/harness.html`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });

const listeningLines = ["# Golden review — počúvaci pack", ""];
let totalFiles = 0;

function comboDirSafe(combo) {
  return path.join(outRoot, combo.combo.replace(/[^a-z0-9-]/gi, "_"));
}

try {
  for (const combo of golden.combos) {
    const group = byGroupKey.get(combo.groupKey);
    if (!group) throw new Error(`dataset group missing for ${combo.groupKey}`);
    const comboDir = path.join(comboDirSafe(combo));
    mkdirSync(comboDir, { recursive: true });

    listeningLines.push(`## ${combo.combo}`, "");
    listeningLines.push("| Súbor | Kandidát (index/seed) | Heuristické poradie |");
    listeningLines.push("| ----- | --------------------- | ------------------- |");

    // Render each candidate through the REAL engine (pattern mode) — a plain
    // cross-boundary call into the harness module (no imports here: vite-node
    // would rewrite them and the browser has no SSR helper).
    const rendered = await page.evaluate((args) => window.__renderCombo(args), {
      candidateSeeds: group.candidates.map((candidate) => candidate.seed),
      genre: group.genre,
      style: group.style,
    });

    const safeCombo = combo.combo.replace(/[^a-z0-9-]/gi, "_");
    for (const [position, entry] of rendered.entries()) {
      const candidateIndex = group.candidates.find((c) => c.seed === entry.seed)?.index ?? position;
      const name = `cand-${candidateIndex}.wav`;
      writeFileSync(path.join(comboDir, name), Buffer.from(entry.b64, "base64"));
      totalFiles += 1;
      const heuristicRank = combo.order.indexOf(candidateIndex) + 1;
      listeningLines.push(
        `| ${safeCombo}/${name} | #${candidateIndex} (${entry.seed}) | heuristic: ${heuristicRank}. |`,
      );
    }
    listeningLines.push(
      "",
      `→ Tvoje poradie pre ${combo.combo} zapíš do \`scripts/data/intent-ranker-golden.json\` (kandidát INDEXY, najlepší prvý).`,
      "",
    );
  }
} finally {
  await browser.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}

listeningLines.push(
  "---",
  "",
  "Po prespojaní všetkých combo: nastav v `scripts/data/intent-ranker-golden.json`",
  "`reviewed: true`, `reviewedBy`, `reviewedAt` a pusti `npm run ranker:train`.",
);
writeFileSync(path.join(outRoot, "LISTENING.md"), listeningLines.join("\n"));

console.log(`[review-pack] ${totalFiles} candidate render(s) → ${outRoot} (+ LISTENING.md)`);
