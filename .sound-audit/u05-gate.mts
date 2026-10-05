import { drumsOnlyTrack, goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE, stepToSample } from "../tests/unsuno/golden-synth";

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
function bestCorr(c: Float64Array): {corr:number;margin:number} {
  const scored: {r:number;corr:number}[] = [];
  for (let r=0;r<12;r++){
    const rot = c.map((_,i)=>c[(i+r)%12]);
    scored.push({r,corr:Math.max(pearson(rot,MAJOR),pearson(rot,MINOR))});
  }
  scored.sort((a,b)=>b.corr-a.corr);
  const rival = scored.find(s=>s.r!==scored[0].r)!;
  return {corr:scored[0].corr, margin:(scored[0].corr-rival.corr)/scored[0].corr};
}

const t = drumsOnlyTrack();
const pcm = renderGoldenTrack(t);
const bs = stepToSample(16, t.bpm, GOLDEN_SAMPLE_RATE);
for (let bar=0; bar<4; bar++) {
  const {corr, margin} = bestCorr(barChroma(pcm.subarray(bar*bs,(bar+1)*bs), GOLDEN_SAMPLE_RATE));
  console.log(`drums-only b${bar}: corr ${corr.toFixed(3)} margin ${margin.toFixed(3)}`);
}
// silence bar
const sil = new Float32Array(bs);
const {corr: sc, margin: sm} = bestCorr(barChroma(sil, GOLDEN_SAMPLE_RATE));
console.log(`silence: corr ${sc.toFixed(3)} margin ${sm.toFixed(3)}`);
// sanity: house b0 correlation
const h = goldenTracks()[0];
const hpcm = renderGoldenTrack(h);
const hbs = stepToSample(16, h.bpm, GOLDEN_SAMPLE_RATE);
const {corr: hc, margin: hm} = bestCorr(barChroma(hpcm.subarray(0,hbs), GOLDEN_SAMPLE_RATE));
console.log(`house b0: corr ${hc.toFixed(3)} margin ${hm.toFixed(3)}`);
