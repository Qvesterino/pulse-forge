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
  /** Live destination-selected slot signals (for custom destinations like MORPH). */
  slots: Array<{ sig: GainNode; amt: number } | null>;
  /** MPE pressure — retunes the PRESS source of this voice live. */
  setPressure(value: number, when?: number): void;
  /** Update a live MOD matrix parameter on an already-scheduled voice. */
  setParameter(id: string, value: number, when?: number): void;
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

/**
 * Build a small non-linear control curve outside the audio callback. Web Audio
 * AudioParams sum connected control signals linearly, but the worklet contract
 * applies a floor after summing all routes. A WaveShaper lets the fallback use
 * the same bounded law without allocating or branching in process() (the
 * curve is created once per voice at note scheduling time).
 */
function controlCurve(size: number, map: (input: number) => number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    curve[i] = map((i / (size - 1)) * 2 - 1);
  }
  return curve;
}

function boundedCutoffDelta(base: number): Float32Array<ArrayBuffer> {
  return controlCurve(1025, (normalized) => {
    const modCut = normalized * 4;
    const target = Math.max(60, Math.min(18000, base * (1 + Math.max(-0.9, modCut))));
    return target - base;
  });
}

function boundedAmpDelta(): Float32Array<ArrayBuffer> {
  return controlCurve(1025, (normalized) => Math.max(0.1, 1 + normalized * 2) - 1);
}

export function scheduleVoiceModMatrix(
  ctx: BaseAudioContext,
  p: Record<string, number>,
  opts: ModVoiceOpts,
): ModVoiceHandle | null {
  const slotDefs: Array<{ id: "modAAmt" | "modBAmt"; src: number; dst: number; amt: number }> = [
    { id: "modAAmt", src: Math.round(p.modASrc ?? 0), dst: Math.round(p.modADst ?? 0), amt: p.modAAmt ?? 0 },
    { id: "modBAmt", src: Math.round(p.modBSrc ?? 0), dst: Math.round(p.modBDst ?? 1), amt: p.modBAmt ?? 0 },
  ];
  if (slotDefs.every((s) => Math.abs(s.amt) < 0.001)) return null;

  const lfoRate = Math.max(0, p.modLfoRate ?? 2);
  const nodes: AudioNode[] = [];
  const pressSources: ConstantSourceNode[] = [];
  const lfoFrequencies: AudioParam[] = [];
  const sourceBuses = new Map<number, GainNode>();

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
      return bus;
    }
    if (src === 1) {
      // LFO: unipolar sine — constant 0.5 + osc ±0.5.
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
      lfoFrequencies.push(osc.frequency);
      nodes.push(dc, osc, depth, bus);
      return bus;
    }
    if (src === 2) {
      const dc = ctx.createConstantSource();
      dc.offset.value = Math.max(0, Math.min(1, opts.velocity));
      dc.start(opts.when);
      dc.stop(opts.stopTime);
      dc.connect(bus);
      nodes.push(dc, bus);
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
      pressSources.push(dc);
      return bus;
    }
    return null;
  };

  // Build every source once per voice. Selector gains below make source
  // changes live in the fallback graph, matching the worklet's per-sample
  // `p.modASrc`/`p.modBSrc` reads without rebuilding a voice.
  for (const src of [0, 1, 2, 3]) {
    const bus = buildSource(src);
    if (bus) sourceBuses.set(src, bus);
  }

  let ampNode: GainNode | null = null;
  const slots: ModVoiceHandle["slots"] = [];
  const cutoffRoutes: GainNode[] = [];
  const ampRoutes: GainNode[] = [];
  const amountControls: Array<{ id: string; param: AudioParam }> = [];
  const sourceControls: Array<{ id: string; params: AudioParam[] }> = [];
  const destinationControls: Array<{ id: string; params: Array<{ dst: number; param: AudioParam }> }> = [];

  for (const def of slotDefs) {
    if (Math.abs(def.amt) < 0.001) {
      slots.push(null);
      continue;
    }
    const amount = Math.max(-1, Math.min(1, Number.isFinite(def.amt) ? def.amt : 0));
    const selectedSource = ctx.createGain();
    selectedSource.gain.value = 1;
    const sourceParams: AudioParam[] = [];
    for (const [sourceId, sourceBus] of sourceBuses) {
      const select = ctx.createGain();
      select.gain.value = sourceId === def.src ? 1 : 0;
      sourceBus.connect(select).connect(selectedSource);
      sourceParams.push(select.gain);
      nodes.push(select);
    }
    nodes.push(selectedSource);
    sourceControls.push({ id: def.id.replace("Amt", "Src"), params: sourceParams });

    const amountNode = ctx.createGain();
    amountNode.gain.value = amount;
    selectedSource.connect(amountNode);
    nodes.push(amountNode);
    amountControls.push({ id: def.id, param: amountNode.gain });

    // Keep all destination branches alive and select exactly one at a time.
    // Later selector automation can therefore move a held voice between
    // CUTOFF, AMP and MORPH without rebuilding or rewiring its voice graph.
    const morph = ctx.createGain();
    morph.gain.value = def.dst === 0 ? 1 : 0;
    amountNode.connect(morph);
    nodes.push(morph);

    const cutoff = ctx.createGain();
    cutoff.gain.value = def.dst === 1 && opts.cutoffParam && opts.cutoffBase ? 1 : 0;
    amountNode.connect(cutoff);
    nodes.push(cutoff);
    if (opts.cutoffParam && opts.cutoffBase) cutoffRoutes.push(cutoff);

    if (!ampNode) {
      ampNode = ctx.createGain();
      ampNode.gain.value = 1;
    }
    const amp = ctx.createGain();
    amp.gain.value = def.dst === 3 ? 1 : 0;
    amountNode.connect(amp);
    nodes.push(amp);
    ampRoutes.push(amp);

    destinationControls.push({
      id: def.id.replace("Amt", "Dst"),
      params: [
        { dst: 0, param: morph.gain },
        { dst: 1, param: cutoff.gain },
        { dst: 3, param: amp.gain },
      ],
    });
    slots.push({ sig: morph, amt: 1 });
  }

  if (cutoffRoutes.length > 0 && opts.cutoffParam && opts.cutoffBase) {
    const sum = ctx.createGain();
    sum.gain.value = 1;
    for (const route of cutoffRoutes) {
      const scaled = ctx.createGain();
      scaled.gain.value = 2;
      route.connect(scaled).connect(sum);
      nodes.push(scaled);
    }
    const normalize = ctx.createGain();
    normalize.gain.value = 0.25;
    const shaped = ctx.createWaveShaper();
    shaped.curve = boundedCutoffDelta(opts.cutoffBase);
    shaped.oversample = "none";
    sum.connect(normalize).connect(shaped).connect(opts.cutoffParam);
    nodes.push(sum, normalize, shaped);
  }

  if (ampRoutes.length > 0 && ampNode) {
    const sum = ctx.createGain();
    sum.gain.value = 1;
    for (const route of ampRoutes) {
      const scaled = ctx.createGain();
      scaled.gain.value = 1;
      route.connect(scaled).connect(sum);
      nodes.push(scaled);
    }
    const normalize = ctx.createGain();
    normalize.gain.value = 0.5;
    const shaped = ctx.createWaveShaper();
    shaped.curve = boundedAmpDelta();
    shaped.oversample = "none";
    sum.connect(normalize).connect(shaped).connect(ampNode.gain);
    nodes.push(sum, normalize, shaped);
  }

  if (nodes.length === 0) return null;

  return {
    ampNode,
    slots,
    setPressure(value, when) {
      const at = Math.max(ctx.currentTime, when ?? ctx.currentTime);
      const clamped = Math.max(0, Math.min(1, value));
      for (const dc of pressSources) dc.offset.setTargetAtTime(clamped, at, 0.01);
    },
    setParameter(id, value, when) {
      const at = Math.max(ctx.currentTime, when ?? ctx.currentTime);
      if (id === "modAAmt" || id === "modBAmt") {
        const clamped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
        for (const control of amountControls) {
          if (control.id === id) control.param.setTargetAtTime(clamped, at, 0.005);
        }
        return;
      }
      if (id === "modASrc" || id === "modBSrc") {
        const source = Math.max(0, Math.min(3, Math.round(Number.isFinite(value) ? value : 0)));
        for (const control of sourceControls) {
          if (control.id !== id) continue;
          control.params.forEach((param, index) => param.setTargetAtTime(index === source ? 1 : 0, at, 0.005));
        }
        return;
      }
      if (id === "modADst" || id === "modBDst") {
        const destination = Math.round(Number.isFinite(value) ? value : -1);
        for (const control of destinationControls) {
          if (control.id !== id) continue;
          for (const target of control.params) target.param.setTargetAtTime(target.dst === destination ? 1 : 0, at, 0.005);
        }
        return;
      }
      if (id === "modLfoRate") {
        const rate = Math.max(0, Math.min(12, Number.isFinite(value) ? value : 0));
        for (const frequency of lfoFrequencies) frequency.setTargetAtTime(rate, at, 0.005);
      }
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

/** Forward live MOD matrix writes to every live fallback voice. */
export function updateVoiceModMatrix(
  handles: Iterable<ModVoiceHandle | null | undefined>,
  id: string,
  value: number,
  when?: number,
): void {
  for (const handle of handles) handle?.setParameter(id, value, when);
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
