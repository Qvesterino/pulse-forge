import { TsarProcessor, FRAME_SIZE } from "../../src/tsar/dsp/tsarProcessor";

/**
 * WAVE 4 — THE MUTATION AUDIT HARNESS.
 *
 * The roadmap's criterion is blunt: *"Varianty sú odlišné aj zvukovo; iba
 * odlišné číselné hodnoty nie sú dôkazom kvality."* A variant that differs
 * only in its numbers is not a variation — it is a different patch that
 * sounds the same.
 *
 * So the audit renders patches through the REAL processor (no AudioContext,
 * no worklet host) and measures the difference in the SOUND. The measurement
 * is the in-repo formula from `tests/tsar/engine.test.ts` — the same
 * relative-difference measure the engine test already uses to prove that a
 * DSP parameter changes the sound — generalised to stereo, so a change in
 * the stereo image counts too.
 *
 * The harness exists to be doubted: it has controls. `audibleDistance` of a
 * patch against ITSELF is exactly 0, and the distance of a patch that differs
 * only in a SILENT source's parameters is also exactly 0 — which is the trap
 * the criterion warns about, made measurable.
 */

export const AUDIT_SR = 44100;
export const AUDIT_BLOCK = 128;

/**
 * The engine's own TSAR parameter shape — the same defaults the panel and
 * the factory presets start from.
 */
export function auditParams(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    srcAEngine: 1,
    srcALevel: 0.8,
    srcAPan: 0,
    srcACoarse: 0,
    srcAFine: 0,
    srcARoot: 60,
    srcAMorph: 0,
    srcAScan: 0,
    srcAUnison: 1,
    srcASpread: 0,
    srcAAtk: 0.005,
    srcADec: 0.6,
    srcASus: 0.7,
    srcARel: 0.4,
    srcAFilter: 0,
    srcACutoff: 18000,
    srcAQ: 0.8,
    srcAFilterEnv: 0,
    srcBEngine: 0,
    srcBLevel: 0,
    srcBAtk: 0.005,
    srcBDec: 0.6,
    srcBSus: 0.7,
    srcBRel: 0.4,
    srcBFilter: 0,
    srcBCutoff: 18000,
    srcBQ: 0.8,
    srcBMorph: 0,
    srcBScan: 0,
    srcBUnison: 1,
    srcBSpread: 0,
    morph: 0,
    sub: 0,
    subOct: -1,
    noise: 0,
    noiseColor: 0.5,
    glide: 0,
    velocity: 0.7,
    lfoRate: 2,
    lfoShape: 0,
    lfoSync: 0,
    tone: 0,
    drive: 0,
    width: 0.5,
    level: 0.8,
    ...overrides,
  };
}

/** A wavetable of `frameCount` frames, each with a rising harmonic count. */
export function auditTable(frameCount = 8): { frames: Float32Array; frameCount: number } {
  const flat = new Float32Array(frameCount * FRAME_SIZE);
  for (let f = 0; f < frameCount; f++) {
    const harmonics = 1 + f * 2;
    for (let i = 0; i < FRAME_SIZE; i++) {
      let sample = 0;
      for (let h = 1; h <= harmonics; h++) {
        sample += Math.sin((2 * Math.PI * h * i) / FRAME_SIZE) / h;
      }
      flat[f * FRAME_SIZE + i] = sample * 0.5;
    }
  }
  return { frames: flat, frameCount };
}

export interface AuditRender {
  left: Float32Array;
  right: Float32Array;
}

/**
 * Render one patch through the real TSAR processor.
 *
 * TWO notes are played, and the render is long enough for the ENVELOPE to
 * develop: a patch's decay and release live in the second half of a note, so
 * a short render would call a decay change "inaudible" — the measurement
 * would be blind, not the sound. The first note is released at 0.31 s, the
 * second note starts at 1.2 s, and the render runs to 2.2 s.
 */
export function renderPatch(
  params: Record<string, number>,
  options: { seconds?: number; tableFrames?: number; bTableFrames?: number; notes?: number[] } = {},
): AuditRender {
  const seconds = options.seconds ?? 2.2;
  const notes = options.notes ?? [60, 67];
  const processor = new TsarProcessor({ sampleRate: AUDIT_SR });
  processor.applyParams(params);
  const table = auditTable(options.tableFrames ?? 8);
  processor.setWavetable(0, table.frames, table.frameCount);
  if ((params.srcBLevel ?? 0) > 0) {
    const bTable = auditTable(options.bTableFrames ?? 8);
    processor.setWavetable(1, bTable.frames, bTable.frameCount);
  }
  const frames = Math.ceil(seconds * AUDIT_SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const when = (index: number) => (index === 0 ? 0.01 : 1.2);
  notes.forEach((pitch, index) => {
    processor.postEvent({ type: "noteOn", pitch, velocity: 1, when: when(index) });
    processor.postEvent({ type: "noteOff", pitch, velocity: 1, when: when(index) + 0.3 });
  });
  let frame = 0;
  while (frame < frames) {
    const count = Math.min(AUDIT_BLOCK, frames - frame);
    processor.process(left.subarray(frame, frame + count), right.subarray(frame, frame + count), frame);
    frame += count;
  }
  return { left, right };
}

/** The RMS of one channel. */
export function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

/**
 * The relative difference between two signals — the engine test's formula
 * (`tests/tsar/engine.test.ts`), generalised to both channels.
 *
 * 0 means "the same sound"; 0.05 means the difference carries a twentieth
 * of the base's energy.
 */
export function relativeDifference(a: Float32Array, b: Float32Array, fromSec = 0.1): number {
  const from = Math.floor(fromSec * AUDIT_SR);
  let diff = 0;
  let energy = 0;
  for (let i = from; i < a.length; i++) {
    diff += (a[i]! - b[i]!) ** 2;
    energy += a[i]! * a[i]!;
  }
  return energy > 0 ? Math.sqrt(diff / energy) : 0;
}

/**
 * The audible distance between two renders: the relative difference across
 * the STEREO image, so a change of width counts as well as a change of tone.
 *
 * The window starts at the first note (0.01 s) and NOT later: the ATTACK is
 * part of the sound, and a measurement that skipped it would call an
 * attack-only variant "inaudible" when it is anything but.
 */
export function audibleDistance(base: AuditRender, variant: AuditRender, fromSec = 0.01): number {
  const from = Math.floor(fromSec * AUDIT_SR);
  let diff = 0;
  let energy = 0;
  for (let i = from; i < base.left.length; i++) {
    diff += (base.left[i]! - variant.left[i]!) ** 2 + (base.right[i]! - variant.right[i]!) ** 2;
    energy += base.left[i]! * base.left[i]! + base.right[i]! * base.right[i]!;
  }
  return energy > 0 ? Math.sqrt(diff / energy) : 0;
}
