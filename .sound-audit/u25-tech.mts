import { detectBassNotes } from "../src/reference/analysis/bass";
import { estimateTempo } from "../src/ai/audio-tempo-key";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const techno = goldenTracks()[1];
const pcm = renderGoldenTrack(techno);
const tempo = estimateTempo(pcm, GOLDEN_SAMPLE_RATE)!;
const det = detectBassNotes(pcm, GOLDEN_SAMPLE_RATE, {
  bpm: tempo.bpm,
  chordContext: { barRoots: techno.chords.map((c) => c.rootPc), barSec: 240 / tempo.bpm },
})!;
console.log("tempo", tempo.bpm, "notes", det.notes.length);
for (const n of det.notes.slice(0, 10)) console.log(`${n.startSec.toFixed(2)}s +${n.durationSec.toFixed(2)}s m${n.midi} c${n.confidence.toFixed(2)}`);
