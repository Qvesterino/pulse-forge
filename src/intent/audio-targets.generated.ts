// BOOTSTRAP STUB — replace by running `npm run references:genres`.
//
// `scripts/measure-genre-references.mjs` measures genres by loading
// `src/intent/song.ts` through a live Vite dev server, and `song.ts` reaches
// `audio-feedback.ts`, which imports this module. So the generator cannot
// produce this file while this file is missing — a bootstrap cycle. This stub
// breaks the cycle so the generator can run; it carries no data.
//
// Do NOT commit this file. `npm run references:genres` overwrites it with the
// measured table. A committed empty table would silently make every audio
// target lookup fall back to defaults.
export type GeneratedAudioTarget = {
  rmsRange: [number, number];
  crestRange: [number, number];
  zcrRange: [number, number];
  bassRange: [number, number];
};

export const GENERATED_AUDIO_TARGETS: Record<string, GeneratedAudioTarget> = {};
