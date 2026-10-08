export const FLAC_SUPPORTED_SAMPLE_RATES = [
  8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
] as const;

export function isFlacSampleRateSupported(sampleRate: number): boolean {
  return Number.isInteger(sampleRate) && (FLAC_SUPPORTED_SAMPLE_RATES as readonly number[]).includes(sampleRate);
}

export function formatFlacSupportedSampleRates(): string {
  return FLAC_SUPPORTED_SAMPLE_RATES.map((rate) => `${rate / 1000} kHz`).join(", ");
}
