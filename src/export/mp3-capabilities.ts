export const MP3_SUPPORTED_SAMPLE_RATES = [
  8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000,
] as const;

export function isMp3SampleRateSupported(sampleRate: number): boolean {
  return Number.isInteger(sampleRate) && (MP3_SUPPORTED_SAMPLE_RATES as readonly number[]).includes(sampleRate);
}
