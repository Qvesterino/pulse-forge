import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EFFECT_DEFS } from "../../src/effects/registry";
import {
  assetCategoryOf,
  categoryColor,
  moodLabel,
} from "../src/ui/kitColors";
import {
  getLastPlayActivity,
  recordPlayActivity,
  subscribePlayActivity,
} from "../src/ui/playActivity";
import { effectEditorSpec } from "../src/ui/effectEditorRegistry";
import { gestureMatches, gesturesByArea } from "../src/ui/helpContent";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import type { DrumPad } from "../src/project-model/types";

/**
 * Small UI-logic modules that previous rounds never touched: kit color /
 * category mapping (dock pads), the play-activity pub/sub (MIDI readout +
 * pad flash), the effect editor registry (page-1 primary controls), and the
 * help-content search. Individually tiny, collectively load-bearing for
 * every session.
 */

describe("kitColors — category and mood surfaces", () => {
  it("every category has a hex color and every mood a label", () => {
    const categories = [...new Set(FACTORY_ASSETS.map((a) => a.category))];
    for (const category of categories) {
      expect(categoryColor(category)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    for (const mood of [...new Set(FACTORY_ASSETS.map((a) => a.mood))].filter((m): m is NonNullable<typeof m> => !!m)) {
      expect(moodLabel(mood).length).toBeGreaterThan(0);
    }
  });

  it("synth pads classify by their synth type", () => {
    const pad = (synth: unknown) => ({ synth }) as unknown as DrumPad;
    expect(assetCategoryOf(pad({ type: "kick" }))).toBe("Kick");
    expect(assetCategoryOf(pad({ type: "snare" }))).toBe("Snare");
    expect(assetCategoryOf(pad({ type: "hatClosed" }))).toBe("Hat");
    expect(assetCategoryOf(pad({ type: "hatOpen" }))).toBe("Hat");
    expect(assetCategoryOf(pad({ type: "clap" }))).toBe("Clap");
    expect(assetCategoryOf(pad({ type: "cowbell" }))).toBe("Percussion");
    expect(assetCategoryOf(pad({ type: "somethingNew" }))).toBe("Percussion"); // safe default
  });

  it("sample pads classify via the asset lookup; unknown and null assets fall back", () => {
    const withAsset = (assetId: string | null) => ({ assetId }) as unknown as DrumPad;
    const known = FACTORY_ASSETS[0]!;
    expect(assetCategoryOf(withAsset(known.id))).toBe(known.category);
    expect(assetCategoryOf(withAsset(null))).toBe("Percussion");
    expect(assetCategoryOf(withAsset("no-such-asset-id"))).toBe("Percussion");
  });
});

describe("playActivity — note-fired pub/sub", () => {
  beforeEach(() => {
    // Drain the module-level "last" by recording a neutral event.
    recordPlayActivity({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the last event with a monotonic timestamp", async () => {
    recordPlayActivity({ pitch: 60 });
    const first = getLastPlayActivity();
    expect(first?.pitch).toBe(60);
    await new Promise((r) => setTimeout(r, 2));
    recordPlayActivity({ pitch: 62 });
    const second = getLastPlayActivity();
    expect(second?.pitch).toBe(62);
    expect(second!.at).toBeGreaterThanOrEqual(first!.at);
  });

  it("notifies subscribers until they unsubscribe", () => {
    const listener = vi.fn();
    const unsub = subscribePlayActivity(listener);
    recordPlayActivity({ padId: "kick-1" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    recordPlayActivity({ padId: "kick-2" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLastPlayActivity()?.padId).toBe("kick-2");
  });

  it("payload is copied at record time (later mutation of the caller's object cannot drift)", () => {
    const event: { padId: string; at?: number } = { padId: "snare" };
    recordPlayActivity(event);
    event.padId = "mutated-after";
    expect(getLastPlayActivity()?.padId).toBe("snare");
  });
});

describe("effectEditorRegistry — page-1 controls", () => {
  const types = Object.keys(EFFECT_DEFS) as Array<keyof typeof EFFECT_DEFS>;

  it("every effect resolves to a spec whose family matches its audio definition", () => {
    for (const type of types) {
      const spec = effectEditorSpec(type as never);
      expect(spec.family).toBe(EFFECT_DEFS[type].category);
    }
  });

  it("curated primaryParamIds EXIST in their effect's parameter surface (no dead page-1 knobs)", () => {
    for (const type of types) {
      const spec = effectEditorSpec(type as never);
      const defs = EFFECT_DEFS[type].params;
      for (const id of spec.primaryParamIds ?? []) {
        expect(
          defs.some((p: { id: string }) => p.id === id),
          `${String(type)}: primary param "${id}" missing from definitions`,
        ).toBe(true);
      }
    }
  });

  it("curated first pages stay small (the whole point is brevity)", () => {
    for (const type of types) {
      const spec = effectEditorSpec(type as never);
      expect((spec.primaryParamIds ?? []).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("helpContent — gesture search", () => {
  const areas = gesturesByArea();

  it("every gesture lands in exactly one area (no orphans, no duplicates)", () => {
    const grouped = areas.flatMap((a) => a.items);
    const actions = grouped.map((g) => `${g.area}/${g.action}`);
    expect(new Set(actions).size).toBe(actions.length);
    expect(areas.every((a) => a.items.length > 0)).toBe(true);
  });

  it("matching is case-insensitive across area/action/detail and empty query matches all", () => {
    const first = areas[0]!.items[0]!;
    expect(gestureMatches(first, "")).toBe(true);
    expect(gestureMatches(first, "   ")).toBe(true);
    expect(gestureMatches(first, first.action.toUpperCase().slice(0, 4))).toBe(true);
    expect(gestureMatches(first, first.detail.toUpperCase().slice(0, 6))).toBe(true);
    expect(gestureMatches(first, first.area.toUpperCase())).toBe(true);
    expect(gestureMatches(first, "zzz-no-such-gesture-zzz")).toBe(false);
  });
});
