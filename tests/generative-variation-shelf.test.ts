import { describe, expect, it } from "vitest";
import { clearVariationShelf, shelfVariations, takeShelvedVariations } from "../src/generative/variationShelf";
import type { GenerativeVariation } from "../src/generative/resample";

function variation(id: string): GenerativeVariation {
  return {
    id,
    label: id,
    audio: {
      sampleRate: 48_000,
      channels: 1,
      frames: 96_000,
      durationSec: 2,
      data: new Float32Array(96_000),
      providerId: "mrt2",
      modelId: "v30-q8",
      inputHash: "hash-" + id,
    },
    input: {} as GenerativeVariation["input"],
  };
}

describe("the resample variation shelf (CF-20)", () => {
  it("shelves and pops per track — a pop takes ownership", () => {
    clearVariationShelf();
    shelfVariations("track-a", [variation("a1"), variation("a2")]);
    shelfVariations("track-b", [variation("b1")]);

    expect(takeShelvedVariations("track-a")).toHaveLength(2);
    // A pop consumes the entry — the same take cannot restore twice.
    expect(takeShelvedVariations("track-a")).toBeNull();
    expect(takeShelvedVariations("track-b")).toHaveLength(1);
  });

  it("re-shelving a track replaces its previous takes", () => {
    clearVariationShelf();
    shelfVariations("track-a", [variation("old")]);
    shelfVariations("track-a", [variation("new-1"), variation("new-2")]);
    const taken = takeShelvedVariations("track-a");
    expect(taken?.map((v) => v.id)).toEqual(["new-1", "new-2"]);
  });

  it("is bounded — the eight most recent tracks survive", () => {
    clearVariationShelf();
    for (let index = 0; index < 10; index += 1) {
      shelfVariations("track-" + index, [variation("v" + index)]);
    }
    expect(takeShelvedVariations("track-0")).toBeNull();
    expect(takeShelvedVariations("track-1")).toBeNull();
    expect(takeShelvedVariations("track-2")).toHaveLength(1);
    expect(takeShelvedVariations("track-9")).toHaveLength(1);
  });

  it("shelving an empty list is a no-op (it must not erase a real shelf)", () => {
    clearVariationShelf();
    shelfVariations("track-a", [variation("keep")]);
    shelfVariations("track-a", []);
    expect(takeShelvedVariations("track-a")).toHaveLength(1);
  });
});
