import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE, stepToSample } from "../tests/unsuno/golden-synth";

const PC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR = [6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const W = [0.2,1,1,1];
function pearson(a: number[], b: number[]): number {
  const n = a.length; const ma = a.reduce((s,v)=>s+v,0)/n; const mb = b.reduce((s,v)=>s+v,0)/n;
  let num=0,da=0,db=0;
  for (let i=0;i<n;i++){num+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}
  return Math.sqrt(da*db)>0?num/Math.sqrt(da*db):0;
}
function barChroma(seg: Float32Array, sr: number): Float64Array {
  const c = new Float64Array(12); let mass=0;
  for (let pc=0;pc<12;pc++){let ws=0;
    for (let o=0;o<4;o++){const f=65.406*Math.pow(2,o+pc/12);const k=(2*Math.PI*f)/sr;const co=2*Math.cos(k);let s1=0,s2=0;
      for(let i=0;i<seg.length;i++){const s0=seg[i]+co*s1-s2;s2=s1;s1=s0;}
      ws+=Math.sqrt(s1*s1+s2*s2-co*s1*s2)*W[o];}
    c[pc]=ws;mass+=ws;}
  if (mass>0) for(let pc=0;pc<12;pc++)c[pc]/=mass;
  return c;
}

for (const track of [goldenTracks()[2], goldenTracks()[3], goldenTracks()[4]]) {
  const pcm = renderGoldenTrack(track);
  const barSamples = stepToSample(16, track.bpm, GOLDEN_SAMPLE_RATE);
  const bars = Math.min(Math.floor(pcm.length/barSamples), track.bars);
  console.log(`== ${track.id} (truth bpm ${track.bpm})`);
  for (let bar=0; bar<bars; bar++) {
    const c = barChroma(pcm.subarray(bar*barSamples,(bar+1)*barSamples), GOLDEN_SAMPLE_RATE);
    const scored: {r:number;corr:number;mode:string}[] = [];
    for (let r=0;r<12;r++){
      const rot = c.map((_,i)=>c[(i+r)%12]);
      const pm = pearson(rot,MAJOR), pn = pearson(rot,MINOR);
      scored.push({r,corr:Math.max(pm,pn),mode:pm>pn?"maj":"min"});
    }
    scored.sort((a,b)=>b.corr-a.corr);
    const best=scored[0]; const rival=scored.find(s=>s.r!==best.r)!;
    const margin=(best.corr-rival.corr)/Math.max(best.corr,1e-9);
    const t = track.chords[bar];
    const r = best.r;
    const triad = [c[r], c[(r+(t.quality.startsWith("min")?3:4))%12], c[(r+7)%12]];
    const weakest = Math.min(...triad);
    console.log(
      ` b${bar} truth ${PC[t.rootPc]}${t.quality} → ${PC[best.r]}${best.mode} corr${best.corr.toFixed(3)} margin${margin.toFixed(3)}`,
      `| m3 ${c[(r+3)%12].toFixed(2)} M3 ${c[(r+4)%12].toFixed(2)} 5th ${c[(r+7)%12].toFixed(2)} b7 ${c[(r+10)%12].toFixed(2)} M7 ${c[(r+11)%12].toFixed(2)} weakest ${weakest.toFixed(2)}`
    );
  }
}
