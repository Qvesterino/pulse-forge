/**
 * v1 vs v3 LISTENING pack — renders the same prompts through BOTH drum
 * conditioning channels (flag override: v1 one-hot vs v3 hybrid semantic)
 * through the REAL engine, so the human can JUDGE BY EAR which conditioning
 * wins. Complements the structural shadow A/B (embedding:ab) with the only
 * evidence that ultimately matters: ears.
 *
 * Run: npx vite-node scripts/render-v1v3-listening.mjs
 * Output: v1v3-listening/<n>-<slug>.{v1,v3}.wav + LISTENING.md
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5253;
const outRoot = path.join(ROOT, "v1v3-listening");

const PROMPTS = [
  "dark rainy berlin techno at 132",
  "sunny uplifting techno at 132",
  "aggressive hard trap at 145",
  "deep house sunset groove",
  "minimal hypnotic techno",
  "funky house party at 125",
];

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

mkdirSync(outRoot, { recursive: true });
const lines = ["# v1 vs v3 conditioning — počúvaci pack", ""];
let totalFiles = 0;

for (const [index, prompt] of PROMPTS.entries()) {
  const slug = prompt
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  console.log(`[v1v3] ${index + 1}/${PROMPTS.length}: ${prompt}`);

  const rendered = await page.evaluate(
    async ({ prompt, index }) => {
      const schema = await import("/src/project-model/schema.ts");
      const wav = await import("/src/rendering/wav.ts");
      const renderer = await import("/src/rendering/renderer.ts");
      const { normalizeIntent } = await import("/src/intent/normalize.ts");
      const { parseIntentText } = await import("/src/intent/text-parser.ts");
      const { planGeneration } = await import("/src/intent/plan.ts");
      const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
      const { symbolicPriorProvider } = await import("/src/intent/providers/symbolic.ts");
      const { setEmbeddingConditionedOverride } = await import("/src/ai/symbolic/prior-client.ts");

      const bank = await generateFactoryBank();
      const out = [];
      for (const mode of ["v1", "v3"]) {
        setEmbeddingConditionedOverride(mode === "v3" ? "on" : "off");
        const doc = schema.createDefaultProject();
        const parsed = parseIntentText(prompt);
        const intent = normalizeIntent({
          ...parsed.input,
          seed: `v1v3-${index}`,
          candidateCount: 0,
          symbolicCandidates: 1,
          text: prompt,
        });
        const plan = planGeneration(intent, doc);
        const { entries } = await symbolicPriorProvider.collectCandidates(
          plan,
          { project: doc, mode: "apply" },
          0,
        );
        const pattern = entries[0]?.pattern;
        if (!pattern) {
          out.push({ mode, error: "no candidate" });
          continue;
        }
        const docWithPattern = { ...doc, patterns: [pattern], activePatternId: pattern.id };
        const buffer = await renderer.renderProject(docWithPattern, bank, {
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
        out.push({ mode, b64: btoa(binary), name: pattern.name });
      }
      setEmbeddingConditionedOverride(null);
      return out;
    },
    { prompt, index },
  );

  const base = path.join(outRoot, `${index + 1}-${slug}`);
  lines.push(`## ${index + 1}. ${prompt}`, "");
  for (const entry of rendered) {
    if (entry.error) {
      lines.push(`- ${entry.mode}: ${entry.error}`, "");
      continue;
    }
    writeFileSync(path.join(outRoot, `${index + 1}-${slug}.${entry.mode}.wav`), Buffer.from(entry.b64, "base64"));
    totalFiles += 1;
    lines.push(`- ${index + 1}-${slug}.${entry.mode}.wav — ${entry.name}`, "");
  }
  lines.push("");
}

lines.push(
  "---",
  "",
  "Počuj páry (v1 = one-hot conditioning, v3 = hybrid semantic+one-hot) a zaznamenaj,",
  "ktorý smer ti hrá lepšie — výsledok patrí do listening-room verdiktu hybridu.",
);
writeFileSync(path.join(outRoot, "LISTENING.md"), lines.join("\n"));

await browser.close();
await server.close();
console.log(`[v1v3] ${totalFiles} render(s) → ${outRoot} (+ LISTENING.md)`);
