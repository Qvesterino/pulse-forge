import { getWorkletManifest, workletFileUrl } from "./workletManifest";
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
 * Modules come in three weight classes:
 *  - CORE (bitcrusher + core-processor: stock FX/instrument processors) —
 *    shared by the AudioEngine's normal live and offline audio paths.
 *  - LAZY (fxeq / ultina / ozvena / morphdynamics / bassHarmonic / skrutka /
 *    rezonans / portal / fxExtras) — heavier DSP (vendored suites +
 *    first-party processors), loaded on demand: only when a project actually
 *    uses the effect (see ensureWorkletsForDoc) or when the engine builds its
 *    chain (which then hot-swaps the bypass runtime once the module lands).
 *    `fxExtras` is one bundle shared by the rare creative/voice/performance
 *    effects; loading it marks every processor it registers ready. Loading
 *    ~500 KB of reverb EQ a beat never touches would be pure waste on
 *    metered/mobile connections.
 *  - GENERATIVE PLAYER — bounded PCM sink, loaded only when a provider-backed
 *    generative track starts.
 *
 * All failures are swallowed: loaders never reject, callers fire-and-forget,
 * and factories keep the fallback/bypass implementation for contexts that
 * could not load modules.
 */

const readyContexts = new WeakSet<BaseAudioContext>();
const inflight = new Map<BaseAudioContext, Promise<void>>();
const readyGenerativePlayers = new WeakSet<BaseAudioContext>();
const generativePlayerInflight = new Map<BaseAudioContext, Promise<void>>();

/**
 * Core-module breaker: a single transient fetch blip (boot race, flaky
 * connection, one dropped request) must not kill worklet DSP for the whole
 * session — the breaker goes permanent only after this many failed
 * TRIGGERS. Retries are trigger-driven (project open, document change,
 * worklet refresh, offline render prep) and deduped by the inflight map,
 * never a self-sustaining loop: the engine gates its FX-rebuild queues on
 * `isWorkletReady` (the instrument path has always done this; the lazy path
 * since the 10-16 audit). A deterministic failure (deployment without the
 * bundle files) still converges to permanent fallbacks after 3 attempts.
 */
const CORE_LOAD_ATTEMPTS = 3;
const coreFailures = new WeakMap<BaseAudioContext, number>();

function coreLoadExhausted(ctx: BaseAudioContext): boolean {
  return (coreFailures.get(ctx) ?? 0) >= CORE_LOAD_ATTEMPTS;
}

/**
 * Re-arm module loading for a context whose worklet global scope was
 * rebuilt by a contextlost → contextrestored cycle: clears every readiness
 * mark and failure count so the next `queueWorkletRefresh` re-runs
 * `addModule` against the fresh scope. Callers must verify the scope is
 * actually gone first (`workletScopeAlive`) — re-adding modules to a scope
 * that kept its registrations throws on the duplicate `registerProcessor`.
 */
export function invalidateWorkletReadiness(ctx: BaseAudioContext): void {
  readyContexts.delete(ctx);
  readyLazyTypes.delete(ctx);
  readyLazyModules.delete(ctx);
  readyInstrumentTypes.delete(ctx);
  readyGenerativePlayers.delete(ctx);
  coreFailures.delete(ctx);
  inflight.delete(ctx);
  lazyInflight.delete(ctx);
  instrumentInflight.delete(ctx);
  generativePlayerInflight.delete(ctx);
}

/**
 * True when the context's worklet scope still has the core processors
 * registered. `contextrestored` may (browser-dependent) hand back a context
 * whose worklet scope was rebuilt; the readiness marks then lie and every
 * factory `new AudioWorkletNode` would throw into `syncProject`. Probing is
 * decisive and cheap — the probe node is never connected. Platforms without
 * the AudioWorkletNode global (jsdom) report alive; the loaders' own
 * guards handle those.
 */
export function workletScopeAlive(ctx: BaseAudioContext): boolean {
  if (typeof AudioWorkletNode === "undefined") return true;
  try {
    new AudioWorkletNode(ctx, "bitcrusher-processor");
    return true;
  } catch {
    return false;
  }
}

/** Lazy worklet DSP modules — loaded on demand, grouped by physical bundle. */
export const LAZY_WORKLET_TYPES = [
  "fxeq",
  "ultina",
  "ozvena",
  "morphdynamics",
  "bassHarmonic",
  "skrutka",
  "rezonans",
  "portal",
  // Creative/voice/performance effects bundled together in
  // public/fx-extra-worklet.js. They are not part of the everyday
  // EQ/comp/delay/reverb chain, so a project that never uses them must not
  // download or parse them during studio startup.
  "vocoder",
  "vinyl",
  "beatMangler",
  "freqShifter",
  "pitchCorrect",
  "pitchShift",
  "reverseSwell",
  "granularFreeze",
  "wowFlutter",
  "tapeStop",
  "stutter",
] as const;
export type LazyWorkletType = (typeof LAZY_WORKLET_TYPES)[number];

/**
 * Effect type -> physical module. Several effects share one module; loading
 * that module marks every type it registers ready.
 */
export const LAZY_MODULE_GROUPS = {
  fxeq: "fxeq",
  ultina: "ultina",
  ozvena: "ozvena",
  morphdynamics: "morphdynamics",
  bassHarmonic: "bassHarmonic",
  skrutka: "skrutka",
  rezonans: "rezonans",
  portal: "portal",
  vocoder: "fxExtras",
  vinyl: "fxExtras",
  beatMangler: "fxExtras",
  freqShifter: "fxExtras",
  pitchCorrect: "fxExtras",
  pitchShift: "fxExtras",
  reverseSwell: "fxExtras",
  granularFreeze: "fxExtras",
  wowFlutter: "fxExtras",
  tapeStop: "fxExtras",
  stutter: "fxExtras",
} as const satisfies Record<LazyWorkletType, string>;
export type LazyWorkletModule = (typeof LAZY_MODULE_GROUPS)[LazyWorkletType];

const LAZY_MODULE_FILES: Record<LazyWorkletModule, string> = {
  fxeq: "/fxeq-worklet.js",
  ultina: "/ultina-worklet.js",
  ozvena: "/ozvena-worklet.js",
  morphdynamics: "/morph-dynamics-worklet.js",
  bassHarmonic: "/bass-harmonic-worklet.js",
  skrutka: "/skrutka-worklet.js",
  rezonans: "/rezonans-worklet.js",
  portal: "/spectral-worklet.js",
  fxExtras: "/fx-extra-worklet.js",
};

/** Number of distinct physical modules behind the lazy type list. */
export const LAZY_MODULE_GROUP_COUNT = new Set<LazyWorkletModule>(Object.values(LAZY_MODULE_GROUPS)).size;

const lazyTypesByModule = new Map<LazyWorkletModule, LazyWorkletType[]>();
for (const type of LAZY_WORKLET_TYPES) {
  const module = LAZY_MODULE_GROUPS[type];
  const group = lazyTypesByModule.get(module);
  if (group) group.push(type);
  else lazyTypesByModule.set(module, [type]);
}

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
  "karplusString",
] as const;

export type WorkletType = (typeof CORE_TYPES)[number] | LazyWorkletType | "generativePlayer";

/**
 * FLAGSHIP INSTRUMENT worklets - loaded on demand like plugin effects, NOT in
 * the core boot bundle. TSAR is ~22 KB minified (measured 2026-10-06) and a
 * beat that never adds a TSAR track must not pay for it; KOPA is a lazy
 * first-party kick designer with its own budget row. Instrument kind ->
 * worklet module (the doc-scan lives in `instrumentWorkletTypesInDoc`).
 */
export const INSTRUMENT_WORKLET_TYPES = ["tsar", "kopa", "choral"] as const;
export type InstrumentWorkletType = (typeof INSTRUMENT_WORKLET_TYPES)[number];

const INSTRUMENT_MODULE_FILES: Record<InstrumentWorkletType, string> = {
  tsar: "/tsar-worklet.js",
  kopa: "/kopa-worklet.js",
  choral: "/choral-worklet.js",
};

const readyLazyTypes = new WeakMap<BaseAudioContext, Set<LazyWorkletType>>();
const readyLazyModules = new WeakMap<BaseAudioContext, Set<LazyWorkletModule>>();
const lazyInflight = new Map<BaseAudioContext, Map<LazyWorkletModule, Promise<void>>>();
const readyInstrumentTypes = new WeakMap<BaseAudioContext, Set<InstrumentWorkletType>>();
const instrumentInflight = new Map<BaseAudioContext, Map<InstrumentWorkletType, Promise<void>>>();

export function isWorkletReady(
  type: WorkletType | InstrumentWorkletType,
  ctx: BaseAudioContext | null | undefined,
): boolean {
  if (!ctx || !readyContexts.has(ctx)) return false;
  if ((LAZY_WORKLET_TYPES as readonly string[]).includes(type)) {
    const lazyType = type as LazyWorkletType;
    if (readyLazyTypes.get(ctx)?.has(lazyType)) return true;
    // A shared module marks every type it registers; the module set is the
    // source of truth if a group's type set is ever partially populated.
    return readyLazyModules.get(ctx)?.has(LAZY_MODULE_GROUPS[lazyType]) ?? false;
  }
  if ((INSTRUMENT_WORKLET_TYPES as readonly string[]).includes(type)) {
    return readyInstrumentTypes.get(ctx)?.has(type as InstrumentWorkletType) ?? false;
  }
  if (type === "generativePlayer") return readyGenerativePlayers.has(ctx);
  return true;
}

/**
 * Load the CORE processor modules for the given context (bitcrusher +
 * core-processor). Safe to call multiple times per context; resolves
 * immediately (without loading) when the platform has no AudioWorklet
 * (jsdom) or after the core breaker went permanent for this context
 * (CORE_LOAD_ATTEMPTS failed triggers — see the constant's note).
 */
export async function loadCoreWorklets(ctx: BaseAudioContext): Promise<void> {
  if (!ctx?.audioWorklet) return; // jsdom and other non-Web-Audio environments
  if (readyContexts.has(ctx) || coreLoadExhausted(ctx)) return;
  const pending = inflight.get(ctx);
  if (pending) return pending;

  const load = (async () => {
    // Resolve the version manifest INSIDE the inflight promise: concurrent
    // callers must share one load even while the manifest fetch is pending.
    const manifest = await getWorkletManifest();
    await Promise.all([
      // These are generated self-contained files. Keeping the two-module
      // contract preserves the loader's readiness semantics while avoiding a
      // production-only Vite data-URL failure for core-processor's relative
      // imports.
      ctx.audioWorklet.addModule(new URL(workletFileUrl("/bitcrusher-worklet.js", manifest), import.meta.url).href),
      ctx.audioWorklet.addModule(new URL(workletFileUrl("/core-worklet.js", manifest), import.meta.url).href),
    ]);
    readyContexts.add(ctx);
    readyLazyTypes.set(ctx, new Set());
    // Instrument worklets (TSAR) track readiness on the same per-context
    // mark; without this set the loader could never report a loaded
    // instrument module (measured by the E2E lazy-load check).
    readyInstrumentTypes.set(ctx, new Set());
    coreFailures.delete(ctx);
  })()
    .catch((err) => {
      const attempts = (coreFailures.get(ctx) ?? 0) + 1;
      coreFailures.set(ctx, attempts);
      if (attempts >= CORE_LOAD_ATTEMPTS) {
        console.warn(
          `[audio-worklets] module load failed ${attempts}× — worklets stay on fallbacks for this context:`,
          err,
        );
      } else {
        console.warn(
          `[audio-worklets] module load failed (attempt ${attempts}/${CORE_LOAD_ATTEMPTS}) — will retry on the next trigger:`,
          err,
        );
      }
    })
    .finally(() => {
      inflight.delete(ctx);
    });
  inflight.set(ctx, load);
  return load;
}

/** Load the bounded generative PCM player only when a generative track starts. */
export async function loadGenerativePlayerWorklet(ctx: BaseAudioContext): Promise<void> {
  if (!ctx?.audioWorklet) return;
  await loadCoreWorklets(ctx);
  if (coreLoadExhausted(ctx) || readyGenerativePlayers.has(ctx)) return;
  const pending = generativePlayerInflight.get(ctx);
  if (pending) return pending;

  const load = (async () => {
    const manifest = await getWorkletManifest();
    await ctx.audioWorklet.addModule(
      new URL(workletFileUrl("/generative-player-worklet.js", manifest), import.meta.url).href,
    );
    readyGenerativePlayers.add(ctx);
  })()
    .catch((err) => {
      console.warn("[audio-worklets] generative player module load failed:", err);
    })
    .finally(() => {
      generativePlayerInflight.delete(ctx);
    });
  generativePlayerInflight.set(ctx, load);
  return load;
}

/**
 * Load ONE lazy worklet module into the context. Several effect types share a
 * physical module (`fxExtras`); requesting any of them fetches that module
 * once and marks every type it registers ready. Must run after (or together
 * with) the core modules — lazy readiness is tracked on top of the core
 * "context ready" mark. Idempotent per context and per module.
 */
export async function loadLazyWorklet(ctx: BaseAudioContext, type: LazyWorkletType): Promise<void> {
  if (!ctx?.audioWorklet) return;
  await loadCoreWorklets(ctx);
  // Under an exhausted core breaker this is a graceful no-op; a core that
  // merely failed transiently re-runs (and this call awaits that retry).
  if (coreLoadExhausted(ctx)) return;
  if (isWorkletReady(type, ctx)) return;

  const module = LAZY_MODULE_GROUPS[type];
  if (readyLazyModules.get(ctx)?.has(module)) {
    // Defensive: module landed but the per-type set did not (e.g. a partial
    // readiness reset). Mark the whole group instead of re-adding the module.
    const set = readyLazyTypes.get(ctx);
    for (const groupType of lazyTypesByModule.get(module) ?? []) set?.add(groupType);
    return;
  }

  let perCtx = lazyInflight.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    lazyInflight.set(ctx, perCtx);
  }
  const pending = perCtx.get(module);
  if (pending) return pending;

  const load = (async () => {
    const manifest = await getWorkletManifest();
    await ctx.audioWorklet.addModule(
      new URL(workletFileUrl(LAZY_MODULE_FILES[module], manifest), import.meta.url).href,
    );
    const modules = readyLazyModules.get(ctx);
    if (modules) modules.add(module);
    else readyLazyModules.set(ctx, new Set([module]));
    let set = readyLazyTypes.get(ctx);
    if (!set) {
      set = new Set();
      readyLazyTypes.set(ctx, set);
    }
    for (const groupType of lazyTypesByModule.get(module) ?? []) set.add(groupType);
  })()
    .catch((err) => {
      console.warn(`[audio-worklets] ${module} module load failed (${type}), effect stays bypassed:`, err);
    })
    .finally(() => {
      perCtx.delete(module);
      if (perCtx.size === 0) lazyInflight.delete(ctx);
    });
  perCtx.set(module, load);
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
  // Under an exhausted core breaker this is a graceful no-op; a core that
  // merely failed transiently re-runs (and this call awaits that retry).
  if (coreLoadExhausted(ctx)) return;
  const instrumentSet = readyInstrumentTypes.get(ctx);
  if (instrumentSet?.has(type)) return;

  let perCtx = instrumentInflight.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    instrumentInflight.set(ctx, perCtx);
  }
  const pending = perCtx.get(type);
  if (pending) return pending;

  const load = (async () => {
    const manifest = await getWorkletManifest();
    await ctx.audioWorklet.addModule(
      new URL(workletFileUrl(INSTRUMENT_MODULE_FILES[type], manifest), import.meta.url).href,
    );
    readyInstrumentTypes.get(ctx)?.add(type);
  })()
    .catch((err) => {
      console.warn(`[audio-worklets] ${type} instrument module load failed, factory keeps its fallback:`, err);
    })
    .finally(() => {
      perCtx.delete(type);
      if (perCtx.size === 0) instrumentInflight.delete(ctx);
    });
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
    loadGenerativePlayerWorklet(ctx),
  ]);
}
