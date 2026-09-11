import type { ParamDef } from "../effects/types";

/**
 * Main-thread mod matrix — the graph equivalent of the wtvoice worklet's
 * per-sample mod routes, shared by every synthesizer that exposes a filter
 * and/or a per-voice amp node. Same numeric schema as the worklet so saved
 * projects and automation lanes mean the same thing on both paths:
 *
 *   src: 0 = ENV (note envelope, worklet shape: attack → sustain 1 → release)
 *        1 = LFO (unipolar sine 0..1 at modLfoRate, phase 0 at note start)
 *        2 = VEL (note velocity)
 *        3 = PRESS (MPE poly aftertouch, live — 0 until pressure arrives)
 *   dst: 0 = MORPH (wavetable only — routed by the caller via `slots`)
 *        1 = CUTOFF — adds base·src·amt·2 Hz (worklet: base·(1 + modCut))
 *        2 = DETUNE (reserved — not implemented on either path yet)
 *        3 = AMP — serial gain node scaled 1 + src·amt
 *
 * All sources are unipolar 0..1 like the worklet; amounts are −1..+1.
 * A slot with |amount| < 0.001 builds no nodes at all, so instruments whose
 * matrix is untouched render bit-identically to before (live == offline).
 */

export interface ModVoiceHandle {
  /** Serial gain node for the AMP destination — insert before the amp env. */
  ampNode: GainNode | null;
  /** Raw post-amount slot signals (for custom destinations like MORPH). */
  slots: Array<{ sig: GainNode; amt: number } | null>;
  /** MPE pressure — retunes the PRESS source of this voice live. */
  setPressure(value: number, when?: number): void;
  /** Disconnect all mod nodes (call from the voice's onended cleanup). */
  dispose(): void;
}

export interface ModVoiceOpts {
  when: number;
  stopTime: number;
  velocity: number;
  /** Note envelope shape for the ENV source (attack start, release from off). */
  attack: number;
  off: number;
  release: number;
  /** CUTOFF destination: target param and its base (keytracked) Hz value. */
  cutoffParam?: AudioParam;
  cutoffBase?: number;
}

export function scheduleVoiceModMatrix(
  ctx: BaseAudioContext,
  p: Record<string, number>,
  opts: ModVoiceOpts,
): ModVoiceHandle | null {
  const slotDefs: Array<{ src: number; dst: number; amt: number }> = [
    { src: Math.round(p.modASrc ?? 0), dst: Math.round(p.modADst ?? 0), amt: p.modAAmt ?? 0 },
    { src: Math.round(p.modBSrc ?? 0), dst: Math.round(p.modBDst ?? 1), amt: p.modBAmt ?? 0 },
  ];
  if (slotDefs.every((s) => Math.abs(s.amt) < 0.001)) return null;

  const lfoRate = Math.max(0, p.modLfoRate ?? 2);
  const nodes: AudioNode[] = [];
  const started: Array<OscillatorNode | ConstantSourceNode> = [];

  const buildSource = (src: number): GainNode | null => {
    // A gain node used as a control-signal bus; the source feeds its input.
    const bus = ctx.createGain();
    bus.gain.value = 1;
    if (src === 0) {
      // ENV: worklet shape — attack ramp to 1, sustain 1, release tau/3.
      // Scheduled directly on a ConstantSource's offset (a GainNode with no
      // input would output silence, not its gain curve).
      const env = ctx.createConstantSource();
      env.offset.setValueAtTime(0, opts.when);
      env.offset.linearRampToValueAtTime(1, opts.when + Math.max(0.001, opts.attack));
      env.offset.setValueAtTime(1, Math.max(opts.when, opts.off - 0.001));
      env.offset.setTargetAtTime(0, Math.max(opts.when, opts.off), Math.max(0.005, opts.release) / 3);
      env.start(opts.when);
      env.stop(opts.stopTime);
      env.connect(bus);
      nodes.push(env, bus);
      started.push(env);
      return bus;
    }
    if (src === 1) {
      // LFO: unipolar sine — constant 0.5 + osc ±0.5.
      if (lfoRate < 0.05) {
        const dc = ctx.createConstantSource();
        dc.offset.value = 0.5;
        dc.start(opts.when);
        dc.stop(opts.stopTime);
        dc.connect(bus);
        nodes.push(dc, bus);
        started.push(dc);
        return bus;
      }
      const dc = ctx.createConstantSource();
      dc.offset.value = 0.5;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = lfoRate;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      osc.connect(depth).connect(bus);
      dc.connect(bus);
      dc.start(opts.when);
      osc.start(opts.when);
      dc.stop(opts.stopTime);
      osc.stop(opts.stopTime);
      nodes.push(dc, osc, depth, bus);
      started.push(dc, osc);
      return bus;
    }
    if (src === 2) {
      const dc = ctx.createConstantSource();
      dc.offset.value = Math.max(0, Math.min(1, opts.velocity));
      dc.start(opts.when);
      dc.stop(opts.stopTime);
      dc.connect(bus);
      nodes.push(dc, bus);
      started.push(dc);
      return bus;
    }
    if (src === 3) {
      // PRESS: live source — 0 until polyPressure retunes the offset.
      const dc = ctx.createConstantSource();
      dc.offset.value = 0;
      dc.start(opts.when);
      dc.stop(opts.stopTime);
      dc.connect(bus);
      nodes.push(dc, bus);
      started.push(dc);
      pressSources.push(dc);
      return bus;
    }
    return null;
  };

  const pressSources: ConstantSourceNode[] = [];
  let ampNode: GainNode | null = null;
  const slots: ModVoiceHandle["slots"] = [];

  for (const def of slotDefs) {
    if (Math.abs(def.amt) < 0.001) {
      slots.push(null);
      continue;
    }
    const src = buildSource(def.src);
    if (!src) {
      slots.push(null);
      continue;
    }
    if (def.dst === 1 && opts.cutoffParam && opts.cutoffBase) {
      // CUTOFF: additive Hz — worklet scale base·src·amt·2.
      const scaled = ctx.createGain();
      scaled.gain.value = def.amt * 2 * opts.cutoffBase;
      src.connect(scaled).connect(opts.cutoffParam);
      nodes.push(scaled);
      slots.push(null);
      continue;
    }
    if (def.dst === 3) {
      // AMP: serial gain node — 1 + src·amt (scaled into its own gain).
      if (!ampNode) {
        ampNode = ctx.createGain();
        ampNode.gain.value = 1;
      }
      const scaled = ctx.createGain();
      scaled.gain.value = def.amt;
      src.connect(scaled).connect(ampNode.gain);
      nodes.push(scaled);
      slots.push(null);
      continue;
    }
    // dst 0 (MORPH) / 2 (DETUNE): raw slot signal for the caller to route
    // (wavetable crossfade wobble); unknown destinations stay inert.
    slots.push({ sig: src, amt: def.amt });
  }

  if (nodes.length === 0) return null;

  return {
    ampNode,
    slots,
    setPressure(value, when) {
      const at = Math.max(when ?? 0, 0);
      const clamped = Math.max(0, Math.min(1, value));
      for (const dc of pressSources) dc.offset.setTargetAtTime(clamped, at, 0.01);
    },
    dispose() {
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    },
  };
}

/** Source options shared by the registry ParamDefs and UI (worklet numbering). */
export const MOD_SRC_OPTIONS = [
  { value: 0, label: "ENV" },
  { value: 1, label: "LFO" },
  { value: 2, label: "VEL" },
  { value: 3, label: "PRESS" },
];

/**
 * Destination options. Wavetable routes slot 0 to the table morph; other
 * instruments have no morph — slot 0 is labeled OFF there. DETUNE (2) is
 * reserved: unimplemented on the worklet and fallback alike.
 */
export function modDstOptions(morph: boolean, cutoff = true) {
  return [
    ...(morph ? [{ value: 0, label: "MORPH" }] : [{ value: 0, label: "OFF" }]),
    ...(cutoff ? [{ value: 1, label: "CUTOFF" }] : []),
    { value: 3, label: "AMP" },
  ];
}

/** The 7 mod-matrix params, appended to a synth's ParamDef list. */
export function modMatrixParams(morph: boolean, opts?: { cutoff?: boolean }): ParamDef[] {
  const cutoff = opts?.cutoff ?? true;
  return [
    { id: "modASrc", label: "MOD A SRC", min: 0, max: 3, default: 0, options: MOD_SRC_OPTIONS },
    { id: "modADst", label: "MOD A DST", min: 0, max: 3, default: 0, options: modDstOptions(morph, cutoff) },
    {
      id: "modAAmt",
      label: "MOD A AMT",
      min: -1,
      max: 1,
      default: 0,
      format: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`,
    },
    { id: "modBSrc", label: "MOD B SRC", min: 0, max: 3, default: 0, options: MOD_SRC_OPTIONS },
    { id: "modBDst", label: "MOD B DST", min: 0, max: 3, default: 1, options: modDstOptions(morph, cutoff) },
    {
      id: "modBAmt",
      label: "MOD B AMT",
      min: -1,
      max: 1,
      default: 0,
      format: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`,
    },
    {
      id: "modLfoRate",
      label: "MOD LFO",
      min: 0,
      max: 12,
      default: 2,
      unit: "Hz",
      format: (v) => (v < 0.05 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
  ];
}
