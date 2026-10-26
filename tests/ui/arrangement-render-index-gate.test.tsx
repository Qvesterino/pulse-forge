import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { createDefaultProject } from "../../src/project-model/schema";
import { addAudioClip, addAudioTakeClip, compAudioTakeRange } from "../../src/commands/audioClips";
import { mockServices, renderWithContext } from "../helpers";
import { BAR_TICKS, type ProjectDocument } from "../../src/project-model/types";

/**
 * THE PANEL BUILDS ITS INDEXES ONCE (performance-cliff audit, findings C-3/C-4).
 *
 * The unit gates next door prove the indexes ANSWER the same thing as the
 * pre-fix scans. This file proves the thing that actually matters for a
 * render: the index is built ONCE PER CLIP LIST, not once per visible clip.
 *
 * How it is measured: the index builders are wrapped by the module mock below,
 * which counts their invocations. The document under the panel grows, and the
 * number of invocations must NOT grow with it.
 *
 * The gate is a COUNT, not a millisecond — it does not care how busy the
 * machine is, and it does not need a browser. Every count assertion is paired
 * with a POSITIVE CONTROL: the DOM must really contain that many visible
 * audio clips, and the comp badge must really be drawn. Without those, a
 * panel that rendered nothing would pass every count assertion.
 */

const counters = vi.hoisted(() => ({ spans: 0, comp: 0, rebuild: 0 }));

vi.mock("../../src/project-model/scene-time", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/project-model/scene-time")>();
  return {
    ...actual,
    buildArrangementSpans: (...args: Parameters<typeof actual.buildArrangementSpans>) => {
      counters.spans++;
      return actual.buildArrangementSpans(...args);
    },
    arrangementSecondsBetweenTicks: (...args: Parameters<typeof actual.arrangementSecondsBetweenTicks>) => {
      counters.rebuild++;
      return actual.arrangementSecondsBetweenTicks(...args);
    },
  };
});

vi.mock("../../src/ui/arrangement/clip-indexes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ui/arrangement/clip-indexes")>();
  return {
    ...actual,
    buildCompTakeOrderIndex: (...args: Parameters<typeof actual.buildCompTakeOrderIndex>) => {
      counters.comp++;
      return actual.buildCompTakeOrderIndex(...args);
    },
  };
});

/**
 * A document with `extraClips` plain audio clips and ONE comp clip.
 *
 * The comp clip is the one that asks both expensive questions: it has a
 * `compSourceTakeId` (the take number) and it has a wall-clock length (the
 * scene span map).
 */
function docWithAudioClips(extraClips: number): ProjectDocument {
  let doc = createDefaultProject();
  const trackId = doc.tracks[0]!.id;

  // Two source passes in one take group...
  doc = addAudioTakeClip(doc, "g1", "pass-1", trackId, "audio.lane-1", 0, 8).execute(doc);
  doc = addAudioTakeClip(doc, "g1", "pass-2", trackId, "audio.lane-2", 0, 8).execute(doc);
  // ...and a comp slice taken from the second pass.
  doc = compAudioTakeRange(doc, "g1", "pass-2", BAR_TICKS, BAR_TICKS * 4).execute(doc);

  // The bulk: ordinary audio clips, one per bar.
  for (let i = 0; i < extraClips; i++) {
    doc = addAudioClip(doc, trackId, `audio.bulk-${i}`, 16 + i, 1).execute(doc);
  }
  return doc;
}

function reset(): void {
  counters.spans = 0;
  counters.comp = 0;
  counters.rebuild = 0;
}

describe("the arrangement render builds its indexes ONCE, not once per visible clip", () => {
  it("keeps the index build count at 1 while the visible clip count grows 6×", () => {
    cleanup();

    // ---- the small document ----
    reset();
    const smallServices = mockServices(docWithAudioClips(6));
    const smallView = renderWithContext(createElement(ArrangementPanel), { services: smallServices });
    const smallClips = smallView.container.querySelectorAll(".arr-audio-clip").length;
    const smallSpans = counters.spans;
    const smallComp = counters.comp;
    const smallRebuild = counters.rebuild;

    // POSITIVE CONTROL: the panel really drew the clips. Without this, a
    // panel that rendered nothing would satisfy every count assertion below.
    expect(smallClips, "the panel must really draw the audio clips").toBeGreaterThanOrEqual(6);
    const badges = Array.from(smallView.container.querySelectorAll(".arr-audio-clip-label")).map(
      (el) => el.textContent ?? "",
    );
    expect(
      badges.some((text) => text.includes("COMP · TAKE 2")),
      "the comp badge must be drawn — that is the per-clip take number",
    ).toBe(true);

    smallView.unmount();
    cleanup();

    // ---- the big document ----
    reset();
    const bigServices = mockServices(docWithAudioClips(36));
    const bigView = renderWithContext(createElement(ArrangementPanel), { services: bigServices });
    const bigClips = bigView.container.querySelectorAll(".arr-audio-clip").length;

    // POSITIVE CONTROL: the bigger document really has more visible clips.
    expect(bigClips, "the bigger document must really draw more clips").toBeGreaterThan(smallClips);

    expect(counters.spans, "the scene span map must be built ONCE, not per visible clip").toBe(1);
    expect(counters.comp, "the comp take index must be built ONCE, not per visible clip").toBe(1);
    expect(counters.rebuild, "the render must not call the per-call rebuild form at all").toBe(0);

    // The counts are the SAME as the small document's, even though the
    // document grew: that is the whole point of ADR 0063's "build the index
    // once, outside the loop".
    expect(counters.spans, "the span build count must not grow with the document").toBe(smallSpans);
    expect(counters.comp, "the comp index build count must not grow with the document").toBe(smallComp);
    expect(counters.rebuild, "the rebuild count must not grow with the document").toBe(smallRebuild);

    bigView.unmount();
    cleanup();
  });
});
