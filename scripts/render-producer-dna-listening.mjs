/**
 * Blind ear-check for Producer DNA groove and hook search lanes.
 *
 * The pack compares SAFE and PERSONAL candidates rendered through the real
 * offline engine. Its pairwise observations are deliberately synthetic: this
 * probes whether the generator realizes a known groove preference direction,
 * not whether it has learned this user's taste. Listening votes stay in the
 * local pack and are never ingested into global training data.
 *
 * Groove:   npm run listening:producer-dna -- --genre=trap --seed=my-seed
 * Hook:     npm run listening:producer-dna:hook -- --genre=trap --seed=my-seed
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
  const mode = answerKey.mode === "hook" ? "hook" : "groove";
  const variantLabel = mode === "hook" ? "EXPERIMENTAL" : "PERSONAL";
  const seen = new Set();
  let directionHits = 0;
  let directionRated = 0;
  let noDifference = 0;
  let unsure = 0;
  let personalFavorites = 0;
  let safeFavorites = 0;
  let favoriteTies = 0;
  let favoriteNeithers = 0;
  for (const verdict of verdictPack.verdicts) {
    const answer = byId.get(verdict?.pairId);
    if (!answer || seen.has(verdict.pairId)) continue;
    seen.add(verdict.pairId);

    const variantSide = answer.variantSide ?? answer.personalSide;
    if ((verdict.directionVote === "A" || verdict.directionVote === "B") && variantSide) {
      directionRated++;
      if (verdict.directionVote === variantSide) directionHits++;
    } else if (verdict.directionVote === "same") noDifference++;
    else if (verdict.directionVote === "unsure") unsure++;
    if (verdict.favoriteVote === variantSide) personalFavorites++;
    else if (verdict.favoriteVote === answer.safeSide) safeFavorites++;
    else if (verdict.favoriteVote === "both") favoriteTies++;
    else if (verdict.favoriteVote === "neither") favoriteNeithers++;
  }

  const expectedVotes = answerKey.pairs.length;
  console.log(`# Producer DNA blind listening (${mode}) — ${answerKey.packId}`);
  console.log(`Intended ${mode} difference recognized: ${directionHits}/${directionRated} decisive votes`);
  console.log(`Difference not heard: ${noDifference}; unsure: ${unsure}`);
  console.log(
    `Listener keep-choice: ${variantLabel} ${personalFavorites}, SAFE ${safeFavorites}, both ${favoriteTies}, neither ${favoriteNeithers}`,
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

function listeningHtml(packId, genre, publicPairs, mode) {
  const payload = JSON.stringify({ packId, genre, pairs: publicPairs }).replaceAll("<", "\\u003c");
  const modeLabel = mode === "hook" ? "hook" : "groove";
  const targetPrompt =
    mode === "hook"
      ? "Ktorý lead hook opakuje motív a zároveň necháva viac priestoru v kadencii?"
      : "Ktorý groove pôsobí syncopovanejšie — viac úderov mimo hlavný dôraz?";
  const notice =
    mode === "hook"
      ? "Porovnávaj A a B bez hádania, ktorý je EXPERIMENTAL. Najprv označ, ktorý hook má opakujúci sa motív s obmenenou kadenciou; potom zvlášť vyber, ktorý by si si nechal. Zmenený pattern vznikol z rovnakého SAFE základu a upravuje iba lead hook. Hlasitosť ukážok je zrovnaná iba pre posluch."
      : "Porovnávaj A a B bez hádania, ktorý je PERSONAL. Najprv vyber, ktorý lepšie spĺňa rytmický cieľ; potom zvlášť označ, ktorý by si si nechal v beate. Hlasitosť ukážok je zrovnaná iba pre posluch.";
  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KYX Producer DNA — blind ${modeLabel} test</title>
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
  <h1>Producer DNA — zaslepený ${modeLabel} posluch</h1>
  <div class="muted">Žáner: ${genre} · pack ${packId}</div>
  <div class="notice">${notice}</div>
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
      hook: ${JSON.stringify(targetPrompt)},
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
  console.log("Generate a blind SAFE vs PERSONAL groove pack, a SAFE vs EXPERIMENTAL hook pack, or score verdicts.");
  console.log("npm run listening:producer-dna -- --genre=trap --seed=my-seed");
  console.log("npm run listening:producer-dna:hook -- --genre=trap --seed=my-seed --pairs=4");
  console.log("Add --ready-timeout-ms=30000 to shorten the browser harness startup diagnostic window.");
  console.log("npm run listening:producer-dna -- --score listening/producer-dna/<pack>/verdicts.json");
} else {
  const mode = option("--mode", "groove").trim().toLowerCase();
  const genre = option("--genre", "trap").trim().toLowerCase();
  const seed = option("--seed", mode === "hook" ? "producer-dna-hook-v1" : "producer-dna-groove-v1").trim();
  const pairCount = Number(option("--pairs", String(REPLICATES_PER_DIRECTION * 2)));
  const readyTimeoutMs = Number(option("--ready-timeout-ms", "120000"));
  if (mode !== "groove" && mode !== "hook") throw new Error(`Unsupported listening mode: ${mode}`);
  if (!VALID_GENRES.has(genre)) throw new Error(`Unsupported genre: ${genre}`);
  if (!seed || seed.length > 100) throw new Error("Seed must contain 1–100 characters");
  if (!Number.isInteger(pairCount) || pairCount < 1 || pairCount > 8) {
    throw new Error("Pair count must be an integer from 1 to 8");
  }
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 5000 || readyTimeoutMs > 300000) {
    throw new Error("Harness ready timeout must be an integer from 5000 to 300000 milliseconds");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const packId = `${timestamp}-${hash32(`${mode}:${genre}:${seed}`).toString(16)}`;
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
window.__renderProducerDnaPack = async ({ genre, seed, pairCount, mode }) => {
  const bank = await bankPromise;
  const rendered = [];
  async function renderTakes(doc, patterns) {
    const takes = [];
    for (const pattern of patterns) {
      const ghost = auditionDoc(doc, pattern);
      const buffer = await renderProject(ghost, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.5 });
      const gainDb = fitRms(buffer);
      takes.push({ b64: toBase64(encodeWav(buffer, 16)), gainDb });
    }
    return takes;
  }

  for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
    const direction = pairIndex % 2 === 0 ? 1 : -1;
    const target = mode === "hook" ? "hook" : direction > 0 ? "more" : "less";
    const pairId = "P" + String(pairIndex + 1).padStart(2, "0");
    let completedPair = false;
    for (let seedAttempt = 0; seedAttempt < 8 && !completedPair; seedAttempt++) {
      const pairSeed = seed + "|" + pairId + (seedAttempt === 0 ? "" : "|base-retry:" + seedAttempt);
      const doc = createDefaultProject();
      const intent = normalizeIntent({
        genre,
        seed: pairSeed,
        roles: mode === "hook" ? ["drums", "bass", "chords", "lead"] : ["drums"],
        length: 64,
        candidateCount: 3,
        constraints: { preserveAnchors: true, allowGhosts: false, allowSwing: false },
      });
      const plan = planGeneration(intent, doc);
      const safeVariant = candidateSearchVariant(plan, plan.candidateSeeds[0], 0, null);
      const safeGenerated = generatePattern(doc, safeVariant.generationPlan.options);
      const safeEvaluated = evaluateCandidate(safeGenerated, safeVariant.validationPlan, {
        project: doc,
        mode: "preview",
      });
      if (!safeEvaluated) throw new Error(pairId + ": SAFE candidate failed its ordinary hard gates");

      if (mode === "hook") {
        const experimentalVariant = candidateSearchVariant(plan, plan.candidateSeeds[2], 2, null);
        if (experimentalVariant.search.melodyFamily !== "evolving-hook") {
          console.warn("[producer-dna] " + pairId + ": no eligible evolving-hook family; retrying");
          continue;
        }
        // Isolate the hook transform: both takes share the exact SAFE pattern,
        // and only the named lead-hook family is applied to the second take.
        const hookSearch = {
          version: 1,
          lane: "experimental",
          family: "evolving-hook",
          melodyFamily: "evolving-hook",
          mode: "experimental",
          variant: 0,
        };
        const hookPrepared = applyCandidateSearchFamily(
          safeEvaluated.pattern,
          doc,
          safeVariant.generationPlan,
          hookSearch,
        );
        if (hookPrepared.search.melodyFamily !== "evolving-hook") {
          console.warn("[producer-dna] " + pairId + ": hook family made no real change; retrying");
          continue;
        }
        const hookEvaluated = evaluateCandidate(hookPrepared.pattern, safeVariant.validationPlan, {
          project: doc,
          mode: "preview",
        });
        if (!hookEvaluated) {
          console.warn("[producer-dna] " + pairId + ": transformed hook failed its ordinary hard gates; retrying");
          continue;
        }
        const leadTargets = new Set(safeVariant.generationPlan.rolePlans.lead.targetTrackIds);
        const leadTracks = doc.tracks.filter(
          (track) => track.kind === "instrument" && leadTargets.has(track.id),
        );
        const leadTrack =
          leadTracks.find((track) => track.name.toLowerCase().includes("lead")) ??
          leadTracks[2 % Math.max(1, leadTracks.length)];
        if (!leadTrack) throw new Error(pairId + ": no target lead track for hook comparison");
        const noteTrackIds = new Set([
          ...Object.keys(safeEvaluated.pattern.notes ?? {}),
          ...Object.keys(hookEvaluated.pattern.notes ?? {}),
        ]);
        for (const trackId of noteTrackIds) {
          if (trackId === leadTrack.id) continue;
          if (
            JSON.stringify(safeEvaluated.pattern.notes?.[trackId] ?? []) !==
            JSON.stringify(hookEvaluated.pattern.notes?.[trackId] ?? [])
          ) {
            throw new Error(pairId + ": hook comparison changed a non-lead instrument part");
          }
        }
        if (JSON.stringify(safeEvaluated.pattern.rows) !== JSON.stringify(hookEvaluated.pattern.rows)) {
          throw new Error(pairId + ": hook comparison changed drum content");
        }
        const leadBefore = safeEvaluated.pattern.notes?.[leadTrack.id] ?? [];
        const leadAfter = hookEvaluated.pattern.notes?.[leadTrack.id] ?? [];
        if (JSON.stringify(leadBefore) === JSON.stringify(leadAfter)) {
          throw new Error(pairId + ": evolving-hook did not change the rendered lead data");
        }
        const takes = await renderTakes(doc, [safeEvaluated.pattern, hookEvaluated.pattern]);
        rendered.push({
          id: pairId,
          target,
          safe: takes[0],
          variant: takes[1],
          variantName: "experimental",
          leadNoteCounts: { safe: leadBefore.length, experimental: leadAfter.length },
          baseSeedAttempt: seedAttempt + 1,
        });
        completedPair = true;
        console.log("[producer-dna] " + pairId + ": evolving hook changed lead only, SAFE drum/melodic roles preserved");
        continue;
      }

      const preferenceContext = preferenceContextForIntent(plan.intent);
      const personalBias = inferPersonalSearchBias(snapshots(preferenceContext, direction, pairId), preferenceContext);
      if (!personalBias || Math.sign(personalBias.grooveSyncopation) !== direction) {
        throw new Error("Synthetic preference did not produce the requested groove direction");
      }
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
          const evaluated = evaluateCandidate(prepared.pattern, variant.validationPlan, {
            project: doc,
            mode: "preview",
          });
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
      const takes = await renderTakes(doc, [safeEvaluated.pattern, selection.candidate.pattern]);
      rendered.push({
        id: pairId,
        target,
        safe: takes[0],
        variant: takes[1],
        variantName: "personal",
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
      throw new Error(pairId + ": no valid " + mode + " alternative after 8 deterministic base seeds");
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
    optimizeDeps: {
      // The repository contains many listening HTML artifacts; crawl only
      // this generated browser harness for the one-off offline render.
      entries: [`listening/producer-dna/${path.basename(packDirectory)}/harness.html`],
      noDiscovery: true,
      holdUntilCrawlEnd: false,
    },
    server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false },
  });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    const browserDiagnostics = [];
    const requestsInFlight = new Set();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserDiagnostics.push(`console: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      requestsInFlight.delete(request);
      browserDiagnostics.push(`request failed: ${request.url()} — ${request.failure()?.errorText ?? "unknown error"}`);
    });
    page.on("request", (request) => requestsInFlight.add(request));
    page.on("requestfinished", (request) => requestsInFlight.delete(request));
    page.on("response", (response) => {
      if (response.status() >= 400) {
        browserDiagnostics.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });
    await page.goto(`http://127.0.0.1:${PORT}/listening/producer-dna/${path.basename(packDirectory)}/harness.html`, {
      waitUntil: "commit",
      timeout: 120000,
    });
    try {
      await page.waitForFunction(() => window.__producerDnaReady === true, null, { timeout: readyTimeoutMs });
    } catch (error) {
      const documentState = await page
        .evaluate(() => ({
          readyState: document.readyState,
          title: document.title,
          bodyText: document.body?.innerText?.slice(0, 400) ?? "",
          moduleScripts: Array.from(document.scripts)
            .map((script) => script.src)
            .filter(Boolean),
        }))
        .catch(() => null);
      const details = [
        ...pageErrors.map((message) => `page error: ${message}`),
        ...browserDiagnostics,
        `pending requests: ${[...requestsInFlight].map((request) => request.url()).join(", ") || "none"}`,
        `document: ${JSON.stringify(documentState)}`,
      ];
      throw new Error(
        `Producer DNA harness did not initialize within ${readyTimeoutMs} ms.${details.length ? `\n${details.join("\n")}` : ""}`,
        { cause: error },
      );
    }
    const rendered = await page.evaluate((input) => window.__renderProducerDnaPack(input), {
      genre,
      seed,
      pairCount,
      mode,
    });
    if (pageErrors.length > 0) throw new Error(`Browser render failed: ${pageErrors.join("; ")}`);

    const answerPairs = [];
    const publicPairs = [];
    const variantOnA = new Set(
      rendered
        .map((pair) => pair.id)
        .sort(
          (left, right) =>
            hash32(`${seed}:${left}:side`) - hash32(`${seed}:${right}:side`) || left.localeCompare(right),
        )
        .slice(0, Math.ceil(rendered.length / 2)),
    );
    for (const pair of rendered) {
      const variantIsA = variantOnA.has(pair.id);
      const variant = pair.variant ?? pair.personal;
      if (!variant) throw new Error(`${pair.id}: missing generated alternative`);
      const a = variantIsA ? variant : pair.safe;
      const b = variantIsA ? pair.safe : variant;
      const aFile = `${pair.id}-A.wav`;
      const bFile = `${pair.id}-B.wav`;
      writeFileSync(path.join(packDirectory, aFile), Buffer.from(a.b64, "base64"));
      writeFileSync(path.join(packDirectory, bFile), Buffer.from(b.b64, "base64"));
      answerPairs.push({
        id: pair.id,
        target: pair.target,
        variantSide: variantIsA ? "A" : "B",
        safeSide: variantIsA ? "B" : "A",
        variantName: pair.variantName ?? (mode === "hook" ? "experimental" : "personal"),
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
          mode,
          generatedAt: new Date().toISOString(),
          genre,
          seed,
          preferenceSource:
            mode === "hook"
              ? "none; same SAFE source, isolated hook transformation"
              : "synthetic groove probes; not the user's ledger",
          pairs: answerPairs,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      path.join(packDirectory, "index.html"),
      listeningHtml(path.basename(packDirectory), genre, publicPairs, mode),
    );
    writeFileSync(
      path.join(packDirectory, "LISTENING.md"),
      [
        `# KYX Producer DNA — blind ${mode} listening pack`,
        "",
        `Mode: **${mode}** · Genre: **${genre}** · Pairs: **${answerPairs.length}** · Seed: \`${seed}\``,
        "",
        mode === "hook"
          ? "Open `index.html` in a browser. A/B order is blinded. The EXPERIMENTAL take is made by applying only the evolving-hook family to the same SAFE source pattern; drums and all non-lead parts must remain content-identical. First identify the repeating motif with altered cadence, then separately choose which take you would keep."
          : "Open `index.html` in a browser. It hides whether A/B is SAFE or PERSONAL, asks separately about the requested groove direction and personal preference, then downloads `verdicts.json`.",
        "",
        mode === "hook"
          ? "No preference observations are created or read. Both takes are rendered offline through KYX's real renderer and RMS-matched for listening only; the pack does not modify a project, the user's preference ledger, or global training data."
          : "These pairs use synthetic high/low syncopation preference observations to exercise the existing personal-ranker → candidate-search path. They do **not** use or modify a user's preference ledger. The audio is rendered offline by KYX and RMS-matched for listening only; the underlying project/audio is not modified.",
        "",
        "Do not open `answer-key.json` until votes are saved. The downloaded votes remain local and are not training data. To summarize afterward:",
        "",
        `\`npm run listening:producer-dna -- --score listening/producer-dna/${path.basename(packDirectory)}/verdicts.json\``,
        "",
        "This small one-listener probe is diagnostic, not a quality gate, trained dataset, or evidence of broad user preference.",
        "",
      ].join("\n"),
    );
    console.log(`[producer-dna] ${answerPairs.length} blind ${mode} pair(s) → ${packDirectory}`);
    console.log(`[producer-dna] open ${path.join(packDirectory, "index.html")}`);
    console.log("[producer-dna] no user ledger or global training data was read or changed");
  } finally {
    await browser?.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    for (const filename of ["harness.mjs", "harness.html"]) {
      const helperPath = path.join(packDirectory, filename);
      if (existsSync(helperPath)) unlinkSync(helperPath);
    }
  }
}
