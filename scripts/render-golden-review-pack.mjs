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
const outRoot = path.join(ROOT, "public", "golden-review");

const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
const dataset = JSON.parse(readFileSync(path.join(ROOT, "scripts", "data", "intent-ranker-dataset.json"), "utf8"));
const byGroupKey = new Map(dataset.groups.map((group) => [group.groupKey, group]));

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

const listeningLines = ["# Golden review — počúvaci pack", ""];
let totalFiles = 0;

for (const combo of golden.combos) {
  const group = byGroupKey.get(combo.groupKey);
  if (!group) throw new Error(`dataset group missing for ${combo.groupKey}`);
  const safeCombo = combo.combo.replace(/[^a-z0-9-]/gi, "_");
  const comboDir = path.join(outRoot, safeCombo);
  mkdirSync(comboDir, { recursive: true });

  listeningLines.push(`## ${combo.combo}`, "");
  listeningLines.push("| Súbor | Kandidát (index/seed) | Heuristické poradie |");
  listeningLines.push("| ----- | --------------------- | ------------------- |");

  // Render each candidate through the REAL engine (pattern mode).
  const rendered = await page.evaluate(
    async ({ candidateSeeds, genre, style }) => {
      const schema = await import("/src/project-model/schema.ts");
      const wav = await import("/src/rendering/wav.ts");
      const renderer = await import("/src/rendering/renderer.ts");
      const { generatePattern } = await import("/src/ai/generator.ts");
      const { normalizeIntent } = await import("/src/intent/normalize.ts");
      const { planGeneration } = await import("/src/intent/plan.ts");
      const { generateFactoryBank } = await import("/src/sample-library/factory.ts");

      const bank = await generateFactoryBank();
      const out = [];
      for (const seed of candidateSeeds) {
        const intent = normalizeIntent({
          genre,
          ...(style ? { style } : {}),
          seed,
          roles: ["drums", "bass"],
        });
        const baseDoc = schema.createDefaultProject();
        const plan = planGeneration(intent, baseDoc);
        const pattern = generatePattern(baseDoc, plan.options);
        const doc = {
          ...baseDoc,
          patterns: [pattern],
          activePatternId: pattern.id,
        };
        const buffer = await renderer.renderProject(doc, bank, {
          mode: "pattern",
          sampleRate: 44100,
          tailSeconds: 0.6,
        });
        const encoded = wav.encodeWav(buffer, 16);
        const bytes = new Uint8Array(encoded);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        out.push({ seed, b64: btoa(binary) });
      }
      return out;
    },
    {
      candidateSeeds: group.candidates.map((candidate) => candidate.seed),
      genre: group.genre,
      style: group.style,
    },
  );

  for (const [position, entry] of rendered.entries()) {
    const candidateIndex = group.candidates.find((c) => c.seed === entry.seed)?.index ?? position;
    const name = `cand-${candidateIndex}.wav`;
    writeFileSync(path.join(comboDir, name), Buffer.from(entry.b64, "base64"));
    totalFiles += 1;
    const heuristicRank = combo.order.indexOf(candidateIndex) + 1;
    listeningLines.push(`| ${safeCombo}/${name} | #${candidateIndex} (${entry.seed}) | heuristic: ${heuristicRank}. |`);
  }
  listeningLines.push(
    "",
    `→ Tvoje poradie pre ${combo.combo} zapíš do \`scripts/data/intent-ranker-golden.json\` (kandidát INDEXY, najlepší prvý).`,
    "",
  );
}

listeningLines.push(
  "---",
  "",
  "Po prespojaní všetkých combo: nastav v `scripts/data/intent-ranker-golden.json`",
  "`reviewed: true`, `reviewedBy`, `reviewedAt` a pusti `npm run ranker:train`.",
);
writeFileSync(path.join(outRoot, "LISTENING.md"), listeningLines.join("\n"));

await browser.close();
await server.close();
console.log(`[review-pack] ${totalFiles} candidate render(s) → public/golden-review/ (+ LISTENING.md)`);
