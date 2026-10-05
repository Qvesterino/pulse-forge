import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE, stepToSample } from "../tests/unsuno/golden-synth";
const PC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const boom = goldenTracks()[2];
const pcm = renderGoldenTrack(boom);
const bs = stepToSample(16, boom.bpm, GOLDEN_SAMPLE_RATE);
// raw oct0 goertzel per bar
for (const bar of [0,1,2,3]) {
  const seg = pcm.subarray(bar*bs,(bar+1)*bs);
  const bass = new Array(12).fill(0);
  for (let pc=0;pc<12;pc++){
    const f = 65.406*Math.pow(2, pc/12);
    const k=(2*Math.PI*f)/GOLDEN_SAMPLE_RATE;const co=2*Math.cos(k);
    let s1=0,s2=0;
    for(let i=0;i<seg.length;i++){const s0=seg[i]+co*s1-s2;s2=s1;s1=s0;}
    bass[pc]=Math.sqrt(s1*s1+s2*s2-co*s1*s2);
  }
  const sum = bass.reduce((a,b)=>a+b,0);
  const top = bass.map((v,i)=>({i,share:v/sum})).sort((a,b)=>b.share-a.share).slice(0,4);
  console.log(`boom b${bar} truth ${PC[boom.chords[bar].rootPc]}: oct0 top ${top.map(t=>`${PC[t.i]}:${t.share.toFixed(2)}`).join(" ")}`);
}
