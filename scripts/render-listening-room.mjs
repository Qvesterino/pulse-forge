/**
 * MORPH DYNAMICS listening harness (user request 2026-09-21): render every
 * GOLDEN preset through the REAL engine onto the house demo beat so the
 * human ear can judge them fast — the presets were designed from constants,
 * not from listening, and this pack is the ear-tuning aid.
 *
 * For each GOLDEN preset it renders TWO staged versions (preset on the DRUM
 * track and preset on the 808 track) plus ONE bypass reference — 17 WAVs.
 * The generated index.html is an A/B player: Space swaps A/B, arrows walk
 * presets, and each row compares bypass vs preset on the chosen path.
 *
 * EXTENDED — LISTENING ROOM (user request 2026-09-21): besides the morph
 * suite it renders a SCENES suite (4 genre presets on their OWN genre
 * beats, each with a bypass) and an INTENT suite (3 ranker groups with
 * DATASET-COMPATIBLE groupKeys × 4 candidates each) whose ranking and
 * favourite verdicts — collected by room.html via POST /api/verdict —
 * ingest straight into the intent-engine training data
 * (`npm run listening:ingest`).
 *
 * Run:    npm run listening:room      (vite-node, headless Chromium)
 * Output: listening/room/ (wav + room.html + room.json)  (gitignored —
 * WAVs must not enter the repo or the PWA precache).
 * Serve:  npm run listening:serve      → http://127.0.0.1:5179/room/
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5237;
const OUT = path.join(ROOT, "listening", "room");

mkdirSync(OUT, { recursive: true });

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

// INTENT suite groups come straight from the ranker dataset — same
// groupKey/genre/style/seeds means ranking verdicts ingest 1:1 into
// intent-ranker-golden.json and actually train the ranker.
const datasetPath = path.join(ROOT, "scripts", "data", "intent-ranker-dataset.json");
const GROUPS_DATA = (() => {
  try {
    const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
    const picked = [];
    const wanted = ["house", "techno", "trap"];
    for (const genre of wanted) {
      const group = (dataset.groups ?? []).find(
        (g) => g.groupKey.startsWith(genre + ":") && (g.candidates?.length ?? 0) >= 4,
      );
      if (!group) continue;
      picked.push({
        groupKey: group.groupKey,
        genre: group.genre,
        style: group.groupKey.split(":")[1],
        seeds: group.candidates.slice(0, 4).map((c) => c.seed),
      });
    }
    return picked;
  } catch {
    return [];
  }
})();
if (GROUPS_DATA.length === 0) {
  throw new Error("ranker dataset missing or has no usable groups — run the dataset script first");
}

// The evaluate body is a STRING on purpose: vite-node would otherwise
// rewrite the dynamic import() inside the callback into
// __vite_ssr_dynamic_import__, which does not exist in the page.
const packs = await page.evaluate(
  `
  (async () => {
  const wav = await import("/src/rendering/wav.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
  const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
  const { FACTORY_PRESETS, GOLDEN_PRESET_IDS, SCENE_PRESET_IDS } = await import(
    "/src/effects/morph-dynamics-core/presets/factoryPresets.ts"
  );
  const { defaultParamsOf } = await import("/src/effects/registry.ts");
  const { normalizeIntent } = await import("/src/intent/normalize.ts");
  const { planGeneration } = await import("/src/intent/plan.ts");
  const { generatePattern } = await import("/src/ai/generator.ts");
  const { getStyleNamesForGenre } = await import("/src/ai/grooves/index.ts");
  // roleForTrack + MELODIC_NOTES_CAP are mirrored LOCALLY (do NOT import
  // intent/favorites.ts here — its import chain currently crosses a broken
  // intermediate state in instruments/definitions.ts).
  const MELODIC_NOTES_CAP = 128;
  const roleForTrack = (trackName, index) => {
    const name = trackName.toLowerCase();
    if (name.includes("bass")) return "bass";
    if (name.includes("chord")) return "chord";
    if (name.includes("lead")) return "lead";
    return index === 0 ? "bass" : index === 1 ? "chord" : index === 2 ? "lead" : null;
  };

  const bank = await generateFactoryBank();
  const baseDoc = createProjectFromTemplate("house");
  const rateId = "morphdynamics";

  const encode = (buffer) => {
    const bytes = new Uint8Array(wav.encodeWav(buffer, 16));
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(binary);
  };

  const renderDoc = async (doc) => {
    const buffer = await renderer.renderProject(doc, bank, {
      mode: "pattern",
      sampleRate: 44100,
      tailSeconds: 0.8,
    });
    return encode(buffer);
  };

  const trackIdFor = (doc, kind) => {
    // path: "drums" → the drum track; "808" → the first instrument track.
    if (kind === "drums") return doc.tracks.find((t) => t.kind === "drum").id;
    return doc.tracks.find((t) => t.kind === "instrument").id;
  };

  const withMorph = (preset, pathKind) => {
    const doc = createProjectFromTemplate("house");
    const trackId = trackIdFor(doc, pathKind);
    const fx = {
      id: "fx-morph-listen-" + pathKind,
      type: rateId,
      bypassed: false,
      params: { ...defaultParamsOf(rateId), ...preset.params },
    };
    doc.tracks = doc.tracks.map((t) =>
      t.id === trackId ? { ...t, effects: [...(t.effects ?? []), fx] } : t,
    );
    return { doc, trackId };
  };

  const withMorphOnGenre = (templateId, presetParams) => {
    const doc = createProjectFromTemplate(templateId);
    const drums = doc.tracks.find((t) => t.kind === "drum");
    const fx = {
      id: "fx-morph-room",
      type: rateId,
      bypassed: false,
      params: { ...defaultParamsOf(rateId), ...presetParams },
    };
    doc.tracks = doc.tracks.map((t) =>
      t.id === drums.id ? { ...t, effects: [...(t.effects ?? []), fx] } : t,
    );
    return doc;
  };

  const out = { bypass: null, presets: [], scenes: [], intent: [] };

  // ONE bypass reference — the unprocessed demo beat both paths compare to.
  out.bypass = await renderDoc(baseDoc);

  for (const id of GOLDEN_PRESET_IDS.filter(Boolean)) {
    const preset = FACTORY_PRESETS.find((p) => p.id === id);
    if (!preset) continue;
    const entry = {
      id: preset.id,
      label: preset.label ?? preset.name,
      category: preset.category,
      description: preset.description ?? "",
      paths: {},
    };
    for (const pathKind of ["drums", "808"]) {
      const { doc } = withMorph(preset, pathKind);
      entry.paths[pathKind] = await renderDoc(doc);
    }
    out.presets.push(entry);
  }

  // ── SCENES suite — genre presets on their OWN genre beats + bypasses ───
  // Iterates SCENE_PRESET_IDS so NEW scene presets join automatically —
  // register the preset→template pairing here (a missing pairing skips
  // silently; add it when a matching TemplateId exists).
  const SCENE_TEMPLATE_BY_ID = {
    "morph-drill-bus-pressure": "drill",
    "morph-phonk-808-weight": "phonk",
    "morph-jersey-vocal-bark": "jersey",
    // No DnB template exists — the closest energetic pairing is drill.
    "morph-dnb-punch-glue": "drill",
  };
  for (const presetId of SCENE_PRESET_IDS) {
    const templateId = SCENE_TEMPLATE_BY_ID[presetId];
    if (!templateId) continue;
    const preset = FACTORY_PRESETS.find((p) => p.id === presetId);
    if (!preset) continue;
    const bypass = await renderDoc(createProjectFromTemplate(templateId));
    const wet = withMorphOnGenre(templateId, preset.params);
    const wetAudio = await renderDoc(wet);
    out.scenes.push({
      id: preset.id,
      label: preset.label ?? preset.name,
      templateId,
      description: preset.description ?? "",
      bypass,
      wet: wetAudio,
    });
  }

  // ── INTENT suite — groups injected from the RANKER DATASET (1:1 keys) ──
  const GROUPS_DATA = ${JSON.stringify(GROUPS_DATA)};
  for (const group of GROUPS_DATA) {
    const groupKey = group.groupKey;
    const groupGenre = group.genre;
    const style = group.style;
    const candidates = [];
    for (let seedIndex = 0; seedIndex < group.seeds.length; seedIndex++) {
      const seed = group.seeds[seedIndex];
      const intent = normalizeIntent({
        genre: groupGenre,
        style: style.toLowerCase().replace(/\s+/g, ""),
        energy: 0.3 + ((seedIndex * 13) % 7) / 10,
        density: 0.3 + ((seedIndex * 7) % 7) / 10,
        complexity: 0.2 + ((seedIndex * 11) % 8) / 10,
        variation: 0.2 + ((seedIndex * 17) % 8) / 10,
        seed,
        roles: ["drums", "bass"],
        candidateCount: 4,
      });
      const plan = planGeneration(intent, baseDoc);
      const pattern = generatePattern(baseDoc, plan.options);
      const audio = await renderDoc({
        ...baseDoc,
        patterns: [pattern],
        activePatternId: pattern.id,
      });
      // FavoriteLedgerEntry shape (mirrors DiceContext) — ★ verdicts here
      // can retrain ALL THREE learned models via favorites:retrain.
      const drumTrack = baseDoc.tracks.find((t) => t.kind === "drum");
      const melodic = [];
      let noteCount = 0;
      const instrumentTracks = baseDoc.tracks.filter((t) => t.kind === "instrument");
      for (const [trackIndex, track] of instrumentTracks.entries()) {
        const notes = (pattern.notes ?? {})[track.id] ?? [];
        if (notes.length === 0 || noteCount >= MELODIC_NOTES_CAP) continue;
        const role = roleForTrack(track.name, trackIndex);
        if (!role) continue;
        melodic.push({
          role,
          trackName: track.name,
          notes: notes.slice(0, MELODIC_NOTES_CAP - noteCount).map((n) => ({
            pitch: n.pitch,
            start: n.start,
            duration: n.duration,
            velocity: n.velocity,
          })),
        });
        noteCount += melodic[melodic.length - 1].notes.length;
      }
      candidates.push({
        seed,
        index: seedIndex,
        audio,
        favorite: {
          savedAt: Date.now(),
          seed,
          genre: groupGenre,
          // grooveId lives on the pattern generation metadata (mirrors DiceContext)
          grooveId: String(pattern.generation?.grooveId ?? plan.options.grooveId ?? ""),
          energy: intent.energy,
          density: intent.density,
          complexity: intent.complexity,
          variation: intent.variation,
          padIds: drumTrack.pads.map((p) => p.id),
          padNames: drumTrack.pads.map((p) => p.name),
          rows: JSON.parse(JSON.stringify(pattern.rows)),
          length: pattern.stepCount,
          style: plan.options.style ?? null,
          ghostWeight: plan.options.ghostWeight,
          microWeight: plan.options.microWeight,
          velocityVariation: plan.options.velocityVariation,
          temperature: plan.options.temperature,
          key: baseDoc.key ?? intent.key ?? null,
          melodic,
        },
      });
    }
    out.intent.push({ groupKey, genre: groupGenre, style, candidates });
  }

  return out;
  })()
  `,
  { timeout: 300000 },
);

await browser.close();
await server.close();

// ── write files ────────────────────────────────────────────────────────────
writeFileSync(path.join(OUT, "bypass.wav"), Buffer.from(packs.bypass, "base64"));
for (const preset of packs.presets) {
  for (const [pathKind, b64] of Object.entries(preset.paths)) {
    writeFileSync(path.join(OUT, `${preset.id}--${pathKind}.wav`), Buffer.from(b64, "base64"));
  }
}

// ── room manifest + suite files (the room page consumes these) ────────────
const roomDir = path.join(ROOT, "listening", "room");
mkdirSync(path.join(roomDir, "morph"), { recursive: true });
mkdirSync(path.join(roomDir, "scenes"), { recursive: true });
mkdirSync(path.join(roomDir, "intent"), { recursive: true });
const room = { generatedAt: new Date().toISOString(), morph: [], scenes: [], intent: [] };

for (const entry of packs.presets) {
  const files = {};
  for (const [pathKind, b64] of Object.entries(entry.paths)) {
    const rel = `morph/${entry.id}--${pathKind}.wav`;
    writeFileSync(path.join(roomDir, rel), Buffer.from(b64, "base64"));
    files[pathKind] = rel;
  }
  room.morph.push({ id: entry.id, label: entry.label, category: entry.category, description: entry.description, files });
}
for (const scene of packs.scenes) {
  const relB = `scenes/${scene.id}--bypass.wav`;
  const relW = `scenes/${scene.id}--wet.wav`;
  writeFileSync(path.join(roomDir, relB), Buffer.from(scene.bypass, "base64"));
  writeFileSync(path.join(roomDir, relW), Buffer.from(scene.wet, "base64"));
  room.scenes.push({
    id: scene.id,
    label: scene.label,
    templateId: scene.templateId,
    description: scene.description,
    files: { bypass: relB, wet: relW },
  });
}
for (const group of packs.intent) {
  const groupDir = group.groupKey.replaceAll(":", "__");
  room.intent.push({
    groupKey: group.groupKey,
    genre: group.genre,
    style: group.style,
    candidates: group.candidates.map((c) => {
      const rel = `intent/${groupDir}--c${c.index}.wav`;
      writeFileSync(path.join(roomDir, rel), Buffer.from(c.audio, "base64"));
      return { seed: c.seed, index: c.index, file: rel, favorite: c.favorite };
    }),
  });
}
writeFileSync(path.join(roomDir, "room.json"), JSON.stringify(room, null, 2));
// Room page: static template copied verbatim — it fetches room.json.
writeFileSync(path.join(roomDir, "room.html"), readFileSync(path.join(ROOT, "scripts", "listening-room-template.html")));

const rows = packs.presets
  .map(
    (preset, index) => `
  <tr data-index="${index}">
    <td class="star">★</td>
    <td><b>${preset.label}</b><span class="cat">${preset.category}</span></td>
    <td class="path-toggle">
      <button class="path" data-path="drums">DRUMS</button>
      <button class="path active" data-path="808">808</button>
    </td>
    <td class="ab">
      <button class="ab-btn a" title="bypass">A</button>
      <button class="ab-btn b active" title="${preset.label}">B</button>
    </td>
    <td class="status">—</td>
  </tr>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8" />
<title>MORPH DYNAMICS — listening pack (GOLDEN)</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, monospace; background: #121212; color: #ddd; margin: 24px auto; max-width: 980px; padding: 0 16px; }
  h1 { font-size: 16px; letter-spacing: 1px; }
  p.hint { color: #888; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  tr { border-bottom: 1px solid #262626; }
  tr.playing { background: #1c1c1c; }
  td { padding: 8px 10px; }
  .cat { color: #777; margin-left: 8px; font-size: 11px; }
  .star { color: #f59e0b; width: 24px; }
  button { font: inherit; background: #222; color: #ccc; border: 1px solid #333; border-radius: 4px; padding: 3px 9px; cursor: pointer; }
  button:hover { border-color: #666; }
  .ab-btn.active { border-color: #f59e0b; color: #f59e0b; }
  .path.active { border-color: #7aa2f7; color: #7aa2f7; }
  .status { color: #888; font-size: 11px; }
  audio { display: block; margin: 10px 0 20px; width: 100%; }
  #current { position: sticky; top: 0; background: #121212; padding: 10px 0; border-bottom: 1px solid #333; }
</style>
</head>
<body>
<h1>MORPH DYNAMICS — listening pack ★ GOLDEN</h1>
<p class="hint">
  A = bypass (surový house beat) · B = preset · Space = prepnúť A/B · ↑/↓ = ďalší preset ·
  každý preset je nahratý na DRUMS aj 808 tracku (prepínač v riadku).
  Zvuk: ${packs.presets.length} presetov × 2 cesty + bypass. Presety vznikli z konštánt — tu ich počuješ a doladíš.
</p>
<div id="current">—</div>
<audio id="player" controls preload="auto"></audio>
<table>
<thead><tr><th></th><th>Preset</th><th>Cesta</th><th>A/B</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<script>
  const rows = [...document.querySelectorAll("tbody tr")];
  const player = document.getElementById("player");
  const current = document.getElementById("current");
  let index = 0, ab = "B", pathKind = "808";
  const fileFor = (i) => {
    const preset = packs[i];
    const src = ab === "A" ? "bypass.wav" : preset.id + "--" + pathKind + ".wav";
    return src;
  };
  const play = () => {
    const preset = packs[index];
    player.src = fileFor(index);
    player.play().catch(() => {});
    current.innerHTML = (ab === "A" ? "A · BYPASS — " : "B · ★ " + preset.label + " (na " + pathKind.toUpperCase() + ") — ") + (preset.description || "");
    rows.forEach((row, i) => row.classList.toggle("playing", i === index));
    const row = rows[index];
    row.querySelectorAll(".ab-btn").forEach((b) => b.classList.toggle("active", b.classList.contains(ab.toLowerCase())));
    row.querySelectorAll(".path").forEach((b) => b.classList.toggle("active", b.dataset.path === pathKind));
    row.querySelector(".status").textContent = "▶ " + (ab === "A" ? "bypass" : "preset");
  };
  const packs = ${JSON.stringify(packs.presets.map((p) => ({ id: p.id, label: p.label })))};
  rows.forEach((row, i) => {
    row.querySelector(".ab-btn.a").onclick = () => { index = i; ab = "A"; play(); };
    row.querySelector(".ab-btn.b").onclick = () => { index = i; ab = "B"; play(); };
    row.querySelectorAll(".path").forEach((b) => b.onclick = () => { pathKind = b.dataset.path; index = i; play(); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); ab = ab === "A" ? "B" : "A"; play(); }
    if (e.key === "ArrowDown") { e.preventDefault(); index = Math.min(rows.length - 1, index + 1); play(); }
    if (e.key === "ArrowUp") { e.preventDefault(); index = Math.max(0, index - 1); play(); }
  });
  play();
</script>
</body>
</html>`;

writeFileSync(path.join(OUT, "index.html"), html);

const md = [
  "# MORPH DYNAMICS — listening pack (GOLDEN ★)",
  "",
  `Vygenerované ${new Date().toISOString()} — ${packs.presets.length} GOLDEN presetov × 2 cesty (drums/808) + bypass.`,
  "",
  "Prehrač: `npm run listening:serve` → http://127.0.0.1:5179",
  "(alebo otvor listening/morph/index.html priamo z disku — plain <audio>, funguje aj z file://)",
  "",
  "Čo počúvať pri každom preset:",
  "- je rozdiel A/B počuteľný a HUDOBNÝ (nie len hlasnejší)?",
  "- ducking/drive reaguje na hranie, alebo stojí?",
  "- transients sú chránené? (žiadne rozdrvené údery)",
  "- pri 808 ceste: sub nechádza? (žiadne bzučanie)",
  "",
  "| Preset | Cesta | Súbor |",
  "| ------ | ----- | ----- |",
  ...packs.presets.flatMap((p) => [`| ${p.label} | drums | ${p.id}--drums.wav |`, `| ${p.label} | 808 | ${p.id}--808.wav |`]),
].join("\n");
writeFileSync(path.join(OUT, "LISTENING.md"), md);

console.log(`listening pack done: ${packs.presets.length * 2 + 1} WAVs → listening/morph/`);
console.log("open it: npm run listening:serve  →  http://127.0.0.1:5179");
