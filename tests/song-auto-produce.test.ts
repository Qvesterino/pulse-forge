import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { GENRES } from "../src/ai/types";
import { composeFullTrack } from "../src/intent/compose";
import { applyMixIntent, planMixProfile } from "../src/intent/mix";
import { FX_CUE_TRACK_NAME } from "../src/intent/transition-cues";

/**
 * P4 SONG AUTO-PRODUCE — every SONG installs produced sound by default.
 *
 * composeFullTrack chains song notes + section FX + mix profile; the IntentPanel
 * draft flow auditions song+mix folded together and USE must install exactly
 * what was heard (preview==USE). These tests lock three promises:
 *
 * 1. Every genre ships a non-empty mix for a neutral intent (no silent,
 *    unproduced songs — tone/punch/space/pump fires somewhere per genre).
 * 2. On an unchanged doc, the re-planned mix equals the composed mix the
 *    audition heard — the justification for installing the composed command
 *    directly instead of re-planning (IntentPanel useSongDraft).
 * 3. The mix never touches the "FX Cues" lane — transition impacts/risers
 *    stay unpumped and uncoloured.
 */

describe("P4 every genre song ships a mix (neutral intent)", () => {
  it("commands.mix + mixSummary are present for all 8 genres", async () => {
    const doc = testDoc();
    for (const genre of GENRES) {
      const result = await composeFullTrack(doc, `${genre} at 128`, {
        input: { genre, seed: `p4-mix-${genre}` },
        loudness: false,
      });
      expect(result.commands.mix).not.toBeNull();
      expect(result.mixSummary).toBeTruthy();
    }
  }, 120_000);
});

describe("P4 preview==USE (composed mix reuse)", () => {
  it("re-planned mix matches the composed mix semantically on an unchanged doc", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "house at 124", {
      input: { genre: "house", seed: "p4-preview-use" },
      loudness: false,
    });
    expect(result.commands.mix).not.toBeNull();

    // Effect ids are uid()-random per planning run and chain order depends
    // on the doc the mix was planned against (baseDoc vs post-song doc), so
    // compare the audible shape per track: chain types + knob values +
    // sidechain wiring, order-insensitive. That is the preview==USE contract
    // the audition promises.
    const mixShape = (d: typeof doc) =>
      d.tracks.map((t) => ({
        id: t.id,
        effects: (
          (t as { effects?: Array<{ type: string; params: unknown; sidechainTrackId?: string | null }> }).effects ?? []
        )
          .map((fx) => ({ type: fx.type, params: fx.params, sidechain: fx.sidechainTrackId ?? null }))
          .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)),
      }));

    // What the draft audition renders: song + composed mix folded.
    const preview = result.commands.mix!.execute(result.commands.song.execute(doc));

    // What USE would install on an untouched doc via the re-plan path.
    const songOnly = result.commands.song.execute(doc);
    const viaReplan = applyMixIntent(songOnly, planMixProfile(result.build.baseIntent)).execute(songOnly);

    expect(mixShape(viaReplan)).toEqual(mixShape(preview));
  }, 120_000);

  it("the mix never touches the FX Cues lane", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "house at 124", {
      input: { genre: "house", seed: "p4-fx-cues" },
      loudness: false,
    });
    expect(result.commands.mix).not.toBeNull();

    const songOnly = result.commands.song.execute(doc);
    const fxBefore = songOnly.tracks.find((t) => t.name === FX_CUE_TRACK_NAME)?.effects ?? [];
    const installed = result.commands.mix!.execute(songOnly);
    const fxAfter = installed.tracks.find((t) => t.name === FX_CUE_TRACK_NAME)?.effects ?? [];
    expect(fxAfter).toEqual(fxBefore);
  }, 120_000);
});
