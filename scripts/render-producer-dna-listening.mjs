/**
 * Blind ear-check for the Producer DNA groove search lane.
 *
 * The pack compares SAFE and PERSONAL candidates rendered through the real
 * offline engine. Its pairwise observations are deliberately synthetic: this
 * probes whether the generator realizes a known groove preference direction,
 * not whether it has learned this user's taste. Listening votes stay in the
 * local pack and are never ingested into global training data.
 *
 * Generate: npm run listening:producer-dna -- --genre=trap --seed=my-seed
 * Score:    npm run listening:producer-dna -- --score listening/producer-dna/<pack>/verdicts.json
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5267;
const VALID_GENRES = new Set(["house", "techno", "trap", "ambient", "drill", "phonk", "jersey", "dnb"]);
const REPLICATES_PER_DIRECTION = 2;
const SYNCOPATION_FEATURE = "drums.syncopation";

function option(name, fallback = undefined) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJson(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function scorePack(verdictPath) {
  const absoluteVerdictPath = path.resolve(verdictPath);
  const packDirectory = path.dirname(absoluteVerdictPath);
  const keyPath = path.join(packDirectory, "answer-key.json");
  const answerKey = readJson(keyPath, "answer-key.json");
  const verdictPack = readJson(absoluteVerdictPath, "verdicts.json");
  if (
    answerKey?.version !== 1 ||
    verdictPack?.version !== 1 ||
    typeof answerKey.packId !== "string" ||
    verdictPack.packId !== answerKey.packId ||
    !Array.isArray(answerKey.pairs) ||
    !Array.isArray(verdictPack.verdicts)
  ) {
    throw new Error("Listening votes do not match a valid Producer DNA pack");
  }

  const byId = new Map(answerKey.pairs.map((pair) => [pair.id, pair]));
  const seen = new Set();
  let directionHits = 0;
  let directionRated = 0;
  let personalFavorites = 0;
  let safeFavorites = 0;
  let favoriteTies = 0;
  let favoriteNeithers = 0;
  for (const verdict of verdictPack.verdicts) {
    const answer = byId.get(verdict?.pairId);
    if (!answer || seen.has(verdict.pairId)) continue;
    seen.add(verdict.pairId);

    if (verdict.directionVote === "A" || verdict.directionVote === "B") {
      directionRated++;
      if (verdict.directionVote === answer.personalSide) directionHits++;
    }
    if (verdict.favoriteVote === answer.personalSide) personalFavorites++;
    else if (verdict.favoriteVote === answer.safeSide) safeFavorites++;
    else if (verdict.favoriteVote === "both") favoriteTies++;
    else if (verdict.favoriteVote === "neither") favoriteNeithers++;
  }

  const expectedVotes = answerKey.pairs.length;
  console.log(`# Producer DNA blind listening — ${answerKey.packId}`);
  console.log(`Groove direction recognized: ${directionHits}/${directionRated} decisive votes`);
  console.log(
    `Personal taste: PERSONAL ${personalFavorites}, SAFE ${safeFavorites}, both ${favoriteTies}, neither ${favoriteNeithers}`,
  );
  console.log(`Completed pairs: ${seen.size}/${expectedVotes}`);
  console.log(
    "Interpretation: this is one listener's small diagnostic sample, not a model-quality gate or training import.",
  );
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function uniquePackDirectory(baseDirectory, packId) {
  let suffix = 0;
  let directory = path.join(baseDirectory, packId);
  while (existsSync(directory)) {
    suffix++;
    directory = path.join(baseDirectory, `${packId}-${suffix}`);
  }
  return directory;
}

function listeningHtml(packId, genre, publicPairs) {
  const payload = JSON.stringify({ packId, genre, pairs: publicPairs }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KYX Producer DNA — blind groove test</title>
  <style>
    :root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #111318; color: #edf0f5; }
    body { margin: 0 auto; max-width: 880px; padding: 28px 18px 56px; }
    h1 { font-size: 1.55rem; margin: 0 0 8px; }
    .muted { color: #a9b0be; }
    .notice { border: 1px solid #444b59; border-radius: 10px; padding: 12px 14px; margin: 18px 0; }
    .pair { background: #1b1f27; border: 1px solid #343a46; border-radius: 12px; margin: 18px 0; padding: 16px; }
    .pair h2 { font-size: 1.05rem; margin: 0 0 14px; }
    .takes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .take { background: #12151a; border-radius: 8px; padding: 12px; }
    audio { width: 100%; margin-top: 4px; }
    fieldset { border: 0; border-top: 1px solid #343a46; margin: 16px 0 0; padding: 12px 0 0; }
    legend { font-weight: 650; padding: 0 8px 0 0; }
    .choices { display: flex; flex-wrap: wrap; gap: 8px; }
    button { color: inherit; background: #292f3a; border: 1px solid #505969; border-radius: 7px; padding: 8px 12px; cursor: pointer; }
    button[aria-pressed="true"] { background: #245d51; border-color: #51b89b; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    #save { background: #3d5cbb; border-color: #8299ed; font-weight: 700; padding: 11px 16px; }
    @media (max-width: 600px) { .takes { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Producer DNA — zaslepený groove posluch</h1>
  <div class="muted">Žáner: ${genre} · pack ${packId}</div>
  <div class="notice">Porovnávaj A a B bez hádania, ktorý je PERSONAL. Najprv vyber, ktorý lepšie spĺňa rytmický cieľ; potom zvlášť označ, ktorý by si si nechal v beate. Hlasitosť ukážok je zrovnaná iba pre posluch.</div>
  <main id="pairs"></main>
  <p id="progress" class="muted"></p>
  <button id="save" disabled>STIAHNUŤ MOJE VERDIKTY</button>
  <p class="muted">Verdikty sa ukladajú iba do stiahnutého súboru. Nemenia Producer DNA ani globálny tréning.</p>
  <script type="module">
    const PACK = ${payload};
    const state = new Map(PACK.pairs.map((pair) => [pair.id, { directionVote: null, favoriteVote: null }]));
    const labels = {
      directionVote: [["A", "A"], ["B", "B"], ["same", "Nerozoznám rozdiel"], ["unsure", "Neviem"]],
      favoriteVote: [["A", "A"], ["B", "B"], ["both", "Obidva"], ["neither", "Ani jeden"]],
    };
    const directions = {
      more: "Ktorý groove pôsobí syncopovanejšie — viac úderov mimo hlavný dôraz?",
      less: "Ktorý groove pôsobí rovnejšie a priamočiarejšie?",
    };
    const root = document.getElementById("pairs");
    for (const pair of PACK.pairs) {
      const card = document.createElement("section");
      card.className = "pair";
      card.dataset.pairId = pair.id;
      const heading = document.createElement("h2");
      heading.textContent = pair.id + " — " + directions[pair.target];
      card.append(heading);
      const takes = document.createElement("div");
      takes.className = "takes";
      for (const [label, file] of [["A", pair.aFile], ["B", pair.bFile]]) {
        const take = document.createElement("div");
        take.className = "take";
        const takeLabel = document.createElement("strong");
        takeLabel.textContent = "Take " + label;
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = "./" + file;
        take.append(takeLabel, audio);
        takes.append(take);
      }
      card.append(takes);
      for (const field of ["directionVote", "favoriteVote"]) {
        const group = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = field === "directionVote" ? "Ktorý viac spĺňa cieľ?" : "Ktorý by si si nechal?";
        group.append(legend);
        const choices = document.createElement("div");
        choices.className = "choices";
        for (const [value, label] of labels[field]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.dataset.field = field;
          button.dataset.value = value;
          button.setAttribute("aria-pressed", "false");
          choices.append(button);
        }
        group.append(choices);
        card.append(group);
      }
      root.append(card);
    }
    function updateProgress() {
      const completed = [...state.values()].filter((vote) => vote.directionVote && vote.favoriteVote).length;
      document.getElementById("progress").textContent = completed + "/" + state.size + " dvojíc ohodnotených";
      document.getElementById("save").disabled = completed !== state.size;
    }
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-field]");
      if (!button) return;
      const card = button.closest("[data-pair-id]");
      const pairId = card?.dataset.pairId;
      if (!pairId) return;
      const vote = state.get(pairId);
      vote[button.dataset.field] = button.dataset.value;
      for (const sibling of button.parentElement.querySelectorAll("button")) {
        sibling.setAttribute("aria-pressed", String(sibling === button));
      }
      updateProgress();
    });
    document.getElementById("save").addEventListener("click", () => {
      const verdicts = PACK.pairs.map((pair) => ({ pairId: pair.id, ...state.get(pair.id) }));
      const content = JSON.stringify({ version: 1, packId: PACK.packId, blind: true, savedAt: Date.now(), verdicts }, null, 2);
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "verdicts.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
    updateProgress();
  </script>
</body>
</html>`;
}

const scorePath = option("--score");
if (scorePath) {
  scorePack(scorePath);
} else if (process.argv.includes("--help")) {
  console.log("Generate a blind SAFE vs PERSONAL groove pack, or score a downloaded verdicts.json.");
  console.log("npm run listening:producer-dna -- --genre=trap --seed=my-seed");
  console.log("npm run listening:producer-dna -- --score listening/producer-dna/<pack>/verdicts.json");
} else {
  const genre = option("--genre", "trap").trim().toLowerCase();
  const seed = option("--seed", "producer-dna-groove-v1").trim();
  if (!VALID_GENRES.has(genre)) throw new Error(`Unsupported genre: ${genre}`);
  if (!seed || seed.length > 100) throw new Error("Seed must contain 1–100 characters");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const packId = `${timestamp}-${hash32(`${genre}:${seed}`).toString(16)}`;
  const packDirectory = uniquePackDirectory(path.join(ROOT, "listening", "producer-dna"), packId);
  mkdirSync(packDirectory, { recursive: true });

  const harness = `
import { createDefaultProject } from "/src/project-model/schema.ts";
import { normalizeIntent } from "/src/intent/normalize.ts";
import { planGeneration } from "/src/intent/plan.ts";
import { generatePattern } from "/src/ai/generator.ts";
import { FEATURE_COUNT, FEATURE_NAMES, extractPatternFeatures } from "/src/ai/features/pattern-features.ts";
import { applyCandidateSearchFamily, candidateSearchVariant, selectPersonalGrooveCandidate } from "/src/intent/candidate-search.ts";
import { createPreferenceObservation, preferenceContextForIntent } from "/src/intent/preference-ledger.ts";
import { inferPersonalSearchBias } from "/src/intent/personal-ranker.ts";
import { evaluateCandidate } from "/src/intent/providers/candidate.ts";
import { generateFactoryBank } from "/src/sample-library/factory.ts";
import { auditionDoc } from "/src/intent/audition.ts";
import { renderProject } from "/src/rendering/renderer.ts";
import { encodeWav } from "/src/rendering/wav.ts";

const bankPromise = generateFactoryBank();
const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");
const offbeatIndex = FEATURE_NAMES.indexOf("drums.offbeatRatio");
function snapshots(context, direction, pairId) {
  const high = new Array(FEATURE_COUNT).fill(0.5);
  const low = new Array(FEATURE_COUNT).fill(0.5);
  high[syncopationIndex] = 0.9;
  low[syncopationIndex] = 0.1;
  high[offbeatIndex] = 0.9;
  low[offbeatIndex] = 0.1;
  const votes = [];
  for (let index = 0; index < 2; index++) {
    const observation = createPreferenceObservation(
      context,
      { contentHash: pairId + "-high-" + index, features: high },
      { contentHash: pairId + "-low-" + index, features: low },
      direction > 0 ? "a" : "b",
      { reason: "groove", createdAt: index + 1 },
    );
    if (!observation) throw new Error("Could not build a valid synthetic groove preference pair");
    votes.push(observation);
  }
  return votes;
}
function measure(pattern, plan, options) {
  const value = extractPatternFeatures({
    doc: options.doc,
    pattern,
    intent: plan.intent,
    options: options.generationOptions,
    resolvedBpm: plan.resolvedBpm,
  }).values[syncopationIndex];
  if (!Number.isFinite(value)) throw new Error("Generated pattern has no finite syncopation feature");
  return value;
}
function fitRms(buffer) {
  let squared = 0;
  let peak = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      if (!Number.isFinite(sample)) throw new Error("Offline render contains a non-finite sample");
      squared += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      count++;
    }
  }
  const rms = count > 0 ? Math.sqrt(squared / count) : 0;
  if (rms <= 1e-7 || peak <= 1e-7) throw new Error("Offline render is silent");
  const desiredRms = Math.pow(10, -18 / 20);
  const peakLimit = Math.pow(10, -1 / 20);
  const gain = Math.min(desiredRms / rms, peakLimit / peak);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) samples[index] *= gain;
  }
  return 20 * Math.log10(gain);
}
function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}
window.__renderProducerDnaPack = async ({ genre, seed, pairCount }) => {
  const bank = await bankPromise;
  const rendered = [];
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
    const direction = pairIndex % 2 === 0 ? 1 : -1;
    const target = direction > 0 ? "more" : "less";
    const pairId = "P" + String(pairIndex + 1).padStart(2, "0");
    let completedPair = false;
    for (let seedAttempt = 0; seedAttempt < 8 && !completedPair; seedAttempt++) {
      const pairSeed = seed + "|" + pairId + (seedAttempt === 0 ? "" : "|base-retry:" + seedAttempt);
    const doc = createDefaultProject();
    const intent = normalizeIntent({
      genre,
      seed: pairSeed,
      roles: ["drums"],
      length: 64,
      candidateCount: 3,
      constraints: { preserveAnchors: true, allowGhosts: false, allowSwing: false },
    });
    const plan = planGeneration(intent, doc);
    const preferenceContext = preferenceContextForIntent(plan.intent);
    const personalBias = inferPersonalSearchBias(snapshots(preferenceContext, direction, pairId), preferenceContext);
    if (!personalBias || Math.sign(personalBias.grooveSyncopation) !== direction) {
      throw new Error("Synthetic preference did not produce the requested groove direction");
    }

    const safeVariant = candidateSearchVariant(plan, plan.candidateSeeds[0], 0, null);
    const safeGenerated = generatePattern(doc, safeVariant.generationPlan.options);
    const safeEvaluated = evaluateCandidate(safeGenerated, safeVariant.validationPlan, { project: doc, mode: "preview" });
    if (!safeEvaluated) throw new Error(pairId + ": SAFE candidate failed its ordinary hard gates");
    const safeSyncopation = measure(safeEvaluated.pattern, safeVariant.validationPlan, {
      doc,
      generationOptions: safeVariant.generationPlan.options,
    });

    const selection = selectPersonalGrooveCandidate({
      plan,
      seed: plan.candidateSeeds[1],
      candidateIndex: 1,
      personalBias,
      baselineSyncopation: safeSyncopation,
      build(variant) {
        const generated = generatePattern(doc, variant.generationPlan.options);
        const prepared = applyCandidateSearchFamily(generated, doc, variant.generationPlan, variant.search);
        const evaluated = evaluateCandidate(prepared.pattern, variant.validationPlan, { project: doc, mode: "preview" });
        if (!evaluated) return null;
        const syncopation = measure(evaluated.pattern, variant.validationPlan, {
          doc,
          generationOptions: variant.generationPlan.options,
        });
        return { candidate: { pattern: evaluated.pattern, grooveId: variant.search.grooveId }, syncopation };
      },
    });
    if (!selection.candidate || selection.outputDelta === null) {
      console.warn(
        "[producer-dna] " + pairId + ": no gated PERSONAL candidate on base seed " + (seedAttempt + 1) + "; retrying",
      );
      continue;
    }
    const personalSyncopation = measure(selection.candidate.pattern, selection.variant.validationPlan, {
      doc,
      generationOptions: selection.variant.generationPlan.options,
    });

    const buffers = [];
    for (const pattern of [safeEvaluated.pattern, selection.candidate.pattern]) {
      const ghost = auditionDoc(doc, pattern);
      const buffer = await renderProject(ghost, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.5 });
      const gainDb = fitRms(buffer);
      buffers.push({ b64: toBase64(encodeWav(buffer, 16)), gainDb });
    }
    rendered.push({
      id: pairId,
      target,
      safe: buffers[0],
      personal: buffers[1],
      baselineSyncopation: safeSyncopation,
      personalSyncopation,
      measuredDelta: personalSyncopation - safeSyncopation,
      grooveId: selection.candidate.grooveId,
      seedAttempts: selection.attempts,
      baseSeedAttempt: seedAttempt + 1,
    });
    completedPair = true;
    console.log(
      "[producer-dna] " + pairId + ": " + target + ", sync " + safeSyncopation.toFixed(3) + " → " + personalSyncopation.toFixed(3) + " (" + selection.attempts + " seed(s))",
    );
    }
    if (!completedPair) {
      throw new Error(pairId + ": no PERSONAL candidate realized the learned direction after 8 base seeds");
    }
  }
  return rendered;
};
window.__producerDnaReady = true;
`;
  writeFileSync(path.join(packDirectory, "harness.mjs"), harness);
  writeFileSync(
    path.join(packDirectory, "harness.html"),
    '<!doctype html><html><body><script type="module" src="./harness.mjs"></scr' + "ipt></body></html>",
  );

  const server = await createServer({
    root: ROOT,
    logLevel: "error",
    server: { port: PORT, host: "127.0.0.1", strictPort: true },
  });
  await server.listen();
  let browser;
  let packComplete = false;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${PORT}/listening/producer-dna/${path.basename(packDirectory)}/harness.html`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => window.__producerDnaReady === true, null, { timeout: 120000 });
    const rendered = await page.evaluate((input) => window.__renderProducerDnaPack(input), {
      genre,
      seed,
      pairCount: REPLICATES_PER_DIRECTION * 2,
    });
    if (pageErrors.length > 0) throw new Error(`Browser render failed: ${pageErrors.join("; ")}`);

    const answerPairs = [];
    const publicPairs = [];
    const personalOnA = new Set(
      rendered
        .map((pair) => pair.id)
        .sort(
          (left, right) =>
            hash32(`${seed}:${left}:side`) - hash32(`${seed}:${right}:side`) || left.localeCompare(right),
        )
        .slice(0, rendered.length / 2),
    );
    for (const pair of rendered) {
      const personalIsA = personalOnA.has(pair.id);
      const a = personalIsA ? pair.personal : pair.safe;
      const b = personalIsA ? pair.safe : pair.personal;
      const aFile = `${pair.id}-A.wav`;
      const bFile = `${pair.id}-B.wav`;
      writeFileSync(path.join(packDirectory, aFile), Buffer.from(a.b64, "base64"));
      writeFileSync(path.join(packDirectory, bFile), Buffer.from(b.b64, "base64"));
      answerPairs.push({
        id: pair.id,
        target: pair.target,
        personalSide: personalIsA ? "A" : "B",
        safeSide: personalIsA ? "B" : "A",
        baselineSyncopation: pair.baselineSyncopation,
        personalSyncopation: pair.personalSyncopation,
        measuredDelta: pair.measuredDelta,
        selectedGrooveId: pair.grooveId,
        seedAttempts: pair.seedAttempts,
        baseSeedAttempt: pair.baseSeedAttempt,
        loudnessGainDb: { A: a.gainDb, B: b.gainDb },
      });
      publicPairs.push({ id: pair.id, target: pair.target, aFile, bFile });
    }
    publicPairs.sort((left, right) => hash32(`${seed}:${left.id}:order`) - hash32(`${seed}:${right.id}:order`));

    writeFileSync(
      path.join(packDirectory, "answer-key.json"),
      JSON.stringify(
        {
          version: 1,
          packId: path.basename(packDirectory),
          generatedAt: new Date().toISOString(),
          genre,
          seed,
          preferenceSource: "synthetic pairwise feature probes; not the user's ledger",
          pairs: answerPairs,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      path.join(packDirectory, "index.html"),
      listeningHtml(path.basename(packDirectory), genre, publicPairs),
    );
    writeFileSync(
      path.join(packDirectory, "LISTENING.md"),
      [
        "# KYX Producer DNA — blind groove listening pack",
        "",
        `Genre: **${genre}** · Pairs: **${answerPairs.length}** · Seed: \`${seed}\``,
        "",
        "Open `index.html` in a browser. It hides whether A/B is SAFE or PERSONAL, asks separately about the requested groove direction and personal preference, then downloads `verdicts.json`.",
        "",
        "These pairs use synthetic high/low syncopation preference observations to exercise the existing personal-ranker → candidate-search path. They do **not** use or modify a user's preference ledger. The audio is rendered offline by KYX and RMS-matched for listening only; the underlying project/audio is not modified.",
        "",
        "Do not open `answer-key.json` until votes are saved. To summarize afterward:",
        "",
        `\`npm run listening:producer-dna -- --score listening/producer-dna/${path.basename(packDirectory)}/verdicts.json\``,
        "",
        "This small one-listener probe is diagnostic, not a quality gate, trained dataset, or evidence of broad user preference.",
        "",
      ].join("\n"),
    );
    packComplete = true;
    console.log(`[producer-dna] ${answerPairs.length} blind pair(s) → ${packDirectory}`);
    console.log(`[producer-dna] open ${path.join(packDirectory, "index.html")}`);
    console.log("[producer-dna] no user ledger or global training data was read or changed");
  } finally {
    await browser?.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    if (packComplete) {
      unlinkSync(path.join(packDirectory, "harness.mjs"));
      unlinkSync(path.join(packDirectory, "harness.html"));
    }
  }
}
