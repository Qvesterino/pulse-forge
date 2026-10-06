/**
 * S4 — TENSOR LAYOUT for the htdemucs ONNX session (ADR 0019 Tier 2).
 *
 * Pure, deterministic, model-contract-only: both known ONNX exports
 * (adowu, StemSplit) follow the demucs convention
 *   input  [1, 2, N]  float32, stereo PLANAR (L then R), 44.1 kHz
 *   output [1, 8, N]  float32, 4 stems × 2 channels, same planar order
 * (vocals, drums, bass, other). The manifest may override the IO names;
 * the LAYOUT is pinned here.
 *
 * Mono pipeline in, mono stems out: the chunk is duplicated to stereo for
 * the model and the stems are folded back as (L + R) / 2.
 */

/** Mono → stereo planar [L…, R…] with L = R = mono. */
export function monoToStereoPlanar(mono: Float32Array): Float32Array {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[i] = mono[i];
    out[mono.length + i] = mono[i];
  }
  return out;
}

/** Demucs planar output [s0L, s0R, s1L, s1R, …] → mono per stem ((L+R)/2). */
export function planarToMonoStems(planar: Float32Array, stemCount: number, samplesPerStem: number): Float32Array[] {
  const stems: Float32Array[] = [];
  for (let s = 0; s < stemCount; s++) {
    const left = s * 2;
    const right = s * 2 + 1;
    const mono = new Float32Array(samplesPerStem);
    for (let i = 0; i < samplesPerStem; i++)
      mono[i] = (planar[left * samplesPerStem + i] + planar[right * samplesPerStem + i]) / 2;
    stems.push(mono);
  }
  return stems;
}

/** Linear resample (the audio-index convention) — used only when the
 * manifest sample rate differs from the pipeline rate. */
export function resampleLinear(data: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return data;
  const ratio = toRate / fromRate;
  const length = Math.max(1, Math.round(data.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i / ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = data[index] ?? 0;
    const b = data[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Trim or zero-pad a stem to the exact chunk length the grid expects. */
export function fitLength(stem: Float32Array, length: number): Float32Array {
  if (stem.length === length) return stem;
  const out = new Float32Array(length);
  out.set(stem.subarray(0, Math.min(stem.length, length)));
  return out;
}
