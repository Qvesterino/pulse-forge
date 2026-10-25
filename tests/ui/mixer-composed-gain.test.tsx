/**
 * The mixer shows the COMPOSED channel gain — the fader × the volume lane
 * (audit F-10, read model S-5).
 *
 * The track-gain lane is a multiplier around unity 1.0 (measured, §5.3 T4):
 * a fader at 0.8 with a lane at 0.5 plays at 0.4. Before this, the fader
 * read 0.8, the lane read 0.5, and NO surface showed the 0.4 — the number
 * the channel was actually at.
 *
 * The read model is the single owner of the composition rule; this file
 * pins the rule AND the surface that consumes it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { Mixer } from "../../src/ui/Mixer";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { addAutomationLane, addAutomationPoint } from "../../src/commands/automation";
import { setTrackParams } from "../../src/commands/project";
import { composedTrackGain, effectiveParamValue } from "../../src/project-model/effective-values";
import type { ProjectDocument } from "../../src/project-model/types";

afterEach(() => {
  cleanup();
});

/** A house project whose first track has a volume lane at `laneValue` and a fader at `gain`. */
function projectWithLane(gain: number, laneValue: number, points?: Array<{ tick: number; value: number }>) {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  const trackId = store.doc.tracks[0].id;
  store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId }));
  const laneId = store.doc.automation[0].id;
  for (const point of points ?? [{ tick: 0, value: laneValue }]) {
    store.execute(addAutomationPoint(store.doc, laneId, point.tick, point.value));
  }
  store.execute(setTrackParams(store.doc, trackId, { gain }));
  return { doc: store.doc, trackId, laneId };
}

describe("the effective-value read model composes the lane with the fader (F-10)", () => {
  it("the channel plays at fader × lane — the number neither surface showed", () => {
    const { doc, trackId } = projectWithLane(0.8, 0.5);
    const effective = composedTrackGain(doc, trackId, 0);

    expect(effective.documentValue).toBe(0.8);
    expect(effective.laneValue).toBe(0.5);
    expect(effective.value).toBeCloseTo(0.4, 10);
    expect(effective.source).toBe("automation");
    expect(effective.automated).toBe(true);
  });

  it("without a lane the fader IS the value in effect", () => {
    const doc = createProjectFromTemplate("house");
    const trackId = doc.tracks[0].id;
    const effective = composedTrackGain(doc, trackId, 0);

    expect(effective.automated).toBe(false);
    expect(effective.source).toBe("document");
    expect(effective.value).toBe(effective.documentValue);
    expect(effective.laneValue).toBeUndefined();
  });

  it("a lane at unity does not change the gain — adding a lane cannot jump the mix", () => {
    const { doc, trackId } = projectWithLane(0.9, 1);
    const effective = composedTrackGain(doc, trackId, 0);

    expect(effective.automated).toBe(true);
    expect(effective.value).toBeCloseTo(0.9, 10);
  });

  it("the lane's value follows the playhead", () => {
    // A ramp from 1.0 down to 0.0 across one bar (480 ticks).
    const { doc, trackId } = projectWithLane(1, 0, [
      { tick: 0, value: 1 },
      { tick: 480, value: 0 },
    ]);

    expect(composedTrackGain(doc, trackId, 0).value).toBeCloseTo(1, 10);
    expect(composedTrackGain(doc, trackId, 240).value).toBeCloseTo(0.5, 10);
    expect(composedTrackGain(doc, trackId, 480).value).toBeCloseTo(0, 10);
  });

  it("a pan lane OVERRIDES the fader's pan — it is absolute, not a multiplier", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const trackId = store.doc.tracks[0].id;
    store.execute(addAutomationLane(store.doc, { kind: "trackPan", trackId }));
    const laneId = store.doc.automation[0].id;
    store.execute(addAutomationPoint(store.doc, laneId, 0, 0.5));

    const effective = effectiveParamValue(store.doc, { kind: "trackPan", trackId }, 0);
    expect(effective.value).toBe(0.5);
    expect(effective.automated).toBe(true);
  });
});

describe("the mixer shows the composed gain under the VOL fader (F-10)", () => {
  it("shows the AUTO badge, the lane's factor and the effective level", () => {
    const { doc } = projectWithLane(0.8, 0.5);
    renderWithContext(<Mixer />, { services: mockServices(doc) });

    const readout = screen.getByTestId("mixer-composed-gain");
    expect(readout).toHaveTextContent("AUTO");
    expect(readout).toHaveTextContent("×0.50");
    // 0.8 × 0.5 = 0.4 → 20·log10(0.4) = -7.96 dB.
    expect(readout).toHaveTextContent("-8.0");
  });

  it("shows nothing when no lane drives the channel — the fader already IS the value", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(<Mixer />, { services: mockServices(doc) });

    expect(screen.queryByTestId("mixer-composed-gain")).not.toBeInTheDocument();
  });

  it("the readout FOLLOWS the lane — a lane added later appears at once", () => {
    // The lane slice is subscribed explicitly: a lane arrives in
    // `doc.automation` and leaves `doc.tracks` untouched, so a mixer that only
    // watched the tracks would keep showing a stale composed gain. The tracks
    // slice is deliberately NOT replaced here, so the re-render can only come
    // from the lane subscription.
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });
    expect(screen.queryByTestId("mixer-composed-gain")).not.toBeInTheDocument();

    const withLane: ProjectDocument = {
      ...doc,
      automation: [
        {
          id: "lane-1",
          target: { kind: "trackGain", trackId: doc.tracks[0].id },
          points: [{ tick: 0, value: 0.5 }],
        },
      ],
    };
    const store = services.store as unknown as {
      _setDoc: (next: ProjectDocument) => void;
      _emit: () => void;
    };
    store._setDoc(withLane);
    act(() => store._emit());

    expect(screen.getByTestId("mixer-composed-gain")).toHaveTextContent("×0.50");
  });
});
