import { FACTORY_ASSETS } from "./manifest";
import { forkRandom } from "../shared/rng";
import type { DrumPad } from "../project-model/types";
import { classifyPads } from "../assist/patternOps";
import type { DiceLocks } from "../intent/dice";

const POOLS: Record<string, string[]> = {
  kicks: FACTORY_ASSETS.filter((a) => a.category === "Kick").map((a) => a.id),
  snares: FACTORY_ASSETS.filter((a) => a.category === "Snare" || a.category === "Clap").map((a) => a.id),
  hats: FACTORY_ASSETS.filter((a) => a.category === "Hat" || a.category === "Cymbal" || a.category === "Crash").map(
    (a) => a.id,
  ),
  toms: FACTORY_ASSETS.filter((a) => a.category === "Tom").map((a) => a.id),
  percs: FACTORY_ASSETS.filter((a) => a.category === "Percussion").map((a) => a.id),
};

/**
 * Resolve category-constrained kit assignments for dice.
 * Returns Map<padId, assetId> only for pads that should be swapped.
 * Respects locks (drums/kick/snare/hats/kit).
 */
export function resolveKitAssignments(
  pads: DrumPad[],
  seed: string,
  locks: DiceLocks,
  jitter: number,
): Map<string, string> {
  const out = new Map<string, string>();
  if (locks.kit || locks.drums) return out;
  // Only randomize when jitter > 0.15 and chance based on jitter
  const chanceRand = forkRandom(seed, "dice.kit.chance");
  if (chanceRand() > jitter * 0.7) return out; // ~0% at jitter 0, ~70% at jitter 1

  const rnd = forkRandom(seed, "dice.kit");
  const fams = classifyPads(pads);
  const used = new Set<string>();

  const pick = (pool: string[]): string => {
    const avail = pool.filter((id) => !used.has(id));
    const src = avail.length > 0 ? avail : pool;
    const id = src[Math.floor(rnd() * src.length)] ?? pool[0];
    used.add(id);
    return id;
  };

  if (!locks.kick) {
    for (const pad of fams.kicks) {
      out.set(pad.id, pick(POOLS.kicks));
    }
  }
  if (!locks.snare) {
    for (const pad of fams.snares) {
      out.set(pad.id, pick(POOLS.snares));
    }
  }
  if (!locks.hats) {
    for (const pad of fams.hats) {
      out.set(pad.id, pick(POOLS.hats));
    }
  }
  // With high jitter, also randomize toms/percs slightly
  if (jitter > 0.6) {
    const others = fams.others;
    for (const pad of others) {
      if (rnd() < 0.4) {
        const pool = pad.name.toLowerCase().includes("tom") ? POOLS.toms : POOLS.percs;
        out.set(pad.id, pick(pool));
      }
    }
  }

  return out;
}
