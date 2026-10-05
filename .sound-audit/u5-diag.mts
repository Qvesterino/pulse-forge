import { analyzeSectionMix } from "../src/analysis/sectionMixDoctor";
import { analyzeMixHealth, deriveMixAutoFix } from "../src/analysis/mixDoctor";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const SR = GOLDEN_SAMPLE_RATE;
const barSec = 240 / 126;
// house: 8 bars → 4 sections of 2 bars, last one made QUIET (chorus sim)
const house = goldenTracks()[0];
const pcm = renderGoldenTrack(house);
const quietFrom = Math.floor(3 * 2 * barSec * SR);
const quiet = new Float32Array(pcm.length);
quiet.set(pcm);
for (let i = quietFrom; i < quiet.length; i++) quiet[i] *= 0.5; // −6 dB tail
const sections = [0, 1, 2, 3].map((i) => ({ role: `sec${i}`, startSec: i * 2 * barSec, endSec: (i + 1) * 2 * barSec }));
const findings = analyzeSectionMix([quiet], SR, sections);
console.log("quiet-fixture findings:", findings.map((f) => `${f.kind}@${f.section}: ${f.message}`).join(" | ") || "NONE");

// clean: all sections equal → no balance finding
const cleanFindings = analyzeSectionMix([pcm], SR, sections);
console.log("clean findings:", cleanFindings.map((f) => `${f.kind}@${f.section}`).join(" | ") || "NONE");

// masking: loud sustained 70 Hz bass, no kick
const mask = new Float32Array(SR * 12);
for (let i = 0; i < mask.length; i++) {
  const t = i / SR;
  mask[i] = 0.6 * Math.sin(2 * Math.PI * 70 * t) + 0.05 * Math.sin(2 * Math.PI * 220 * t);
}
const maskFindings = analyzeSectionMix([mask], SR, [
  { role: "a", startSec: 0, endSec: 6 },
  { role: "b", startSec: 6, endSec: 12 },
]);
console.log("masking findings:", maskFindings.map((f) => `${f.kind}@${f.section}: ${f.evidence}`).join(" | ") || "NONE");

// full-source report + auto fix on the house render
const report = analyzeMixHealth([pcm], SR);
const fix = deriveMixAutoFix(report);
console.log("house report: lowShare", report.lowEndShare.toFixed(2), "peak", report.peak.toFixed(2), "fix:", fix?.label ?? "none");
