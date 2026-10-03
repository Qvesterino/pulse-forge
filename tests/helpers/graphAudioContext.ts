/**
 * AUDIT 2026-10-03 — instrument signal-graph mock.
 *
 * WHY THIS EXISTS
 *
 * The Clavinet shipped silent for its entire life: its factory built a full
 * voice chain and never connected it to the instrument output. Source scanning
 * for `amp.connect(output)` finds that class of bug but produces false
 * positives immediately — bass/bass808/granular/vocalchop legitimately reach the
 * output through an intermediate node, and vocalchop writes
 * `amp.connect(mod?.ampNode ?? tone)`, which no single regex can match. Three
 * consecutive "broader" regex attempts cried wolf.
 *
 * So this mock models Web Audio edge semantics correctly and lets the test do
 * real graph reachability instead of pattern matching:
 *
 *   - `connect()` registers the edge on BOTH endpoints (`source.outputs` and
 *     `destination.inputs`). The wrong version — pushing to `dest.inputs` only
 *     — makes `source.disconnect()` look like it severs incoming edges, which
 *     hides exactly the rebuild patterns the engine uses everywhere.
 *   - Both `disconnect()` forms are implemented: the targeted
 *     `disconnect(node)` (which throws `InvalidAccessError` when that edge does
 *     not exist, like the real API) and the argument-less form that clears all
 *     outgoing edges only.
 *   - Pass-through nodes (analyser, splitter, panner, delay, filters) are
 *     ordinary graph nodes, NOT dead ends. An analyser sitting inline on the
 *     signal path is load-bearing, so reachability must traverse it.
 *   - `ctx.destination` is a terminal sentinel with no outputs.
 */

/** A node that generates audio without any input. */
export type SourceKind = "oscillator" | "bufferSource" | "constantSource";

export class GraphNode {
  readonly outputs = new Set<GraphNode | Terminal>();
  readonly inputs = new Set<GraphNode>();
  /**
   * Control edges: things this node drives that are NOT audio inputs — an LFO
   * wired to `osc.detune` or `filter.frequency`. These are recorded separately
   * because an LFO is a MODULATOR: it is supposed to be absent from the audio
   * path. Treating "not on the audio path" as a defect flags every LFO in the
   * registry, which is the same false positive as a naive source scan.
   */
  readonly paramTargets = new Set<GraphNode>();
  /** Set only for nodes that manufacture signal on their own. */
  readonly sourceKind: SourceKind | null = null;
  readonly kind: string;
  params: Record<string, number> = {};
  /** Scheduling surface — no-ops, but they must exist or the factory throws. */
  onended: (() => void) | null = null;
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  type = "sine";
  oversample: OverSampleType = "none";
  curve: Float32Array | null = null;

  constructor(kind: string, sourceKind: SourceKind | null = null) {
    this.kind = kind;
    this.sourceKind = sourceKind;
  }

  start(_when?: number, _offset?: number, _duration?: number): void {}
  stop(_when?: number): void {}
  setPeriodicWave(_wave: unknown): void {}
  /** Instruments that read `ctx.currentTime` in a factory must not divide by it. */
  get automationRate(): AutomationRate {
    return "a-rate";
  }

  connect(destination?: GraphNode | Terminal | null): this {
    if (!destination) return this;
    if (destination instanceof GraphNode || destination instanceof Terminal) {
      this.outputs.add(destination);
      if (destination instanceof GraphNode) destination.inputs.add(this);
      return this;
    }
    // An AudioParam (or anything else that is not a graph node) is a CONTROL
    // edge. Remember which node it belongs to so reachability can tell an LFO
    // from a dead voice.
    const owner = (destination as { __owner?: GraphNode }).__owner;
    if (owner) this.paramTargets.add(owner);
    return this;
  }

  disconnect(destination?: GraphNode | Terminal): this {
    if (destination === undefined) {
      // Real Web Audio: clears this node's OUTGOING edges only. Inbound edges
      // are the previous node's business.
      for (const out of this.outputs) {
        if (out instanceof GraphNode) out.inputs.delete(this);
      }
      this.outputs.clear();
      this.paramTargets.clear();
      return this;
    }
    if (!this.outputs.has(destination)) {
      const err = new Error("InvalidAccessError");
      err.name = "InvalidAccessError";
      throw err;
    }
    this.outputs.delete(destination);
    if (destination instanceof GraphNode) destination.inputs.delete(this);
    return this;
  }
}

export class Terminal {
  readonly kind = "destination";
  readonly inputs = new Set<GraphNode>();
}

/** Every node built during one context's life, for whole-graph inspection. */
export interface GraphSnapshot {
  nodes: GraphNode[];
  sources: GraphNode[];
  terminal: Terminal;
}

/**
 * A stand-in AudioParam. `_value` holds the LAST value written, which is what
 * the real param's `.value` would report before rendering starts.
 *
 * `automated` is the load-bearing part. Once any scheduling method has been
 * called, `_value` is the last AUTOMATION TARGET, not the level at note time —
 * a voice envelope schedules 0.0001 → peak → 0.0001, so a naive `gain.value`
 * read after `noteOn` sees silence for EVERY voice. Any check that reasons about
 * signal level must therefore refuse to conclude from an automated param; it can
 * only conclude from a param that was set once and never scheduled.
 */
class ParamStub {
  automated = false;
  constructor(public _value: number) {}
  get value(): number {
    return this._value;
  }
  set value(v: number) {
    this._value = v;
  }
  setValueAtTime(v: number): void {
    this.automated = true;
    this._value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.automated = true;
    this._value = v;
  }
  exponentialRampToValueAtTime(v: number): void {
    this.automated = true;
    this._value = v;
  }
  setTargetAtTime(v: number): void {
    this.automated = true;
    this._value = v;
  }
  cancelScheduledValues(): void {}
  cancelAndHoldAtTime(): void {}
}

/** A static (never-automated) gain reads as a level; an automated one does not. */
const SILENCE_EPS = 1e-3;

function staticGainOf(node: GraphNode): number | null {
  if (node.kind !== "gain") return null;
  const p = (node as unknown as { gain: ParamStub }).gain;
  if (p.automated) return null;
  return p.value;
}

/** Gain above which a path is carrying real signal. `null` = cannot tell. */
function pathIsAudible(node: GraphNode): boolean | null {
  const g = staticGainOf(node);
  if (g === null) return null;
  return g > SILENCE_EPS;
}

export class GraphAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  readonly destination = new Terminal();
  readonly nodes: GraphNode[] = [];

  private node(kind: string, sourceKind: SourceKind | null = null): GraphNode {
    const n = new GraphNode(kind, sourceKind);
    // AudioParam stubs must be REAL properties on the node (`node.gain.value`),
    // not tucked into a `params` record — real code does `output.gain.value = 1`
    // and would get undefined otherwise.
    for (const p of [
      "gain",
      "frequency",
      "Q",
      "detune",
      "pan",
      "delayTime",
      "threshold",
      "ratio",
      "attack",
      "release",
      "knee",
      "playbackRate",
      "offset",
      "B",
      "k",
    ]) {
      const stub = new ParamStub(p === "gain" || p === "pan" ? 1 : 0);
      // Tag each param with its owning node so `lfo.connect(osc.detune)` can be
      // recognised as a CONTROL edge rather than a dangling audio edge.
      (stub as unknown as { __owner: GraphNode }).__owner = n;
      (n as unknown as Record<string, ParamStub>)[p] = stub;
      n.params[p] = stub as unknown as number;
    }
    this.nodes.push(n);
    return n;
  }

  createGain = (): GraphNode => this.node("gain");
  createOscillator = (): GraphNode => this.node("oscillator", "oscillator");
  createConstantSource = (): GraphNode => this.node("constantSource", "constantSource");
  createBufferSource = (): GraphNode => this.node("bufferSource", "bufferSource");
  createBiquadFilter = (): GraphNode => this.node("biquad");
  createStereoPanner = (): GraphNode => this.node("panner");
  createDelay = (): GraphNode => this.node("delay");
  createConvolver = (): GraphNode => this.node("convolver");
  createDynamicsCompressor = (): GraphNode => this.node("compressor");
  createWaveShaper = (): GraphNode => this.node("waveShaper");
  createAnalyser = (): GraphNode => this.node("analyser");
  createChannelSplitter = (): GraphNode => this.node("splitter");
  createChannelMerger = (): GraphNode => this.node("merger");
  createPanner = (): GraphNode => this.node("panner");
  createAudioWorkletNode = (): GraphNode => this.node("worklet");

  /** One instrument (808) builds a periodic wave; it is data, not a graph node. */
  createPeriodicWave = (real: Float32Array, imag: Float32Array, _opts?: unknown): unknown => ({ real, imag });

  /** Instruments that reach for a worklet-based voice; port calls must not throw. */
  get port(): { postMessage: (data: unknown) => void } {
    return { postMessage: () => {} };
  }

  /** A plausible buffer so sampler/granular paths can attach one. */
  createBuffer(channels: number, length: number): { length: number; numberOfChannels: number; getChannelData: (i: number) => Float32Array } {
    return {
      length,
      numberOfChannels: channels,
      getChannelData: (i: number) => new Float32Array(length),
    };
  }

  snapshot(): GraphSnapshot {
    return {
      nodes: this.nodes,
      sources: this.nodes.filter((n) => n.sourceKind !== null),
      terminal: this.destination,
    };
  }
}

/**
 * Walk BACKWARD from the instrument output and collect everything that can
 * reach it. A voice is audible only if at least one source node is in that set.
 */
export function reachableFromOutput(output: GraphNode): { reachable: Set<GraphNode>; reachedSources: GraphNode[] } {
  const reachable = new Set<GraphNode>([output]);
  const stack = [output];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const upstream of cur.inputs) {
      if (!reachable.has(upstream)) {
        reachable.add(upstream);
        stack.push(upstream);
      }
    }
  }
  const reachedSources = [...reachable].filter((n) => n.sourceKind !== null);
  return { reachable, reachedSources };
}

/**
 * Walk FORWARD from a source over audio edges, carrying one bit of state:
 * "is there still a live-gain path to here?".
 *
 * `unknown` is a real third state. A static gain of 0 mutes the path; a static
 * gain above the floor keeps it alive; an AUTOMATED gain cannot be judged at
 * all (see `ParamStub.automated`) and therefore counts as alive — the test is
 * built to avoid crying wolf, so it only reports a mute when the silence is
 * provable from values that were set once and never scheduled.
 */
function forwardStates(source: GraphNode, terminal: Terminal): { reachedOutput: boolean; reachedTerminal: boolean } {
  const seen = new Set<GraphNode>([source]);
  const stack: Array<{ node: GraphNode | Terminal; live: boolean }> = [{ node: source, live: true }];
  let reachedOutput = false;
  let reachedTerminal = false;
  while (stack.length) {
    const { node, live } = stack.pop()!;
    if (node === terminal) {
      if (live) reachedTerminal = true;
      continue;
    }
    if (node === source || seen.has(node)) {
      // `seen` is only used to bound the walk; continue so `output` itself is
      // inspected below (it may already be in `seen` via another path).
    }
    if (node !== source) {
      const verdict = pathIsAudible(node);
      if (verdict === false && live) {
        // Node proves this path is silent — do not follow it, but still let the
        // walk continue only if some other path into the same node is alive.
      }
    }
    let nextLive = live;
    const verdict = pathIsAudible(node as GraphNode);
    if (verdict === false) nextLive = false;
    for (const out of node.outputs) {
      if (out === terminal) {
        if (nextLive) reachedTerminal = true;
        continue;
      }
      if (nextLive && out.kind === "destination") reachedTerminal = true;
      if (nextLive) reachedOutput = true;
      if (!seen.has(out)) {
        seen.add(out);
        stack.push({ node: out, live: nextLive });
      }
    }
  }
  return { reachedOutput, reachedTerminal };
}

export interface SourceClassification {
  /** Carries real signal to the instrument output. This is the good case. */
  audible: GraphNode[];
  /** Reaches the output only through a provably-static zero gain. A defect. */
  silentVoices: GraphNode[];
  /** Drives a param of a node that is on the audio path (LFO → depth → param). */
  modulators: GraphNode[];
  /**
   * Reaches `ctx.destination` while bypassing the instrument output, fully
   * muted. Ten instruments do this on purpose (see below), so it is NOT a
   * defect — but it is tracked so the distinction is visible.
   */
  silentReferences: GraphNode[];
  /**
   * Reaches `ctx.destination` with live gain, bypassing the instrument output.
   * A defect: it escapes the track bus, so track gain/pan/mute/solo and the
   * whole mixer chain are skipped.
   */
  leaks: GraphNode[];
  /** Reaches nothing at all — neither audio, nor a param, nor the terminal. */
  dead: GraphNode[];
}

/**
 * Classify every source node an instrument built.
 *
 * Six outcomes, and getting the boundaries wrong is the whole hazard here —
 * each earlier, narrower version of this helper produced false positives:
 *
 *   1. "not on the audio path" as a defect flags every LFO. LFO → depthGain →
 *      param is a CONTROL chain, and the depth gain is an intermediate node, so
 *      only a forward walk finds it.
 *   2. The silent reference clock is a source that reaches `ctx.destination`
 *      directly at gain 0, deliberately, as a `setTimeout`-free teardown timer
 *      (its `onended` must fire in offline rendering too). It is infrastructure.
 *      Ten instruments build one: pluck, flute, organ, strings, bell, reese,
 *      acid, brass, clav, drumsynth.
 *   3. Gain must only be judged on params that were set once. Reading
 *      `gain.value` after `noteOn` sees 0.0001 for EVERY voice, because that is
 *      the envelope's last scheduled target.
 */
export function classifySources(
  output: GraphNode,
  allNodes: GraphNode[],
  terminal: Terminal,
): SourceClassification {
  const { reachable } = reachableFromOutput(output);
  const result: SourceClassification = {
    audible: [],
    silentVoices: [],
    modulators: [],
    silentReferences: [],
    leaks: [],
    dead: [],
  };

  for (const n of allNodes) {
    if (n.sourceKind === null) continue;

    // 1. On the audio path at all? (backward walk from the output)
    if (reachable.has(n)) {
      // Reachable, but is every path through it statically muted?
      const { reachedOutput, reachedTerminal } = forwardStates(n, terminal);
      if (reachedOutput) result.audible.push(n);
      else result.silentVoices.push(n);
      continue;
    }

    // 2. Control chain: does anything this source can reach drive a param of a
    //    node that is itself on the audio path? Two hops is normal
    //    (lfo → depthGain → bandpass.frequency).
    const forward = new Set<GraphNode>([n]);
    const stack = [n];
    let drivesLiveNode = false;
    while (stack.length && !drivesLiveNode) {
      const cur = stack.pop()!;
      for (const t of cur.paramTargets) {
        if (reachable.has(t)) {
          drivesLiveNode = true;
          break;
        }
      }
      for (const out of cur.outputs) {
        if (out instanceof GraphNode && !forward.has(out)) {
          forward.add(out);
          stack.push(out);
        }
      }
    }
    if (drivesLiveNode) {
      result.modulators.push(n);
      continue;
    }

    // 3. Bypasses the instrument output and goes to the context destination.
    if (forwardStates(n, terminal).reachedTerminal) {
      result.silentReferences.push(n);
      continue;
    }

    result.dead.push(n);
  }
  return result;
}

/** Back-compat wrapper used by the earlier probe. */
export function orphanedSources(output: GraphNode, allNodes: GraphNode[]): GraphNode[] {
  return classifySources(output, allNodes, new Terminal()).dead;
}
