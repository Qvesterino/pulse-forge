import { TSAR_PARAM_DEFS } from "./params";

/**
 * TSAR — which parameter axes can be HEARD in a given patch.
 *
 * These rules live in their own module because TWO surfaces need them and
 * both of them sit close to the boot path: the mutation engine (wave 4) and
 * the ORBIT surface (wave 5). When the ORBIT catalogue was imported by the
 * project model's normaliser, the whole mutation module rode into the studio
 * boot path with it — the liveness rules are the only thing ORBIT needs from
 * there, and they are small.
 *
 * The rules are read off the DSP, not off taste:
 *
 *  - a slot with LEVEL 0 is silent — the processor scales the source by
 *    `levelA`/`levelB`, so its parameters reach no ear;
 *  - `srcAMorph`/`srcBMorph` select the WAVETABLE frame; the granular engine
 *    returns before reading them and the sampler's branch ignores them;
 *  - `srcASpread`/`srcBSpread` only detune when UNISON > 1 — with one voice
 *    the spread offset is zero;
 *  - the global `morph` blends A against B, so it needs B to sound at all;
 *  - `lfoRate` reaches the sound only through a mod slot that uses the LFO.
 *
 * A "no" here does not make the parameter wrong — it makes it INVISIBLE to
 * this patch. Moving it would change numbers and no sound.
 */

/** The engine's LFO is mod-matrix source 1 (processor: `mod.src === 1 ? lfo`). */
const LFO_MOD_SOURCE = 1;
/** The wavetable engine (TsarEngine 1) is the only one that reads a morph. */
const ENGINE_WAVETABLE = 1;

/** A parameter's value in a patch, falling back to the parameter's default. */
export function paramValue(base: Record<string, number>, paramId: string): number {
  const raw = base[paramId];
  if (Number.isFinite(raw)) return raw!;
  const def = TSAR_PARAM_DEFS[paramId];
  return def ? def.default : 0;
}

/**
 * Can this axis be HEARD in the current patch?
 *
 * The name is kept for the mutation engine's public path; the rules are the
 * same ones, now shared instead of copied.
 */
export function isMutationAxisLive(axisId: string, base: Record<string, number>): boolean {
  if (axisId.endsWith("Q") || axisId.endsWith("FilterEnv") || axisId.endsWith("Filter")) {
    // An OPEN filter passes everything, so its Q, its type and its envelope
    // amount change no sound. The cutoff is at its maximum when the filter
    // is open — and the maximum IS the default, so this is the common case.
    const slot = axisId.startsWith("srcB") ? "B" : "A";
    const cutoff = paramValue(base, slot === "A" ? "srcACutoff" : "srcBCutoff");
    const max = TSAR_PARAM_DEFS[slot === "A" ? "srcACutoff" : "srcBCutoff"]?.max ?? Number.POSITIVE_INFINITY;
    return cutoff < max - 1e-9;
  }
  if (axisId === "noiseColor") {
    // The noise COLOUR only colours noise that is there.
    return paramValue(base, "noise") > 0;
  }
  if (axisId === "width") {
    // The stereo width works on the SIDE signal, and the side signal is
    // proportional to (panR − panL). A source panned to the centre has no
    // side at all — so with every audible source centred, the width does
    // nothing.
    const audible = (slot: "A" | "B") => paramValue(base, slot === "A" ? "srcALevel" : "srcBLevel") > 0;
    const offCentre = (slot: "A" | "B") => Math.abs(paramValue(base, slot === "A" ? "srcAPan" : "srcBPan")) > 0.001;
    return (audible("A") && offCentre("A")) || (audible("B") && offCentre("B"));
  }
  if (axisId === "glide") {
    // The engine ignores a glide at or below 0.001 (processor: glide > 0.001).
    return paramValue(base, "glide") > 0.001;
  }
  if (axisId === "lfoRate") {
    for (let slotIndex = 1; slotIndex <= 4; slotIndex += 1) {
      if (paramValue(base, `mod${slotIndex}Src`) !== LFO_MOD_SOURCE) continue;
      if (paramValue(base, `mod${slotIndex}Amt`) !== 0) return true;
    }
    return false;
  }
  const slot = axisId.startsWith("srcA") ? "A" : axisId.startsWith("srcB") ? "B" : null;
  if (slot) {
    const level = paramValue(base, slot === "A" ? "srcALevel" : "srcBLevel");
    if (level <= 0) return false;
    const engine = paramValue(base, slot === "A" ? "srcAEngine" : "srcBEngine");
    if (axisId.endsWith("Morph") && engine !== ENGINE_WAVETABLE) return false;
    if (axisId.endsWith("Spread")) {
      const unison = paramValue(base, slot === "A" ? "srcAUnison" : "srcBUnison");
      if (unison <= 1) return false;
    }
    return true;
  }
  if (axisId === "morph") {
    // The A↔B blend needs both sides to sound.
    return paramValue(base, "srcALevel") > 0 && paramValue(base, "srcBLevel") > 0;
  }
  return true;
}
