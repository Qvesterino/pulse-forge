// Scratch analysis over tmp-audit.json (sound-library quality pass).
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(new URL("./tmp-audit.json", import.meta.url), "utf8"));
const B = ["sub", "low", "lowmid", "mid", "himid", "high", "air"];
const p = (s, w) => String(s).padStart(w);
const comb = (...xs) => 10 * Math.log10(xs.reduce((a, x) => a + 10 ** (x / 10), 0));
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

for (const r of rows) {
  const b = r.bands;
  r.top = comb(b.himid, b.high, b.air);      // 2k+ share (dB)
  r.topRel = r.top - b.mid;                  // brightness vs mid band
  r.mudRel = b.lowmid - b.mid;               // 120-350 vs 350-2000
  r.subRel = b.sub - b.mid;
  r.lowRel = b.low - b.mid;
  r.airRel = b.air - b.mid;
  r.highRel = b.high - b.mid;
}

const hdr = ["id", "cat", "dur", "peak", "crest", "lufs", "cent", ...B, "topRel", "mudRel"].map((s) => s);
const byCat = new Map();
for (const r of rows) (byCat.get(r.category) ?? byCat.set(r.category, []).get(r.category)).push(r);

console.log("id".padEnd(38) + "cat".padEnd(10) + ["dur", "peak", "crest", "lufs", "cent"].map((s) => p(s, 8)).join("") + B.map((s) => p(s, 8)).join("") + p("topRel", 8) + p("mudRel", 8));
for (const [cat, list] of [...byCat.entries()].sort()) {
  console.log(`\n--- ${cat} (${list.length}) ---`);
  for (const r of [...list].sort((a, c) => a.id.localeCompare(c.id))) {
    console.log(
      r.id.padEnd(38) +
        r.category.slice(0, 9).padEnd(10) +
        [f1(r.durationSec), f1(r.peakDb), f1(r.crestDb), f1(r.momentaryLufs), Math.round(r.bands.centroid)].map((s) => p(s, 8)).join("") +
        B.map((k) => p(f1(r.bands[k]), 8)).join("") +
        p(f1(r.topRel), 8) +
        p(f1(r.mudRel), 8),
    );
  }
}

console.log("\n=== DULLEST (topRel lowest = least 2k+ energy vs mid) ===");
for (const r of [...rows].sort((a, c) => a.topRel - c.topRel).slice(0, 14))
  console.log(`  ${r.id.padEnd(36)} topRel ${f1(r.topRel)}  high ${f1(r.bands.high)}  air ${f1(r.bands.air)}  centroid ${Math.round(r.bands.centroid)}`);

console.log("\n=== BRIGHTEST (topRel highest) ===");
for (const r of [...rows].sort((a, c) => c.topRel - a.topRel).slice(0, 12))
  console.log(`  ${r.id.padEnd(36)} topRel ${f1(r.topRel)}  centroid ${Math.round(r.bands.centroid)}`);

console.log("\n=== MUDDIEST (mudRel highest = 120-350 dominates mid) ===");
for (const r of [...rows].sort((a, c) => c.mudRel - a.mudRel).slice(0, 12))
  console.log(`  ${r.id.padEnd(36)} mudRel ${f1(r.mudRel)}  lowRel ${f1(r.lowRel)}  centroid ${Math.round(r.bands.centroid)}`);

console.log("\n=== THINNEST in lowmid (mudRel lowest) ===");
for (const r of [...rows].sort((a, c) => a.mudRel - c.mudRel).slice(0, 10))
  console.log(`  ${r.id.padEnd(36)} mudRel ${f1(r.mudRel)}  sub ${f1(r.bands.sub)}  low ${f1(r.bands.low)}`);

console.log("\n=== SUB-SHARE outliers (subRel highest) ===");
for (const r of [...rows].sort((a, c) => c.subRel - a.subRel).slice(0, 10))
  console.log(`  ${r.id.padEnd(36)} subRel ${f1(r.subRel)}  sub ${f1(r.bands.sub)}`);

console.log("\n=== CREST outliers ===");
const crS = [...rows].sort((a, c) => a.crestDb - c.crestDb);
console.log(" lowest:");
for (const r of crS.slice(0, 10)) console.log(`  ${r.id.padEnd(36)} crest ${f1(r.crestDb)}  peak ${f1(r.peakDb)} lufs ${f1(r.momentaryLufs)}`);
console.log(" highest:");
for (const r of crS.slice(-10)) console.log(`  ${r.id.padEnd(36)} crest ${f1(r.crestDb)}  peak ${f1(r.peakDb)} lufs ${f1(r.momentaryLufs)}`);

console.log("\n=== LOUDEST / QUIETEST momentary LUFS ===");
for (const r of [...rows].sort((a, c) => c.momentaryLufs - a.momentaryLufs).slice(0, 6))
  console.log(`  ${r.id.padEnd(36)} ${f1(r.momentaryLufs)} LUFS`);
for (const r of [...rows].sort((a, c) => a.momentaryLufs - c.momentaryLufs).slice(0, 6))
  console.log(`  ${r.id.padEnd(36)} ${f1(r.momentaryLufs)} LUFS`);

console.log("\n=== DURATION outliers per category ===");
for (const [cat, list] of byCat) {
  const d = list.map((r) => r.durationSec);
  const m = d.reduce((a, x) => a + x, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / d.length);
  for (const r of list) {
    if (Math.abs(r.durationSec - m) > 2 * Math.max(sd, 0.001))
      console.log(`  ${r.id.padEnd(36)} ${f1(r.durationSec)}s vs ${cat} mean ${f1(m)} (sd ${f1(sd)})`);
  }
}

console.log("\n=== SPECTRAL REDUNDANCY (band-share + centroid distance, per category) ===");
const vec = (r) => [r.bands.sub, r.bands.low, r.bands.lowmid, r.bands.mid, r.bands.himid, r.bands.high, r.bands.air, Math.log2(r.bands.centroid + 1)];
const dist = (a, c) => Math.sqrt(vec(a).reduce((s, x, i) => s + (x - vec(c)[i]) ** 2, 0));
for (const [cat, list] of [...byCat.entries()].sort()) {
  if (list.length < 2) continue;
  const pairs = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) pairs.push([dist(list[i], list[j]), list[i].id, list[j].id]);
  pairs.sort((a, c) => a[0] - c[0]);
  console.log(`\n${cat}:`);
  for (const [d, a, c] of pairs.slice(0, 3)) console.log(`  ${f1(d).padStart(7)}  ${a}  <>  ${c}`);
}
