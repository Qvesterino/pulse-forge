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

self.onmessage = (e: MessageEvent<{ decay: number; sampleRate: number; seed: number }>) => {
  const { decay, sampleRate, seed } = e.data;
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
