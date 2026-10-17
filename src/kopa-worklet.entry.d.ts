/**
 * Type-only stub for the KOPA worklet entry. The implementation is plain JS
 * on purpose — it is the classic-script bundle input for
 * AudioWorklet.addModule (see scripts/build-kopa-worklet.mjs). Importing the
 * module only executes its side effect (registerProcessor); it has no
 * exports.
 */
export {};
