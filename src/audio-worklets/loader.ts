import { assetUrl } from "../shared/assetUrls";
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
 *  - LAZY (fxeq / ultina / ozvena / morphdynamics / bassHarmonic / skrutka) —
 *    heavier DSP (vendored suites + first-party processors), loaded on demand: only
 *    when a project actually uses the effect (see ensureWorkletsForDoc) or
 *    when the engine builds its chain (which then hot-swaps the bypass
 *    runtime once the module lands). Loading ~500 KB of reverb EQ a beat
 *    never touches would be pure waste on metered/mobile connections.
 *
 * All failures are swallowed: loaders never reject, callers fire-and-forget,
 * and factories keep the fallback/bypass implementation for contexts that
 * could not load modules.
 */

const readyContexts = new WeakSet<BaseAudioContext>();
const failedContexts = new WeakSet<BaseAudioContext>();
const inflight = new Map<BaseAudioContext, Promise<void>>();

/** Lazy worklet DSP modules (vendored suites + first-party) — per effect type, on demand. */
export const LAZY_WORKLET_TYPES = ["fxeq", "ultina", "ozvena", "morphdynamics", "bassHarmonic", "skrutka"] as const;
export type LazyWorkletType = (typeof LAZY_WORKLET_TYPES)[number];

const LAZY_MODULE_URLS: Record<LazyWorkletType, string> = {
  fxeq: new URL(assetUrl("/fxeq-worklet.js"), import.meta.url).href,
  ultina: new URL(assetUrl("/ultina-worklet.js"), import.meta.url).href,
  ozvena: new URL(assetUrl("/ozvena-worklet.js"), import.meta.url).href,
  morphdynamics: new URL(assetUrl("/morph-dynamics-worklet.js"), import.meta.url).href,
  bassHarmonic: new URL(assetUrl("/bass-harmonic-worklet.js"), import.meta.url).href,
  skrutka: new URL(assetUrl("/skrutka-worklet.js"), import.meta.url).href,
};

const CORE_TYPES = [
  "bitcrusher",
  "apeks",
  "sirka",
  "prud",
  "sidechain",
  "transient",
  "gate",
  "limiter",
  "envFollower",
  "compressor",
  "kwmeter",
  "rtMonitor",
  "stepGate",
  "svFilter",
  "flanger",
  "tremolo",
  "autowah",
  "stutter",
  "tapeSat",
  "comb",
  "multiTapDelay",
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
  "pitchCorrect",
  "vinyl",
  "beatMangler",
  "vocoder",
  "reverseSwell",
  "granularFreeze",
  "generativePlayer",
] as const;

export type WorkletType = (typeof CORE_TYPES)[number] | LazyWorkletType;

/**
 * FLAGSHIP INSTRUMENT worklets - loaded on demand like plugin effects, NOT in
 * the core boot bundle. TSAR is ~22 KB minified (measured 2026-10-06) and a
 * beat that never adds a TSAR track must not pay for it; KOPA is a lazy
 * first-party kick designer with its own budget row. Instrument kind ->
 * worklet module (the doc-scan lives in `instrumentWorkletTypesInDoc`).
 */
export const INSTRUMENT_WORKLET_TYPES = ["tsar", "kopa"] as const;
export type InstrumentWorkletType = (typeof INSTRUMENT_WORKLET_TYPES)[number];

const INSTRUMENT_MODULE_URLS: Record<InstrumentWorkletType, string> = {
  tsar: new URL(assetUrl("/tsar-worklet.js"), import.meta.url).href,
  kopa: new URL(assetUrl("/kopa-worklet.js"), import.meta.url).href,
};

const readyLazyTypes = new WeakMap<BaseAudioContext, Set<LazyWorkletType>>();
const lazyInflight = new Map<BaseAudioContext, Map<LazyWorkletType, Promise<void>>>();
const readyInstrumentTypes = new WeakMap<BaseAudioContext, Set<InstrumentWorkletType>>();
const instrumentInflight = new Map<BaseAudioContext, Map<InstrumentWorkletType, Promise<void>>>();

export function isWorkletReady(
  type: WorkletType | InstrumentWorkletType,
  ctx: BaseAudioContext | null | undefined,
): boolean {
  if (!ctx || !readyContexts.has(ctx)) return false;
  if ((LAZY_WORKLET_TYPES as readonly string[]).includes(type)) {
    return readyLazyTypes.get(ctx)?.has(type as LazyWorkletType) ?? false;
  }
  if ((INSTRUMENT_WORKLET_TYPES as readonly string[]).includes(type)) {
    return readyInstrumentTypes.get(ctx)?.has(type as InstrumentWorkletType) ?? false;
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
    ctx.audioWorklet.addModule(new URL(assetUrl("/bitcrusher-worklet.js"), import.meta.url).href),
    ctx.audioWorklet.addModule(new URL(assetUrl("/core-worklet.js"), import.meta.url).href),
  ])
    .then(() => {
      readyContexts.add(ctx);
      readyLazyTypes.set(ctx, new Set());
      // Instrument worklets (TSAR) track readiness on the same per-context
      // mark; without this set the loader could never report a loaded
      // instrument module (measured by the E2E lazy-load check).
      readyInstrumentTypes.set(ctx, new Set());
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
 * Load ONE lazy worklet module
 * (fxeq/ultina/ozvena/morphdynamics/bassHarmonic/skrutka)
 * into the context. Must run after (or together with) the core modules — lazy
 * readiness is tracked on top of the core "context ready" mark. Idempotent
 * per context.
 */
export async function loadLazyWorklet(ctx: BaseAudioContext, type: LazyWorkletType): Promise<void> {
  if (!ctx?.audioWorklet) return;
  await loadCoreWorklets(ctx);
  if (failedContexts.has(ctx)) return;
  const lazySet = readyLazyTypes.get(ctx);
  if (lazySet?.has(type)) return;

  let perCtx = lazyInflight.get(ctx);
  if (perCtx?.get(type)) return perCtx.get(type);

  const load = ctx.audioWorklet
    .addModule(LAZY_MODULE_URLS[type])
    .then(() => {
      readyLazyTypes.get(ctx)?.add(type);
    })
    .catch((err) => {
      console.warn(`[audio-worklets] ${type} module load failed, effect stays bypassed:`, err);
    })
    .finally(() => {
      perCtx = lazyInflight.get(ctx);
      perCtx?.delete(type);
      if (perCtx && perCtx.size === 0) lazyInflight.delete(ctx);
    });
  if (!perCtx) {
    perCtx = new Map();
    lazyInflight.set(ctx, perCtx);
  }
  perCtx.set(type, load);
  return load;
}

/**
 * Load ONE flagship INSTRUMENT module (tsar) into the context. Same contract
 * as the lazy loader: idempotent per context, never rejects, and the
 * factory keeps a fallback for contexts where the module is unavailable.
 */
export async function loadInstrumentWorklet(ctx: BaseAudioContext, type: InstrumentWorkletType): Promise<void> {
  if (!ctx?.audioWorklet) return;
  await loadCoreWorklets(ctx);
  if (failedContexts.has(ctx)) return;
  const instrumentSet = readyInstrumentTypes.get(ctx);
  if (instrumentSet?.has(type)) return;

  let perCtx = instrumentInflight.get(ctx);
  if (perCtx?.get(type)) return perCtx.get(type);

  const load = ctx.audioWorklet
    .addModule(INSTRUMENT_MODULE_URLS[type])
    .then(() => {
      readyInstrumentTypes.get(ctx)?.add(type);
    })
    .catch((err) => {
      console.warn(`[audio-worklets] ${type} instrument module load failed, factory keeps its fallback:`, err);
    })
    .finally(() => {
      perCtx = instrumentInflight.get(ctx);
      perCtx?.delete(type);
      if (perCtx && perCtx.size === 0) instrumentInflight.delete(ctx);
    });
  if (!perCtx) {
    perCtx = new Map();
    instrumentInflight.set(ctx, perCtx);
  }
  perCtx.set(type, load);
  return load;
}

/**
 * Load the lazy effect + instrument worklet modules a PROJECT actually uses
 * into the context. Returns the set of LAZY types that are ready afterwards —
 * callers use it to decide whether an FX rebuild is worth it. Instrument
 * worklets are fire-and-forget from the caller's perspective (the factory
 * hot-swaps when the module lands).
 */
export async function ensureWorkletsForDoc(doc: unknown, ctx: BaseAudioContext): Promise<LazyWorkletType[]> {
  await loadCoreWorklets(ctx);
  const wanted = lazyWorkletTypesInDoc(doc);
  const instrumentWanted = instrumentWorkletTypesInDoc(doc);
  await Promise.all([
    ...wanted.map((type) => loadLazyWorklet(ctx, type)),
    ...instrumentWanted.map((type) => loadInstrumentWorklet(ctx, type)),
  ]);
  return wanted.filter((type) => isWorkletReady(type, ctx));
}

/** Which flagship instrument worklets does the project reference (pure). */
export function instrumentWorkletTypesInDoc(doc: unknown): InstrumentWorkletType[] {
  if (typeof doc !== "object" || doc === null) return [];
  const container = doc as { tracks?: unknown };
  if (!Array.isArray(container.tracks)) return [];
  const found = new Set<InstrumentWorkletType>();
  for (const track of container.tracks) {
    const kind = (track as { kind?: unknown; instrument?: unknown } | null)?.instrument;
    if (typeof kind === "string" && (INSTRUMENT_WORKLET_TYPES as readonly string[]).includes(kind)) {
      found.add(kind as InstrumentWorkletType);
    }
  }
  return [...found];
}

/** Which lazy worklet effects does the project reference (pure). */
export function lazyWorkletTypesInDoc(doc: unknown): LazyWorkletType[] {
  if (typeof doc !== "object" || doc === null) return [];
  const found = new Set<LazyWorkletType>();
  const scan = (effects: unknown) => {
    if (!Array.isArray(effects)) return;
    for (const effect of effects) {
      const type = (effect as { type?: unknown } | null)?.type;
      if (typeof type === "string" && (LAZY_WORKLET_TYPES as readonly string[]).includes(type)) {
        found.add(type as LazyWorkletType);
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
 * Legacy entry point: core + ALL lazy modules (the pre-lazy behavior).
 * Kept for the browser check suite, which exercises every worklet path.
 */
export async function loadAllWorklets(ctx: BaseAudioContext): Promise<void> {
  await loadCoreWorklets(ctx);
  await Promise.all([
    ...LAZY_WORKLET_TYPES.map((type) => loadLazyWorklet(ctx, type)),
    ...INSTRUMENT_WORKLET_TYPES.map((type) => loadInstrumentWorklet(ctx, type)),
  ]);
}
