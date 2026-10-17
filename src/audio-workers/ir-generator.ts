/**
 * Impulse Response Generator Web Worker.
 *
 * Generates stereo impulse response buffers for the reverb effect.
 * Runs off the main thread so parameter changes (decay) don't cause glitches.
 *
 * Input message: { decay: number, sampleRate: number, seed: number }
 * Output message: { left: Float32Array, right: Float32Array, length: number }
 */

// Mulberry32 PRNG — deterministic from seed
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

self.onmessage = (e: MessageEvent<unknown>) => {
  // AudioWorklet/Worker messages are raw structured clones — never trust the
  // shape (canonical contract: onset-detector.ts / warp-render.ts). A bad
  // payload must be dropped, not turned into a giant allocation: decay is
  // multiplied by sampleRate into the buffer length, so an unclamped value is
  // an OOM waiting to happen.
  const data = e.data;
  if (data == null || typeof data !== "object") return;
  const { decay, sampleRate, seed } = data as { decay?: unknown; sampleRate?: unknown; seed?: unknown };
  if (
    typeof decay !== "number" ||
    !Number.isFinite(decay) ||
    decay <= 0 ||
    decay > 60 ||
    typeof sampleRate !== "number" ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 768_000 ||
    typeof seed !== "number" ||
    !Number.isFinite(seed)
  ) {
    return;
  }
  const length = Math.max(1, Math.floor(sampleRate * decay));
  const rand = mulberry32(seed);

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const env = Math.pow(1 - i / length, 2.4);
    left[i] = (rand() * 2 - 1) * env;
    right[i] = (rand() * 2 - 1) * env;
  }

  // Transfer the ArrayBuffers for zero-copy
  self.postMessage({ left, right, length }, { transfer: [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer] });
};

// Without this, the file is a TypeScript *script* rather than a module, and the
// `mulberry32` above lands in the whole program's global scope. tsc then accepts
// `mulberry32(...)` in any file under src/ with no import at all - green
// typecheck, ReferenceError at runtime. The worker is already instantiated with
// `{ type: "module" }` in src/effects/registry.ts, so this changes nothing at
// runtime; it only puts the declaration back in module scope where it belongs.
export {};
