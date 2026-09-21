/** Deterministic multi-channel -> mono averaging (no clipping). Ported from audiokey `src/audio/mono.ts`. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();
  const length = channels[0].length;
  const out = new Float32Array(length);
  const n = channels.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < n; c++) sum += channels[c][i] ?? 0;
    out[i] = sum / n;
  }
  return out;
}
