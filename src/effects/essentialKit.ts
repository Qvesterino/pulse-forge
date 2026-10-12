import type { EffectType } from "../project-model/types";
import type { BeatmakingEffectChain, BeatmakingEffectChainItem } from "./chains";

/**
 * Module-first starting set — the five devices every track wants, as five
 * separate pickable slots instead of one fixed chain.
 *
 * Complementary to the SOURCE-first dock (`sourceProfiles.ts`): that one
 * starts from WHAT you record (kick, snare, 808); this one starts from
 * WHICH device does what. A slot holds a FACTORY PRESET, never a chain id,
 * because the factory loudness trim measured for that preset
 * (`factoryFxPresetGainDb`) is the entire compensation for a single device.
 * Routing a one-device "chain" through the loudness probe would add a
 * second, chain-level trim on top of it.
 */
export interface EssentialKitVariant {
  label: string;
  presetId: string;
}

export interface EssentialKitSlot {
  id: EssentialKitSlotId;
  label: string;
  /** What a click inserts — drives the dock's device label. */
  type: EffectType;
  variants: readonly EssentialKitVariant[];
}

/** Signal-flow order: tone → dynamics → character → echo → room. */
export const ESSENTIAL_KIT_SLOT_ORDER = ["eq", "dynamics", "character", "delay", "reverb"] as const;
export type EssentialKitSlotId = (typeof ESSENTIAL_KIT_SLOT_ORDER)[number];

export const ESSENTIAL_KIT_SLOTS: readonly EssentialKitSlot[] = [
  {
    id: "eq",
    label: "EQ",
    type: "eq",
    variants: [
      { label: "Clean", presetId: "eq-clean" },
      { label: "Warm", presetId: "eq-warm" },
      { label: "Air", presetId: "eq-air" },
    ],
  },
  {
    id: "dynamics",
    label: "DYNAMICS",
    type: "compressor",
    variants: [
      { label: "Glue", presetId: "comp-glue" },
      { label: "Punch", presetId: "comp-punch" },
      { label: "Heavy", presetId: "comp-smash" },
    ],
  },
  {
    id: "character",
    label: "SATURATION",
    type: "saturation",
    variants: [
      { label: "Warm", presetId: "saturation-tape-warm" },
      { label: "Valve", presetId: "saturation-valve" },
      { label: "Sizzle", presetId: "saturation-sizzle" },
    ],
  },
  {
    id: "delay",
    label: "DELAY",
    type: "delay",
    variants: [
      { label: "Slap", presetId: "delay-slap" },
      { label: "1/8", presetId: "delay-pingpong" },
      { label: "Dub", presetId: "delay-dub" },
    ],
  },
  {
    id: "reverb",
    label: "REVERB",
    type: "reverb",
    variants: [
      { label: "Room", presetId: "reverb-tight-room" },
      { label: "Plate", presetId: "reverb-dark-plate" },
      { label: "Hall", presetId: "reverb-hall" },
    ],
  },
] satisfies readonly EssentialKitSlot[];

/**
 * The variant each slot starts on. Chosen so LOAD KIT inserts a restrained,
 * mix-ready starting point rather than three stacked effects at once.
 */
export const ESSENTIAL_KIT_DEFAULT_VARIANT: Readonly<Record<EssentialKitSlotId, string>> = {
  eq: "Clean",
  dynamics: "Glue",
  character: "Warm",
  delay: "Slap",
  reverb: "Room",
};

export function essentialKitSlot(id: EssentialKitSlotId): EssentialKitSlot {
  const found = ESSENTIAL_KIT_SLOTS.find((slot) => slot.id === id);
  if (!found) throw new Error(`Unknown essential kit slot ${id}`);
  return found;
}

export function essentialKitVariant(slot: EssentialKitSlot, label: string): EssentialKitVariant {
  const found = slot.variants.find((variant) => variant.label === label);
  if (!found) throw new Error(`Unknown essential kit variant ${label} for slot ${slot.id}`);
  return found;
}

/** One slot as a chain so it can ride the existing insert path unchanged. */
export function essentialKitChain(slot: EssentialKitSlot, variant: EssentialKitVariant): BeatmakingEffectChain {
  return {
    id: `essential-${slot.id}-${variant.presetId}`,
    name: `${slot.label} · ${variant.label}`,
    description: `Essential kit ${slot.label} device.`,
    effects: [{ type: slot.type, presetId: variant.presetId }],
  };
}

/** Every slot at once, in signal-flow order — what LOAD KIT inserts. */
export function essentialKitChainFor(
  selection: Partial<Readonly<Record<EssentialKitSlotId, string>>>,
): BeatmakingEffectChain {
  const items: BeatmakingEffectChainItem[] = ESSENTIAL_KIT_SLOT_ORDER.flatMap((id) => {
    const slot = essentialKitSlot(id);
    const label = selection[id] ?? ESSENTIAL_KIT_DEFAULT_VARIANT[id];
    return [{ type: slot.type, presetId: essentialKitVariant(slot, label).presetId }];
  });
  return {
    id: `essential-kit-${ESSENTIAL_KIT_SLOT_ORDER.join("-")}`,
    name: "ESSENTIAL KIT",
    description: "EQ, dynamics, saturation, delay and reverb in one click.",
    effects: items,
  };
}

/** The kit as selected, defaults filled in — the shape the dock reads. */
export function essentialKitSelection(
  partial: Partial<Readonly<Record<EssentialKitSlotId, string>>>,
): Readonly<Record<EssentialKitSlotId, string>> {
  const filled = { ...ESSENTIAL_KIT_DEFAULT_VARIANT };
  for (const [id, label] of Object.entries(partial)) {
    const slot = essentialKitSlot(id as EssentialKitSlotId);
    // Resolve through the variant table so an unknown label throws instead of
    // silently inserting a default the dock is not showing.
    essentialKitVariant(slot, label as string);
    filled[id as EssentialKitSlotId] = label as string;
  }
  return filled;
}
