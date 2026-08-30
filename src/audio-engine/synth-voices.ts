// Shared drum synth voice helpers — single source for DrumSynth (pads) and 808 core
// Future: add Worklet/SVF variants here, keep AudioEngine.triggerSynth + registry 808 in sync
export interface DrumSynthParams {
  decay: number; // 0.02..1.5
  tone: number; // 200..12000
  snap: number; // 0..1 attack/click/sizzle
  body: number; // 0..1 sub/fat
}

export function hatVoiceParams(p: DrumSynthParams, isOpen: boolean, lengthMul: number) {
  const baseDecay = p.decay * lengthMul;
  // decay respects user value; open default already longer via allowed def
  const decay = baseDecay;
  // snap adds sizzle (HP freq bump), body slightly darkens
  const hpFreq = Math.max(1000, Math.min(12000, p.tone * (1 + p.snap * 0.35) - p.body * 600));
  // extra shimmer for open hats when snap high
  const shimmer = isOpen && p.snap > 0.5;
  return { decay, hpFreq, shimmer };
}

export function kickVoiceParams(p: DrumSynthParams, pitchOffset: number, lengthMul: number) {
  const baseDecay = p.decay * lengthMul;
  const startHz = 150 * Math.pow(2, pitchOffset / 12) * (1 + p.body * 0.15);
  const endHz = 45 * Math.pow(2, pitchOffset / 12);
  const clickLevel = 0.2 + (p.tone / 12000) * 0.3 + p.snap * 0.28;
  const clickDur = 0.008 + p.snap * 0.014;
  const pitchDropTime = Math.min(0.09, baseDecay * (0.35 + p.body * 0.15));
  return { baseDecay, startHz, endHz, clickLevel, clickDur, pitchDropTime };
}

export function snareVoiceParams(p: DrumSynthParams, pitchOffset: number, lengthMul: number) {
  const baseDecay = p.decay * lengthMul;
  const toneHz = 192 * Math.pow(2, pitchOffset / 12) * (1 + p.body * 0.08);
  const bpFreq = Math.max(500, Math.min(8000, p.tone));
  const q = 0.9 + p.snap * 0.7;
  const bodyGain = 0.62 + p.body * 0.28;
  const snapGain = 0.55 + p.snap * 0.35;
  const noiseDecay = baseDecay * (0.6 + p.snap * 0.5);
  const triDecay = 0.11 * lengthMul * (0.8 + p.body * 0.4);
  return { baseDecay, toneHz, bpFreq, q, bodyGain, snapGain, noiseDecay, triDecay };
}

export function percVoiceParams(p: DrumSynthParams) {
  const freq = Math.max(500, Math.min(8000, p.tone));
  const q = 2.5 + p.snap * 3;
  const decay = 0.04 + p.body * 0.04;
  return { freq, q, decay };
}
