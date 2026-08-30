import { FACTORY_ASSETS } from "./manifest";
import { forkRandom } from "../shared/rng";
import type { DrumPad, DrumSynthConfig } from "../project-model/types";
import { classifyPads } from "../assist/patternOps";
import type { DiceLocks } from "../intent/dice";
import { resolveKitPreset, kitPresetById } from "../project-model/kit-presets";

const POOLS: Record<string, string[]> = {
  kicks: FACTORY_ASSETS.filter((a) => a.category === "Kick").map((a) => a.id),
  snares: FACTORY_ASSETS.filter((a) => a.category === "Snare" || a.category === "Clap").map((a) => a.id),
  hats: FACTORY_ASSETS.filter((a) => a.category === "Hat" || a.category === "Cymbal" || a.category === "Crash").map(
    (a) => a.id,
  ),
  toms: FACTORY_ASSETS.filter((a) => a.category === "Tom").map((a) => a.id),
  percs: FACTORY_ASSETS.filter((a) => a.category === "Percussion").map((a) => a.id),
};

function poolForMood(base: string[], mood: string | null, _seed: string): string[] {
  if (!mood) return base;
  const filtered = FACTORY_ASSETS.filter((a) => (a.mood as readonly string[]).includes(mood)).map((a) => a.id);
  const intersect = base.filter((id) => filtered.includes(id));
  if (intersect.length >= 2) return intersect;
  return base;
}

/**
 * Full kit variability — preset swap + per-pad variation + synth/gain/pan/choke + user samples.
 * Returns Map<padId, Partial<DrumPad>> for pads that should be swapped.
 * When kit lock or drums lock, returns empty.
 * Preset swap is whole-kit (curated), per-pad jitter adds ±1 sample variation.
 */
export function resolveKitAssignments(
  pads: DrumPad[],
  seed: string,
  locks: DiceLocks,
  jitter: number,
  opts: {
    genre?: string;
    kitId?: string | null;
    mood?: string | null;
    userAssetIds?: string[];
  } = {},
): Map<string, Partial<DrumPad>> {
  const out = new Map<string, Partial<DrumPad>>();
  if (locks.kit || locks.drums) return out;
  const chanceRand = forkRandom(seed, "dice.kit.chance");
  if (chanceRand() > jitter * 0.7) return out;

  const genre = opts.genre ?? "house";
  const rnd = forkRandom(seed, "dice.kit");
  const fams = classifyPads(pads);

  // Merge user assets into pools (category via filename heuristic or keep as percs)
  const userIds = opts.userAssetIds ?? [];
  const userKicks = userIds.filter((id) => /kick|808|bd/i.test(id));
  const userSnares = userIds.filter((id) => /snare|clap/i.test(id));
  const userHats = userIds.filter((id) => /hat|ride|crash/i.test(id));

  const kicksPool = [...POOLS.kicks, ...userKicks];
  const snaresPool = [...POOLS.snares, ...userSnares];
  const hatsPool = [...POOLS.hats, ...userHats];

  // Resolve preset — whole kit swap
  let preset = null as ReturnType<typeof kitPresetById> | ReturnType<typeof resolveKitPreset> | null;
  if (opts.kitId) {
    preset = kitPresetById(opts.kitId) ?? null;
  } else {
    preset = resolveKitPreset(`${seed}|${genre}`, genre);
  }

  const presetMap = new Map<number, typeof preset extends null ? never : NonNullable<typeof preset>["pads"][number]>();
  if (preset) {
    for (const p of preset.pads) presetMap.set(p.idx, p);
  }

  // Helper to pick alternative within same category (for jitter variation)
  const pickAlt = (current: string | null, pool: string[], mood: string | null): string | null => {
    const base = poolForMood(pool, mood, seed);
    const alt = base.filter((id) => id !== current);
    const src = alt.length > 0 ? alt : base;
    return src[Math.floor(rnd() * src.length)] ?? current;
  };

  // Build full kit assignment from preset
  for (let idx = 0; idx < pads.length; idx++) {
    const pad = pads[idx];
    const fam = (() => {
      if (fams.kicks.some((p) => p.id === pad.id)) return "kicks" as const;
      if (fams.snares.some((p) => p.id === pad.id)) return "snares" as const;
      if (fams.hats.some((p) => p.id === pad.id)) return "hats" as const;
      return "others" as const;
    })();

    // Respect per-family locks
    if (fam === "kicks" && locks.kick) continue;
    if (fam === "snares" && locks.snare) continue;
    if (fam === "hats" && locks.hats) continue;

    // Preset base
    const presetPad = presetMap.get(idx);
    let assetId: string | null = presetPad?.assetId ?? pad.assetId;
    let synth: DrumSynthConfig | null | undefined = presetPad?.synth ?? null;
    let gain: number | undefined = presetPad?.gain;
    let pan: number | undefined = presetPad?.pan;
    let chokeGroup: number | null | undefined = presetPad?.chokeGroup;

    // Per-pad ±1 variation at jitter >0.3 (20% chance)
    if (jitter > 0.3 && rnd() < 0.2) {
      const pool =
        fam === "kicks" ? kicksPool : fam === "snares" ? snaresPool : fam === "hats" ? hatsPool : POOLS.percs;
      const alt = pickAlt(assetId, pool, opts.mood ?? null);
      if (alt) {
        assetId = alt;
        synth = null;
      }
    }

    // Synth toggle — 25% of swapped pads become synth at high jitter (techno/trap modern)
    let isSynth = false;
    if (jitter > 0.5 && rnd() < 0.25) {
      // Only hats/percs/others become synth, keep kicks/snares mostly sample for punch
      if (fam === "hats" || fam === "others") {
        const synthType = fam === "hats" ? "hatClosed" : "perc";
        synth = {
          type: synthType as DrumSynthConfig["type"],
          decay: 0.06 + rnd() * 0.25,
          tone: 4000 + rnd() * 6000,
          snap: 0.2 + rnd() * 0.4,
          body: 0.2 + rnd() * 0.3,
        };
        assetId = null;
        isSynth = true;
      }
    }

    // Gain/pan/choke jitter
    let finalGain = gain;
    let finalPan = pan;
    let finalChoke = chokeGroup;
    if (!isSynth) {
      if (gain !== undefined) {
        finalGain = Math.max(0.6, Math.min(1.4, gain + (rnd() - 0.5) * 0.3 * jitter));
        finalGain = Math.round(finalGain * 100) / 100;
      }
      if (pan !== undefined) {
        finalPan = Math.max(-0.4, Math.min(0.4, pan + (rnd() - 0.5) * 0.4 * jitter));
        finalPan = Math.round(finalPan * 100) / 100;
      }
      // Choke: at jitter>0.4 randomly drop choke for kicks 30% or add hats to 2
      if (jitter > 0.4 && rnd() < 0.15) {
        if (fam === "kicks" && chokeGroup === 1 && rnd() < 0.3) finalChoke = null;
        if (fam === "hats" && chokeGroup === 2 && rnd() < 0.2) finalChoke = 2;
      }
    }

    // Only push if differs from current pad (avoid noop)
    const cur = pad;
    const differs =
      assetId !== cur.assetId ||
      JSON.stringify(synth) !== JSON.stringify(cur.synth ?? null) ||
      (finalGain !== undefined && Math.abs(finalGain - cur.gain) > 0.01) ||
      (finalPan !== undefined && Math.abs(finalPan - cur.pan) > 0.01) ||
      (finalChoke !== undefined && finalChoke !== cur.chokeGroup);

    if (differs) {
      out.set(pad.id, {
        assetId: assetId ?? null,
        synth: synth ?? null,
        gain: finalGain,
        pan: finalPan,
        chokeGroup: finalChoke,
      });
    }
  }

  return out;
}

/** Back-compat: string-only map for older callers (now returns Partial<DrumPad>). */
export type KitAssignmentMap = Map<string, Partial<DrumPad>>;
