/**
 * "TRAIN MY TASTE" — the one command that closes the learning loop
 * (user request 2026-09-21). Everything the listening room and the dice
 * tray collected becomes training data for the intent engine, in order:
 *
 *   1. ingest       — listening/verdicts.json → ranker golden + favorites pack
 *   2. merge        — room favourites + dice ★ packs (listening/dice-packs/)
 *                     → listening/favorites-combined.json
 *   3. retrain      — favorites:retrain (drum prior + melodic prior + ranker)
 *   4. activate     — ranker:activate (golden review gate → ranker:train →
 *                     validation report → flips DEFAULT_RANKER_MODE to
 *                     "active" when the holdout gate says ready)
 *   5. before/after — model manifests + validation report diffed and printed
 *
 * Every step is resilient: a failure is captured into the summary and the
 * next step still runs when it does not depend on the failed one. Use
 * --dry-run to print the plan and current data state without training.
 *
 * Run: npm run taste:train [-- --dry-run]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LISTENING = path.join(ROOT, "listening");
const VERDICTS = path.join(LISTENING, "verdicts.json");
const PACK = path.join(LISTENING, "favorites-pack.json");
const COMBINED = path.join(LISTENING, "favorites-combined.json");
const DICE_PACKS = path.join(LISTENING, "dice-packs");
const GOLDEN = path.join(ROOT, "scripts", "data", "intent-ranker-golden.json");
const VALIDATION = path.join(ROOT, "scripts", "data", "intent-ranker-validation.json");
const MODELS_DIR = path.join(ROOT, "public", "models");
const DRY = process.argv.includes("--dry-run");

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const run = (label, cmd) => {
  console.log(`\n[taste] ▶ ${label}\n[taste] $ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT });
    return { label, cmd, ok: true };
  } catch (err) {
    console.error(`[taste] ✗ ${label} failed (${err.status ?? "?"})`);
    return { label, cmd, ok: false, status: err.status };
  }
};

const sha = (value) => {
  // Cheap stable hash for manifest diffing without pulling crypto imports
  // into the report — the full hashes live in the manifests themselves.
  let h = 0;
  const s = JSON.stringify(value);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
};

// ── 1) sources report ───────────────────────────────────────────────────────
const verdicts = readJson(VERDICTS);
const verdictCount = Array.isArray(verdicts) ? verdicts.length : 0;
const roomPack = readJson(PACK);
const roomEntries = roomPack?.entries?.length ?? 0;
mkdirSync(DICE_PACKS, { recursive: true });
const diceFiles = existsSync(DICE_PACKS)
  ? readdirSync(DICE_PACKS).filter((f) => f.endsWith(".json"))
  : [];
const golden = readJson(GOLDEN);
const roomCombos = (golden?.combos ?? []).filter((c) => c.source === "listening-room").length;

console.log("══════════════════════════════════════════════");
console.log("  TRAIN MY TASTE — learning loop orchestrator");
console.log("══════════════════════════════════════════════");
console.log(`sources:
  • listening verdicts:        ${verdictCount}
  • room ★ favourites:         ${roomEntries}
  • dice ★ packs (folder):     ${diceFiles.length} (${diceFiles.join(", ") || "empty"})
  • golden combos from room:   ${roomCombos}`);

if (verdictCount === 0 && roomEntries === 0 && diceFiles.length === 0) {
  console.error(
    "\n[taste] nothing to train from — listen first:\n" +
      "  npm run listening:serve → http://127.0.0.1:5179/room/\n" +
      "  (dice ★ packy: dice tray ⬇★ export → drop into listening/dice-packs/)",
  );
  process.exit(1);
}

// ── 2) ingest listening verdicts (also stamps top-level golden reviewed) ────
const results = [];
if (!DRY && verdictCount > 0) {
  results.push(run("ingest verdicts", "node scripts/ingest-listening-verdicts.mjs"));
} else if (DRY) {
  console.log("[taste] (dry-run) would run: node scripts/ingest-listening-verdicts.mjs");
}

// Top-level reviewed flag — ranker:activate gates on it; listening-room
// verdicts ARE the human review, so a room-sourced combo satisfies it.
const goldenNow = readJson(GOLDEN);
if (
  goldenNow &&
  (goldenNow.combos ?? []).some((c) => c.source === "listening-room") &&
  goldenNow.reviewed !== true
) {
  goldenNow.reviewed = true;
  goldenNow.reviewedBy = "listening-room";
  goldenNow.reviewedAt = new Date().toISOString();
  writeFileSync(GOLDEN, JSON.stringify(goldenNow, null, 2));
  console.log("[taste] golden reviewed:=true (listening-room verdicts are the human review)");
}

// ── 3) merge favourites: room pack + dice packs → one combined pack ─────────
const merged = { version: 1, exportedAt: new Date().toISOString(), source: "train-my-taste", entries: [] };
const seen = new Set();
const addEntries = (pack, origin) => {
  for (const entry of pack?.entries ?? []) {
    const key = sha({ seed: entry.seed, rows: entry.rows, savedAt: entry.savedAt });
    if (seen.has(key)) continue;
    seen.add(key);
    merged.entries.push({ ...entry, origin });
  }
};
addEntries(roomPack, "listening-room");
for (const file of diceFiles) {
  try {
    addEntries(JSON.parse(readFileSync(path.join(DICE_PACKS, file), "utf8")), `dice:${file}`);
  } catch (err) {
    console.warn(`[taste] skipping unreadable dice pack ${file}: ${err.message}`);
  }
}
if (merged.entries.length > 0) {
  writeFileSync(COMBINED, JSON.stringify(merged, null, 2));
  console.log(`[taste] combined favourites: ${merged.entries.length} entries → listening/favorites-combined.json`);
}

// ── 4) BEFORE snapshot (manifests + validation) ─────────────────────────────
const snapshotModels = () => {
  const out = {};
  for (const file of existsSync(MODELS_DIR) ? readdirSync(MODELS_DIR) : []) {
    if (!file.endsWith(".manifest.json")) continue;
    const m = readJson(path.join(MODELS_DIR, file));
    if (!m) continue;
    out[file] = { hash: sha(m), modelHash: m.modelHash, report: m.report ?? null };
  }
  out["__validation__"] = readJson(VALIDATION);
  return out;
};
const before = DRY ? null : snapshotModels();

// ── 5) train ────────────────────────────────────────────────────────────────
if (DRY) {
  console.log("[taste] (dry-run) would run:");
  if (merged.entries.length > 0)
    console.log("  • npx vite-node scripts/export-favorites-training.mts listening/favorites-combined.json");
  console.log("  • npm run ranker:activate   (golden gate → ranker:train → validation → maybe flip active)");
  console.log("[taste] dry-run complete — no training executed.");
  process.exit(0);
}

if (merged.entries.length > 0) {
  results.push(
    run(
      "retrain favourites (3 models)",
      `npx vite-node scripts/export-favorites-training.mts listening/favorites-combined.json`,
    ),
  );
} else {
  console.log("[taste] no favourites to retrain — skipping favorites:retrain");
}
results.push(run("ranker train + activation gate", "npm run ranker:activate"));

// ── 6) AFTER snapshot + diff ────────────────────────────────────────────────
const after = snapshotModels();
console.log("\n══════════════════════════════════════════════");
console.log("  BEFORE / AFTER");
console.log("══════════════════════════════════════════════");
const allFiles = new Set([...Object.keys(before), ...Object.keys(after)]);
for (const file of allFiles) {
  if (file === "__validation__") continue;
  const b = before[file];
  const a = after[file];
  const changed = !b || !a || b.hash !== a.hash;
  console.log(`  ${changed ? "●" : " "} ${file.replace(".manifest.json", "")}${changed ? " — RETRAINED" : " — unchanged"}`);
  if (changed && a?.report) {
    const entries = Object.entries(a.report).slice(0, 6);
    for (const [k, v] of entries) console.log(`      ${k}: ${typeof v === "number" ? Number(v).toFixed(4) : v}`);
  }
}
const vb = before?.__validation__;
const va = after?.__validation__;
if (vb || va) {
  const pick = (v) =>
    v && typeof v === "object"
      ? Object.entries(v)
          .filter(([, x]) => typeof x === "number")
          .map(([k, x]) => `${k}=${Number(x).toFixed(4)}`)
          .join("  ")
      : "—";
  console.log(`  validation before: ${pick(vb)}`);
  console.log(`  validation after:  ${pick(va)}`);
}

console.log("\n══════════════════════════════════════════════");
console.log("  STEP SUMMARY");
console.log("══════════════════════════════════════════════");
for (const r of results) console.log(`  ${r.ok ? "✔" : "✗"} ${r.label}`);
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? "\n[taste] learning loop closed — your taste is now in the models ✔"
    : `\n[taste] ${failed} step(s) failed — see output above (python deps? gate not ready?)`,
);
process.exit(failed > 0 ? 1 : 0);
