const MIN_MEASURABLE_AUDITION_LUFS = -119;

function isMeasurableLufs(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > MIN_MEASURABLE_AUDITION_LUFS;
}

/** Return a shared, quieter-side target only when every compared reading is usable. */
export function resolveLoudnessMatchTarget(readings: readonly (number | null)[]): number | null {
  const measurableReadings = readings.filter(isMeasurableLufs);
  if (readings.length === 0 || measurableReadings.length !== readings.length) return null;
  return Math.min(...measurableReadings);
}

/** Apply monitor-only matching without ever amplifying a side or trusting invalid measurements. */
export function getLoudnessMatchGain(
  lufsIntegrated: number | null,
  targetLufs: number | null,
  enabled: boolean,
): number {
  if (!enabled || !isMeasurableLufs(lufsIntegrated) || !isMeasurableLufs(targetLufs)) return 1;
  return Math.min(1, Math.pow(10, (targetLufs - lufsIntegrated) / 20));
}

export function formatAuditionTrim(gain: number): string {
  if (!Number.isFinite(gain)) return "unavailable";
  return `${(20 * Math.log10(Math.max(1e-12, Math.min(1, gain)))).toFixed(1)} dB`;
}
