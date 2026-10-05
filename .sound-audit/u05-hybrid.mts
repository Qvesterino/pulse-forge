import { detectChordSpans } from "../src/reference/analysis/chords";
import { expandChordSpans, chordBarAccuracy } from "../src/reference/unsuno-metrics";
import { estimateTempo } from "../src/ai/audio-tempo-key";
import { goldenTracks, drumsOnlyTrack, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const PC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
for (const track of [...goldenTracks(), drumsOnlyTrack()]) {
  const pcm = renderGoldenTrack(track);
  const tempo = estimateTempo(pcm, GOLDEN_SAMPLE_RATE);
  const det = tempo ? detectChordSpans(pcm, GOLDEN_SAMPLE_RATE, { bpm: tempo.bpm }) : null;
  if (!det) { console.log(track.id, "NO DETECTION"); continue; }
  const acc = chordBarAccuracy(expandChordSpans(det.spans), track.chords);
  console.log(
    track.id.padEnd(15),
    `spans[${det.spans.map((s) => `${PC[s.rootPc]}${s.quality}@${s.startBar}x${s.bars}(${s.confidence.toFixed(2)})`).join(", ")}]`,
    `exact ${acc.exactCorrect}/${acc.total} root ${acc.rootCorrect}/${acc.total}`,
  );
}
