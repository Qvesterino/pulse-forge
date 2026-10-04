import { computeOnsetEnvelopes, removeBaseline } from "../src/reference/dsp/spectralFlux";
import { estimateTempoCandidates } from "../src/reference/analysis/tempoCandidates";
import { estimateKey, estimateTempo } from "../src/ai/audio-tempo-key";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

for (const track of goldenTracks()) {
  const pcm = renderGoldenTrack(track);
  const env = computeOnsetEnvelopes(pcm, GOLDEN_SAMPLE_RATE, 2048, 256);
  const baseline = removeBaseline(env.combined, Math.max(8, Math.round(env.frameRate)));
  const cands = estimateTempoCandidates(baseline, env.frameRate, 60, 200, 6);
  let folded = cands[0]?.bpm ?? 0;
  while (folded > 0 && folded < 70) folded *= 2;
  while (folded > 180) folded /= 2;
  const key = estimateKey(pcm, GOLDEN_SAMPLE_RATE);
  const old = estimateTempo(pcm, GOLDEN_SAMPLE_RATE);
  console.log(
    track.id,
    `NEW tempo ${folded.toFixed(1)} (${cands[0]?.score.toFixed(2)}) vs OLD ${old?.bpm ?? "null"}`,
    `| key ${key?.key ?? "null"}`,
  );
}
