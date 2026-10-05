import { detectDrumMap } from "../src/reference/analysis/drums";
import { stepF1 } from "../src/reference/unsuno-metrics";
import { estimateTempo } from "../src/ai/audio-tempo-key";
import { goldenTracks, drumsOnlyTrack, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

for (const track of [...goldenTracks(), drumsOnlyTrack()]) {
  const pcm = renderGoldenTrack(track);
  const tempo = estimateTempo(pcm, GOLDEN_SAMPLE_RATE);
  if (!tempo) { console.log(track.id, "no tempo"); continue; }
  const det = detectDrumMap(pcm, GOLDEN_SAMPLE_RATE, { bpm: tempo.bpm });
  if (!det) { console.log(track.id, "null"); continue; }
  const parts: string[] = [];
  for (const band of ["kick", "snare", "hat"] as const) {
    // Pattern-level comparison: the detection folds to one repeated bar, so
    // the truth side is the union of lit slots across all bars.
    const truthSet = new Set<number>();
    for (let bar = 0; bar < track.bars; bar++) {
      for (let s = 0; s < 16; s++) if ((track.drums[band][bar]?.[s] ?? 0) > 0) truthSet.add(s);
    }
    const m = stepF1(det.bands[band].steps, [...truthSet].sort((a, b) => a - b), { tolerance: 0 });
    parts.push(`${band} F1 ${m.f1.toFixed(2)} (p${m.precision.toFixed(2)} r${m.recall.toFixed(2)}) det[${det.bands[band].steps.join(",")}]`);
  }
  console.log(track.id.padEnd(15), parts.join("  "));
}
