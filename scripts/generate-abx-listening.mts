/**
 * Generates the ABX FORCED-CHOICE listening page — the validation tool for
 * the listening loop and every sound-quality wave (Phase C validation,
 * docs/INTENT-MCP-EXPANSION-PLAN.md).
 *
 * WHY: a listening verdict from one person is a sample of one. ABX turns
 * N=1 into a discrimination measurement: the listener hears X, then A and B
 * in RANDOM order, and must decide which one X was. Chance is 50 %, so
 * repeated trials give a real binomial p-value (18/20 correct → p ≈ 0.0002).
 *
 * Input: listening/abx/lanes.json
 *   { "lanes": [ { "lane": "groove-swing-drop", "label": "swing bake",
 *                  "fileA": "pairs/groove-before.wav",
 *                  "fileB": "pairs/groove-after.wav" } ] }
 * Output: listening/abx/index.html (self-contained, zero build) +
 *         trials POST → /api/abx-trial → listening/abx/trials.jsonl
 *         (served by scripts/serve-listening.mjs).
 *
 * Run: npm run listening:abx   (then npm run listening:serve)
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "listening", "abx");
const LANES_PATH = path.join(OUT_DIR, "lanes.json");

interface Lane {
  lane: string;
  label: string;
  fileA: string;
  fileB: string;
}

function loadLanes(): Lane[] {
  if (!existsSync(LANES_PATH)) {
    // First run: write an example so the serve + page flow is walkable.
    const example: Lane[] = [
      {
        lane: "example-groove-swing",
        label: "groove swing bake (example pair — replace with your render)",
        fileA: "pairs/example-a.wav",
        fileB: "pairs/example-b.wav",
      },
    ];
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(LANES_PATH, JSON.stringify({ lanes: example }, null, 2));
    return example;
  }
  const parsed = JSON.parse(readFileSync(LANES_PATH, "utf8")) as { lanes?: Lane[] };
  if (!Array.isArray(parsed.lanes) || parsed.lanes.length === 0) throw new Error("lanes.json: empty lanes");
  for (const lane of parsed.lanes) {
    if (typeof lane.lane !== "string" || typeof lane.fileA !== "string" || typeof lane.fileB !== "string") {
      throw new Error(`lanes.json: invalid lane entry ${JSON.stringify(lane)}`);
    }
  }
  return parsed.lanes;
}

const LANES = loadLanes();
const LANES_LITERAL = JSON.stringify(LANES).replace(/</g, "\\u003c");

const PAGE = `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="utf-8">
<title>KYX ABX — forced-choice listening</title>
<style>
  body { background: #14151a; color: #d9dae0; font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 20px; letter-spacing: .08em; }
  .lane { border: 1px solid #2c2e37; border-radius: 8px; padding: 16px 20px; margin: 14px 0; }
  .lane h2 { font-size: 15px; margin: 0 0 8px; }
  button { background: #2b2d36; color: #d9dae0; border: 1px solid #3d3f4a; border-radius: 6px; padding: 8px 18px; font-size: 14px; cursor: pointer; margin: 4px 6px 4px 0; }
  button:hover { background: #363947; }
  button.choice { background: #1d5c3f; border-color: #2e8b57; }
  .stat { font-variant-numeric: tabular-nums; color: #9aa0ad; }
  .ok { color: #59c98b; }
  .sig { color: #59c98b; font-weight: 600; }
  audio { display: block; margin: 6px 0; }
</style>
</head>
<body>
<h1>KYX ABX — forced-choice počúvanie</h1>
<p>X = referenčný stimulus. Prehraj X, potom A a B (náhodné poradie) a rozhodni,
ktorý bol X. Náhoda je 50 % — p-hodnota pod 0.05 znamená, že vieš rozoznať
rozdiel aj naslepo. Každá voľba sa loguje do <span class="stat">abx/trials.jsonl</span>.</p>
<div id="lanes"></div>
<h2>Spolu</h2>
<div id="summary" class="stat">—</div>
<script>
const LANES = ${LANES_LITERAL};

// Minimal binomial two-sided p-value (mirror of src/listening/abx-stats.ts).
function pValue(correct, total) {
  if (total <= 0) return 1;
  let pmf = Math.pow(0.5, total);
  const pmfObs = (() => { let v = pmf; for (let k = 1; k <= correct; k++) v = (v * (total - k + 1)) / k; return v; })();
  let sum = 0;
  for (let k = 0; k <= total; k++) {
    if (k > 0) pmf = (pmf * (total - k + 1)) / k;
    if (pmf <= pmfObs * (1 + 1e-9)) sum += pmf;
  }
  return Math.min(1, sum);
}

// Per-lane X choice — re-randomized after every vote so the listener cannot
// learn a fixed assignment.
const xChoice = {};
function xFor(lane) {
  if (xChoice[lane.lane] == null) xChoice[lane.lane] = Math.random() < 0.5 ? "A" : "B";
  return xChoice[lane.lane];
}

let trials = [];
try { trials = JSON.parse(localStorage.getItem("abx-trials") || "[]"); } catch { trials = []; }

const byLane = new Map();
function laneTrials(laneLane) {
  const list = byLane.get(laneLane) || [];
  byLane.set(laneLane, list);
  return list;
}

function srcFor(lane, which) {
  return which === "A" ? lane.fileA : lane.fileB;
}

function play(lane, which, audioEl) {
  audioEl.src = srcFor(lane, which);
  audioEl.play();
}

function vote(lane, audioEl) {
  const xWas = xFor(lane);
  const answer = document.getElementById("choice-" + lane.lane).value;
  const trial = { lane: lane.lane, xWas, answer, correct: xWas === answer, reactionMs: 0, receivedAt: Date.now() };
  trials.push(trial);
  localStorage.setItem("abx-trials", JSON.stringify(trials));
  // re-randomize X for the next round
  delete xChoice[lane.lane];
  try {
    fetch("/api/abx-trial", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(trial),
    });
  } catch { /* offline listening — the localStorage copy survives */ }
  renderStats();
}

function renderStats() {
  const total = trials.length;
  const correct = trials.filter((t) => t.correct).length;
  const p = pValue(correct, total);
  document.getElementById("summary").innerHTML =
    total > 0
      ? '<span class="' + (p < 0.05 ? 'sig' : 'stat') + '">' + correct + '/' + total + ' správne · p = ' + p.toFixed(4)
        + (p < 0.05 ? ' — rozdiel je počuteľný aj naslepo' : ' — zatiaľ nerozoznateľný od náhody') + '</span>'
      : '—';
  // per-lane refresh
  for (const lane of LANES) {
    const list = laneTrials(lane.lane);
    const correctLane = list.filter((t) => t.correct).length;
    const el = document.getElementById("stat-" + lane.lane);
    if (el) {
      el.innerHTML = 'skúšky: ' + list.length + ' · správne: ' + correctLane
        + ' · p = ' + (list.length > 0 ? pValue(correctLane, list.length).toFixed(4) : '—');
    }
  }
}

const root = document.getElementById("lanes");
for (const lane of LANES) {
  const div = document.createElement("div");
  div.className = "lane";
  div.innerHTML = '<h2>' + lane.lane + ' — ' + lane.label + '</h2>'
    + '<button data-which="X">▶ X</button>'
    + '<button data-which="A">▶ A</button>'
    + '<button data-which="B">▶ B</button>'
    + '<div class="stat" id="stat-' + lane.lane + '">skúšky: 0</div>'
    + '<select id="choice-' + lane.lane + '"><option value="A">A</option><option value="B">B</option></select>'
    + '<button id="vote-' + lane.lane + '">Hlasuj</button>';
  const audio = new Audio();
  div.querySelectorAll("[data-which]").forEach((button) => {
    button.addEventListener("click", () => play(lane, button.getAttribute("data-which"), audio));
  });
  div.querySelector("#vote-" + lane.lane).addEventListener("click", () => vote(lane, audio));
  root.appendChild(div);
}
renderStats();
</script></script>
</body>
</html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "index.html"), PAGE);
console.log(`abx: wrote listening/abx/index.html (${LANES.length} lane(s) from lanes.json)`);
console.log("serve with: npm run listening:serve  →  http://127.0.0.1:5179/abx/");
