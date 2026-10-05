import { renderGoldenTrack, goldenTracks } from "../tests/unsuno/golden-synth";
import { detectBassNotes } from "../src/reference/analysis/bass";
import { trackPitch } from "../src/audio-workers/pitch-tracker";
import { applyLowPass } from "../src/reference/analysis/bass";

const SAMPLE_RATE = 22050; // golden synth rate — check
console.log(
  "golden sample rates:",
  goldenTracks()
    .slice(0, 1)
    .map(() => "see below"),
);
for (const track of goldenTracks()) {
  if (track.id !== "house-126-am" && track.id !== "techno-130-em") continue;
  const pcm = renderGoldenTrack(track);
  console.log(`\n=== ${track.id} bpm=${track.bpm} bars=${track.bars} len=${pcm.length} ===`);
  // Truth bass onsets
  const stepSec = 60 / track.bpm / 4;
  console.log(
    "truth bass (first 8):",
    track.bass.slice(0, 8).map((n) => `step${n.step}@${((n.step * stepSec) * 1000).toFixed(0)}ms midi${n.pitch}`),
  );
  // Kick onsets
  const kickSteps: number[] = [];
  track.drums.kick.forEach((bar, bi) => bar.forEach((v, s) => v > 0 && kickSteps.push(bi * 16 + s)));
  console.log(
    "kick steps (first 8):",
    kickSteps.slice(0, 8).map((s) => `@${((s * stepSec) * 1000).toFixed(0)}ms`),
  );
  // Raw pitch frames around first kick+bass
  const iso = applyLowPass(pcm.subarray(0, Math.floor(4 * SAMPLE_RATE)), SAMPLE_RATE, 300);
  const small = new Float32Array(Math.floor(iso.length / 8));
  for (let i = 0; i < small.length; i++) small[i] = iso[i * 8];
  const frames = trackPitch(small, SAMPLE_RATE / 8, { fminHz: 40, fmaxHz: 250, hopMs: 20 }).filter(
    (f) => f.timeSec < 1.5,
  );
  console.log("pitch frames <1.5s (time ms / midi / clarity):");
  for (const f of frames) {
    console.log(`  ${(f.timeSec * 1000).toFixed(0)}ms  midi ${f.midi.toFixed(1)}  cl ${f.clarity.toFixed(2)}  rms ${f.rms.toFixed(3)}`);
  }
}
void SAMPLE_RATE;
void detectBassNotes;