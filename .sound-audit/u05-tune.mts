import { goldenTracks, drumsOnlyTrack, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";
import { estimateTempo } from "../src/ai/audio-tempo-key";

// replicate goertzelChroma + scoring to print share/margin per bar for gate tuning
const PC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const TEMPLATES: Record<string, number[]> = { maj:[0,4,7], min:[0,3,7], dom7:[0,4,7,10], min7:[0,3,7,10], maj7:[0,4,7,11], sus4:[0,5,7] };
const W = [0.4,1,1,1];

function barChroma(seg: Float32Array, sr: number): Float64Array {
  const c = new Float64Array(12); let mass = 0;
  for (let pc = 0; pc < 12; pc++) {
    let wsum = 0;
    for (let o = 0; o < 4; o++) {
      const f = 65.406 * Math.pow(2, o + pc / 12);
      const k = (2*Math.PI*f)/sr; const coeff = 2*Math.cos(k);
      let s1=0,s2=0;
      for (let i=0;i<seg.length;i++){const s0=seg[i]+coeff*s1-s2;s2=s1;s1=s0;}
      wsum += Math.sqrt(s1*s1+s2*s2-coeff*s1*s2)*W[o];
    }
    c[pc]=wsum; mass+=wsum;
  }
  if (mass>0) for (let pc=0;pc<12;pc++) c[pc]/=mass;
  return c;
}

for (const track of [...goldenTracks(), drumsOnlyTrack()]) {
  const pcm = renderGoldenTrack(track);
  const tempo = estimateTempo(pcm, GOLDEN_SAMPLE_RATE);
  if (!tempo) { console.log(track.id, "no tempo"); continue; }
  const barSamples = Math.round((60/tempo.bpm*4) * GOLDEN_SAMPLE_RATE);
  const bars = Math.floor(pcm.length / barSamples);
  const out: string[] = [];
  for (let bar=0; bar<Math.min(bars, track.chords.length || bars); bar++) {
    const chroma = barChroma(pcm.subarray(bar*barSamples,(bar+1)*barSamples), GOLDEN_SAMPLE_RATE);
    const scored: {r:number;q:string;score:number;share:number}[] = [];
    for (let root=0; root<12; root++)
      for (const [q,iv] of Object.entries(TEMPLATES)) {
        const set = new Set(iv.map(x=>(root+x)%12));
        let share=0, pen=0;
        for (let pc=0;pc<12;pc++){ if(set.has(pc)) share+=chroma[pc]; else pen+=chroma[pc]; }
        scored.push({r:root,q,score:share-0.3*pen,share});
      }
    scored.sort((a,b)=>b.score-a.score || a.q.length-b.q.length);
    const best = scored[0];
    const secondRoot = scored.find(s=>s.r!==best.r)!.score;
    const margin = (best.score-secondRoot)/Math.max(best.score,1e-9);
    const truth = track.chords[bar];
    const ok = truth && best.r===truth.rootPc && best.q===truth.quality ? "OK" : "!!";
    out.push(`b${bar}:${PC[best.r]}${best.q} sh${best.share.toFixed(2)} m${margin.toFixed(2)} ${ok}`);
  }
  console.log(track.id.padEnd(16), out.join("  "));
}
