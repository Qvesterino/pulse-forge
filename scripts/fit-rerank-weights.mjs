/**
 * FIT RERANK WEIGHTS — learn the audio weight from ★ generations.
 *
 * For every ★-kept roll in a favorites pack: REGENERATE the candidate bank
 * (same intent + seed — the engine is deterministic), rank it (first pass),
 * render the top finalists and score their audio fit against the genre
 * targets. The kept candidate is identified by matching the stored drum rows
 * (role-ordered flatten, so pad-id drift across projects is fine). Then the
 * PURE grid search (fitRerankWeight) finds the audio weight that would have
 * picked the kept candidate most often — and the result installs as one
 * localStorage line (printed below).
 *
 * Run: npm run rerank:fit -- <favorites-pack.json>
 *      (same pack the dice tray ⬇ ★ downloads / favorites:retrain consumes)
 * Output: scripts/data/rerank-weights.json + the install command.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5254;
const packPath = process.argv[2] ?? path.join(ROOT, "scripts", "data", "favorites-pack.json");
const MAX_ENTRIES = 30;

const pack = JSON.parse(readFileSync(path.resolve(packPath), "utf8"));
if (pack.version !== 1 || !Array.isArray(pack.entries)) throw new Error("unexpected favorites pack shape");
const entries = pack.entries.filter((entry) => entry.rows && Object.keys(entry.rows).length > 0).slice(0, MAX_ENTRIES);
console.log(`[rerank:fit] ${entries.length} favorite roll(s) from ${path.basename(packPath)}`);
if (entries.length === 0) {
  console.log("[rerank:fit] nothing to fit — ★ some rolls first");
  process.exit(0);
}

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

const outcome = await page.evaluate(async (favorites) => {
  const schema = await import("/src/project-model/schema.ts");
  const { normalizeIntent } = await import("/src/intent/normalize.ts");
  const { planGeneration } = await import("/src/intent/plan.ts");
  const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
  const { symbolicPriorProvider } = await import("/src/intent/providers/symbolic.ts");
  const { rankCandidateBank } = await import("/src/intent/candidate-bank.ts");
  const { inferPadRole } = await import("/src/ai/pad-roles.ts");
  const { extractAudioFeatures } = await import("/src/ai/audio-features.ts");
  const { scoreAudioFit, audioTargetFor } = await import("/src/intent/audio-feedback.ts");
  const { fitRerankWeight } = await import("/src/intent/rerank-weights.ts");

  const bank = await generateFactoryBank();
  const doc = schema.createDefaultProject();
  const drumTrack = doc.tracks.find((track) => track.kind === "drum");
  const drumPads = drumTrack?.pads ?? [];
  const padRoleById = new Map(drumPads.map((pad, index) => [pad.id, inferPadRole(pad.name, index)]));

  const ALL_ROLES = ["kick", "snare", "clap", "closedHat", "openHat", "perc", "tom", "fx"];
  /** Role-ordered velocity flatten — pad-id drift across projects is fine. */
  const flattenByRoles = (rowsRecord, idToRole) => {
    const out = [];
    for (const role of ALL_ROLES) {
      for (const [padId, row] of Object.entries(rowsRecord)) {
        if (idToRole.get(padId) === role) out.push(...row);
      }
    }
    return out;
  };

  const renderPattern = async (pattern) => {
    const renderer = await import("/src/rendering/renderer.ts");
    const patternDoc = { ...doc, patterns: [pattern], activePatternId: pattern.id };
    const buffer = await renderer.renderProject(patternDoc, bank, {
      mode: "pattern",
      sampleRate: 44100,
      tailSeconds: 0.5,
    });
    const channels = buffer.numberOfChannels;
    const out = new Float32Array(buffer.length);
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < out.length; index++) out[index] += data[index] / channels;
    }
    return out;
  };

  const samples = [];
  let generations = 0;
  let matched = 0;

  for (const [entryIndex, favorite] of favorites.entries()) {
    const idToRole = new Map();
    (favorite.padIds ?? []).forEach((padId, index) => {
      idToRole.set(padId, inferPadRole((favorite.padNames ?? [])[index], index));
    });
    const keptFlat = flattenByRoles(favorite.rows, idToRole);

    const intent = normalizeIntent({
      genre: favorite.genre,
      ...(favorite.style ? { style: favorite.style } : {}),
      energy: favorite.energy,
      density: favorite.density,
      complexity: favorite.complexity,
      variation: favorite.variation,
      ...(favorite.key ? { key: favorite.key } : {}),
      seed: favorite.seed,
      candidateCount: 3,
      symbolicCandidates: 2,
      roles: ["drums", "bass", "chords", "lead"],
    });
    const plan = planGeneration(intent, doc);
    let candidates;
    try {
      candidates = (await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 0)).entries;
    } catch {
      continue;
    }
    if (candidates.length < 2) continue;
    const ranked = rankCandidateBank(doc, candidates);
    const finalists = ranked.slice(0, 4);

    // match the ★-kept candidate by role-ordered drum-grid distance
    const distances = finalists.map((candidate) => {
      const candidateFlat = flattenByRoles(candidate.pattern.rows ?? {}, padRoleById);
      const length = Math.min(keptFlat.length, candidateFlat.length);
      let sum = 0;
      for (let index = 0; index < length; index++) sum += (keptFlat[index] - candidateFlat[index]) ** 2;
      return { candidateIndex: candidate.candidateIndex, distance: Math.sqrt(sum) };
    });
    distances.sort((a, b) => a.distance - b.distance);
    const keptIndex = distances[0].candidateIndex;
    matched += 1;
    generations += 1;

    const maxScore = Math.max(...finalists.map((candidate) => candidate.score), 1e-9);
    for (const candidate of finalists) {
      let audio = 0.5;
      try {
        const pcm = await renderPattern(candidate.pattern);
        const features = extractAudioFeatures(pcm, 44100);
        audio = scoreAudioFit(features, audioTargetFor(favorite.genre));
      } catch {
        audio = 0.5; // failed render = neutral, candidate keeps its rank
      }
      samples.push({
        generationId: `gen-${entryIndex}`,
        firstPass: Math.max(0, Math.min(1, candidate.score / maxScore)),
        audio,
        kept: candidate.candidateIndex === keptIndex,
      });
    }
  }

  const fitted = fitRerankWeight(samples);
  return { fitted, generations, matched, sampleCount: samples.length };
}, entries);

await browser.close();
await server.close();

if (!outcome || !outcome.fitted) {
  console.log(
    `[rerank:fit] not enough usable generations (matched ${outcome?.matched ?? 0}/${entries.length}) — KEEP default 0.3`,
  );
  process.exit(1);
}

const learned = {
  weight: outcome.fitted.weight,
  source: "learned-v1 (fit-rerank-weights)",
  fittedAt: new Date().toISOString(),
  accuracy: outcome.fitted.accuracy,
  baselineAccuracy: outcome.fitted.baselineAccuracy,
  generations: outcome.fitted.generations,
  samples: outcome.sampleCount,
};
const outDir = path.join(ROOT, "scripts", "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "rerank-weights.json"), JSON.stringify(learned, null, 2) + "\n");

console.log(
  `[rerank:fit] generations=${learned.generations} matchedKept=${outcome.matched} samples=${outcome.sampleCount}`,
);
console.log(
  `[rerank:fit] top-1 accuracy: baseline ${learned.baselineAccuracy} → fitted ${learned.accuracy} at weight ${learned.weight}`,
);
console.log("[rerank:fit] install in the app console:");
console.log(`  localStorage.setItem("pf:rerank-weights", ${JSON.stringify(JSON.stringify(learned))})`);
console.log("[rerank:fit] report → scripts/data/rerank-weights.json");
