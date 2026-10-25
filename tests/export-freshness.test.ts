/**
 * The export freshness contract (audit F-01).
 *
 * The export panel captures the document at RENDER time, and its selectors
 * are fine-grained — `normalizeProject` preserves object identity for
 * untouched slices, so an edit confined to the arrangement / automation /
 * returns / macros / lfos / scenes does NOT re-render the panel. The captured
 * document can therefore already be stale before the user clicks, and a stem
 * render is multi-second, so an edit made during it has to be caught too.
 *
 * The master path has guarded this since it was written; the stem and track
 * paths had no guard at all.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addAutomationLane, addAutomationPoint } from "../src/commands/automation";
import { assertExportSourceCurrent, captureExportSource } from "../src/ui/export-freshness";

describe("the export freshness contract (F-01)", () => {
  it("a capture stays current while the project does not change", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const source = captureExportSource(() => store.doc);
    expect(() => assertExportSourceCurrent(source, () => store.doc)).not.toThrow();
  });

  it("an AUTOMATION-only edit is caught — the slice the fine-grained selectors miss", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0];
    const source = captureExportSource(() => store.doc);

    // An edit confined to the automation domain. The export panel does not
    // subscribe to it, so the render-time capture would have stayed the
    // pre-edit document — and the export would have shipped the old curve.
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = store.doc.automation[store.doc.automation.length - 1].id;
    store.execute(addAutomationPoint(store.doc, laneId, 480, 0.42));

    expect(() => assertExportSourceCurrent(source, () => store.doc)).toThrow(/changed during export/);
  });

  it("a mutation DURING the render is caught", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0];
    // The export captures the source, then the render runs for seconds…
    const source = captureExportSource(() => store.doc);
    // …and the user edits the project while it runs.
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));

    expect(() => assertExportSourceCurrent(source, () => store.doc)).toThrow(
      "The project changed during export. The stale result was discarded; export again.",
    );
  });

  it("the captured document is the CURRENT one at call time, not a render-time copy", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const stale = store.doc; // what a render-time capture would hold
    const track = store.doc.tracks[0];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const fresh = captureExportSource(() => store.doc);
    expect(fresh.doc).not.toBe(stale);
    expect(() => assertExportSourceCurrent(fresh, () => store.doc)).not.toThrow();
  });
});
