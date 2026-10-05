import { detectBassNotes } from "../src/reference/analysis/bass";
import { bassNoteMetrics } from "../src/reference/unsuno-metrics";
import { estimateTempo } from "../src/ai/audio-tempo-key";
import { goldenTracks, drumsOnlyTrack, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

for (const track of [...goldenTracks(), drumsOnlyTrack()]) {
  const pcm = renderGoldenTrack(track);
  const tempo = estimateTempo(pcm, GOLDEN_SAMPLE_RATE);
  const det = tempo ? detectBassNotes(pcm, GOLDEN_SAMPLE_RATE, { bpm: tempo.bpm, chordContext: { barRoots: track.chords.map((c) => c.rootPc), barSec: 240 / tempo.bpm } }) : null;
  if (!det) { console.log(track.id.padEnd(15), "NO DETECTION"); continue; }
  if (det.notes.length === 0) { console.log(track.id.padEnd(15), "empty (honest)"); continue; }
  const stepSec = 60 / track.bpm / 4;
  // truth notes in seconds
  const truth = track.bass.map((n) => ({
    startSec: (n.step * stepSec),
    midi: n.pitch,
  }));
  const m = bassNoteMetrics(det.notes.map((n) => ({ startSec: n.startSec, midi: n.midi })), truth, stepSec * 0.6);
  console.log(
    track.id.padEnd(15),
    `notes ${det.notes.length} (truth ${truth.length})`,
    `recall ${m.onset.recall.toFixed(2)} prec ${m.onset.precision.toFixed(2)}`,
    `pitch ${(m.pitchAccuracy * 100).toFixed(0)}% pc ${(m.pitchClassAccuracy * 100).toFixed(0)}%`,
    `cov ${det.coverage.toFixed(2)}`,
  );
  if (m.onset.recall < 0.7 || m.pitchAccuracy < 0.9) {
    const detSorted = [...det.notes].sort((a, b) => a.startSec - b.startSec).slice(0, 8);
    console.log("   first detected:", detSorted.map((n) => `${n.startSec.toFixed(2)}s m${n.midi}(${(n.confidence).toFixed(2)})`).join(" "));
    console.log("   first truth:  ", truth.slice(0, 8).map((n) => `${n.startSec.toFixed(2)}s m${n.midi}`).join(" "));
  }
}
