import { renderGoldenTrack, GOLDEN_SAMPLE_RATE, stepToSample } from "../tests/unsuno/golden-synth";
import { trackPitch } from "../src/audio-workers/pitch-tracker";
import { applyLowPass } from "../src/reference/analysis/bass";

const boom = JSON.parse(JSON.stringify({ bpm: 90 }));
const pcm = renderGoldenTrack({
  id: "x", bpm: 90, bars: 1, key: { tonicPc: 0, mode: "minor" },
  drums: { kick: [Array.from({length:16},(_,i)=>i%4===0?1:0)], snare: [Array.from({length:16},()=>0)], hat: [Array.from({length:16},()=>0)] },
  bass: [{ step: 0, pitch: 36, durationSteps: 4 }, { step: 6, pitch: 43, durationSteps: 2 }, { step: 12, pitch: 46, durationSteps: 4 }],
  chords: [{ bar: 0, rootPc: 0, quality: "min7" as const }],
});
const samples = Math.min(pcm.length, stepToSample(16, 90, GOLDEN_SAMPLE_RATE));
const iso = applyLowPass(pcm.subarray(0, samples), GOLDEN_SAMPLE_RATE, 300);
const small = new Float32Array(Math.floor(samples / 8));
for (let i = 0; i < small.length; i++) small[i] = iso[i * 8];
const frames = trackPitch(small, GOLDEN_SAMPLE_RATE / 8, { fminHz: 40, fmaxHz: 250, hopMs: 20 });
console.log("frame count", frames.length);
for (const f of frames.slice(0, 40)) {
  console.log(`${f.timeSec.toFixed(2)}s midi ${f.midi.toFixed(1)} clarity ${f.clarity.toFixed(2)} rms ${f.rms.toFixed(3)}`);
}
void boom;
