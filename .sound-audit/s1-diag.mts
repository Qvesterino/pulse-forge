import { transcribeTrack } from "../src/reference/transcribe";
import { bassNoteMetrics, chordBarAccuracy, expandChordSpans, stepF1, keyMatch, tempoFoldError } from "../src/reference/unsuno-metrics";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

for (const track of goldenTracks()) {
  const pcm = renderGoldenTrack(track);
  console.time(track.id);
  const t = transcribeTrack(pcm, GOLDEN_SAMPLE_RATE, { separation: "hpss", sections: [{ role: "fold", startSec: 0, endSec: pcm.length / GOLDEN_SAMPLE_RATE }] });
  const elapsed = Math.round(console.timeEnd(track.id));

  // bass
  const stepSec = 60 / track.bpm / 4;
  const truthBass = track.bass.map((n) => ({ startSec: n.step * stepSec, midi: n.pitch }));
  const bm = bassNoteMetrics(t.bass.notes.map((n) => ({ startSec: n.startSec, midi: n.midi })), truthBass, stepSec * 0.6);
  // chords
  const cm = chordBarAccuracy(expandChordSpans(t.chords.spans), track.chords);
  // drums
  const drumParts: string[] = [];
  for (const band of ["kick", "snare", "hat"] as const) {
    const truth = new Set<number>();
    for (let bar = 0; bar < track.bars; bar++) for (let s = 0; s < 16; s++) if ((track.drums[band][bar]?.[s] ?? 0) > 0) truth.add(s);
    drumParts.push(`${band[0]} ${stepF1(t.drums[band], [...truth].sort((a, b) => a - b), { tolerance: 1 }).f1.toFixed(2)}`);
  }
  const km = keyMatch(t.key?.key ?? null, track.key);
  const te = tempoFoldError(t.tempo?.bpm ?? null, track.bpm);
  console.log(
    track.id.padEnd(15),
    `bass r${bm.onset.recall.toFixed(2)} p${(bm.pitchAccuracy * 100).toFixed(0)}% pc${(bm.pitchClassAccuracy * 100).toFixed(0)}%`,
    `chords ${cm.exactCorrect}/${cm.total}`,
    drumParts.join(" "),
    `key ${km.exact ? "OK" : "MISS"}`,
    `tempo ${t.tempo?.bpm ?? "null"} (${te?.toFixed(1) ?? "-"})`,
    `${elapsed}ms`,
  );
}
