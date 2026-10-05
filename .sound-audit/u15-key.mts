import { detectChordSpans, deriveKeyFromChords } from "../src/reference/analysis/chords";
import { estimateTempo } from "../src/ai/audio-tempo-key";
import { goldenTracks, drumsOnlyTrack, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
for (const track of [...goldenTracks(), drumsOnlyTrack()]) {
  const pcm = renderGoldenTrack(track);
  const tempo = estimateTempo(pcm, GOLDEN_SAMPLE_RATE);
  const det = tempo ? detectChordSpans(pcm, GOLDEN_SAMPLE_RATE, { bpm: tempo.bpm }) : null;
  const derived = det ? deriveKeyFromChords(det.spans, det.barsAnalyzed) : null;
  const got = derived ? `${NOTE_NAMES[derived.tonicPc]} ${derived.mode} (${derived.confidence.toFixed(2)})` : "null";
  const want = `${NOTE_NAMES[track.key.tonicPc]} ${track.key.mode}`;
  console.log(track.id.padEnd(15), `derived ${got.padEnd(28)} truth ${want} ${derived && derived.tonicPc === track.key.tonicPc && derived.mode === track.key.mode ? "OK" : "MISS"}`);
}
