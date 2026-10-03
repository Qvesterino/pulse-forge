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

class ParamStub {
  constructor(public _value: number) {}
  get value(): number {
    return this._value;
  }
  set value(v: number) {
    this._value = v;
  }
  setValueAtTime(v: number): void {
    this._value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this._value = v;
  }
  exponentialRampToValueAtTime(v: number): void {
    this._value = v;
  }
  setTargetAtTime(v: number): void {
    this._value = v;
  }
  cancelScheduledValues(): void {}
  cancelAndHoldAtTime(): void {}
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
 * Classify the source nodes an instrument built.
 *
 *   audible  — reaches the output on the audio path (it makes the sound)
 *   mod      — drives a param of a node that is on the audio path (an LFO:
 *             it shapes the sound and MUST NOT be on the audio path itself)
 *   dead     — neither, i.e. it was built, started, and reaches nothing
 *
 * Only `dead` is a defect. Getting this distinction wrong flags every LFO in
 * the registry, which is what the first version of this helper did.
 */
export function classifySources(
  output: GraphNode,
  allNodes: GraphNode[],
): { audible: GraphNode[]; modulators: GraphNode[]; dead: GraphNode[] } {
  const { reachable } = reachableFromOutput(output);
  const audible: GraphNode[] = [];
  const modulators: GraphNode[] = [];
  const dead: GraphNode[] = [];
  for (const n of allNodes) {
    if (n.sourceKind === null) continue;
    if (reachable.has(n)) {
      audible.push(n);
      continue;
    }
    const drivesLiveNode = [...n.paramTargets].some((t) => reachable.has(t));
    if (drivesLiveNode) modulators.push(n);
    else dead.push(n);
  }
  return { audible, modulators, dead };
}

/** Back-compat wrapper used by the earlier probe. */
export function orphanedSources(output: GraphNode, allNodes: GraphNode[]): GraphNode[] {
  return classifySources(output, allNodes).dead;
}
