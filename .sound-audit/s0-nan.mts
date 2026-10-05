import { separateHPSS } from "../src/analysis/hpss";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const pcm = renderGoldenTrack(goldenTracks()[0]);
const stems = separateHPSS(pcm, GOLDEN_SAMPLE_RATE)!;
for (const [name, stem] of [["perc", stems.percussive], ["harm", stems.harmonic], ["bass", stems.bass]] as const) {
  let first = -1;
  let count = 0;
  for (let i = 0; i < stem.length; i++) {
    if (!Number.isFinite(stem[i])) {
      if (first < 0) first = i;
      count++;
    }
  }
  console.log(name, "NaN count", count, "first at", first, "=", stem[first]);
}
