/**
 * GROOVE LISTENING PACK — renders every NEW groove from the genre-depth
 * sprint (waves 1-3) through the REAL engine, so the human can JUDGE BY EAR
 * whether each pattern matches its reference identity (Macky Gee rollers,
 * Suicideboys horrorcore, Klangkuenstler hard techno, Don Toliver lux…).
 *
 * Each groove: the FIRST pattern of the set, rendered at the groove's own
 * tempo midpoint (doc.bpm set per groove). Output is a flat folder of WAVs +
 * LISTENING.md with one row per groove.
 *
 * Run: npm run listening:grooves
 * Output: groove-listening/<id>.wav + LISTENING.md
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5255;
const outRoot = path.join(ROOT, "groove-listening");

const GROOVE_IDS = [
  // wave 1 — dnb + phonk
  "dnb.roller",
  "dnb.amen",
  "phonk.horror",
  // wave 2 — techno + trap
  "techno.hard",
  "techno.melodic",
  "trap.lux",
  "trap.hyper",
  // wave 3 — drill
  "drill.sample",
  "drill.hyper",
  "drill.melodic",
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
const lines = ["# Groove depth sprint — počúvaci pack", ""];
let totalFiles = 0;
let failures = 0;

for (const grooveId of GROOVE_IDS) {
  console.log(`[grooves] rendering ${grooveId} …`);
  const rendered = await page.evaluate(
    async (grooveId) => {
      const schema = await import("/src/project-model/schema.ts");
      const wav = await import("/src/rendering/wav.ts");
      const renderer = await import("/src/rendering/renderer.ts");
      const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
      const { getGrooveById, GROOVE_LIBRARY } = await import("/src/ai/grooves/index.ts");
      const { generatePattern } = await import("/src/ai/generator.ts");
      const { normalizeIntent } = await import("/src/intent/normalize.ts");
      const { planGeneration } = await import("/src/intent/plan.ts");

      const groove = getGrooveById(grooveId);
      if (!groove) return { error: `groove ${grooveId} not found` };

      const bank = await generateFactoryBank();
      // doc.bpm = the groove's tempo midpoint so generatePattern stays in feel
      const midBpm = Math.round((groove.bpm[0] + groove.bpm[1]) / 2);
      const doc = { ...schema.createDefaultProject(), bpm: midBpm };
      const out = [];
      // render up to 2 patterns per groove for variety
      for (const [patternIndex, pattern] of groove.patterns.slice(0, 2).entries()) {
        const patternDoc = {
          ...doc,
          patterns: [
            ...doc.patterns,
            {
              id: `groove-render-${grooveId}-${patternIndex}`,
              name: `${groove.name} ${patternIndex + 1}`,
              trackId: doc.tracks.find((t) => t.kind === "drum")?.id ?? doc.tracks[0]?.id ?? "",
              stepCount: 16,
              rows: pattern,
              swing: groove.swing,
            },
          ],
          activePatternId: `groove-render-${grooveId}-${patternIndex}`,
        };
        const intent = normalizeIntent({
          genre: groove.genre,
          seed: `groove-${grooveId}-${patternIndex}`,
          roles: ["drums"],
          bpmRange: [midBpm, midBpm],
        });
        const plan = planGeneration(intent, patternDoc);
        const generated = generatePattern(patternDoc, plan.options);
        const renderDoc = {
          ...patternDoc,
          patterns: [
            ...patternDoc.patterns.slice(0, doc.patterns.length),
            generated,
          ],
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
    grooveId,
  );

  if (rendered.error) {
    console.log(`[grooves] ERROR: ${rendered.error}`);
    failures += 1;
    continue;
  }
  lines.push(`## ${grooveId} (@ ${rendered.midBpm} BPM)`, "");
  for (const entry of rendered.out) {
    const name = `${grooveId.replace(".", "-")}-${entry.patternIndex + 1}.wav`;
    writeFileSync(path.join(outRoot, name), Buffer.from(entry.b64, "base64"));
    totalFiles += 1;
    lines.push(`- ${name}`);
  }
  lines.push("");
}

lines.push(
  "---",
  "",
  "Pri každom groove posúď: **sedí referenčnej identite?** (roller = Macky Gee,",
  "amen = chopped break, horror = Suicideboys halftime, hard = Klangkuenstler,",
  "melodic = Ben Bohmer, lux = Don Toliver, hyper = NY drill, sample = Bronx).",
  "Verdikty pošli v Správe — každý ovplyvní ďalšiu ladenie groove knižnice.",
);
writeFileSync(path.join(outRoot, "LISTENING.md"), lines.join("\n"));

await browser.close();
await server.close();
console.log(`[grooves] ${totalFiles} render(s) → ${outRoot} (+ LISTENING.md)`);
if (failures > 0) {
  console.log(`[grooves] ${failures} failure(s)`);
  process.exitCode = 1;
}
