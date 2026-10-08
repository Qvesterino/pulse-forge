export const MASTERING_RENDER_SAMPLE_RATES = [44_100, 48_000, 96_000] as const;

export type MasteringRenderSampleRate = (typeof MASTERING_RENDER_SAMPLE_RATES)[number];

export const MASTERING_RENDER_SAMPLE_RATE_LABELS: Record<MasteringRenderSampleRate, string> = {
  44_100: "44.1 kHz",
  48_000: "48 kHz",
  96_000: "96 kHz",
};
