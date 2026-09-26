import type { Track } from "../project-model/types";
import type { BeatmakingEffectChain } from "./chains";

/** A single parameter driven by a source macro. Values are intentionally
 * explicit so a macro can move several devices as one musical gesture. */
export interface SourceMacroTarget {
  slot: number;
  paramId: string;
  from: number;
  to: number;
}

export interface SourceMacro {
  label: string;
  defaultValue: number;
  targets: readonly SourceMacroTarget[];
}

export interface SourceProfile {
  id: SourceProfileId;
  label: string;
  description: string;
  chainId: string;
  macros: readonly SourceMacro[];
}

export const SOURCE_PROFILE_IDS = ["kick", "snare", "hat", "808", "loop", "vocalChop"] as const;
export type SourceProfileId = (typeof SOURCE_PROFILE_IDS)[number];

const macro = (label: string, defaultValue: number, targets: readonly SourceMacroTarget[]): SourceMacro => ({
  label,
  defaultValue,
  targets,
});

/**
 * Source-first starting points for the bottom dock. These are deliberately
 * short chains: a beatmaker can load one, then shape the result with three
 * high-value controls without opening a full plugin panel.
 */
export const SOURCE_PROFILES: readonly SourceProfile[] = [
  {
    id: "kick",
    label: "KICK",
    description: "Transient and ceiling for a forward, controlled kick.",
    chainId: "kick-punch",
    macros: [
      macro("PUNCH", 0.65, [
        { slot: 0, paramId: "attack", from: 0.25, to: 0.9 },
        { slot: 1, paramId: "drive", from: 0.12, to: 0.3 },
      ]),
      macro("BODY", 0.4, [{ slot: 0, paramId: "sustain", from: -0.5, to: 0.25 }]),
      macro("TIGHT", 0.55, [
        { slot: 0, paramId: "sensitivity", from: 0.45, to: 0.9 },
        { slot: 1, paramId: "softness", from: 0.38, to: 0.12 },
      ]),
    ],
  },
  {
    id: "snare",
    label: "SNARE",
    description: "Snap, body and tape crack for a beat-ready snare.",
    chainId: "snare-snap",
    macros: [
      macro("SNAP", 0.6, [
        { slot: 0, paramId: "attack", from: 0.3, to: 0.95 },
        { slot: 1, paramId: "drive", from: 0.25, to: 0.72 },
      ]),
      macro("BODY", 0.45, [{ slot: 0, paramId: "sustain", from: -0.45, to: 0.4 }]),
      macro("CRACK", 0.35, [
        { slot: 1, paramId: "tone", from: 3500, to: 9500 },
        { slot: 1, paramId: "hysteresis", from: 0.25, to: 0.75 },
      ]),
    ],
  },
  {
    id: "hat",
    label: "HAT",
    description: "Stereo taps and a filtered RYFT tail for hats.",
    chainId: "hat-space",
    macros: [
      macro("WIDTH", 0.65, [
        { slot: 0, paramId: "spread", from: 0.25, to: 1 },
        { slot: 1, paramId: "spread", from: 0.3, to: 1 },
      ]),
      macro("SPACE", 0.35, [
        { slot: 0, paramId: "mix", from: 0.08, to: 0.34 },
        { slot: 1, paramId: "mix", from: 0.08, to: 0.34 },
      ]),
      macro("BITE", 0.6, [
        { slot: 0, paramId: "tone", from: 4800, to: 10000 },
        { slot: 1, paramId: "toneLp", from: 5200, to: 12000 },
      ]),
    ],
  },
  {
    id: "808",
    label: "808",
    description: "Upper harmonics, low-end weight and mono-safe presence.",
    chainId: "808-harmonics",
    macros: [
      macro("HARMONICS", 0.5, [
        { slot: 0, paramId: "drive", from: 0.25, to: 0.78 },
        { slot: 0, paramId: "mix", from: 0.55, to: 0.9 },
      ]),
      macro("WEIGHT", 0.5, [{ slot: 1, paramId: "lowShelfGain", from: -2, to: 3 }]),
      macro("PRESENCE", 0.35, [
        { slot: 1, paramId: "highShelfGain", from: -1, to: 3 },
        { slot: 1, paramId: "highShelfFreq", from: 5500, to: 9500 },
      ]),
    ],
  },
  {
    id: "loop",
    label: "LOOP",
    description: "Dust, wobble and warm tape for a finished loop texture.",
    chainId: "dusty-loop",
    macros: [
      macro("DUST", 0.4, [
        { slot: 0, paramId: "amount", from: 0.2, to: 0.8 },
        { slot: 0, paramId: "crackle", from: 0.12, to: 0.7 },
        { slot: 0, paramId: "hiss", from: 0.12, to: 0.55 },
      ]),
      macro("WOBBLE", 0.3, [
        { slot: 0, paramId: "wow", from: 0.1, to: 0.75 },
        { slot: 0, paramId: "flutter", from: 0.08, to: 0.4 },
      ]),
      macro("WARMTH", 0.45, [
        { slot: 1, paramId: "drive", from: 0.18, to: 0.58 },
        { slot: 1, paramId: "tone", from: 8500, to: 4200 },
      ]),
    ],
  },
  {
    id: "vocalChop",
    label: "VOCAL",
    description: "Pitch and tempo-repeat controls for instant vocal chops.",
    chainId: "vocal-chop",
    macros: [
      macro("PITCH", 0.35, [{ slot: 0, paramId: "semitones", from: -7, to: 5 }]),
      macro("REPEAT", 0.55, [
        { slot: 1, paramId: "chance", from: 0.15, to: 0.95 },
        { slot: 1, paramId: "mix", from: 0.55, to: 1 },
      ]),
      macro("WIDTH", 0.45, [
        { slot: 0, paramId: "width", from: 0.2, to: 1 },
        { slot: 1, paramId: "gate", from: 1, to: 5 },
      ]),
    ],
  },
];

export function sourceProfileOf(id: SourceProfileId): SourceProfile {
  return SOURCE_PROFILES.find((profile) => profile.id === id) ?? SOURCE_PROFILES[0];
}

/** Infer a useful initial tab from the current track and selected drum pad. */
export function sourceProfileForTrack(track: Track, selectedPadId = ""): SourceProfileId {
  if (track.kind === "drum") {
    const pad = track.pads.find((candidate) => candidate.id === selectedPadId);
    const name = `${pad?.name ?? ""} ${track.name}`.toLowerCase();
    if (/kick|808|bass drum/.test(name)) return "kick";
    if (/snare|clap|rim/.test(name)) return "snare";
    if (/hat|hh|cymbal|shaker/.test(name)) return "hat";
    return "kick";
  }
  if (track.kind === "instrument") {
    if (track.instrument === "808" || track.instrument === "bass" || track.instrument === "logdrum") return "808";
    if (track.instrument === "vocalchop" || /vocal|vox|voice|chop/.test(track.name.toLowerCase())) return "vocalChop";
    return "loop";
  }
  return "loop";
}

export function sourceChainOf(
  profile: SourceProfile,
  chains: readonly BeatmakingEffectChain[],
): BeatmakingEffectChain | null {
  return chains.find((chain) => chain.id === profile.chainId) ?? null;
}
