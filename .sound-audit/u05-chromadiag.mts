import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE, stepToSample } from "../tests/unsuno/golden-synth";

const PC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR = [6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function chromaOct(segment: Float32Array, sr: number): number[][] {
  // 12 pc × 4 octaves individually
  const grid: number[][] = [];
  for (let pc = 0; pc < 12; pc++) {
    const row: number[] = [];
    for (let oct = 0; oct < 4; oct++) {
      const f = 65.406 * Math.pow(2, oct + pc / 12);
      const k = (2 * Math.PI * f) / sr;
      const coeff = 2 * Math.cos(k);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < segment.length; i++) {
        const s0 = segment[i] + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      row.push(Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2));
    }
    grid.push(row);
  }
  return grid;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length; const ma = a.reduce((s,v)=>s+v,0)/n; const mb = b.reduce((s,v)=>s+v,0)/n;
  let num=0,da=0,db=0;
  for (let i=0;i<n;i++){num+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}
  return Math.sqrt(da*db)>0?num/Math.sqrt(da*db):0;
}

const house = goldenTracks()[0];
const pcm = renderGoldenTrack(house);
const barSamples = stepToSample(16, house.bpm, GOLDEN_SAMPLE_RATE);
for (const bar of [0, 2]) {
  const grid = chromaOct(pcm.subarray(bar*barSamples, (bar+1)*barSamples), GOLDEN_SAMPLE_RATE);
  const octSum = [0,0,0,0];
  for (const row of grid) row.forEach((v,i)=>octSum[i]+=v);
  const total = octSum.reduce((s,v)=>s+v,0);
  console.log(`house bar ${bar} truth ${PC[house.chords[bar].rootPc]}: octave share [${octSum.map(v=>(v/total).toFixed(2)).join(", ")}]`);
  for (const weights of [[1,1,1,1],[0.4,1,1,1],[0.25,1,1,1]]) {
    const chroma = grid.map(row => row.reduce((s,v,i)=>s+v*weights[i],0));
    const sum = chroma.reduce((s,v)=>s+v,0);
    const norm = chroma.map(v=>v/sum);
    const scored = [];
    for (let rot=0;rot<12;rot++){
      const rotated = norm.map((_,i)=>norm[(i+rot)%12]);
      scored.push({k:`${PC[rot]}min`,r:pearson(rotated,MINOR)});
      scored.push({k:`${PC[rot]}maj`,r:pearson(rotated,MAJOR)});
    }
    const top = scored.sort((a,b)=>b.r-a.r).slice(0,2).map(s=>`${s.k} ${s.r.toFixed(3)}`);
    const truthRoot = house.chords[bar].rootPc;
    console.log(`  w[${weights}] top2: ${top.join(" | ")}`);
  }
}
