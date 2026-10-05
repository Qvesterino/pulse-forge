import { separateHPSS } from "../src/analysis/hpss";
import { detectDrumMap } from "../src/reference/analysis/drums";
import { detectChordSpans } from "../src/reference/analysis/chords";
import { detectBassNotes } from "../src/reference/analysis/bass";
import { estimateTempo } from "../src/ai/audio-tempo-key";
import { stepF1, chordBarAccuracy, expandChordSpans, bassNoteMetrics } from "../src/reference/unsuno-metrics";
import { goldenTracks, drumsOnlyTrack, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const SR = GOLDEN_SAMPLE_RATE;
const house = goldenTracks()[0];
const pcm = renderGoldenTrack(house);
const tempo = estimateTempo(pcm, SR)!;
console.time("hpss");
const stems = separateHPSS(pcm, SR)!;
console.timeEnd("hpss");

// energy conservation
const rms = (d: Float32Array) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
console.log("rms full", rms(pcm).toFixed(4), "perc+harmonic", Math.sqrt(rms(stems.percussive) ** 2 + rms(stems.harmonic) ** 2).toFixed(4));

// drums on percussive stem
const drumDet = detectDrumMap(stems.percussive, SR, { bpm: tempo.bpm });
for (const band of ["kick", "snare", "hat"] as const) {
  const truth = new Set<number>();
  for (let bar = 0; bar < house.bars; bar++) for (let s = 0; s < 16; s++) if ((house.drums[band][bar]?.[s] ?? 0) > 0) truth.add(s);
  const m = stepF1(drumDet!.bands[band].steps, [...truth].sort((a, b) => a - b), { tolerance: 1 });
  console.log(`percussive ${band} F1 ${m.f1.toFixed(2)}`);
}

// chords on harmonic stem
const chordDet = detectChordSpans(stems.harmonic, SR, { bpm: tempo.bpm })!;
const chordAcc = chordBarAccuracy(expandChordSpans(chordDet.spans), house.chords);
console.log("harmonic chords exact", `${chordAcc.exactCorrect}/${chordAcc.total}`);

// bass on bass stem
const bassDet = detectBassNotes(stems.bass, SR, { bpm: tempo.bpm, chordContext: { barRoots: house.chords.map((c) => c.rootPc), barSec: 240 / tempo.bpm } });
const stepSec = 60 / 126 / 4;
const truthBass = house.bass.map((n) => ({ startSec: n.step * stepSec, midi: n.pitch }));
const bm = bassNoteMetrics((bassDet?.notes ?? []).map((n) => ({ startSec: n.startSec, midi: n.midi })), truthBass, stepSec * 0.6);
console.log(`bass stem recall ${bm.onset.recall.toFixed(2)} pitch ${(bm.pitchAccuracy * 100).toFixed(0)}% pc ${(bm.pitchClassAccuracy * 100).toFixed(0)}%`);

// silence → null
console.log("silence:", separateHPSS(new Float32Array(SR * 3), SR) === null ? "null ok" : "FAIL");
// drums-only sanity (kick present → percussive)
const bed = renderGoldenTrack(drumsOnlyTrack());
const bedStems = separateHPSS(bed, SR)!;
console.log("drums-only percussive rms", rms(bedStems.percussive).toFixed(4), "harmonic rms", rms(bedStems.harmonic).toFixed(4));
