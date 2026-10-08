// Direct node render: the builders are pure (ctx, dest) → OfflineAudioContext
// via node's webaudio polyfill? Check what node 24 offers.
console.log("OfflineAudioContext in node:", typeof globalThis.OfflineAudioContext);
