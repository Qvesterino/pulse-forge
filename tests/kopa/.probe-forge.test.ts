import { describe, expect, it } from "vitest";

const SR = 48000;
function synthKick(click: boolean): Float32Array {
  const startHz = 130, settledHz = 50, pitchTimeSec = 0.04, decaySec = 0.4;
  const n = Math.ceil(1.2 * SR);
  const pcm = new Float32Array(n);
  let phase = 0;
  let lcg = 42;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const k = t < pitchTimeSec ? Math.pow(t / pitchTimeSec, 0.4) : 1;
    const hz = startHz * Math.pow(settledHz / startHz, k);
    const decay = Math.exp(-t / decaySec);
    phase += hz / SR;
    let v = Math.sin(2 * Math.PI * phase) * decay * 0.85;
    if (click) {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      const noise = (lcg / 0x80000000 - 1) * 2;
      v += noise * Math.exp(-t / 0.004) * 0.9;
      v += Math.sin(2 * Math.PI * 2500 * t) * Math.exp(-t / 0.004) * 0.45;
    }
    pcm[i] = Math.max(-1, Math.min(1, v));
  }
  return pcm;
}

describe("forge probe", () => {
  it("prints high-band windows", () => {
    for (const click of [false, true]) {
      const pcm = synthKick(click);
      let peak = 0;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      const onsetThreshold = peak * 0.25;
      let onset = 0;
      while (Math.abs(pcm[onset]!) < onsetThreshold) onset += 1;
      let hpState = 0;
      const hpCoef = Math.exp((-2 * Math.PI * 1000) / SR);
      const highAt = (i: number) => {
        hpState += (1 - hpCoef) * (pcm[i]! - hpState);
        return pcm[i]! - hpState;
      };
      const win = (from: number, to: number) => {
        let sumSq = 0;
        for (let i = from; i < to; i++) sumSq += highAt(i) * highAt(i);
        return Math.sqrt(sumSq / (to - from));
      };
      console.log(
        `click=${click} onset=${onset} clickWin=${win(onset, onset + 240).toFixed(3)} bodyWin=${win(onset + 960, onset + 2880).toFixed(3)}`,
      );
    }
    expect(true).toBe(true);
  });
});
