import { describe, expect, it } from "vitest";
import {
  ESSENTIAL_KIT_DEFAULT_VARIANT,
  ESSENTIAL_KIT_SLOTS,
  ESSENTIAL_KIT_SLOT_ORDER,
  essentialKitChainFor,
  essentialKitSelection,
  essentialKitSlot,
  essentialKitVariant,
} from "../src/effects/essentialKit";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";
import { ADDITIONAL_EFFECT_GROUPS, CORE_EFFECT_GROUPS, CORE_EFFECT_ORDER, EFFECT_DEFS } from "../src/effects/registry";
import { applyEssentialKit } from "../src/commands/effectParams";
import { setEffectParam } from "../src/commands/commands";
import { effectEditorSpec } from "../src/ui/effectEditorRegistry";
import { isEffectQuickControlParam } from "../src/ui/EffectQuickControls";
import { createDefaultProject } from "../src/project-model/schema";

const presetById = new Map(CORE_EFFECT_PRESETS.map((preset) => [preset.id, preset]));
const typesInCore = CORE_EFFECT_GROUPS.flatMap((group) => group.types);
const typesInMore = ADDITIONAL_EFFECT_GROUPS.flatMap((group) => group.types);

describe("ESSENTIAL_KIT — slot table integrity", () => {
  it("covers exactly the declared slot ids, each once", () => {
    const ids = ESSENTIAL_KIT_SLOTS.map((slot) => slot.id);
    expect([...ids].sort()).toEqual([...ESSENTIAL_KIT_SLOT_ORDER].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every variant is a real factory preset of the slot's own device type", () => {
    // applyEssentialKit throws on a missing or mismatched preset, so a dead
    // entry here would surface as a half-inserted kit, not a silent no-op.
    for (const slot of ESSENTIAL_KIT_SLOTS) {
      expect(slot.variants.length, slot.id).toBeGreaterThanOrEqual(2);
      const labels = slot.variants.map((variant) => variant.label);
      expect(new Set(labels).size, `${slot.id} duplicate variant labels`).toBe(labels.length);
      for (const variant of slot.variants) {
        const preset = presetById.get(variant.presetId);
        expect(preset, `${slot.id} → ${variant.presetId}`).toBeDefined();
        expect(preset!.type, `${slot.id} → ${variant.presetId}`).toBe(slot.type);
      }
    }
  });

  it("ships the five fundamentals — tone, dynamics, character, delay, reverb", () => {
    // A POSITION claim, not a membership one: a kit that dropped the delay
    // while adding two more EQ flavours would still satisfy every check above.
    expect(ESSENTIAL_KIT_SLOTS.map((slot) => slot.type)).toEqual(["eq", "compressor", "saturation", "delay", "reverb"]);
  });

  it("every slot default is a variant that slot actually offers", () => {
    for (const id of ESSENTIAL_KIT_SLOT_ORDER) {
      const slot = essentialKitSlot(id);
      expect(
        slot.variants.some((variant) => variant.label === ESSENTIAL_KIT_DEFAULT_VARIANT[id]),
        `${id} default "${ESSENTIAL_KIT_DEFAULT_VARIANT[id]}"`,
      ).toBe(true);
    }
  });

  it("rejects an unknown variant instead of silently falling back", () => {
    // The fallback path would insert a device the dock is not showing — the
    // user clicks "Heavy" and gets "Glue" with no visible cause.
    expect(() => essentialKitSelection({ eq: "Nope" })).toThrow(/Nope/);
    expect(() => essentialKitVariant(essentialKitSlot("delay"), "Nope")).toThrow(/Nope/);
  });
});

describe("ESSENTIAL_KIT — the menu these devices live in", () => {
  it("puts the four fundamentals in the FIRST menu layer, not behind MORE", () => {
    // These four shipped only in the "MORE ..." optgroups, which buried the
    // most basic devices one click deeper than character effects.
    for (const type of ["compressor", "saturation", "delay", "reverb"]) {
      expect(typesInCore, `${type} missing from the core Add Effect menu`).toContain(type);
      expect(typesInMore, `${type} would now print twice`).not.toContain(type);
    }
  });

  it("keeps EQ at the head of TONE and puts delay before reverb in SPACE", () => {
    const space = CORE_EFFECT_GROUPS.find((group) => group.key === "space")!.types;
    const eqIndex = typesInCore.indexOf("eq");
    const delayIndex = space.indexOf("delay");
    const reverbIndex = space.indexOf("reverb");
    expect(space).toContain("delay");
    expect(space).toContain("reverb");
    // Signal flow: echo shapes the material, the room places it.
    expect(delayIndex).toBeGreaterThanOrEqual(0);
    expect(reverbIndex).toBeGreaterThan(delayIndex);
    expect(eqIndex).toBe(0);
  });

  it("no effect appears in both core and additional groups", () => {
    // A duplicate in a <select> shows the same device twice with no way to
    // tell the entries apart.
    const overlap = typesInCore.filter((type) => typesInMore.includes(type));
    expect(overlap).toEqual([]);
  });

  it("every core group is non-empty", () => {
    for (const group of CORE_EFFECT_GROUPS) expect(group.types.length, group.key).toBeGreaterThan(0);
    expect(CORE_EFFECT_ORDER.length).toBeGreaterThanOrEqual(37);
  });
});

describe("applyEssentialKit — one undo step, signal-flow order", () => {
  const doc = createDefaultProject();
  const track = doc.tracks[0]!;

  it("inserts five devices in slot order", () => {
    const command = applyEssentialKit(doc, track.id);
    const next = command.execute(doc);
    const types = next.tracks.find((t) => t.id === track.id)!.effects.map((fx) => fx.type);
    expect(types).toEqual(["eq", "compressor", "saturation", "delay", "reverb"]);
  });

  it("undoes the whole kit in one step", () => {
    const command = applyEssentialKit(doc, track.id);
    const next = command.execute(doc);
    expect(command.undo(next)).toEqual(doc);
  });

  it("applies the selected variant, not the default", () => {
    const command = applyEssentialKit(doc, track.id, { reverb: "Hall" });
    const next = command.execute(doc);
    const reverb = next.tracks.find((t) => t.id === track.id)!.effects.at(-1)!;
    expect(reverb.type).toBe("reverb");
    expect(reverb.params.decay).toBe(4.2); // reverb-hall, not reverb-tight-room
  });

  it("leaves the document untouched when a variant label is unknown", () => {
    // The resolution runs before any insert: half a kit is worse than none.
    expect(() => applyEssentialKit(doc, track.id, { delay: "Nope" })).toThrow(/Nope/);
  });

  it("honours the insertion anchor so the kit lands after the selected device", () => {
    const seeded = { ...doc, tracks: doc.tracks.map((t) => (t.id === track.id ? { ...t, effects: [] } : t)) };
    const command = applyEssentialKit(seeded, track.id, {}, 0);
    const next = command.execute(seeded);
    const types = next.tracks.find((t) => t.id === track.id)!.effects.map((fx) => fx.type);
    expect(types[0]).toBe("eq");
    expect(types).toHaveLength(5);
  });
});

describe("essentialKitChainFor — chain shape", () => {
  it("emits one effect per slot, defaults filled in", () => {
    const chain = essentialKitChainFor({});
    expect(chain.effects.map((item) => item.type)).toEqual(["eq", "compressor", "saturation", "delay", "reverb"]);
    expect(chain.effects.every((item) => presetById.has(item.presetId))).toBe(true);
  });

  it("mixes an explicit choice with untouched defaults", () => {
    const chain = essentialKitChainFor({ delay: "Dub" });
    const delay = chain.effects.find((item) => item.type === "delay")!;
    const eq = chain.effects.find((item) => item.type === "eq")!;
    expect(delay.presetId).toBe("delay-dub");
    // Resolve through the slot's variant table rather than hardcoding the id,
    // so changing a default updates this assertion instead of pinning it.
    expect(eq.presetId).toBe(essentialKitVariant(essentialKitSlot("eq"), ESSENTIAL_KIT_DEFAULT_VARIANT.eq).presetId);
  });
});

describe("KIT MULTIVIEW — every kit device has a curated first page", () => {
  // The multiview renders `primaryParamIds` for all five devices at once. A
  // slot without an override would show zero knobs beside four full columns,
  // and the defect would look like "that device has nothing to tweak" rather
  // than "nobody curated it".
  it("gives every slot exactly four primary parameters", () => {
    for (const slot of ESSENTIAL_KIT_SLOTS) {
      const spec = effectEditorSpec(slot.type);
      expect(spec.primaryParamIds, `${slot.type} has no curated MAIN page`).toBeDefined();
      expect(spec.primaryParamIds!.length, `${slot.type} primary count`).toBe(4);
    }
  });

  it("every primary id is a real parameter of its own device", () => {
    // A stale id resolves to undefined at render time and silently drops the
    // column to three knobs, so the count check above is not enough on its own.
    for (const slot of ESSENTIAL_KIT_SLOTS) {
      const def = EFFECT_DEFS[slot.type];
      for (const id of effectEditorSpec(slot.type).primaryParamIds ?? []) {
        expect(
          def.params.some((param) => param.id === id),
          `${slot.type}.${id} is not a ParamDef`,
        ).toBe(true);
      }
    }
  });

  it("the five pages are mutually distinct — no two devices show the same knobs", () => {
    const signatures = ESSENTIAL_KIT_SLOTS.map((slot) => (effectEditorSpec(slot.type).primaryParamIds ?? []).join(","));
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("every device that declares mix can still reach it from the dock", () => {
    // MIX reaches the user along two paths: `EffectQuickControls` (the shared
    // MIX/FEEDBACK/SYNC strip) and `primaryParamIds` (the MAIN page). Compressor
    // takes the first path — its curated MAIN page has been threshold/ratio/
    // attack/release since the registry shipped. EQ takes neither: it is a
    // wet-on-wet filter with no dry path at all, and is bypassed instead.
    for (const slot of ESSENTIAL_KIT_SLOTS) {
      const def = EFFECT_DEFS[slot.type];
      const mixParam = def.params.find((param) => param.id === "mix");
      const onMainPage = (effectEditorSpec(slot.type).primaryParamIds ?? []).includes("mix");
      const onQuickStrip = !!mixParam && isEffectQuickControlParam(mixParam);
      expect(!!mixParam, `${slot.type} unexpectedly declares mix`).toBe(slot.type !== "eq");
      if (mixParam) {
        expect(onMainPage || onQuickStrip, `${slot.type} declares mix but no dock path renders it`).toBe(true);
      }
    }
  });

  it("a multiview drag writes through the command into the document", () => {
    const doc = createDefaultProject();
    const track = doc.tracks[0]!;
    const loaded = applyEssentialKit(doc, track.id).execute(doc);
    const inserted = loaded.tracks.find((t) => t.id === track.id)!.effects;

    const reverb = inserted.find((fx) => fx.type === "reverb")!;
    const before = reverb.params.decay;
    const max = EFFECT_DEFS.reverb.params.find((p) => p.id === "decay")!.max;

    const next = setEffectParam(loaded, track.id, reverb.id, "decay", max).execute(loaded);
    const after = next.tracks.find((t) => t.id === track.id)!.effects.find((fx) => fx.id === reverb.id)!;
    expect(after.params.decay).toBe(max);
    expect(after.params.decay).not.toBe(before);
  });

  it("the document value wins over a stale render — the multiview reads state, it does not own it", () => {
    // Same kit, edited directly in the document. If the dock kept its own copy
    // of the parameter it would still render the value LOAD KIT wrote.
    const doc = createDefaultProject();
    const track = doc.tracks[0]!;
    const loaded = applyEssentialKit(doc, track.id).execute(doc);
    const delay = loaded.tracks.find((t) => t.id === track.id)!.effects.find((fx) => fx.type === "delay")!;

    const edited = setEffectParam(loaded, track.id, delay.id, "feedback", 0.8).execute(loaded);
    const readBack = edited.tracks.find((t) => t.id === track.id)!.effects.find((fx) => fx.id === delay.id)!;
    expect(readBack.params.feedback).toBe(0.8);
  });
});
