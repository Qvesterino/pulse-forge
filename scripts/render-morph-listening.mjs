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
 * Run:    npm run listening:morph      (vite-node, headless Chromium)
 * Output: listening/morph/*.wav + index.html + LISTENING.md  (gitignored —
 * WAVs must not enter the repo or the PWA precache).
 * Serve:  npm run listening:serve      → http://127.0.0.1:5179
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5237;
const OUT = path.join(ROOT, "listening", "morph");

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
  const { FACTORY_PRESETS, GOLDEN_PRESET_IDS } = await import(
    "/src/effects/morph-dynamics-core/presets/factoryPresets.ts"
  );
  const { defaultParamsOf } = await import("/src/effects/registry.ts");

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

  const out = { bypass: null, presets: [] };

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
