globalThis.sampleRate = 48000;
const { TsarProcessor } = await import("../src/tsar/dsp/tsarProcessor.ts").catch(
  async () => await import("../src/tsar/dsp/tsarProcessor.js"),
);
