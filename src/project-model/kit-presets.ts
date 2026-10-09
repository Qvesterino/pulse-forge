import type { DrumSynthConfig, SampleLayer } from "./types";

export interface KitPreset {
  id: string;
  name: string;
  genre: string;
  description: string;
  pads: Array<{
    idx: number; // 0..15
    assetId: string | null;
    synth?: DrumSynthConfig | null;
    gain?: number;
    pan?: number;
    chokeGroup?: number | null;
    pitch?: number;
    /**
     * Round-robin / velocity variant set carried onto the pad by the dice kit
     * swap (resolveKitAssignments). Members must resolve in the factory bank
     * (asset or a derived `.rr2/.rr3` variant) and MUST include the pad's own
     * assetId — a set that drops the pad's voice would change its sound.
     */
    layers?: SampleLayer[];
  }>;
}

function s(
  idx: number,
  assetId: string | null,
  opts: Partial<{
    synth: DrumSynthConfig | null;
    gain: number;
    pan: number;
    chokeGroup: number | null;
    layers: SampleLayer[];
  }> = {},
): KitPreset["pads"][number] {
  return {
    idx,
    assetId,
    synth: opts.synth ?? null,
    gain: opts.gain,
    pan: opts.pan,
    chokeGroup: opts.chokeGroup,
    ...(opts.layers ? { layers: opts.layers } : {}),
  };
}

/** Full-window round-robin set over the bank's derived variants (RR_VARIATIONS). */
function rr(sampleId: string): SampleLayer[] {
  return [sampleId, `${sampleId}.rr2`, `${sampleId}.rr3`].map((id, i) => ({
    id: `layer.kit.rr.${i}`,
    sampleId: id,
    min: 0,
    max: 1,
  }));
}

/** Velocity-DYNAMIC set: ghost timbre under soft hits, the body pool rotating, an optional hard accent. */
function dyn(ghost: string, mains: string[], accent?: string): SampleLayer[] {
  const ghostMax = 0.35;
  const bodyMax = accent ? 0.8 : 1;
  const layers: SampleLayer[] = [{ id: "layer.kit.dyn.ghost", sampleId: ghost, min: 0, max: ghostMax }];
  mains.forEach((sampleId, i) => {
    layers.push({ id: `layer.kit.dyn.main.${i}`, sampleId, min: ghostMax, max: bodyMax });
  });
  if (accent) layers.push({ id: "layer.kit.dyn.accent", sampleId: accent, min: 0.8, max: 1 });
  return layers;
}

/** The stock-kit dynamic sets, mirrored inline (kit-presets stays project-model-local — no sample-library import). */
const SNARE_DYNAMIC = dyn(
  "factory.snare.tight",
  ["factory.snare.main", "factory.snare.main.rr2", "factory.snare.main.rr3"],
  "factory.snare.punch",
);
const HAT_DYNAMIC = dyn("factory.hat.closed.soft", [
  "factory.hat.closed",
  "factory.hat.closed.rr2",
  "factory.hat.closed.rr3",
]);
const KICK_PUNCH_RR = rr("factory.kick.punch");
const TIMBALE_RR = rr("factory.perc.timbale");
const BONGOS_RR = rr("factory.perc.bongos");
const CONGA_HIGH_RR = rr("factory.perc.conga.high");
const SHAKER_FAST_RR = rr("factory.shaker.fast");

export const KIT_PRESETS: KitPreset[] = [
  {
    id: "house-classic",
    name: "House Classic",
    genre: "house",
    description: "Punchy house — deep kick, tight snare, crisp hats",
    pads: [
      s(0, "factory.kick.deep", { chokeGroup: 1 }),
      s(1, "factory.kick.punch", { chokeGroup: 1, gain: 0.9 }),
      s(2, "factory.kick.soft", { chokeGroup: 1, gain: 0.85 }),
      s(3, "factory.rim.chip"),
      s(4, "factory.snare.main"),
      s(5, "factory.snare.tight", { gain: 0.9 }),
      s(6, "factory.clap.main"),
      s(7, "factory.shaker.soft"),
      s(8, "factory.hat.closed", { chokeGroup: 2 }),
      s(9, "factory.hat.closed.soft", { chokeGroup: 2, gain: 0.6 }),
      s(10, "factory.hat.open", { chokeGroup: 2 }),
      s(11, "factory.ride.ping", { chokeGroup: 2, gain: 0.85 }),
      s(12, "factory.tom.low"),
      s(13, "factory.tom.high", { gain: 0.9 }),
      s(14, "factory.perc.tick", { gain: 0.7 }),
      s(15, "factory.perc.blip"),
    ],
  },
  {
    id: "techno-drive",
    name: "Techno Drive",
    genre: "techno",
    description: "Driving techno — distorted kick, dark hats, industrial",
    pads: [
      s(0, "factory.kick.techno", { chokeGroup: 1 }),
      s(1, "factory.kick.deep", { chokeGroup: 1, gain: 0.85, pan: -0.05 }),
      s(2, "factory.kick.909", { chokeGroup: 1, gain: 0.8 }),
      s(3, "factory.rim.chip", { gain: 0.6 }),
      s(4, "factory.snare.punch", { gain: 0.95 }),
      s(5, "factory.snare.tight", { gain: 0.85 }),
      s(6, "factory.clap.soft", { gain: 0.7 }),
      s(7, "factory.shaker.soft", { gain: 0.5 }),
      s(8, "factory.hat.closed", { chokeGroup: 2 }),
      s(9, "factory.hat.pedal", { chokeGroup: 2, gain: 0.7 }),
      s(10, "factory.hat.open.short", { chokeGroup: 2, gain: 0.85 }),
      s(11, "factory.crash.dark", { chokeGroup: 2, gain: 0.6 }),
      s(12, "factory.tom.low", { gain: 0.9 }),
      s(13, "factory.tom.mid", { gain: 0.9 }),
      s(14, "factory.perc.tick", { gain: 0.6, pan: 0.1 }),
      s(15, "factory.fx.noise", { gain: 0.5 }),
    ],
  },
  {
    id: "trap-808",
    name: "Trap 808",
    genre: "trap",
    description: "Modern trap — 808 sub, trap snare, crisp hats",
    pads: [
      s(0, "factory.kick.sub808", { chokeGroup: 1 }),
      s(1, "factory.kick.trap", { chokeGroup: 1, gain: 0.9 }),
      s(2, "factory.kick.808pure", { chokeGroup: 1, gain: 0.8 }),
      s(3, "factory.rim.chip", { gain: 0.7 }),
      s(4, "factory.snare.trap", { gain: 0.95 }),
      s(5, "factory.snare.punch", { gain: 0.9 }),
      s(6, "factory.clap.soft", { gain: 0.75 }),
      s(7, "factory.shaker.soft", { gain: 0.4 }),
      s(8, "factory.hat.closed", { chokeGroup: 2 }),
      s(9, "factory.hat.closed.soft", { chokeGroup: 2, gain: 0.65 }),
      s(10, "factory.hat.open.short", { chokeGroup: 2, gain: 0.8 }),
      s(11, "factory.ride.ping", { chokeGroup: 2, gain: 0.5 }),
      s(12, "factory.tom.low", { gain: 0.8, pan: -0.15 }),
      s(13, "factory.tom.high", { gain: 0.8, pan: 0.15 }),
      s(14, "factory.perc.tick", { gain: 0.6 }),
      s(15, "factory.perc.blip", { gain: 0.85 }),
    ],
  },
  {
    id: "ukg-breaks",
    name: "UKG Breaks",
    genre: "house",
    description: "UK garage / breaks — shuffled, percussive",
    pads: [
      s(0, "factory.kick.punch", { chokeGroup: 1 }),
      s(1, "factory.kick.soft", { chokeGroup: 1, gain: 0.8 }),
      s(2, "factory.kick.deep", { chokeGroup: 1, gain: 0.75 }),
      s(3, "factory.rim.chip"),
      s(4, "factory.snare.main", { gain: 0.9 }),
      s(5, "factory.snare.tight", { gain: 0.85, pan: 0.08 }),
      s(6, "factory.clap.main", { gain: 0.9 }),
      s(7, "factory.perc.conga", { gain: 0.8, pan: -0.12 }),
      s(8, "factory.hat.closed", { chokeGroup: 2 }),
      s(9, "factory.hat.pedal", { chokeGroup: 2, gain: 0.7 }),
      s(10, "factory.hat.open", { chokeGroup: 2, gain: 0.85 }),
      s(11, "factory.perc.tambourine", { chokeGroup: 2, gain: 0.75 }),
      s(12, "factory.tom.low", { gain: 0.85 }),
      s(13, "factory.tom.high", { gain: 0.85 }),
      s(14, "factory.perc.cowbell", { gain: 0.7, pan: 0.15 }),
      s(15, "factory.shaker.soft", { gain: 0.6 }),
    ],
  },
  {
    id: "minimal",
    name: "Minimal",
    genre: "techno",
    description: "Minimal — stripped, clicky, subtle",
    pads: [
      s(0, "factory.kick.soft", { chokeGroup: 1 }),
      s(1, "factory.kick.deep", { chokeGroup: 1, gain: 0.8 }),
      s(2, null, { synth: { type: "kick", decay: 0.12, tone: 120, snap: 0.4, body: 0.3 }, chokeGroup: 1 }),
      s(3, "factory.rim.chip", { gain: 0.6 }),
      s(4, "factory.snare.tight", { gain: 0.7 }),
      s(5, null, { synth: { type: "clap", decay: 0.15, tone: 2800, snap: 0.6, body: 0.2 } }),
      s(6, "factory.clap.soft", { gain: 0.6 }),
      s(7, "factory.perc.tick", { gain: 0.5, pan: -0.08 }),
      s(8, "factory.hat.closed", { chokeGroup: 2, gain: 0.7 }),
      s(9, null, { synth: { type: "hatClosed", decay: 0.06, tone: 8000, snap: 0.3, body: 0.2 }, chokeGroup: 2 }),
      s(10, "factory.hat.open.short", { chokeGroup: 2, gain: 0.6 }),
      s(11, "factory.shaker.soft", { chokeGroup: 2, gain: 0.4 }),
      s(12, "factory.tom.low", { gain: 0.6 }),
      s(13, "factory.tom.mid", { gain: 0.6 }),
      s(14, "factory.perc.blip", { gain: 0.5, pan: 0.1 }),
      s(15, null, { synth: { type: "perc", decay: 0.09, tone: 1500, snap: 0.5, body: 0.1 } }),
    ],
  },
  {
    id: "dark-rumble",
    name: "Dark Rumble",
    genre: "techno",
    description: "Dark warehouse — boomy, aggressive",
    pads: [
      s(0, "factory.kick.techno", { chokeGroup: 1 }),
      s(1, "factory.kick.808drive", { chokeGroup: 1, gain: 0.85 }),
      s(2, "factory.kick.deep", { chokeGroup: 1, gain: 0.8 }),
      s(3, "factory.rim.chip", { gain: 0.5 }),
      s(4, "factory.snare.punch", { gain: 0.9 }),
      s(5, "factory.snare.trap", { gain: 0.85 }),
      s(6, "factory.fx.impact", { gain: 0.7 }),
      s(7, "factory.fx.reverse", { gain: 0.6 }),
      s(8, "factory.hat.closed", { chokeGroup: 2 }),
      s(9, "factory.hat.closed.soft", { chokeGroup: 2, gain: 0.55 }),
      s(10, "factory.crash.dark", { chokeGroup: 2, gain: 0.65 }),
      s(11, "factory.crash.main", { chokeGroup: 2, gain: 0.5 }),
      s(12, "factory.tom.low", { gain: 0.9, pan: -0.1 }),
      s(13, "factory.tom.mid", { gain: 0.9, pan: 0.1 }),
      s(14, "factory.fx.noise", { gain: 0.5, pan: -0.12 }),
      s(15, "factory.fx.riser", { gain: 0.6, pan: 0.12 }),
    ],
  },
  {
    id: "bright-perc",
    name: "Bright Perc",
    genre: "ambient",
    description: "Bright & airy — percussion heavy, open",
    pads: [
      s(0, "factory.kick.soft", { chokeGroup: 1, gain: 0.85 }),
      s(1, "factory.kick.deep", { chokeGroup: 1, gain: 0.7 }),
      s(2, null, { synth: { type: "kick", decay: 0.2, tone: 90, snap: 0.2, body: 0.5 }, chokeGroup: 1 }),
      s(3, "factory.rim.chip", { gain: 0.7, pan: -0.1 }),
      s(4, "factory.snare.main", { gain: 0.75 }),
      s(5, "factory.clap.soft", { gain: 0.7, pan: 0.08 }),
      s(6, "factory.perc.conga", { gain: 0.85, pan: -0.15 }),
      s(7, "factory.perc.tambourine", { gain: 0.8, pan: 0.15 }),
      s(8, "factory.hat.closed.soft", { chokeGroup: 2, gain: 0.6 }),
      s(9, "factory.shaker.soft", { chokeGroup: 2, gain: 0.65 }),
      s(10, "factory.hat.open.short", { chokeGroup: 2, gain: 0.7 }),
      s(11, "factory.ride.bell", { chokeGroup: 2, gain: 0.75 }),
      s(12, "factory.tom.mid", { gain: 0.8 }),
      s(13, "factory.tom.high", { gain: 0.8 }),
      s(14, "factory.perc.cowbell", { gain: 0.75 }),
      s(15, "factory.perc.blip", { gain: 0.6 }),
    ],
  },
  {
    id: "live-kit",
    name: "Live Kit",
    genre: "house",
    description: "Live drums — acoustic feel, warm",
    pads: [
      s(0, "factory.kick.punch", { chokeGroup: 1 }),
      s(1, "factory.kick.deep", { chokeGroup: 1, gain: 0.85 }),
      s(2, "factory.kick.soft", { chokeGroup: 1, gain: 0.8 }),
      s(3, "factory.rim.chip", { gain: 0.85 }),
      s(4, "factory.snare.main", { gain: 0.95, pan: 0.02 }),
      s(5, "factory.snare.tight", { gain: 0.9, pan: -0.02 }),
      s(6, "factory.clap.main", { gain: 0.8 }),
      s(7, "factory.perc.conga", { gain: 0.75 }),
      s(8, "factory.hat.closed", { chokeGroup: 2 }),
      s(9, "factory.hat.pedal", { chokeGroup: 2, gain: 0.75 }),
      s(10, "factory.hat.open", { chokeGroup: 2 }),
      s(11, "factory.ride.ping", { chokeGroup: 2, gain: 0.9 }),
      s(12, "factory.tom.low", { gain: 0.9, pan: -0.12 }),
      s(13, "factory.tom.high", { gain: 0.9, pan: 0.12 }),
      s(14, "factory.perc.tambourine", { gain: 0.7 }),
      s(15, "factory.shaker.soft", { gain: 0.75 }),
    ],
  },
  {
    id: "latin-perc",
    name: "Latin Percussion",
    genre: "latin",
    description: "Latin percussion — congas, bongos, timbale, cajón, agogô",
    pads: [
      s(0, "factory.kick.soft", { chokeGroup: 1 }),
      s(1, "factory.kick.deep", { chokeGroup: 1, gain: 0.85 }),
      s(2, "factory.perc.cajon", { chokeGroup: 1, gain: 0.9 }),
      s(3, "factory.rim.chip", { gain: 0.7 }),
      s(4, "factory.perc.timbale", { gain: 0.9, layers: TIMBALE_RR }),
      s(5, "factory.clap.soft", { gain: 0.7 }),
      s(6, "factory.perc.bongos", { gain: 0.9, layers: BONGOS_RR }),
      s(7, "factory.perc.conga.high", { gain: 0.85, pan: -0.1, layers: CONGA_HIGH_RR }),
      s(8, "factory.shaker.fast", { chokeGroup: 2, layers: SHAKER_FAST_RR }),
      s(9, "factory.perc.agogo", { gain: 0.8, pan: 0.15 }),
      s(10, "factory.perc.conga", { gain: 0.8 }),
      s(11, "factory.perc.tambourine", { chokeGroup: 2, gain: 0.7 }),
      s(12, "factory.tom.low", { gain: 0.85 }),
      s(13, "factory.perc.cowbell", { gain: 0.75, pan: 0.1 }),
      s(14, "factory.perc.tick", { gain: 0.6 }),
      s(15, "factory.perc.blip", { gain: 0.6 }),
    ],
  },
  {
    id: "jazz-kit",
    name: "Jazz Combo",
    genre: "jazz",
    description: "Jazz combo — washey ride comping, soft kick, brushed backbeat",
    pads: [
      s(0, "factory.kick.soft", { chokeGroup: 1, gain: 0.9 }),
      s(1, "factory.kick.punch", { chokeGroup: 1, gain: 0.75 }),
      s(2, "factory.perc.cajon", { gain: 0.7 }),
      s(3, "factory.rim.chip", { gain: 0.8 }),
      s(4, "factory.snare.tight", { gain: 0.8 }),
      s(5, "factory.snare.main", { gain: 0.7, layers: SNARE_DYNAMIC }),
      s(6, "factory.clap.soft", { gain: 0.5 }),
      s(7, "factory.perc.conga.high", { gain: 0.6, pan: -0.08, layers: CONGA_HIGH_RR }),
      s(8, "factory.hat.closed.soft", { chokeGroup: 2, gain: 0.7, layers: HAT_DYNAMIC }),
      s(9, "factory.hat.pedal", { chokeGroup: 2, gain: 0.6 }),
      s(10, "factory.ride.jazz", { chokeGroup: 2, gain: 0.9 }),
      s(11, "factory.ride.bell", { chokeGroup: 2, gain: 0.65 }),
      s(12, "factory.tom.low", { gain: 0.75 }),
      s(13, "factory.tom.high", { gain: 0.75 }),
      s(14, "factory.crash.roll", { gain: 0.5 }),
      s(15, "factory.shaker.soft", { gain: 0.5 }),
    ],
  },
  {
    id: "rock-kit",
    name: "Rock Backline",
    genre: "rock",
    description: "Rock backline — cracking snare, china accent, full toms",
    pads: [
      s(0, "factory.kick.punch", { chokeGroup: 1, layers: KICK_PUNCH_RR }),
      s(1, "factory.kick.deep", { chokeGroup: 1, gain: 0.9 }),
      s(2, "factory.kick.techno", { chokeGroup: 1, gain: 0.8 }),
      s(3, "factory.rim.chip", { gain: 0.6 }),
      s(4, "factory.snare.main", { gain: 0.95, layers: SNARE_DYNAMIC }),
      s(5, "factory.snare.punch", { gain: 0.9 }),
      s(6, "factory.clap.main", { gain: 0.7 }),
      s(7, "factory.perc.cowbell", { gain: 0.65 }),
      s(8, "factory.hat.closed", { chokeGroup: 2, layers: HAT_DYNAMIC }),
      s(9, "factory.hat.open.short", { chokeGroup: 2, gain: 0.8 }),
      s(10, "factory.ride.ping", { chokeGroup: 2, gain: 0.85 }),
      s(11, "factory.crash.china", { chokeGroup: 2, gain: 0.65 }),
      s(12, "factory.tom.low", { gain: 0.9, pan: -0.1 }),
      s(13, "factory.tom.mid", { gain: 0.9, pan: 0.1 }),
      s(14, "factory.tom.high", { gain: 0.85 }),
      s(15, "factory.crash.roll", { gain: 0.6 }),
    ],
  },
];

export function getKitPresetsForGenre(genre: string): KitPreset[] {
  const byGenre = KIT_PRESETS.filter((k) => k.genre === genre);
  return byGenre.length > 0 ? byGenre : KIT_PRESETS;
}

export function resolveKitPreset(seed: string, genre: string): KitPreset {
  const pool = getKitPresetsForGenre(genre);
  // Deterministic hash → index
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = (h ^ (h >>> 16)) >>> 0;
  return pool[h % pool.length];
}

export function kitPresetById(id: string): KitPreset | undefined {
  return KIT_PRESETS.find((k) => k.id === id);
}
