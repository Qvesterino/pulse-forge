import { readFileSync } from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const rows = JSON.parse(readFileSync(path.join(here, "analysis.json"), "utf8"));

const fmt = (v, w = 6) => (v === null || v === undefined ? "-".padStart(w) : String(v).padStart(w));
const cat = (f) => f.split(".")[1];

const groups = {};
for (const r of rows) (groups[cat(r.file)] ??= []).push(r);

const targets = { kick: -8, snare: -9.5, clap: -10.5, hat: -15.5, ride: -17, crash: -17, tom: -11.5, rim: -13, perc: -13.5, shaker: -13.5, fx: -13, tonal: -16, mallet: -16 };

for (const [c, list] of Object.entries(groups)) {
  console.log(`\n=== ${c.toUpperCase()} (${list.length}) ===`);
  console.log("file                    dur   peak  LUFS tgt  crest atkMs decMs leadSil tailSil loudMs  clip limRun sub   low  lowmid  mid himid  high  air  centroid");
  for (const r of list.sort((a, b) => a.file.localeCompare(b.file))) {
    const b = r.bands;
    console.log(
      [
        r.file.replace("factory.", "").padEnd(20),
        fmt(r.durationSec.toFixed(2), 5),
        fmt(r.peakDb.toFixed(1), 6),
        fmt(r.momentaryLufs.toFixed(1), 5),
        fmt(targets[c] ?? "-", 4),
        fmt(r.crestDb.toFixed(1), 6),
        fmt(r.attackMs?.toFixed(1) ?? "-", 5),
        fmt(r.decayMs.toFixed(0), 5),
        fmt(r.leadSilenceMs.toFixed(1), 6),
        fmt(r.tailSilenceMs.toFixed(0), 6),
        fmt(r.loudMs.toFixed(0), 6),
        fmt(r.clipSamples, 4),
        fmt(r.limiterRuns, 4),
        fmt(b.sub.toFixed(0), 4),
        fmt(b.low.toFixed(0), 4),
        fmt(b.lowmid.toFixed(0), 6),
        fmt(b.mid.toFixed(0), 4),
        fmt(b.himid.toFixed(0), 5),
        fmt(b.high.toFixed(0), 5),
        fmt(b.air.toFixed(0), 4),
        fmt(Math.round(b.centroid), 5),
      ].join(" "),
    );
  }
}

// outliers / technical flags across everything
console.log("\n=== FLAGS ===");
for (const r of rows) {
  const flags = [];
  if (r.clipSamples > 0) flags.push(`CLIP x${r.clipSamples}`);
  if (Math.abs(r.dcOffset) > 1e-3) flags.push(`DC ${r.dcOffset}`);
  if (r.leadSilenceMs > 1) flags.push(`LEAD ${r.leadSilenceMs}ms`);
  if (r.tailSilenceMs > 400) flags.push(`DEADAIR ${r.tailSilenceMs}ms (loud ${r.loudMs}ms)`);
  if (r.loudMs < 40 && r.durationSec > 0.45) flags.push(`SHORT-SOUND-LONG-FILE loud=${r.loudMs}ms file=${r.durationSec}s`);
  if (r.peakDb > -0.3) flags.push(`HOTPEAK ${r.peakDb}`);
  if (r.crestDb < 6) flags.push(`SQUASHED crest=${r.crestDb}`);
  if (r.limiterRuns > 0) flags.push(`LIMRIDE runs=${r.limiterRuns} maxrun=${r.limiterMaxRunMs}ms`);
  if (r.attackMs === null || r.attackMs > 25) flags.push(`SLOWATK ${r.attackMs}ms`);
  if (r.format.channels === 2) {
    if (r.stereo && r.stereo.sideDb > -30) flags.push(`STEREO side=${r.stereo.sideDb.toFixed(1)}dB corr=${r.stereo.correlation.toFixed(2)}`);
  }
  if (flags.length) console.log(r.file.padEnd(42), flags.join(" | "));
}

// tuning of kicks/toms
console.log("\n=== TUNING (low-end glide) ===");
for (const r of rows) {
  if (r.tuning && Object.keys(r.tuning).length) {
    const parts = Object.entries(r.tuning).map(([k, v]) => `${k}: ${v.hz}Hz ${v.noteName}${v.cents >= 0 ? "+" : ""}${v.cents}c`);
    console.log(r.file.replace("factory.", "").padEnd(22), parts.join("  "));
  }
}

// redundancy: nearest neighbor by feature distance within category
console.log("\n=== NEAREST NEIGHBORS (feature distance within category) ===");
const feat = (r) => {
  const b = r.bands;
  return [b.sub, b.low, b.lowmid, b.mid, b.himid, b.high, b.air, r.crestDb, r.attackMs ?? 0, Math.min(r.decayMs, 1000)];
};
const norm = (v) => {
  const m = Math.max(...v.map(Math.abs), 1);
  return v.map((x) => x / m);
};
for (const [c, list] of Object.entries(groups)) {
  if (list.length < 2) continue;
  const F = list.map((r) => norm(feat(r)));
  const pairs = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    let d = 0;
    for (let k = 0; k < F[i].length; k++) d += (F[i][k] - F[j][k]) ** 2;
    pairs.push([Math.sqrt(d), list[i].file, list[j].file]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [d, a, b2] of pairs.slice(0, Math.min(2, pairs.length)))
    console.log(`${c.padEnd(12)} d=${d.toFixed(3)}  ${a.replace("factory.", "")} <-> ${b2.replace("factory.", "")}`);
}
