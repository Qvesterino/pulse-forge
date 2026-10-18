/**
 * AudioBufferSourceNode playback-rate ratio for previewing a loop at a target
 * tempo. Slowing a 120 BPM source to 90 BPM uses 0.75; the clip stretch path
 * stores the reciprocal duration factor because it preserves pitch.
 */
export function loopPreviewPlaybackRate(sourceBpm: number, targetBpm: number): number {
  if (!Number.isFinite(sourceBpm) || sourceBpm <= 0 || !Number.isFinite(targetBpm) || targetBpm <= 0) return 1;
  return Math.min(4, Math.max(0.25, targetBpm / sourceBpm));
}
