export type AssetCategory =
  | "Kick"
  | "Snare"
  | "Clap"
  | "Hat"
  | "Cymbal"
  | "Tom"
  | "Rim"
  | "Percussion"
  | "Tonal";

export interface FactoryAsset {
  id: string;
  name: string;
  category: AssetCategory;
  character: string;
  tags: string[];
}

export const FACTORY_ASSETS: FactoryAsset[] = [
  { id: "factory.kick.deep", name: "Kick Deep", category: "Kick", character: "Deep, Punchy", tags: ["house", "deep", "sub"] },
  { id: "factory.kick.punch", name: "Kick Punch", category: "Kick", character: "Punchy, Bright", tags: ["house", "punchy"] },
  { id: "factory.kick.techno", name: "Kick Techno", category: "Kick", character: "Driving, Distorted", tags: ["techno", "drive"] },
  { id: "factory.rim.chip", name: "Rim Chip", category: "Rim", character: "Dry, Tight", tags: ["rim", "tight"] },
  { id: "factory.snare.main", name: "Snare Main", category: "Snare", character: "Fat, Classic", tags: ["snare", "house"] },
  { id: "factory.snare.tight", name: "Snare Tight", category: "Snare", character: "Short, Dry", tags: ["snare", "tight"] },
  { id: "factory.clap.main", name: "Clap Main", category: "Clap", character: "Wide, Punchy", tags: ["clap", "house"] },
  { id: "factory.shaker.soft", name: "Shaker Soft", category: "Percussion", character: "Soft, Airy", tags: ["shaker", "groove"] },
  { id: "factory.hat.closed", name: "Hat Closed", category: "Hat", character: "Crisp, Bright", tags: ["hat", "closed"] },
  { id: "factory.hat.closed.soft", name: "Hat Closed Soft", category: "Hat", character: "Soft, Low", tags: ["hat", "closed", "soft"] },
  { id: "factory.hat.open", name: "Hat Open", category: "Hat", character: "Open, Bright", tags: ["hat", "open"] },
  { id: "factory.ride.ping", name: "Ride Ping", category: "Cymbal", character: "Metallic, Sustained", tags: ["ride", "cymbal"] },
  { id: "factory.tom.low", name: "Tom Low", category: "Tom", character: "Deep, Round", tags: ["tom", "low"] },
  { id: "factory.tom.high", name: "Tom High", category: "Tom", character: "Bright, Round", tags: ["tom", "high"] },
  { id: "factory.perc.tick", name: "Perc Tick", category: "Percussion", character: "Clicky, Tight", tags: ["perc", "click"] },
  { id: "factory.perc.blip", name: "Perc Blip", category: "Percussion", character: "Tonal, Short", tags: ["perc", "blip"] },
  { id: "factory.tonal.pluck", name: "Pluck C4", category: "Tonal", character: "Bright, Short", tags: ["pluck", "lead"] },
  { id: "factory.tonal.stab", name: "Stab C4", category: "Tonal", character: "Saw, Chord", tags: ["stab", "chord"] },
  { id: "factory.tonal.keys", name: "Keys C4", category: "Tonal", character: "Soft, Clean", tags: ["keys", "piano"] },
  { id: "factory.tonal.bell", name: "Bell C5", category: "Tonal", character: "Clear, Long", tags: ["bell", "lead"] },
];
