import { renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";
import { trackPitch } from "../src/audio-workers/pitch-tracker";
import { applyLowPass } from "../src/reference/analysis/bass";

const techno = { bpm: 130, bass: [{ step: 0, pitch: 28, dur: 1 }, { step: 2, pitch: 40, dur: 1 }] };
const pcm = renderGoldenTrack({
  id: "x", bpm: 130, bars: 1, key: { tonicPc: 4, mode: "minor" },
  drums: { kick: [Array.from({length:16},(_,i)=>i%4===0?1:0)], snare: [Array.from({length:16},()=>0)], hat: [Array.from({length:16},()=>0)] },
  bass: [{ step: 0, pitch: 28, durationSteps: 1 }, { step: 2, pitch: 40, durationSteps: 1 }, { step: 4, pitch: 28, durationSteps: 1 }, { step: 6, pitch: 40, durationSteps: 1 }],
  chords: [{ bar: 0, rootPc: 4, quality: "min" as const }],
});
const iso = applyLowPass(pcm.subarray(0, Math.floor(GOLDEN_SAMPLE_RATE * 3)), GOLDEN_SAMPLE_RATE, 300);
const small = new Float32Array(Math.floor(Math.floor(GOLDEN_SAMPLE_RATE * 3) / 8));
for (let i = 0; i < small.length; i++) small[i] = iso[i * 8];
const frames = trackPitch(small, GOLDEN_SAMPLE_RATE / 8, { fminHz: 40, fmaxHz: 250, hopMs: 10 });
for (const f of frames.slice(0, 90)) {
  if (f.timeSec < 0.75) console.log(`${f.timeSec.toFixed(2)} m${f.midi.toFixed(1)} c${f.clarity.toFixed(2)} rms${f.rms.toFixed(3)}`);
}
void techno;
