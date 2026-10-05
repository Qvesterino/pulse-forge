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
function chromas(seg: Float32Array, sr: number): {root: number[]; qual: number[]} {
  const root = new Array(12).fill(0), qual = new Array(12).fill(0);
  for (let pc=0;pc<12;pc++) for (let o=0;o<4;o++) {
    const f=65.406*Math.pow(2,o+pc/12);const k=(2*Math.PI*f)/sr;const co=2*Math.cos(k);
    let s1=0,s2=0;
    for(let i=0;i<seg.length;i++){const s0=seg[i]+co*s1-s2;s2=s1;s1=s0;}
    const m=Math.sqrt(s1*s1+s2*s2-co*s1*s2);
    root[pc]+=m; if(o>0) qual[pc]+=m;
  }
  const rm=Math.max(...root), qm=Math.max(...qual);
  return {root: root.map(v=>v/rm), qual: qual.map(v=>v/(qm||1))};
}
function rootVerdict(root: number[]): {r:number;corr:number;fCorr:number} {
  const scored: {r:number;corr:number}[] = [];
  for (let r=0;r<12;r++){
    const rot = root.map((_,i)=>root[(i+r)%12]);
    scored.push({r,corr:Math.max(pearson(rot,MAJOR),pearson(rot,MINOR))});
  }
  scored.sort((a,b)=>b.corr-a.corr);
  const truth = scored.find; // noop
  return {r:scored[0].r, corr:scored[0].corr, fCorr: scored.find(s=>s.r!==scored[0].r)!.corr};
}

// boombap bars 1 (Fm7) and dnb bary 0 (Gm, in the 86.9 grid = bars 0+1)
const boom = goldenTracks()[2];
const bpcm = renderGoldenTrack(boom);
const bbs = stepToSample(16, boom.bpm, GOLDEN_SAMPLE_RATE);
for (const bar of [0,1,2,3]) {
  const {root, qual} = chromas(bpcm.subarray(bar*bbs,(bar+1)*bbs), GOLDEN_SAMPLE_RATE);
  const v = rootVerdict(root);
  const t = boom.chords[bar];
  // top-3 root correlations with names
  const all: {r:number;c:number}[] = [];
  for (let r=0;r<12;r++){const rot=root.map((_,i)=>root[(i+r)%12]);all.push({r,c:Math.max(pearson(rot,MAJOR),pearson(rot,MINOR))});}
  all.sort((a,b)=>b.c-a.c);
  console.log(`boom b${bar} truth ${PC[t.rootPc]}${t.quality} → root ${PC[v.r]} corr${v.corr.toFixed(3)}`,
    `top3: ${all.slice(0,3).map(s=>`${PC[s.r]}:${s.c.toFixed(3)}`).join(" ")}`,
    `| qual m3 ${qual[(t.rootPc+3)%12].toFixed(2)} M3 ${qual[(t.rootPc+4)%12].toFixed(2)} b7 ${qual[(t.rootPc+10)%12].toFixed(2)} M7 ${qual[(t.rootPc+11)%12].toFixed(2)}`);
}
const dnb = goldenTracks()[4];
const dpcm = renderGoldenTrack(dnb);
const detBar = Math.round((60/86.9*4)*GOLDEN_SAMPLE_RATE);
for (const bar of [0,1]) {
  const {root, qual} = chromas(dpcm.subarray(bar*detBar,(bar+1)*detBar), GOLDEN_SAMPLE_RATE);
  const v = rootVerdict(root);
  const t = dnb.chords[bar*2];
  const all: {r:number;c:number}[] = [];
  for (let r=0;r<12;r++){const rot=root.map((_,i)=>root[(i+r)%12]);all.push({r,c:Math.max(pearson(rot,MAJOR),pearson(rot,MINOR))});}
  all.sort((a,b)=>b.c-a.c);
  console.log(`dnb detBar${bar} truth ${PC[t.rootPc]}${t.quality} → root ${PC[v.r]} corr${v.corr.toFixed(3)}`,
    `top3: ${all.slice(0,3).map(s=>`${PC[s.r]}:${s.c.toFixed(3)}`).join(" ")}`,
    `| qual m3 ${qual[(t.rootPc+3)%12].toFixed(2)} M3 ${qual[(t.rootPc+4)%12].toFixed(2)} b7 ${qual[(t.rootPc+10)%12].toFixed(2)} M7 ${qual[(t.rootPc+11)%12].toFixed(2)}`);
}
