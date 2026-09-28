import { describe, it, expect } from "vitest";
import { composeFullTrack } from "../src/intent/compose";
import { testDoc } from "./fixtures/doc";
import type { NoteEvent } from "../src/project-model/types";

/**
 * HUM & HARMONIZE in SUNO MODE — the hummed hook becomes the lead AND its
 * diatonic backing stack on a dedicated "Hum Harmony" track, installed with
 * the song in ONE undo step.
 */

const HUM_NOTES: NoteEvent[] = [
  { id: "h1", pitch: 69, start: 0, duration: 240, velocity: 0.85 },
  { id: "h2", pitch: 72, start: 240, duration: 240, velocity: 0.8 },
  { id: "h3", pitch: 76, start: 480, duration: 240, velocity: 0.8 },
];

async function compose(harmonize: boolean) {
  const doc = testDoc();
  return composeFullTrack(doc, "house pop at 122", {
    input: { genre: "house" },
    seed: harmonize ? "harmonize-on" : "harmonize-off",
    hum: { notes: HUM_NOTES, loopTicks: 960, key: "A Natural Minor", harmonize },
  });
}

describe("hum & harmonize in SUNO MODE", () => {
  it("harmonize builds the Hum Harmony track with the backing stack", async () => {
    const result = await compose(true);
    expect(result.skipped.join(" ")).not.toContain("harmonize:");
    const next = result.commands.song.execute(testDoc());
    const harmonyTrack = next.tracks.find((t) => t.name === "Hum Harmony");
    expect(harmonyTrack).toBeDefined();

    // lead sections carry the backing notes under the harmony track id
    const harmonyId = harmonyTrack!.id;
    const backingBars = result.build.sections
      .filter((s) => s.roles.includes("lead"))
      .flatMap((s) => s.pattern.notes[harmonyId] ?? []);
    expect(backingBars.length).toBeGreaterThan(0);
    // A natural minor pitch classes: A B C D E F G
    const allowed = new Set([9, 11, 0, 2, 4, 5, 7]);
    for (const note of backingBars) {
      expect(allowed.has(((note.pitch % 12) + 12) % 12)).toBe(true);
    }
    // backing never shouts over the lead — sub-lead velocities
    expect(Math.max(...backingBars.map((n) => n.velocity))).toBeLessThan(0.8);
    // one undo step restores everything (track + notes + song)
    const undone = result.commands.song.undo(next);
    expect(undone.tracks.some((t) => t.name === "Hum Harmony")).toBe(false);
  });

  it("no harmonize option: no Hum Harmony track, byte-conservative path", async () => {
    const result = await compose(false);
    const next = result.commands.song.execute(testDoc());
    expect(next.tracks.some((t) => t.name === "Hum Harmony")).toBe(false);
  });
});
