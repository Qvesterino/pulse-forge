import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR = [6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return Math.sqrt(da * db) > 0 ? num / Math.sqrt(da * db) : 0;
}

function chroma(pcm: Float32Array, sr: number): number[] {
  const c = new Array(12).fill(0);
  for (let pc = 0; pc < 12; pc++)
    for (let oct = 0; oct < 4; oct++) {
      const f = 65.406 * Math.pow(2, oct + pc / 12);
      const k = (2 * Math.PI * f) / sr;
      const coeff = 2 * Math.cos(k);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < pcm.length; i++) {
        const s0 = pcm[i] + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      c[pc] += Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
    }
  return c;
}

function top3(c: number[]): string[] {
  const scored: { k: string; r: number }[] = [];
  for (let rot = 0; rot < 12; rot++) {
    const rotated = c.map((_, i) => c[(i + rot) % 12]);
    scored.push({ k: `${NOTE_NAMES[rot]} maj`, r: pearson(rotated, MAJOR) });
    scored.push({ k: `${NOTE_NAMES[rot]} min`, r: pearson(rotated, MINOR) });
  }
  return scored.sort((a, b) => b.r - a.r).slice(0, 3).map((s) => `${s.k} ${s.r.toFixed(3)}`);
}

for (const track of goldenTracks()) {
  const pcm = renderGoldenTrack(track);
  const six = Math.min(pcm.length, 6 * GOLDEN_SAMPLE_RATE);
  const cHead = chroma(pcm.subarray(0, six), GOLDEN_SAMPLE_RATE);
  const cAll = chroma(pcm, GOLDEN_SAMPLE_RATE);
  const maxH = Math.max(...cHead);
  console.log(track.id, `truth ${NOTE_NAMES[track.key.tonicPc]} ${track.key.mode}`);
  console.log(`  head6s chroma: ${cHead.map((v) => (v / maxH).toFixed(2)).join(" ")}`);
  console.log(`  head top3: ${top3(cHead).join(" | ")}`);
  console.log(`  full top3: ${top3(cAll).join(" | ")}`);
}
