// AUDIO TARGET PROFILES — all 19 Genre-union members (W0.1).
//
// Values are INFORMED estimates derived from known BPM ranges, spectral
// characteristics and production conventions per genre. When
// `npm run references:genres` runs against a live server, these are
// overwritten with MEASURED values (BS.1770 + spectral analysis of full
// reference renders per genre).
//
// The bootstrap stub was empty — it existed to break a circular import
// (audio-feedback.ts imports this file, which imports audio-feedback.ts
// through the song builder). These informed values fix D1: 15 of 19 genres
// no longer score against the house profile.

export type GeneratedAudioTarget = {
  rmsRange: [number, number];
  crestRange: [number, number];
  zcrRange: [number, number];
  bassRange: [number, number];
};

export const GENERATED_AUDIO_TARGETS: Record<string, GeneratedAudioTarget> = {
  house: {
    rmsRange: [0.05, 0.3],
    crestRange: [1, 8],
    zcrRange: [0.01, 0.15],
    bassRange: [0.15, 0.6],
  },
  techno: {
    rmsRange: [0.08, 0.35],
    crestRange: [1, 8],
    zcrRange: [0.005, 0.1],
    bassRange: [0.25, 0.7],
  },
  trap: {
    rmsRange: [0.04, 0.25],
    crestRange: [1, 20],
    zcrRange: [0.005, 0.12],
    bassRange: [0.3, 0.8],
  },
  ambient: {
    rmsRange: [0.01, 0.12],
    crestRange: [1, 30],
    zcrRange: [0.005, 0.08],
    bassRange: [0.1, 0.5],
  },
  dnb: {
    rmsRange: [0.06, 0.32],
    crestRange: [1, 10],
    zcrRange: [0.02, 0.18],
    bassRange: [0.2, 0.65],
  },
  drill: {
    rmsRange: [0.04, 0.28],
    crestRange: [1, 18],
    zcrRange: [0.005, 0.12],
    bassRange: [0.28, 0.75],
  },
  phonk: {
    rmsRange: [0.05, 0.25],
    crestRange: [1, 15],
    zcrRange: [0.003, 0.08],
    bassRange: [0.3, 0.8],
  },
  jersey: {
    rmsRange: [0.07, 0.35],
    crestRange: [1, 8],
    zcrRange: [0.015, 0.15],
    bassRange: [0.2, 0.65],
  },
  ukg: {
    rmsRange: [0.05, 0.3],
    crestRange: [1, 12],
    zcrRange: [0.01, 0.14],
    bassRange: [0.2, 0.7],
  },
  amapiano: {
    rmsRange: [0.04, 0.28],
    crestRange: [1, 15],
    zcrRange: [0.008, 0.12],
    bassRange: [0.25, 0.7],
  },
  boombap: {
    rmsRange: [0.05, 0.28],
    crestRange: [1, 15],
    zcrRange: [0.008, 0.12],
    bassRange: [0.15, 0.55],
  },
  chiptune: {
    rmsRange: [0.06, 0.3],
    crestRange: [1, 25],
    zcrRange: [0.08, 0.4],
    bassRange: [0.02, 0.3],
  },
  detroit: {
    rmsRange: [0.08, 0.35],
    crestRange: [1, 8],
    zcrRange: [0.005, 0.1],
    bassRange: [0.28, 0.72],
  },
  drone: {
    rmsRange: [0.005, 0.08],
    crestRange: [1, 40],
    zcrRange: [0.002, 0.06],
    bassRange: [0.1, 0.55],
  },
  eurodance: {
    rmsRange: [0.08, 0.35],
    crestRange: [1, 6],
    zcrRange: [0.015, 0.15],
    bassRange: [0.15, 0.55],
  },
  hyperpop: {
    rmsRange: [0.1, 0.4],
    crestRange: [1, 5],
    zcrRange: [0.03, 0.3],
    bassRange: [0.1, 0.5],
  },
  latin: {
    rmsRange: [0.05, 0.3],
    crestRange: [1, 14],
    zcrRange: [0.01, 0.14],
    bassRange: [0.12, 0.55],
  },
  postrock: {
    rmsRange: [0.01, 0.2],
    crestRange: [1, 35],
    zcrRange: [0.005, 0.1],
    bassRange: [0.08, 0.5],
  },
  trance: {
    rmsRange: [0.08, 0.35],
    crestRange: [1, 6],
    zcrRange: [0.015, 0.15],
    bassRange: [0.15, 0.55],
  },
};
