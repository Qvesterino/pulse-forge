/**
 * AudioWorklet module loader. Pre-loads processor modules per context and
 * reports readiness synchronously so effect factories can fall back.
 *
 * Readiness is tracked PER CONTEXT: addModule() registers processors on one
 * BaseAudioContext only. The live engine context and every OfflineAudioContext
 * (freeze/bounce/export renders) each need their own load. A global flag would
 * make factories construct AudioWorkletNodes in contexts where the processor
 * was never registered — which throws.
 *
 * All failures are swallowed: `loadWorkletModules()` never rejects, callers
 * fire-and-forget, and factories simply keep the fallback implementation
 * (WaveShaperNode / setInterval) for contexts that could not load modules.
 */

const readyContexts = new WeakSet<BaseAudioContext>();
const failedContexts = new WeakSet<BaseAudioContext>();
const inflight = new Map<BaseAudioContext, Promise<void>>();

export function isWorkletReady(
  type:
    | "bitcrusher"
    | "sidechain"
    | "transient"
    | "gate"
    | "limiter"
    | "envFollower"
    | "compressor"
    | "kwmeter"
    | "stepGate"
    | "svFilter"
    | "flanger"
    | "tremolo"
    | "autowah"
    | "stutter"
    | "tapeSat"
    | "comb"
    | "vowel"
    | "duckDelay"
    | "reverb",
  ctx: BaseAudioContext | null | undefined,
): boolean {
  if (!ctx || !readyContexts.has(ctx)) return false;
  return (
    type === "bitcrusher" ||
    type === "sidechain" ||
    type === "transient" ||
    type === "gate" ||
    type === "limiter" ||
    type === "envFollower" ||
    type === "compressor" ||
    type === "kwmeter" ||
    type === "stepGate" ||
    type === "svFilter" ||
    type === "flanger" ||
    type === "tremolo" ||
    type === "autowah" ||
    type === "stutter" ||
    type === "tapeSat" ||
    type === "comb" ||
    type === "vowel" ||
    type === "duckDelay" ||
    type === "reverb"
  );
}

/**
 * Pre-load all AudioWorklet processor modules for the given context.
 * Safe to call multiple times per context; resolves immediately (without
 * loading) when the platform has no AudioWorklet (jsdom) or when a previous
 * load for this context already failed.
 */
export async function loadWorkletModules(ctx: BaseAudioContext): Promise<void> {
  if (!ctx?.audioWorklet) return; // jsdom and other non-Web-Audio environments
  if (readyContexts.has(ctx) || failedContexts.has(ctx)) return;
  const pending = inflight.get(ctx);
  if (pending) return pending;

  const load = Promise.all([
    ctx.audioWorklet.addModule(new URL("./bitcrusher-processor.js", import.meta.url).href),
    // The core module imports sidechain, transient, gate, limiter,
    // envFollower and compressor processors. Keeping this as one addModule
    // call preserves the existing two-module contract.
    ctx.audioWorklet.addModule(new URL("./core-processor.js", import.meta.url).href),
  ])
    .then(() => {
      readyContexts.add(ctx);
    })
    .catch((err) => {
      failedContexts.add(ctx);
      console.warn("[audio-worklets] module load failed, using fallback implementations:", err);
    })
    .finally(() => {
      inflight.delete(ctx);
    });
  inflight.set(ctx, load);
  return load;
}
