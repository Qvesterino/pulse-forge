/**
 * LANE LISTENING PACK — renders the NEW sub-genre lanes (this session's
 * waves) through the REAL engine WITH their melodic dialects: drums from
 * the groove + bass/chords/lead from the per-style melodic layer. The
 * human judges by ear whether each lane matches its reference identity.
 *
 * Run: node scripts/render-lane-listening.mjs
 * Output: lane-listening/<id>.wav + LISTENING.md
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5257;
const outRoot = path.join(ROOT, "lane-listening");

const LANES = [
  { id: "house.amapiano", ref: "log drum answers the kick, airy chords" },
  { id: "house.dembow", ref: "chop bass under the rim chop" },
  { id: "house.ghettotech", ref: "banging 808 bounce, Detroit" },
  { id: "house.baile", ref: "tamborzão punchy syncopation" },
  { id: "house.footwork", ref: "jumpy battle polyrhythm, 160" },
  { id: "dnb.jungle", ref: "long deep sub under fast break" },
  { id: "house.slaphouse", ref: "plucky slap bass, minimal club" },
  { id: "house.metal", ref: "gallop backbeat, heavy" },
  { id: "house.tropical", ref: "soft beach floor, steel pan" },
  { id: "house.kuduro", ref: "Luanda carnival engine" },
  { id: "house.grunge", ref: "garage stomp backbeat" },
  { id: "house.indie", ref: "garage-groove revival, dance lean" },
];

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  // hmr off: a concurrent session saving a file mid-render kills page.evaluate
  server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
// Generous nav timeout: under a loaded machine (parallel sessions) the
// default 30 s aborts before the dev server's first compile finishes.
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180000 });

mkdirSync(outRoot, { recursive: true });
const lines = ["# New lanes — počúvaci pack (drums + melodic dialect)", ""];
let totalFiles = 0;
let failures = 0;

for (const lane of LANES) {
  const [genre, style] = lane.id.split(".");
  console.log(`[lanes] rendering ${lane.id} …`);
  const rendered = await page.evaluate(
    async ({ genre, style }) => {
      const schema = await import("/src/project-model/schema.ts");
      const wav = await import("/src/rendering/wav.ts");
      const renderer = await import("/src/rendering/renderer.ts");
      const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
      const { getGrooveById } = await import("/src/ai/grooves/index.ts");
      const { generatePattern } = await import("/src/ai/generator.ts");
      const { normalizeIntent } = await import("/src/intent/normalize.ts");
      const { planGeneration } = await import("/src/intent/plan.ts");

      const groove = getGrooveById(`${genre}.${style}`);
      if (!groove) return { error: `groove ${genre}.${style} not found` };

      const bank = await generateFactoryBank();
      const midBpm = Math.round((groove.bpm[0] + groove.bpm[1]) / 2);
      const doc = { ...schema.createDefaultProject(), bpm: midBpm };
      const out = [];
      for (const [patternIndex, pattern] of groove.patterns.slice(0, 2).entries()) {
        const patternDoc = {
          ...doc,
          patterns: [
            ...doc.patterns,
            {
              id: `lane-render-${style}-${patternIndex}`,
              name: `${groove.name} ${patternIndex + 1}`,
              trackId: doc.tracks.find((t) => t.kind === "drum")?.id ?? doc.tracks[0]?.id ?? "",
              stepCount: 16,
              rows: pattern,
              swing: groove.swing,
            },
          ],
          activePatternId: `lane-render-${style}-${patternIndex}`,
        };
        // FULL roles — the melodic dialect must be audible, not just drums
        const intent = normalizeIntent({
          genre,
          style,
          seed: `lane-${style}-${patternIndex}`,
          bpmRange: [midBpm, midBpm],
        });
        const plan = planGeneration(intent, patternDoc);
        const generated = generatePattern(patternDoc, plan.options);
        const renderDoc = {
          ...patternDoc,
          patterns: [...patternDoc.patterns.slice(0, doc.patterns.length), generated],
          activePatternId: generated.id,
        };
        const buffer = await renderer.renderProject(renderDoc, bank, {
          mode: "pattern",
          sampleRate: 44100,
          tailSeconds: 0.8,
        });
        const encoded = wav.encodeWav(buffer, 16);
        const bytes = new Uint8Array(encoded);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        out.push({ patternIndex, b64: btoa(binary) });
      }
      return { out, midBpm };
    },
    { genre, style },
  );

  if (rendered.error) {
    console.log(`[lanes] ERROR: ${rendered.error}`);
    failures += 1;
    continue;
  }
  lines.push(`## ${lane.id} (@ ${rendered.midBpm} BPM)`, "", `Ref: ${lane.ref}`, "");
  for (const entry of rendered.out) {
    const name = `${lane.id.replace(".", "-")}-${entry.patternIndex + 1}.wav`;
    writeFileSync(path.join(outRoot, name), Buffer.from(entry.b64, "base64"));
    totalFiles += 1;
    lines.push(`- ${name}`);
  }
  lines.push("");
}

lines.push(
  "---",
  "",
  "Pri každom lane posúď dve veci: (1) **drumy sedia identite?** (2) **basové dialekty sedia?**",
  "(amapiano = log drum odpovedá kicku, jungle = dlhý sub pod rýchlym breakom, metal = gallop,",
  "dembow = chop basa pod rim chopom, slaphouse = plucky slaps). Verdikty pošli v Správe —",
  "každý ovplyvní ďalšie ladenie dialektov.",
);
writeFileSync(path.join(outRoot, "LISTENING.md"), lines.join("\n"));

await browser.close();
await server.close();
console.log(`[lanes] ${totalFiles} render(s) → ${outRoot} (+ LISTENING.md)`);
if (failures > 0) {
  console.log(`[lanes] ${failures} failure(s)`);
  process.exitCode = 1;
}
