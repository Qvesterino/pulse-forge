/**
 * Blind whole-song comparison for KYX Producer DNA.
 *
 * Compares the production-default BEST-PER-SECTION build against one complete,
 * internally coherent search lane. PERSONAL pairs use a synthetic, isolated
 * preference ledger in a fresh Playwright browser context; no user ledger,
 * project, or training data is read, written, or imported.
 *
 * Generate: npm run listening:producer-dna:song -- --genre=trap --lane=both --pairs=4
 * Score:    npm run listening:producer-dna:song -- --score <pack>/verdicts.json
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5268;
const OUT_ROOT = path.join(ROOT, "listening", "producer-dna-songs");
const VALID_GENRES = new Set(["house", "techno", "trap", "ambient", "drill", "phonk", "jersey", "dnb"]);
const VALID_LANES = new Set(["personal", "experimental"]);
const SAMPLE_RATE = 44100;

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

function tallySideVote(vote, laneSide) {
  if (vote !== "A" && vote !== "B") return "no-decision";
  return vote === laneSide ? "lane" : "baseline";
}

function scorePack(verdictPath) {
  const absoluteVerdictPath = path.resolve(verdictPath);
  const packDirectory = path.dirname(absoluteVerdictPath);
  const answerKey = readJson(path.join(packDirectory, "answer-key.json"), "answer-key.json");
  const verdictPack = readJson(absoluteVerdictPath, "verdicts.json");
  if (
    answerKey?.version !== 1 ||
    answerKey?.kind !== "whole-song" ||
    verdictPack?.version !== 1 ||
    typeof answerKey.packId !== "string" ||
    verdictPack.packId !== answerKey.packId ||
    verdictPack.blind !== true ||
    !Array.isArray(answerKey.pairs) ||
    !Array.isArray(verdictPack.verdicts)
  ) {
    throw new Error("Listening votes do not match a valid KYX whole-song pack");
  }

  const answerIds = new Set();
  for (const pair of answerKey.pairs) {
    if (
      !pair ||
      typeof pair.id !== "string" ||
      !VALID_LANES.has(pair.lane) ||
      !["A", "B"].includes(pair.laneSide) ||
      !["A", "B"].includes(pair.baselineSide) ||
      pair.laneSide === pair.baselineSide ||
      answerIds.has(pair.id)
    ) {
      throw new Error("answer-key.json contains an invalid or duplicate pair entry");
    }
    answerIds.add(pair.id);
  }

  const byId = new Map(answerKey.pairs.map((pair) => [pair.id, pair]));
  const seen = new Set();
  const summary = new Map();
  let laneBriefVotes = 0;
  let baselineBriefVotes = 0;
  let evenBriefVotes = 0;
  let unsureBriefVotes = 0;
  let laneKeepVotes = 0;
  let baselineKeepVotes = 0;
  let bothKeepVotes = 0;
  let neitherKeepVotes = 0;
  let detectedDifferent = 0;
  let detectedSame = 0;
  let unsureDifference = 0;

  for (const verdict of verdictPack.verdicts) {
    const answer = byId.get(verdict?.pairId);
    if (!answer || seen.has(verdict.pairId)) continue;
    seen.add(verdict.pairId);

    const laneSummary = summary.get(answer.lane) ?? {
      brief: { lane: 0, baseline: 0, even: 0, unsure: 0 },
      keep: { lane: 0, baseline: 0, both: 0, neither: 0 },
      difference: { yes: 0, no: 0, unsure: 0 },
      pairs: 0,
    };
    laneSummary.pairs++;

    const brief = tallySideVote(verdict.briefVote, answer.laneSide);
    if (brief === "lane") {
      laneBriefVotes++;
      laneSummary.brief.lane++;
    } else if (brief === "baseline") {
      baselineBriefVotes++;
      laneSummary.brief.baseline++;
    } else if (verdict.briefVote === "same") {
      evenBriefVotes++;
      laneSummary.brief.even++;
    } else if (verdict.briefVote === "unsure") {
      unsureBriefVotes++;
      laneSummary.brief.unsure++;
    }

    const keep = tallySideVote(verdict.keepVote, answer.laneSide);
    if (keep === "lane") {
      laneKeepVotes++;
      laneSummary.keep.lane++;
    } else if (keep === "baseline") {
      baselineKeepVotes++;
      laneSummary.keep.baseline++;
    } else if (verdict.keepVote === "both") {
      bothKeepVotes++;
      laneSummary.keep.both++;
    } else if (verdict.keepVote === "neither") {
      neitherKeepVotes++;
      laneSummary.keep.neither++;
    }

    if (verdict.differenceVote === "yes") {
      detectedDifferent++;
      laneSummary.difference.yes++;
    } else if (verdict.differenceVote === "no") {
      detectedSame++;
      laneSummary.difference.no++;
    } else if (verdict.differenceVote === "unsure") {
      unsureDifference++;
      laneSummary.difference.unsure++;
    }
    summary.set(answer.lane, laneSummary);
  }

  console.log(`# KYX whole-song blind listening — ${answerKey.packId}`);
  console.log(`Completed pairs: ${seen.size}/${answerKey.pairs.length}`);
  console.log(
    `Brief fit: complete lane ${laneBriefVotes}, best-per-section ${baselineBriefVotes}, same ${evenBriefVotes}, unsure ${unsureBriefVotes}`,
  );
  console.log(
    `Would keep: complete lane ${laneKeepVotes}, best-per-section ${baselineKeepVotes}, both ${bothKeepVotes}, neither ${neitherKeepVotes}`,
  );
  console.log(`Perceived difference: yes ${detectedDifferent}, no ${detectedSame}, unsure ${unsureDifference}`);
  for (const [lane, counts] of summary) {
    console.log(
      `${lane.toUpperCase()} (${counts.pairs}): brief lane/baseline ${counts.brief.lane}/${counts.brief.baseline}; keep lane/baseline ${counts.keep.lane}/${counts.keep.baseline}`,
    );
  }
  console.log(
    "Interpretation: descriptive listening evidence from this pack, not a model-quality gate or training import.",
  );
}

function listeningHtml(packId, genre, publicPairs) {
  const payload = JSON.stringify({ packId, genre, pairs: publicPairs }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KYX Producer DNA — blind whole-song test</title>
  <style>
    :root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #111318; color: #edf0f5; }
    body { margin: 0 auto; max-width: 900px; padding: 28px 18px 56px; }
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
  <h1>Producer DNA — zaslepený posluch celej skladby</h1>
  <div class="muted">Žáner: ${genre} · pack ${packId}</div>
  <div class="notice">Pri každom páre si vypočuj obe celé skladby. Porovnávaš „Best per section“ s jedným súvislým generatívnym smerom, ale označenia sú skryté. Najprv hlasuj podľa zadania, potom podľa toho, čo by si si nechal. Neotváraj answer-key.json, kým neuložíš verdikty.</div>
  <main id="pairs"></main>
  <p id="progress" class="muted"></p>
  <button id="save" disabled>STIAHNUŤ MOJE VERDIKTY</button>
  <p class="muted">Verdikty sa ukladajú iba do stiahnutého súboru. Nečítajú ani nemenia Producer DNA ledger a nevstupujú do tréningu.</p>
  <script type="module">
    const PACK = ${payload};
    const state = new Map(PACK.pairs.map((pair) => [pair.id, { briefVote: null, keepVote: null, differenceVote: null }]));
    const labels = {
      briefVote: [["A", "A"], ["B", "B"], ["same", "Približne rovnako"], ["unsure", "Neviem"]],
      keepVote: [["A", "A"], ["B", "B"], ["both", "Obe"], ["neither", "Ani jednu"]],
      differenceVote: [["yes", "Áno"], ["no", "Nie"], ["unsure", "Neviem"]],
    };
    const questions = {
      briefVote: "Ktorá lepšie napĺňa zadanie a funguje ako celok?",
      keepVote: "Ktorú by si si nechal a ďalej produkoval?",
      differenceVote: "Vnímaš medzi nimi zmysluplný hudobný rozdiel?",
    };
    const root = document.getElementById("pairs");
    for (const pair of PACK.pairs) {
      const card = document.createElement("section");
      card.className = "pair";
      card.dataset.pairId = pair.id;
      const heading = document.createElement("h2");
      heading.textContent = "Dvojica " + pair.id;
      card.append(heading);
      const takes = document.createElement("div");
      takes.className = "takes";
      for (const [label, file] of [["A", pair.aFile], ["B", pair.bFile]]) {
        const take = document.createElement("div");
        take.className = "take";
        const takeLabel = document.createElement("strong");
        takeLabel.textContent = "Celá skladba " + label;
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = "./" + file;
        take.append(takeLabel, audio);
        takes.append(take);
      }
      card.append(takes);
      for (const field of ["briefVote", "keepVote", "differenceVote"]) {
        const group = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = questions[field];
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
      const completed = [...state.values()].filter((vote) => vote.briefVote && vote.keepVote && vote.differenceVote).length;
      document.getElementById("progress").textContent = completed + "/" + state.size + " dvojíc ohodnotených";
      document.getElementById("save").disabled = completed !== state.size;
    }
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-field]");
      if (!button) return;
      const pairId = button.closest("[data-pair-id]")?.dataset.pairId;
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
  console.log("Generate a blind whole-song comparison or score a downloaded verdicts.json.");
  console.log("npm run listening:producer-dna:song -- --genre=trap --lane=both --pairs=4");
  console.log("npm run listening:producer-dna:song -- --score listening/producer-dna-songs/<pack>/verdicts.json");
  console.log(
    "Options: --lane=personal|experimental|both --pairs=1..8 --seed=<stable-seed> (up to 3 seed attempts per pair)",
  );
} else {
  const genre = option("--genre", "trap").trim().toLowerCase();
  const laneOption = option("--lane", "both").trim().toLowerCase();
  const seed = option("--seed", "producer-dna-song-v1").trim();
  const requestedPairs = Number(option("--pairs", "4"));
  const pairCount = Number.isFinite(requestedPairs) ? Math.max(1, Math.min(8, Math.floor(requestedPairs))) : 4;
  if (!VALID_GENRES.has(genre)) throw new Error(`Unsupported genre: ${genre}`);
  if (laneOption !== "both" && !VALID_LANES.has(laneOption)) throw new Error(`Unsupported lane: ${laneOption}`);
  if (!seed || seed.length > 100) throw new Error("Seed must contain 1–100 characters");

  const lanes = laneOption === "both" ? ["personal", "experimental"] : [laneOption];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const packId = `${timestamp}-${hash32(`${genre}:${laneOption}:${seed}`).toString(16)}`;
  const packDirectory = uniquePackDirectory(OUT_ROOT, packId);
  mkdirSync(packDirectory, { recursive: true });

  const harness = `
import { createDefaultProject } from "/src/project-model/schema.ts";
import { normalizeIntent } from "/src/intent/normalize.ts";
import { planSongForm, buildSong, applySongCommand } from "/src/intent/song.ts";
import { planMixProfile, applyMixIntent } from "/src/intent/mix.ts";
import { preferenceContextForIntent, createPreferenceObservation, PREFERENCE_LEDGER_KEY, PREFERENCE_LEARNING_KEY } from "/src/intent/preference-ledger.ts";
import { FEATURE_COUNT, FEATURE_NAMES } from "/src/ai/features/pattern-features.ts";
import { generateFactoryBank } from "/src/sample-library/factory.ts";
import { renderProject } from "/src/rendering/renderer.ts";
import { encodeWav } from "/src/rendering/wav.ts";
import { canonicalizePattern, contentHash } from "/src/ai/evaluation.ts";
import { reviewSongAudio } from "/src/intent/song-audio-review.ts";

const bankPromise = generateFactoryBank();
const lengthHint = { kind: "short", label: "short" };
const allRoles = ["drums", "bass", "chords", "lead"];
const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");
const offbeatIndex = FEATURE_NAMES.indexOf("drums.offbeatRatio");

function installSyntheticGroovePreferences(intent, pairId, direction) {
  const form = planSongForm(intent, undefined, lengthHint);
  const contexts = new Map();
  for (const section of form.sections) {
    const wanted = section.instrumentation.filter((role) => intent.roles.includes(role));
    const roles = wanted.length > 0 ? wanted : intent.roles;
    const context = preferenceContextForIntent({
      genre: intent.genre,
      productionProfile: intent.productionProfile,
      roles,
      preserve: intent.preserve,
    });
    contexts.set(context.key, context);
  }

  const observations = [];
  let createdAt = 1;
  for (const context of contexts.values()) {
    for (let replicate = 0; replicate < 2; replicate++) {
      const high = new Array(FEATURE_COUNT).fill(0.5);
      const low = new Array(FEATURE_COUNT).fill(0.5);
      if (syncopationIndex >= 0) { high[syncopationIndex] = 0.9; low[syncopationIndex] = 0.1; }
      if (offbeatIndex >= 0) { high[offbeatIndex] = 0.9; low[offbeatIndex] = 0.1; }
      const observation = createPreferenceObservation(
        context,
        { contentHash: pairId + "_" + context.key + "_" + replicate + "_high", features: high },
        { contentHash: pairId + "_" + context.key + "_" + replicate + "_low", features: low },
        direction > 0 ? "a" : "b",
        { reason: "groove", createdAt: createdAt++ },
      );
      if (!observation) throw new Error("Could not create a valid isolated synthetic preference pair");
      observations.push(observation);
    }
  }
  localStorage.setItem(PREFERENCE_LEDGER_KEY, JSON.stringify(observations));
  localStorage.setItem(PREFERENCE_LEARNING_KEY, "on");
}

function fitRms(buffer) {
  let squared = 0;
  let peak = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      if (!Number.isFinite(sample)) throw new Error("Offline song render contains a non-finite sample");
      squared += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      count++;
    }
  }
  const rms = count > 0 ? Math.sqrt(squared / count) : 0;
  if (rms <= 1e-7 || peak <= 1e-7) throw new Error("Offline song render is silent");
  const gain = Math.min(Math.pow(10, -18 / 20) / rms, Math.pow(10, -1 / 20) / peak);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) samples[index] *= gain;
  }
  return { gainDb: 20 * Math.log10(gain), review: reviewSongAudio(buffer) };
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

async function renderBuild(doc, build, mixCommand, sections, bank) {
  const selectedBuild = { ...build, sections, alternatives: [] };
  let preview = applySongCommand(doc, selectedBuild).execute(doc);
  if (mixCommand) preview = mixCommand.execute(preview);
  const buffer = await renderProject(preview, bank, {
    mode: "song",
    sampleRate: ${SAMPLE_RATE},
    tailSeconds: 1,
  });
  const loudness = fitRms(buffer);
  const hashes = sections.map((section) => contentHash(canonicalizePattern(doc, section.pattern)));
  return {
    b64: toBase64(encodeWav(buffer, 16)),
    gainDb: loudness.gainDb,
    review: loudness.review,
    sectionHashes: hashes,
    signature: contentHash(hashes.join("|")),
  };
}

window.__producerDnaSongReady = false;
window.__producerDnaSongError = null;
bankPromise.then(
  () => {
    window.__producerDnaSongReady = true;
  },
  (error) => {
    window.__producerDnaSongError = error instanceof Error ? error.message : String(error);
  },
);
window.__renderProducerDnaSongPair = async ({ genre, seed, pairId, lane, personalDirection }) => {
  const bank = await bankPromise;
  const maxSeedAttempts = 3;
  let lastFailure = "no complete, distinct lane alternative";
  for (let seedAttempt = 0; seedAttempt < maxSeedAttempts; seedAttempt++) {
    const pairSeed = seed + "|" + pairId + (seedAttempt === 0 ? "" : "|base-retry:" + seedAttempt);
    const doc = createDefaultProject();
    const intent = normalizeIntent({
      genre,
      seed: pairSeed,
      roles: allRoles,
      candidateCount: 3,
    });
    localStorage.removeItem(PREFERENCE_LEDGER_KEY);
    if (lane === "personal") installSyntheticGroovePreferences(intent, pairId, personalDirection);
    else localStorage.setItem(PREFERENCE_LEDGER_KEY, "[]");

    try {
      const build = await buildSong(doc, intent, {
        length: lengthHint,
        bank,
        candidateCount: 3,
        onProgress: (done, label, total) =>
          console.log("[producer-dna-song:progress] section " + label + " (" + done + "/" + total + ")"),
      });
      const availableLanes = build.alternatives.map((candidate) => candidate.lane);
      console.log(
        "[producer-dna-song:lanes] " +
          pairId +
          " seed " +
          (seedAttempt + 1) +
          ": " +
          (availableLanes.length > 0 ? availableLanes.join(", ") : "none"),
      );
      let mixCommand = null;
      try {
        const profile = planMixProfile(build.baseIntent);
        if (profile.decisions.length > 0) mixCommand = applyMixIntent(doc, profile);
      } catch {
        // The production UI treats the intent-driven mix as optional garnish.
      }
      const alternative = build.alternatives.find((candidate) => candidate.lane === lane);
      if (!alternative) {
        lastFailure =
          "lane " +
          lane +
          " unavailable or identical to best-per-section (available: " +
          (availableLanes.join(", ") || "none") + ")";
        console.log("[producer-dna-song:retry] " + pairId + ": " + lastFailure);
        continue;
      }
      const baseline = await renderBuild(doc, build, mixCommand, build.sections, bank);
      const completeLane = await renderBuild(doc, build, mixCommand, alternative.sections, bank);
      if (baseline.signature === completeLane.signature) {
        lastFailure = "complete lane content hash matched baseline";
        continue;
      }
      const changedSections = baseline.sectionHashes.filter((hash, index) => hash !== completeLane.sectionHashes[index]).length;
      return {
        id: pairId,
        lane,
        mode: alternative.mode,
        personalDirection: lane === "personal" ? (personalDirection > 0 ? "more-syncopated" : "straighter") : null,
        totalBars: build.totalBars,
        resolvedBpm: build.resolvedBpm,
        sectionCount: build.sections.length,
        changedSections,
        baseline,
        laneBuild: completeLane,
        seedAttempt: seedAttempt + 1,
      };
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(pairId + ": could not render a distinct full-song " + lane + " lane after " + maxSeedAttempts + " seeds — " + lastFailure);
};
`;

  writeFileSync(path.join(packDirectory, "harness.mjs"), harness);
  writeFileSync(
    path.join(packDirectory, "harness.html"),
    '<!doctype html><html><body><script type="module" src="./harness.mjs"></scr' + "ipt></body></html>",
  );

  const server = await createServer({
    root: ROOT,
    logLevel: "error",
    // The harness is a one-shot render, not an interactive app. Disabling HMR
    // keeps concurrent edits in the shared worktree from navigating the page
    // and destroying an in-flight OfflineAudioContext render.
    server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false },
  });
  await server.listen();
  let browser;
  let context;
  let packComplete = false;
  try {
    browser = await chromium.launch();
    context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) =>
      pageErrors.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`),
    );
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[producer-dna-song:")) console.log(text);
      else if (message.type() === "error") pageErrors.push(text);
    });
    await page.goto(
      `http://127.0.0.1:${PORT}/listening/producer-dna-songs/${path.basename(packDirectory)}/harness.html`,
      {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      },
    );
    await page.waitForFunction(
      () => window.__producerDnaSongReady === true || typeof window.__producerDnaSongError === "string",
      null,
      { timeout: 120000 },
    );
    const bankError = await page.evaluate(() => window.__producerDnaSongError);
    if (bankError) throw new Error(`Factory sample bank failed: ${bankError}`);

    const renderedPairs = [];
    const laneCounts = new Map(lanes.map((lane) => [lane, 0]));
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
      const lane = lanes[pairIndex % lanes.length];
      const pairId = "S" + String(pairIndex + 1).padStart(2, "0");
      const laneIndex = laneCounts.get(lane) ?? 0;
      laneCounts.set(lane, laneIndex + 1);
      const personalDirection = laneIndex % 2 === 0 ? 1 : -1;
      console.log(`[producer-dna-song] ${pairId}: building complete ${lane} comparison…`);
      const rendered = await page.evaluate((input) => window.__renderProducerDnaSongPair(input), {
        genre,
        seed,
        pairId,
        lane,
        personalDirection,
      });
      if (pageErrors.length > 0) throw new Error(`Browser render failed: ${pageErrors.join("; ")}`);
      renderedPairs.push(rendered);
      console.log(
        `[producer-dna-song] ${pairId}: ${rendered.sectionCount} sections / ${rendered.totalBars} bars, ${rendered.changedSections} changed section(s), mode=${rendered.mode}`,
      );
    }

    const byLane = new Map();
    for (const pair of renderedPairs) {
      const entries = byLane.get(pair.lane) ?? [];
      entries.push(pair.id);
      byLane.set(pair.lane, entries);
    }
    const laneOnA = new Map();
    for (const [lane, ids] of byLane) {
      const firstIsLane = (hash32(`${seed}:${lane}:side`) & 1) === 0;
      ids.forEach((id, index) => laneOnA.set(id, index % 2 === 0 ? firstIsLane : !firstIsLane));
    }

    const answerPairs = [];
    const publicPairs = [];
    for (const pair of renderedPairs) {
      const laneIsA = laneOnA.get(pair.id) ?? false;
      const a = laneIsA ? pair.laneBuild : pair.baseline;
      const b = laneIsA ? pair.baseline : pair.laneBuild;
      const aFile = `${pair.id}-A.wav`;
      const bFile = `${pair.id}-B.wav`;
      writeFileSync(path.join(packDirectory, aFile), Buffer.from(a.b64, "base64"));
      writeFileSync(path.join(packDirectory, bFile), Buffer.from(b.b64, "base64"));
      answerPairs.push({
        id: pair.id,
        lane: pair.lane,
        laneMode: pair.mode,
        laneSide: laneIsA ? "A" : "B",
        baselineSide: laneIsA ? "B" : "A",
        personalDirection: pair.personalDirection,
        totalBars: pair.totalBars,
        resolvedBpm: pair.resolvedBpm,
        sectionCount: pair.sectionCount,
        changedSections: pair.changedSections,
        seedAttempt: pair.seedAttempt,
        baselineSignature: pair.baseline.signature,
        laneSignature: pair.laneBuild.signature,
        loudnessGainDb: { A: a.gainDb, B: b.gainDb },
        audioReview: { A: a.review, B: b.review },
      });
      publicPairs.push({ id: pair.id, aFile, bFile });
    }
    publicPairs.sort((left, right) => hash32(`${seed}:${left.id}:order`) - hash32(`${seed}:${right.id}:order`));

    writeFileSync(
      path.join(packDirectory, "answer-key.json"),
      JSON.stringify(
        {
          version: 1,
          kind: "whole-song",
          packId: path.basename(packDirectory),
          generatedAt: new Date().toISOString(),
          genre,
          seed,
          sampleRate: SAMPLE_RATE,
          levelMatching: "whole-song RMS toward -18 dBFS, with a -1 dBFS peak ceiling; listening copies only",
          personalPreferenceSource:
            "synthetic groove-direction examples installed only in this fresh ephemeral browser context; never read from or written to a user's ledger",
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
        "# KYX Producer DNA — blind whole-song listening pack",
        "",
        `Genre: **${genre}** · Pairs: **${answerPairs.length}** · Seed: \`${seed}\``,
        "",
        "Open `index.html` and listen to both complete arrangements in each pair. Vote separately for brief fit, which version you would keep, and whether you hear a meaningful difference. The pack compares the normal best-per-section build with a coherent complete search lane; lane identities and A/B mapping are in `answer-key.json`.",
        "",
        "Every version was rendered offline by KYX at 44.1 kHz and RMS-matched for listening (target -18 dBFS, peak ceiling -1 dBFS). This changes only the listening copy. `audioReview` in the answer key reports technical measurements, not artistic quality.",
        "",
        "PERSONAL pairs use synthetic groove preferences in a fresh, temporary Playwright browser context to exercise the current search policy. The user's browser data and local Producer DNA ledger are never opened or imported; the verdict file is not a training import. This is a small diagnostic listening sample, not evidence of broad preference or a model-quality gate.",
        "",
        "Do not open `answer-key.json` until the votes are saved. To summarize afterward:",
        "",
        `\`npm run listening:producer-dna:song -- --score listening/producer-dna-songs/${path.basename(packDirectory)}/verdicts.json\``,
        "",
      ].join("\n"),
    );
    packComplete = true;
    console.log(`[producer-dna-song] ${answerPairs.length} blind whole-song pair(s) → ${packDirectory}`);
    console.log(`[producer-dna-song] open ${path.join(packDirectory, "index.html")}`);
    console.log("[producer-dna-song] no user preference ledger or global training data was read or changed");
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    if (packComplete) {
      unlinkSync(path.join(packDirectory, "harness.mjs"));
      unlinkSync(path.join(packDirectory, "harness.html"));
    }
  }
}
