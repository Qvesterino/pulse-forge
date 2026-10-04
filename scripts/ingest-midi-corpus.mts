/**
 * W2 — PUBLIC-DOMAIN MIDI CORPUS INGEST CLI
 * (docs/intent-killer-feature-plan.md W2, audit docs/W2-MIDI-CORPUS-AUDIT-2026-10-04.md).
 *
 * Walks the fetched Mutopia-derived Public Domain MIDI pack and writes
 * `scripts/data/midi-melodic-dataset.json` — next-note training samples for
 * the symbolic melodic prior, built by the pure core in
 * `src/ai/midi-corpus-ingest.ts` (which mirrors the engine's own feature,
 * quantization and degree-inversion contracts — the same reason the core
 * lives in `src/`: it is covered by vitest AND tsc).
 *
 * Licensing (hard rule from the plan §4 W2): only pieces whose catalog entry
 * says `license === "Public Domain"` are ingested. The per-piece manifest
 * (with license, sourceUrl and sha1) is written next to the dataset and IS
 * committed — no data without provenance.
 *
 * CONDITIONING: rows are grouped `classical.<era>#midi:<piece>#<role>` so the
 * v2 embedding transform resolves them through their OWN semantic region
 * (never the ambient centroid) — see the audit for why the shared-prefix
 * variant was rejected.
 *
 * Train-only by design: the trainer merges this file with `--midi-corpus` and
 * never puts a corpus group in the held-out library validation.
 *
 * Run: npm run corpus:ingest
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseMidiFile } from "../src/midi/midiFile";
import {
  MELODIC_FEATURES_VERSION,
  MELODIC_FEATURE_COUNT,
  MELODIC_DURATION_VALUES,
} from "../src/ai/symbolic/melodic-features";
import {
  collectSamples,
  eraOf,
  splitRoles,
  toDegreeEvents,
  MAX_BARS_PER_PIECE,
  MAX_SAMPLES_PER_ROLE,
  type CatalogPiece,
  type CorpusSample,
} from "../src/ai/midi-corpus-ingest";

const OUT_DIR = path.join(process.cwd(), "scripts", "data");
const CORPUS_DIR = path.join(OUT_DIR, "midi-corpus");

function main(): void {
  const manifestPath = path.join(CORPUS_DIR, "manifest.json");
  const midiDir = path.join(CORPUS_DIR, "midi");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `corpus manifest not found at ${manifestPath} — run \`npm run corpus:fetch\` first ` +
        `(docs/intent-killer-feature-plan.md W2)`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pieces: CatalogPiece[] };
  const pdPieces = manifest.pieces.filter((p) => p.license === "Public Domain");
  if (pdPieces.length === 0) throw new Error("no Public Domain pieces in the corpus manifest");

  const samples: CorpusSample[] = [];
  const piecesIngested: string[] = [];
  const piecesSkipped: { id: string; reason: string }[] = [];
  const samplesByRole: Record<string, number> = {};
  const maxSteps = MAX_BARS_PER_PIECE * 16;

  for (const piece of pdPieces) {
    const filePath = path.join(midiDir, path.basename(piece.file));
    if (!existsSync(filePath)) {
      piecesSkipped.push({ id: piece.id, reason: "file missing" });
      continue;
    }
    try {
      const parsed = parseMidiFile(new Uint8Array(readFileSync(filePath)));
      if (!parsed.bpm || parsed.bpm < 30 || parsed.bpm > 240) {
        piecesSkipped.push({ id: piece.id, reason: `implausible bpm ${parsed.bpm}` });
        continue;
      }
      const split = splitRoles(parsed);
      if (!split.key) {
        piecesSkipped.push({ id: piece.id, reason: "key detection below confidence bar" });
        continue;
      }
      let pieceSamples = 0;
      for (const role of ["bass", "chord", "lead"] as const) {
        const events = toDegreeEvents(split[role], role, split.key, maxSteps);
        if (events.length < 8) continue; // too short to teach transitions
        // One leak-guard group per piece+role: the trainer keeps corpus rows
        // train-only anyway, and per-piece grouping guarantees a piece's bars
        // are never split across train/val if the corpus is ever promoted.
        const roleSamples = collectSamples(
          events,
          `classical.${eraOf(piece)}#midi:${piece.id}`,
          "ambient",
          role,
          MAX_SAMPLES_PER_ROLE,
        );
        for (const sample of roleSamples) {
          samples.push(sample);
          pieceSamples++;
        }
        samplesByRole[role] = (samplesByRole[role] ?? 0) + roleSamples.length;
      }
      if (pieceSamples > 0) piecesIngested.push(piece.id);
      else piecesSkipped.push({ id: piece.id, reason: "no role cleared the content bars" });
    } catch (error) {
      piecesSkipped.push({
        id: piece.id,
        reason: `parse error: ${error instanceof Error ? error.message : "unknown"}`,
      });
    }
  }

  // Sanity: fixed feature width, finite values, class ranges (base generator contract).
  for (const sample of samples) {
    if (sample.x.length !== MELODIC_FEATURE_COUNT) throw new Error("feature width drift");
    if (sample.degree < 0 || sample.degree > 7) throw new Error("degree class out of range");
    if (sample.duration < 0 || sample.duration >= MELODIC_DURATION_VALUES.length)
      throw new Error("duration out of range");
    for (const value of sample.x) if (!Number.isFinite(value)) throw new Error("non-finite feature");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "midi-melodic-dataset.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        datasetVersion: "midi-melodic-v1",
        featureVersion: MELODIC_FEATURES_VERSION,
        featureCount: MELODIC_FEATURE_COUNT,
        durationValues: MELODIC_DURATION_VALUES,
        samples: samples.length,
        groups: new Set(samples.map((s) => s.group)).size,
        source: "Mutopia Project (Public Domain) via Defiance99/midi-catalog",
        licenseManifest: "scripts/data/midi-corpus/manifest.json",
        data: samples,
      },
      null,
      0,
    ),
  );

  const skipReasons = piecesSkipped.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[midi-corpus] ingested ${piecesIngested.length}/${pdPieces.length} pieces → ${samples.length} samples`);
  console.log(`[midi-corpus] by role: ${JSON.stringify(samplesByRole)}`);
  console.log(`[midi-corpus] skipped: ${JSON.stringify(skipReasons)}`);
  console.log(`[midi-corpus] dataset → ${outPath}`);
}

// The `--ingest` guard keeps a vitest import of the core side-effect free.
if (process.argv.includes("--ingest")) main();
