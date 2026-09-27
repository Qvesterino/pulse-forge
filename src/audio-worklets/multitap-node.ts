import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Musical divisions for the multi-tap delay, read as "beats per division":
 * the labels are note values (1/2 note = 2 beats …), so delay seconds =
 * beats × seconds/beat. (Historical note: multiplying a BAR length by these
 * values made every tap 4× too long — the units are beats, not bars.)
 */
const MULTITAP_BAR_MULTS = [2, 4 / 3, 1, 2 / 3, 0.5, 1 / 3, 0.25, 1 / 6];

export const multitapDelaySec = (divisionIndex: number, bpm: number): number => {
  const beats = MULTITAP_BAR_MULTS[Math.max(0, Math.min(MULTITAP_BAR_MULTS.length - 1, divisionIndex))];
  return Math.max(0.02, (60 / (bpm || 124)) * beats);
};

const DIV_PARAM_IDS = ["t1Div", "t2Div", "t3Div", "t4Div"] as const;
const TIME_PARAM_IDS = ["t1Time", "t2Time", "t3Time", "t4Time"] as const;
const DIRECT_PARAM_IDS = new Set(["mix", "feedback", "tone", "spread", "taps"]);
const ALL_DIV_IDS = new Set<string>(DIV_PARAM_IDS);
const ALL_TIME_IDS = new Set<string>(TIME_PARAM_IDS);

/**
 * Create the Multi-Tap delay AudioWorkletNode synchronously.
 *
 * The rack surface speaks musical divisions (t1Div..t4Div + BPM via
 * syncBpm); the processor speaks absolute seconds (t1Time..t4Time). This
 * wrapper owns the mapping so division automation and tempo changes land
 * on the audio thread as one scheduled time write per tap.
 *
 * Processor must be pre-loaded via the core bundle — callers gate behind
 * `isWorkletReady("multiTapDelay", ctx)`.
 */
export function createMultitapNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm: number,
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "multitap-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  // Runtime processor-error containment: the browser silently kills a
  // throwing processor — surface + count it.
  attachProcessorErrorGuard(node, "multitap-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  let currentBpm = Number.isFinite(bpm) && bpm > 0 ? Math.max(20, Math.min(300, bpm)) : 124;
  // Division state lives here — syncBpm must re-derive every tap time from
  // the CURRENT divisions, not the construction snapshot.
  const divisions = DIV_PARAM_IDS.map((id) => Math.round(instance.params[id] ?? defaultDivOf(id)));

  const writeTapTimes = (when?: number) => {
    for (let t = 0; t < 4; t++) {
      safeApplyAudioParam(node, TIME_PARAM_IDS[t], multitapDelaySec(divisions[t], currentBpm), when);
    }
  };
  const writeDivision = (tapIndex: number, rawDivision: number, when?: number) => {
    const idx = Math.max(0, Math.min(MULTITAP_BAR_MULTS.length - 1, Math.round(rawDivision)));
    divisions[tapIndex] = idx;
    safeApplyAudioParam(node, TIME_PARAM_IDS[tapIndex], multitapDelaySec(idx, currentBpm), when);
  };

  const apply = (id: string, value: number, when?: number) => {
    if (DIRECT_PARAM_IDS.has(id)) {
      safeApplyAudioParam(node, id, value, when);
      return;
    }
    const divIndex = DIV_PARAM_IDS.indexOf(id as (typeof DIV_PARAM_IDS)[number]);
    if (divIndex >= 0) writeDivision(divIndex, value, when);
  };

  for (const [id, value] of Object.entries(instance.params)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (ALL_DIV_IDS.has(id) || DIRECT_PARAM_IDS.has(id) || ALL_TIME_IDS.has(id)) apply(id, value);
  }
  writeTapTimes();

  return {
    input,
    output,
    setParameter: (id, v) => apply(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => apply(id, v, when),
    getAudioParam: (paramId) => (DIRECT_PARAM_IDS.has(paramId) ? (node.parameters.get(paramId) ?? null) : null),
    syncBpm(next: number, when?: number) {
      if (!Number.isFinite(next) || next <= 0) return;
      const clamped = Math.max(20, Math.min(300, next));
      if (clamped === currentBpm) return;
      currentBpm = clamped;
      writeTapTimes(when);
    },
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

/** Construction defaults mirror the rack defs (1/8, 1/16, 1/4, 1/2). */
function defaultDivOf(id: string): number {
  switch (id) {
    case "t1Div":
      return 4;
    case "t2Div":
      return 6;
    case "t3Div":
      return 2;
    default:
      return 0;
  }
}
