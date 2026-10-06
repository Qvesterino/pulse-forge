import { detectChordSpans } from "../src/reference/analysis/chords";
import { chordBarAccuracy, expandChordSpans } from "../src/reference/unsuno-metrics";
import { estimateTempo } from "../src/ai/audio-tempo-key";
import { separateHPSS, } from "../src/analysis/hpss";
import { applyLowPass } from "../src/reference/analysis/bass";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

for (const track of [goldenTracks()[2], goldenTracks()[4], goldenTracks()[0]]) {
  const pcm = renderGoldenTrack(track);
  const tempo = estimateTempo(pcm, GOLDEN_SAMPLE_RATE)!;
  const stems = separateHPSS(pcm, GOLDEN_SAMPLE_RATE)!;
  const harmHP = (() => { const lp = applyLowPass(stems.harmonic, GOLDEN_SAMPLE_RATE, 130); const out = new Float32Array(stems.harmonic.length); for (let i = 0; i < out.length; i++) out[i] = stems.harmonic[i] - lp[i]; return out; })();
  for (const [name, src] of [["harm", stems.harmonic], ["harmHP130", harmHP]] as const) {
    const det = detectChordSpans(src, GOLDEN_SAMPLE_RATE, { bpm: tempo.bpm })!;
    const acc = chordBarAccuracy(expandChordSpans(det.spans), track.chords);
    console.log(track.id.padEnd(15), name.padEnd(9), `exact ${acc.exactCorrect}/${acc.total}`);
  }
}
