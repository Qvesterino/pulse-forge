import { transcribeTrack } from "../src/reference/transcribe";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const BAR_SEC = 240 / 126;
const track = goldenTracks()[0];
const pcm = renderGoldenTrack(track);
const sections = [0, 1, 2, 3].map((i) => ({ role: `sec${i}`, startSec: i * 4 * BAR_SEC, endSec: (i + 1) * 4 * BAR_SEC }));
const t = transcribeTrack(pcm, GOLDEN_SAMPLE_RATE, { sections });
for (const entry of t.drums.sections ?? []) {
  console.log(entry.role, `kick[${entry.kick}]`, `snare[${entry.snare}]`, `hat[${entry.hat}]`);
}
console.log("track", `kick[${t.drums.kick}]`);
