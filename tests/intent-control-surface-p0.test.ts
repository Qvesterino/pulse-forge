import { describe, expect, it } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { isCreativeBriefRoute } from "../src/intent/model-fallback-policy";
import { applyClipArrangeOps, type ClipArrangeOp } from "../src/intent/arrangeWords";
import { parseExportIntent } from "../src/intent/exact";
import { addAudioClip, audioClipDurationSec } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc, placeClipAt } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * P0 CONTROL-SURFACE HARDENING (docs/audits/2026-10-13-command-surface,
 * GAP-01/02 + roadmap P0-A/P0-B/P0-C).
 *
 * Contract under test:
 *  P0-B — natural export phrasing ("export the current mix", "bounce the
 *         mix", "export my mix as mp3") routes to the export pipeline, not
 *         the generation catch-all. "export the stems" deliberately stays a
 *         prompt (stems are a different pipeline — established contract).
 *  P0-A — a phrase that still falls through to `kind:"pattern"` may NEVER
 *         reach generate(): the terminal route is generation only on
 *         positive creative-brief signal (isCreativeBriefRoute); everything
 *         else clarifies.
 *  P0-C — "fade the selected clip over its final bar" resolves to a
 *         fadeClip op on the selected AUDIO clip, executes as ONE undoable
 *         command through updateAudioClip, and the fade never outlives the
 *         clip (the audioClips clamp invariant).
 */

const doc = testDoc();

const docWithAudioClip = (lengthBars = 4): { doc: ProjectDocument; clipId: string } => {
  const base = testDoc();
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  const next = addAudioClip(base, trackId, "buf-p0", 0, lengthBars).execute(base);
  return { doc: next, clipId: (next.arrangement.audioClips ?? [])[0]!.id };
};

describe("P0-B · natural export phrasing routes to export (GAP-01)", () => {
  const cases = [
    ["export the current mix", "wav"],
    ["export the project", "wav"],
    ["bounce the mix", "wav"],
    ["export my mix as mp3", "mp3"],
    ["export the final master as wav", "wav"],
    ["export the whole song", "wav"],
    ["exportuj celý mix", "wav"],
  ] as const;
  for (const [text, format] of cases) {
    it(`"${text}" → export ${format}`, () => {
      const route = routeIntentText(text, doc);
      expect(route.kind).toBe("export");
      if (route.kind === "export") expect(route.format).toBe(format);
      expect(parseExportIntent(text)).toBe(format);
    });
  }

  it("keeps the established contracts: bare/format forms unchanged, stems stay a prompt", () => {
    for (const [text, format] of [
      ["export wav", "wav"],
      ["exportuj mp3", "mp3"],
      ["export", "wav"],
      ["export the project as mp3", "mp3"],
      ["bounce", "wav"],
    ] as const) {
      const route = routeIntentText(text, doc);
      expect(route.kind, text).toBe("export");
      if (route.kind === "export") expect(route.format, text).toBe(format);
    }
    expect(routeIntentText("export the stems", doc).kind).not.toBe("export");
    // Creative tails must not be captured by the widened export parser (a
    // pre-existing fader parse owns this one — it must merely stay non-export).
    expect(routeIntentText("export a dark mix at 140 bpm", doc).kind).not.toBe("export");
  });
});

describe("P0-A · nothing that falls through may generate (GAP-01 safety net)", () => {
  const MUST_NOT_GENERATE = [
    // export/bounce family (the audited probes)
    "export the current mix",
    "bounce the mix",
    "export the project",
    "export my mix as mp3",
    // clip/fade editing family (GAP-02)
    "fade the selected clip over its final bar",
    "fade out the clip",
    "delete the second clip",
    "remove the intro clip",
    "copy the chorus clip to bar 17",
    "trim the clip at bar 5 to 2 bars",
    // fader / mixer family (GAP-03 territory)
    "lower the vocal by 2 dB",
    "raise the hats a bit",
    "normalize the mix",
    // recording / transport tails
    "record the synth take",
    "set the tempo to 90",
  ];

  for (const text of MUST_NOT_GENERATE) {
    it(`"${text}" never reaches the generation catch-all`, () => {
      const route = routeIntentText(text, doc);
      if (route.kind !== "pattern") return; // deterministic route — not the catch-all
      // Fell through: the P0-A gate must classify it as NOT a creative brief,
      // so the panel clarifies (after a model miss) instead of generating.
      expect(isCreativeBriefRoute(text, route), text).toBe(false);
    });
  }

  it("genuine creative briefs still generate (the gate is not over-tightened)", () => {
    for (const text of ["dark rolling techno at 140", "lofi hip hop for studying", "make me a beat"]) {
      const route = routeIntentText(text, doc);
      expect(route.kind, text).toBe("pattern");
      expect(isCreativeBriefRoute(text, route), text).toBe(true);
    }
  });
});

describe("P0-C · fade verb → updateAudioClip bridge (GAP-02)", () => {
  it("routes the audited phrasing to a fadeClip op on the selected audio clip", () => {
    const { doc: audioDoc, clipId } = docWithAudioClip();
    const route = routeIntentText("fade the selected clip over its final bar", audioDoc, { selectedClipId: clipId });
    expect(route.kind).toBe("clips");
    if (route.kind !== "clips") return;
    expect(route.ops).toHaveLength(1);
    const op = route.ops[0]!;
    expect(op.op).toBe("fadeClip");
    if (op.op !== "fadeClip") return;
    expect(op.clipId).toBe(clipId);
    expect(op.edge).toBe("out");
    // "its final bar" = one bar's seconds at the scene-pinned tempo of the clip.
    expect(op.seconds).toBeCloseTo(audioClipDurationSec(audioDoc, 1, 0), 5);
  });

  it("explicit lengths parse: first-bars fade-in and a millisecond fade-out", () => {
    const { doc: audioDoc, clipId } = docWithAudioClip();
    const fadeIn = routeIntentText("fade in the selected clip over the first 2 bars", audioDoc, {
      selectedClipId: clipId,
    });
    expect(fadeIn.kind).toBe("clips");
    if (fadeIn.kind === "clips") {
      const op = fadeIn.ops[0]!;
      expect(op.op === "fadeClip" && op.edge).toBe("in");
      if (op.op === "fadeClip") expect(op.seconds).toBeCloseTo(audioClipDurationSec(audioDoc, 2, 0), 5);
    }
    const fadeOut = routeIntentText("fade out the selected clip by 500 ms", audioDoc, { selectedClipId: clipId });
    expect(fadeOut.kind).toBe("clips");
    if (fadeOut.kind === "clips") {
      const op = fadeOut.ops[0]!;
      expect(op.op === "fadeClip" && op.edge).toBe("out");
      if (op.op === "fadeClip") expect(op.seconds).toBeCloseTo(0.5, 5);
    }
  });

  it("executes as ONE undoable command and the fade lands on the clip", () => {
    const { doc: audioDoc, clipId } = docWithAudioClip();
    const route = routeIntentText("fade the selected clip over its final bar", audioDoc, { selectedClipId: clipId });
    expect(route.kind).toBe("clips");
    if (route.kind !== "clips") return;
    const store = new ProjectStore(audioDoc);
    const command = applyClipArrangeOps(audioDoc, route.ops);
    expect(command).not.toBeNull();
    if (!command) return;
    store.execute(command);
    const clip = (store.getDoc().arrangement.audioClips ?? []).find((c) => c.id === clipId)!;
    expect(clip.fadeOut).toBeCloseTo(audioClipDurationSec(audioDoc, 1, 0), 5);
    expect(clip.fadeIn).toBe(0);
    // One undo step restores the pre-fade document exactly.
    store.undo();
    const restored = (store.getDoc().arrangement.audioClips ?? []).find((c) => c.id === clipId)!;
    expect(restored.fadeOut).toBe(0);
  });

  it("the fade never outlives the clip (clamp invariant holds through the bridge)", () => {
    const { doc: audioDoc, clipId } = docWithAudioClip(0.5); // half-bar clip
    const route = routeIntentText("fade out the selected clip over its final 4 bars", audioDoc, {
      selectedClipId: clipId,
    });
    expect(route.kind).toBe("clips");
    if (route.kind !== "clips") return;
    const command = applyClipArrangeOps(audioDoc, route.ops);
    expect(command).not.toBeNull();
    if (!command) return;
    const next = command.execute(audioDoc);
    const clip = (next.arrangement.audioClips ?? []).find((c) => c.id === clipId)!;
    const dur = audioClipDurationSec(next, clip.lengthBars, clip.startBar);
    expect(clip.fadeOut).toBeLessThanOrEqual(dur + 1e-9);
    expect(clip.fadeOut).toBeCloseTo(dur, 5);
  });

  it("refuses to guess: no length, contradictory edge, or a scene-clip selection clarify", () => {
    const { doc: audioDoc, clipId } = docWithAudioClip();
    // No fade length in the sentence → no op → the phrase falls through and
    // must clarify under P0-A, never generate.
    const bare = routeIntentText("fade the selected clip", audioDoc, { selectedClipId: clipId });
    expect(bare.kind).toBe("pattern");
    expect(isCreativeBriefRoute("fade the selected clip", bare as Extract<typeof bare, { kind: "pattern" }>)).toBe(
      false,
    );
    // Contradiction ("fade in" + "final bar") is not executed either.
    const contradictory = routeIntentText("fade in the selected clip over its final bar", audioDoc, {
      selectedClipId: clipId,
    });
    expect(contradictory.kind).not.toBe("clips");
    // A scene (pattern) clip selection never produces an audio fade. Build
    // ONE doc instance — template ids are random per construction.
    const sceneBase = testDoc();
    const sceneDoc = placeClipAt(sceneBase, sceneBase.scenes[0]!.id, 0, 2);
    const patternClipId = sceneDoc.arrangement.clips[0]!.id;
    const patternRoute = routeIntentText("fade the selected clip over its final bar", sceneDoc, {
      selectedClipId: patternClipId,
    });
    const routedFadeOps =
      patternRoute.kind === "clips"
        ? patternRoute.ops.filter(
            (op: ClipArrangeOp): op is Extract<ClipArrangeOp, { op: "fadeClip" }> => op.op === "fadeClip",
          )
        : [];
    expect(routedFadeOps).toHaveLength(0);
  });
});
