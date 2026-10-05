import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE, stepToSample } from "../tests/unsuno/golden-synth";
const PC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR = [6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
function pearson(a: number[], b: number[]): number {
  const n = a.length; const ma = a.reduce((s,v)=>s+v,0)/n; const mb = b.reduce((s,v)=>s+v,0)/n;
  let num=0,da=0,db=0;
  for (let i=0;i<n;i++){num+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}
  return Math.sqrt(da*db)>0?num/Math.sqrt(da*db):0;
}
const boom = goldenTracks()[2];
const pcm = renderGoldenTrack(boom);
const bs = stepToSample(16, boom.bpm, GOLDEN_SAMPLE_RATE);
const bar = 1;
const seg = pcm.subarray(bar*bs,(bar+1)*bs);
const root = new Array(12).fill(0); const bass = new Array(12).fill(0);
for (let pc=0;pc<12;pc++) for (let o=0;o<4;o++){
  const f=65.406*Math.pow(2,o+pc/12);const k=(2*Math.PI*f)/GOLDEN_SAMPLE_RATE;const co=2*Math.cos(k);
  let s1=0,s2=0;
  for(let i=0;i<seg.length;i++){const s0=seg[i]+co*s1-s2;s2=s1;s1=s0;}
  const m=Math.sqrt(s1*s1+s2*s2-co*s1*s2);
  root[pc]+=m; if(o===0) bass[pc]=m;
}
const rSum = root.reduce((a,b)=>a+b,0); const bSum = bass.reduce((a,b)=>a+b,0);
const rn = root.map(v=>v/rSum); const bn = bass.map(v=>v/bSum);
const scored: {r:number;corr:number;score:number}[] = [];
for (let r=0;r<12;r++){
  const rot = rn.map((_,i)=>rn[(i+r)%12]);
  const corr = Math.max(pearson(rot,MAJOR),pearson(rot,MINOR));
  scored.push({r,corr,score:corr*(1+0.06*bn[r])});
}
scored.sort((a,b)=>b.score-a.score);
console.log("b1 (truth Fm7) top4:", scored.slice(0,4).map(s=>`${PC[s.r]} corr${s.corr.toFixed(3)} bass${bn[s.r].toFixed(2)} score${s.score.toFixed(4)}`).join(" | "));
