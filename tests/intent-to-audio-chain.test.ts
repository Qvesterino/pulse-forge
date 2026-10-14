import { describe, it, expect, beforeAll } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { normalizeProject } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { parseSelectedAudioClipFadeIntent, applyClipArrangeOps, type ClipArrangeOp } from "../src/intent/arrangeWords";
import { routeIntentText } from "../src/intent/route";
import { audioClipsForPlayback } from "../src/project-model/audio-takes";
import {
  assertGenerativeExportSources,
  computeRenderTicks,
  estimateRenderPcmBytes,
  resolveRenderTailSeconds,
} from "../src/rendering/renderer";
import { audioClipDurationSec } from "../src/commands/audioClips";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";
import type { SampleBank } from "../src/sample-library/factory";

/**
 * DELIVERABLE 5 — natural language → structured intent → validated command →
 * renderer-bound state → undo → save/reload → export pre-flight.
 *
 * The existing intent E2E suites (`intent-e2e-audit{,2,3}.test.ts`, 60+ specs)
 * stop at **undo**. Every one of them ends with `store.undo()` and a doc
 * comparison. So the last two hops the objective names — persistence and export —
 * were never driven from a natural-language request by any spec. This file closes
 * that, and it deliberately does NOT re-test what those suites already prove.
 *
 * Why the renderer-side assertions are the interesting ones: a project document
 * saying `fadeOut: 0.5` proves nothing about audio. `audioClipsForPlayback` is the
 * exact choke point the scheduler, the live editor and `renderProject` all read
 * (`types.ts` documents it as the single filter for clip mute), and
 * `computeRenderTicks` / `estimateRenderPcmBytes` / `resolveRenderTailSeconds`
 * are the pure planners the export path executes before it allocates anything.
 * Asserting against THOSE is how "the parameter reached the DSP's inputs" gets
 * evidence in a unit test.
 *
 * WHAT THIS FILE DOES NOT VERIFY, stated plainly: the rendered PCM itself. No
 * vitest spec in this repo renders audio — `renderProject` requires a real
 * `OfflineAudioContext` and every caller of it in the test suite stubs it out
 * (`tests/bounce.test.ts:348`, `tests/render-quality.test.ts:120`). Audible
 * verification of a fade belongs to the real-browser gate
 * (`npm run test:browser`), not to a jsdom assertion. Claiming a rendered tail
 * here would be fabricating a listening result.
 */

const CLIP_ID = "chain-a1";

/** A project with one arrangement scene clip and one audio clip to fade. */
function fixture(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((t) => t.kind === "drum")!;
  const clip = {
    id: CLIP_ID,
    trackId: track.id,
    bufferId: "factory.kick.main",
    startBar: 0,
    lengthBars: 4,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
  } as AudioClip;
  return {
    ...base,
    arrangement: { ...base.arrangement, audioClips: [clip] },
  } as ProjectDocument;
}

/** The state the renderer will actually consume, as one comparable object. */
function renderInputs(doc: ProjectDocument) {
  return {
    ticks: computeRenderTicks(doc, "song"),
    pcmBytes: estimateRenderPcmBytes(doc, {
      mode: "song",
      sampleRate: 48_000,
      tailSeconds: resolveRenderTailSeconds(doc),
      minimumDurationTicks: 0,
      arrangementOnly: false,
    }),
    tailSeconds: resolveRenderTailSeconds(doc),
    clips: audioClipsForPlayback(doc.arrangement).map((c) => ({
      id: c.id,
      startBar: c.startBar,
      lengthBars: c.lengthBars,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
    })),
  };
}

/** The export pre-flight every export call runs before touching Web Audio. */
function exportPreflight(doc: ProjectDocument): void {
  assertGenerativeExportSources(doc, {} as SampleBank);
}

describe("intent → audio: the chain the other intent suites stop before", () => {
  beforeAll(() => {
    expect(typeof audioClipsForPlayback).toBe("function");
  });

  it("carries one request through every hop and survives the save/reload boundary", () => {
    const doc = fixture();
    const store = new ProjectStore(doc);
    const before = JSON.stringify(store.doc);

    /* 1 — natural language → typed intent, through the REAL router.
       `routeIntentText` is the function the IntentPanel calls; it resolves the
       selection and hands off to the clip parser (route.ts:460). Calling the
       parser directly would prove the parser and skip the thing the objective
       actually names — the request. */
    const phrase = "fade the selected clip out over its final bar";
    const routed = routeIntentText(phrase, store.doc, { selectedClipId: CLIP_ID });
    expect(routed.kind).toBe("clips");
    const ops = (routed as { ops: ClipArrangeOp[] }).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "fadeClip", clipId: CLIP_ID, edge: "out" });

    /* 2 — typed intent → validated command (one undo entry) */
    const command = applyClipArrangeOps(store.doc, ops);
    expect(command).not.toBeNull();
    store.execute(command!);
    expect(store.undoStackLength).toBe(1);

    const applied = store.doc;
    const clip = applied.arrangement.audioClips!.find((c) => c.id === CLIP_ID)!;
    const requested = ops[0] as { seconds: number };

    // The parser pre-clamped to the clip's real duration; the command must not
    // have widened it. A fade that outlives its clip is the D1-class defect.
    expect(clip.fadeOut).toBeCloseTo(requested.seconds, 6);
    expect(clip.fadeOut).toBeLessThanOrEqual(audioClipDurationSec(applied, clip.lengthBars, clip.startBar));

    /* 3 — the RENDERER's view, not just the document's */
    const live = renderInputs(applied);
    expect(live.clips).toHaveLength(1);
    expect(live.clips[0].fadeOut).toBeCloseTo(requested.seconds, 6);
    expect(exportPreflight(applied)).toBeUndefined();

    /* 4 — undo restores the document byte-for-byte */
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(before);
    expect(renderInputs(store.doc).clips[0].fadeOut).toBe(0);

    /* 5 — redo re-applies, and the render inputs come back identically */
    store.redo();
    expect(renderInputs(store.doc)).toEqual(live);

    /* 6 — SAVE / RELOAD. This is the hop D9-class losses live in: an edit that
       "succeeded" but is pruned or dropped by normalizeProject is data loss. */
    const reloaded = normalizeProject(store.doc);
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(store.doc));
    expect(renderInputs(reloaded)).toEqual(live);
    expect(exportPreflight(reloaded)).toBeUndefined();
  });

  it("an UNRELOADABLE fade would show up here — the reload hop is load-bearing, not ceremonial", () => {
    // Control for the spec above: prove the reload assertions can actually fail.
    // An edit that persists in the live document but is pruned by the save path
    // must NOT render-identically after a round-trip.
    const doc = fixture();
    const tampered = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [{ ...doc.arrangement.audioClips![0], fadeOut: Number.NaN }],
      },
    } as ProjectDocument;
    const beforeRender = JSON.stringify(renderInputs(tampered));
    const afterRender = JSON.stringify(renderInputs(normalizeProject(tampered)));
    expect(afterRender).not.toBe(beforeRender);
  });

  it("CONTROL: a request that does not parse leaves the document untouched", () => {
    const doc = fixture();
    const store = new ProjectStore(doc);
    const before = JSON.stringify(store.doc);

    // No fade verb → no typed intent → no command. Nothing may be written.
    expect(parseSelectedAudioClipFadeIntent("make the drums louder", store.doc, CLIP_ID)).toBeNull();

    // ...and the ROUTER must agree: an unrelated request must not fall through
    // to the clips path and mutate something. (P0-A's whole point was that an
    // unrecognized verb used to reach generation; this pins the benign twin.)
    const routed = routeIntentText("make the drums louder", store.doc, { selectedClipId: CLIP_ID });
    expect(routed.kind).not.toBe("clips");

    // ...and a selection that is not an audio clip cannot be faded: the parser
    // must refuse rather than falling back to a scene clip.
    const sceneClipId = doc.arrangement.clips[0]?.id ?? "nope";
    expect(parseSelectedAudioClipFadeIntent("fade the selected clip out", store.doc, sceneClipId)).toBeNull();

    expect(JSON.stringify(store.doc)).toBe(before);
    expect(store.undoStackLength).toBe(0);
  });
});
