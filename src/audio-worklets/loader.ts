/**
 * AudioWorklet module loader. Pre-loads processor modules and provides
 * a readiness flag for synchronous factory fallback.
 *
 * Strategy: fire-and-forget load in openProject(). If a factory runs before
 * modules are loaded, it falls back to the old (WaveShaperNode / setInterval)
 * implementation. On the next syncProject cycle, modules will be ready and
 * the worklet implementation is used.
 */

let bitcrusherReady = false;
let sidechainReady = false;
let loadingPromise: Promise<void> | null = null;

export function isWorkletReady(type: "bitcrusher" | "sidechain"): boolean {
  return type === "bitcrusher" ? bitcrusherReady : sidechainReady;
}

/**
 * Pre-load all AudioWorklet processor modules for the given context.
 * Safe to call multiple times — modules are only loaded once per context.
 * Call this after `engine.useContext(ctx)` but before `engine.setProject()`.
 */
export async function loadWorkletModules(ctx: BaseAudioContext): Promise<void> {
  if (bitcrusherReady && sidechainReady) return;
  if (!loadingPromise) {
    loadingPromise = Promise.all([
      ctx.audioWorklet
        .addModule(new URL("../audio-worklets/bitcrusher-processor.js", import.meta.url).href)
        .then(() => { bitcrusherReady = true; }),
      ctx.audioWorklet
        .addModule(new URL("../audio-worklets/sidechain-processor.js", import.meta.url).href)
        .then(() => { sidechainReady = true; }),
    ]).then(() => {});
  }
  await loadingPromise;
}
