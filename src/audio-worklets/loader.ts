/**
 * AudioWorklet module loader. Loads processor modules per context and
 * reports readiness synchronously so effect factories can fall back.
 *
 * Readiness is tracked PER CONTEXT: addModule() registers processors on one
 * BaseAudioContext only. The live engine context and every OfflineAudioContext
 * (freeze/bounce/export renders) each need their own load. A global flag would
 * make factories construct AudioWorkletNodes in contexts where the processor
 * was never registered — which throws.
 *
 * Modules come in two weight classes:
 *  - CORE (bitcrusher + core-processor: sidechain, transient, gate, limiter,
 *    envFollower, compressor) — a few KB, used by stock effects everywhere.
 *  - PLUGIN (fxeq / ultina / ozvena) — vendored DSP suites, 120–260 KB each.
 *    They load on demand: only when a project actually uses the effect (see
 *    ensureWorkletsForDoc) or when the engine builds its chain (which then
 *    hot-swaps the bypass runtime once the module lands). Loading ~500 KB of
 *    reverb EQ a beat never touches would be pure waste on metered/mobile
 *    connections.
 *
 * All failures are swallowed: loaders never reject, callers fire-and-forget,
 * and factories keep the fallback/bypass implementation for contexts that
 * could not load modules.
 */

const readyContexts = new WeakSet<BaseAudioContext>();
const failedContexts = new WeakSet<BaseAudioContext>();
const inflight = new Map<BaseAudioContext, Promise<void>>();

/** Vendored plugin DSP suites — loaded per effect type, on demand. */
export const PLUGIN_WORKLET_TYPES = ["fxeq", "ultina", "ozvena", "morphdynamics"] as const;
export type PluginWorkletType = (typeof PLUGIN_WORKLET_TYPES)[number];

const PLUGIN_MODULE_URLS: Record<PluginWorkletType, string> = {
  fxeq: new URL("/fxeq-worklet.js", import.meta.url).href,
  ultina: new URL("/ultina-worklet.js", import.meta.url).href,
  ozvena: new URL("/ozvena-worklet.js", import.meta.url).href,
  morphdynamics: new URL("/morph-dynamics-worklet.js", import.meta.url).href,
};

const CORE_TYPES = [
  "bitcrusher",
  "sidechain",
  "transient",
  "gate",
  "limiter",
  "envFollower",
  "compressor",
  "kwmeter",
  "stepGate",
  "svFilter",
  "flanger",
  "tremolo",
  "autowah",
  "stutter",
  "tapeSat",
  "comb",
  "vowel",
  "duckDelay",
  "chorus",
  "delay",
  "eq",
  "kaskada",
  "reverb",
  "wtVoice",
  "grainVoice",
  "ringMod",
  "tapeStop",
  "freqShifter",
  "pitchShift",
  "vinyl",
  "beatMangler",
  "vocoder",
  "reverseSwell",
  "granularFreeze",
] as const;

export type WorkletType = (typeof CORE_TYPES)[number] | PluginWorkletType;

const readyPluginTypes = new WeakMap<BaseAudioContext, Set<PluginWorkletType>>();
const pluginInflight = new Map<BaseAudioContext, Map<PluginWorkletType, Promise<void>>>();

export function isWorkletReady(type: WorkletType, ctx: BaseAudioContext | null | undefined): boolean {
  if (!ctx || !readyContexts.has(ctx)) return false;
  if ((PLUGIN_WORKLET_TYPES as readonly string[]).includes(type)) {
    return readyPluginTypes.get(ctx)?.has(type as PluginWorkletType) ?? false;
  }
  return true;
}

/**
 * Load the CORE processor modules for the given context (bitcrusher +
 * core-processor). Safe to call multiple times per context; resolves
 * immediately (without loading) when the platform has no AudioWorklet
 * (jsdom) or when a previous load for this context already failed.
 */
export async function loadCoreWorklets(ctx: BaseAudioContext): Promise<void> {
  if (!ctx?.audioWorklet) return; // jsdom and other non-Web-Audio environments
  if (readyContexts.has(ctx) || failedContexts.has(ctx)) return;
  const pending = inflight.get(ctx);
  if (pending) return pending;

  const load = Promise.all([
    // These are generated self-contained files. Keeping the two-module
    // contract preserves the loader's readiness semantics while avoiding a
    // production-only Vite data-URL failure for core-processor's relative
    // imports.
    ctx.audioWorklet.addModule(new URL("/bitcrusher-worklet.js", import.meta.url).href),
    ctx.audioWorklet.addModule(new URL("/core-worklet.js", import.meta.url).href),
  ])
    .then(() => {
      readyContexts.add(ctx);
      readyPluginTypes.set(ctx, new Set());
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

/**
 * Load ONE vendored plugin module (fxeq/ultina/ozvena) into the context.
 * Must run after (or together with) the core modules — plugin readiness is
 * tracked on top of the core "context ready" mark. Idempotent per context.
 */
export async function loadPluginWorklet(ctx: BaseAudioContext, type: PluginWorkletType): Promise<void> {
  if (!ctx?.audioWorklet) return;
  await loadCoreWorklets(ctx);
  if (failedContexts.has(ctx)) return;
  const pluginSet = readyPluginTypes.get(ctx);
  if (pluginSet?.has(type)) return;

  let perCtx = pluginInflight.get(ctx);
  if (perCtx?.get(type)) return perCtx.get(type);

  const load = ctx.audioWorklet
    .addModule(PLUGIN_MODULE_URLS[type])
    .then(() => {
      readyPluginTypes.get(ctx)?.add(type);
    })
    .catch((err) => {
      console.warn(`[audio-worklets] ${type} module load failed, effect stays bypassed:`, err);
    })
    .finally(() => {
      perCtx = pluginInflight.get(ctx);
      perCtx?.delete(type);
      if (perCtx && perCtx.size === 0) pluginInflight.delete(ctx);
    });
  if (!perCtx) {
    perCtx = new Map();
    pluginInflight.set(ctx, perCtx);
  }
  perCtx.set(type, load);
  return load;
}

/**
 * Load the plugin modules a PROJECT actually uses into the context.
 * Returns the set of plugin types that are ready afterwards — callers use it
 * to decide whether an FX rebuild is worth it.
 */
export async function ensureWorkletsForDoc(doc: unknown, ctx: BaseAudioContext): Promise<PluginWorkletType[]> {
  await loadCoreWorklets(ctx);
  const wanted = pluginTypesInDoc(doc);
  await Promise.all(wanted.map((type) => loadPluginWorklet(ctx, type)));
  return wanted.filter((type) => isWorkletReady(type, ctx));
}

/** Which vendored plugin effects does the project reference (pure). */
export function pluginTypesInDoc(doc: unknown): PluginWorkletType[] {
  if (typeof doc !== "object" || doc === null) return [];
  const found = new Set<PluginWorkletType>();
  const scan = (effects: unknown) => {
    if (!Array.isArray(effects)) return;
    for (const effect of effects) {
      const type = (effect as { type?: unknown } | null)?.type;
      if (typeof type === "string" && (PLUGIN_WORKLET_TYPES as readonly string[]).includes(type)) {
        found.add(type as PluginWorkletType);
      }
    }
  };
  const container = doc as { tracks?: unknown; returns?: unknown; master?: unknown };
  if (Array.isArray(container.tracks))
    for (const track of container.tracks) scan((track as { effects?: unknown })?.effects);
  if (Array.isArray(container.returns))
    for (const ret of container.returns) scan((ret as { effects?: unknown })?.effects);
  scan((container.master as { effects?: unknown } | null)?.effects);
  return [...found];
}

/**
 * Legacy entry point: core + ALL plugin modules (the pre-lazy behavior).
 * Kept for the browser check suite, which exercises every worklet path.
 */
export async function loadAllWorklets(ctx: BaseAudioContext): Promise<void> {
  await loadCoreWorklets(ctx);
  await Promise.all(PLUGIN_WORKLET_TYPES.map((type) => loadPluginWorklet(ctx, type)));
}
