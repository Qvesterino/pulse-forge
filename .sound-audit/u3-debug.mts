import { renderGoldenTrack, goldenTracks } from "../tests/unsuno/golden-synth";
import { detectDrumMap } from "../src/reference/analysis/drums";

const SR = 44100;

for (const track of goldenTracks()) {
  const pcm = renderGoldenTrack(track);
  const detection = detectDrumMap(pcm, SR, { bpm: track.bpm });
  if (!detection) {
    console.log(`${track.id}: null`);
    continue;
  }
  const truth = (name: "kick" | "snare" | "hat") => {
    const set = new Set<number>();
    for (let bar = 0; bar < track.bars; bar++) {
      for (let slot = 0; slot < 16; slot++) if ((track.drums[name][bar]?.[slot] ?? 0) > 0) set.add(slot);
    }
    return [...set].sort((a, b) => a - b);
  };
  console.log(`\n${track.id} bpm=${track.bpm} detBpm=${detection.bpm} bars=${detection.bars}`);
  for (const band of ["kick", "snare", "hat"] as const) {
    const det = detection.bands[band];
    console.log(`  ${band}: det[${det.steps.join(",")}] truth[${truth(band).join(",")}] cover=${det.coverage}`);
  }
  if (detection.warnings.length) console.log(`  warn: ${detection.warnings.join("; ")}`);
}