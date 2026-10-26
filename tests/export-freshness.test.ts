/**
 * The export freshness contract (audit F-01, extended by audit E-04).
 *
 * The export panel captures the document at RENDER time, and its selectors
 * are fine-grained — `normalizeProject` preserves object identity for untouched
 * slices, so an edit confined to the arrangement / automation / returns /
 * macros / lfos / scenes does NOT re-render the panel. The captured document
 * can therefore already be stale before the user clicks, and a stem render
 * is multi-second, so an edit made during it has to be caught too.
 *
 * The master path has guarded this since it was written; the stem and track
 * paths had no guard at all.
 *
 * Audit E-04: the sample bank is the export's SECOND input. The master path
 * guarded its revision; the stem and track paths did not — a sample replaced
 * mid-render was mixed into the stem and the status still said "N stems
 * exported". These cases are the teeth for that half of the contract.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addAutomationLane, addAutomationPoint } from "../src/commands/automation";
import { assertExportSourceCurrent, captureExportSource, type ExportState } from "../src/ui/export-freshness";

describe("the export freshness contract (F-01)", () => {
  it("a capture stays current while the project does not change", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const state = (): ExportState => ({ doc: store.doc, sampleBankRevision: 1 });
    const source = captureExportSource(state);
    expect(() => assertExportSourceCurrent(source, state)).not.toThrow();
  });

  it("an AUTOMATION-only edit is caught — the slice the fine-grained selectors miss", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0];
    const state = (): ExportState => ({ doc: store.doc, sampleBankRevision: 1 });
    const source = captureExportSource(state);

    // An edit confined to the automation domain. The export panel does not
    // subscribe to it, so the render-time capture would have stayed the
    // pre-edit document — and the export would have shipped the old curve.
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = store.doc.automation[store.doc.automation.length - 1].id;
    store.execute(addAutomationPoint(store.doc, laneId, 480, 0.42));

    expect(() => assertExportSourceCurrent(source, state)).toThrow(/changed during export/);
  });

  it("a mutation DURING the render is caught", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0];
    // The export captures the source, then the render runs for seconds…
    const state = (): ExportState => ({ doc: store.doc, sampleBankRevision: 1 });
    const source = captureExportSource(state);
    // …and the user edits the project while it runs.
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));

    expect(() => assertExportSourceCurrent(source, state)).toThrow(
      "The project changed during export. The stale result was discarded; export again.",
    );
  });

  it("the captured document is the CURRENT one at call time, not a render-time copy", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const stale = store.doc; // what a render-time capture would hold
    const track = store.doc.tracks[0];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const state = (): ExportState => ({ doc: store.doc, sampleBankRevision: 1 });
    const fresh = captureExportSource(state);
    expect(fresh.doc).not.toBe(stale);
    expect(() => assertExportSourceCurrent(fresh, state)).not.toThrow();
  });

  // Audit E-04: the sample bank is the export's second input.
  it("a sample replaced DURING the render is caught (the stem would mix old and new audio)", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    let bankRevision = 7;
    const state = (): ExportState => ({ doc: store.doc, sampleBankRevision: bankRevision });
    const source = captureExportSource(state);

    // The user imports or replaces a sample while the stem renders.
    bankRevision = 8;

    expect(() => assertExportSourceCurrent(source, state)).toThrow(
      "The sample bank changed during export. The stale result was discarded; export again.",
    );
  });

  it("the sample bank revision is captured with the document, not read later", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const source = captureExportSource(() => ({ doc: store.doc, sampleBankRevision: 42 }));
    expect(source.sampleBankRevision).toBe(42);
    // A bank that did not change must NOT trip the guard.
    expect(() => assertExportSourceCurrent(source, () => ({ doc: store.doc, sampleBankRevision: 42 }))).not.toThrow();
  });
});
