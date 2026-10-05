import { detectDrumMap } from "../src/reference/analysis/drums";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const track = goldenTracks()[0];
const pcm = renderGoldenTrack(track);
const sr = GOLDEN_SAMPLE_RATE;
for (const [label, from, to] of [["sec0", 0, 4], ["sec2", 8, 12], ["sec2b", 8.13, 12.19], ["full"]] as const) {
  const a = from !== undefined ? Math.floor(from * BAR_SEC_OR(240 / 126) * 0 + from * (240 / 126) * sr) : 0;
  const b = to !== undefined ? Math.floor(to * (240 / 126) * sr) : pcm.length;
  const det = detectDrumMap(pcm.subarray(a, b), sr, { bpm: 126 });
  console.log(label, det ? `kick[${det.bands.kick.steps}] snare[${det.bands.snare.steps}] hat[${det.bands.hat.steps}]` : "null");
}
function BAR_SEC_OR(x: number) { return x; }
