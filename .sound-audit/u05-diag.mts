import { computeOnsetEnvelopes, removeBaseline } from "D:/pulse-forge/src/reference/dsp/spectralFlux";
import { estimateTempoCandidates } from "D:/pulse-forge/src/reference/analysis/tempoCandidates";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "D:/pulse-forge/tests/unsuno/golden-synth";

for (const track of goldenTracks()) {
  const pcm = renderGoldenTrack(track);
  const env = computeOnsetEnvelopes(pcm, GOLDEN_SAMPLE_RATE, 2048, 256);
  const baseline = removeBaseline(env.combined, Math.round(env.frameRate)); // ~1 s baseline
  const cands = estimateTempoCandidates(baseline, env.frameRate, 60, 200, 6);
  console.log(
    track.id,
    `truth ${track.bpm}`,
    `top3: ${cands.slice(0, 3).map((c) => `${c.bpm.toFixed(1)}(${c.score.toFixed(2)})`).join(" ")}`,
  );
}
