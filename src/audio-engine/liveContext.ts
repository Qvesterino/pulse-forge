/**
 * Live-context guard (Wave 4b): shared by the engine facade and its
 * collaborators (masterChain, and anything after). `instanceof AudioContext`
 * is not safe in browsers that expose only the Base/Offline context globals
 * (and it throws when the constructor is absent) — keep the live-context
 * capability check in ONE place.
 */
export function isLiveAudioContext(ctx: BaseAudioContext | null | undefined): ctx is AudioContext {
  return typeof AudioContext !== "undefined" && ctx instanceof AudioContext;
}
