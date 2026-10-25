/**
 * F-09 — the rack discloses that an automation lane is driving the knob.
 *
 * The rack read the document, so a knob under automation showed the COMMITTED
 * value while the DSP played the LANE's value — the user saw a number that was
 * not what they heard, and a manual edit was overwritten within one scheduler
 * tick while the knob kept showing the user's number.
 *
 * The smallest safe repair (audit F-09): an explicit "AUTO" badge on the
 * parameters that have an active lane, and the lane's current value shown
 * alongside the committed one.
 *
 * These assertions are about the SURFACE: the knob keeps the committed value
 * (that is what a drag writes back), and the line under it discloses what the
 * engine is playing.
 */
import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { EffectRack } from "../../src/ui/EffectRack";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { addAutomationLane, addAutomationPoint } from "../../src/commands/automation";
import type { ProjectDocument } from "../../src/project-model/types";

const FX_ID = "fx-reverb";

function setup(laneValue?: number) {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  const track = store.doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  track.effects = [{ id: FX_ID, type: "reverb", bypassed: false, params: { mix: 0.3, decay: 1.8, tone: 9000 } }];
  if (laneValue !== undefined) {
    store.execute(addAutomationLane(store.doc, { kind: "fxParam", trackId: track.id, fxId: FX_ID, paramId: "decay" }));
    const laneId = store.doc.automation[store.doc.automation.length - 1].id;
    store.execute(addAutomationPoint(store.doc, laneId, 0, laneValue));
  }
  const services = mockServices(store.doc);
  renderWithContext(<EffectRack track={track} />, { services });
  return { track, services, doc: store.doc };
}

describe("the effect rack discloses the value in effect (F-09)", () => {
  it("an automated knob shows the AUTO badge and the value the DSP plays", () => {
    setup(2.4);

    const readout = screen.getByTestId("fx-param-auto-decay");
    expect(readout).toHaveTextContent("AUTO");
    // The lane's value in the effect's own units (reverb decay is seconds).
    expect(readout).toHaveTextContent("2.40 s");
  });

  it("the knob itself keeps the COMMITTED value — a drag still writes what the user set", () => {
    setup(2.4);

    // The slider's own readout is the committed 1.8 s, not the lane's 2.4 s.
    const slider = screen.getByRole("slider", { name: /DECAY/ });
    expect(slider).toBeInTheDocument();
    expect(screen.getByText("1.80 s")).toBeInTheDocument();
  });

  it("a knob with no lane says nothing — the document value IS the value in effect", () => {
    setup();

    expect(screen.queryByTestId("fx-param-auto-decay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fx-param-auto-mix")).not.toBeInTheDocument();
    expect(screen.queryByText("AUTO")).not.toBeInTheDocument();
  });

  it("only the automated knob is marked — its neighbours stay quiet", () => {
    setup(2.4);

    expect(screen.getByTestId("fx-param-auto-decay")).toBeInTheDocument();
    expect(screen.queryByTestId("fx-param-auto-mix")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fx-param-auto-tone")).not.toBeInTheDocument();
  });

  it("the readout FOLLOWS the lane — a lane added later appears at once", () => {
    // The lane slice is subscribed explicitly: a lane arrives in
    // `doc.automation` and leaves `doc.tracks` untouched, so a rack that only
    // watched the tracks would keep showing a stale readout until some
    // unrelated edit happened to redraw it. The tracks slice is deliberately
    // NOT replaced here — only the lane slice changes, so the re-render can
    // only come from the lane subscription.
    const { services, doc, track } = setup();
    expect(screen.queryByTestId("fx-param-auto-decay")).not.toBeInTheDocument();

    const withLane: ProjectDocument = {
      ...doc,
      automation: [
        {
          id: "lane-1",
          target: { kind: "fxParam", trackId: track.id, fxId: FX_ID, paramId: "decay" },
          points: [{ tick: 0, value: 2.4 }],
        },
      ],
    };
    const store = services.store as unknown as {
      _setDoc: (next: ProjectDocument) => void;
      _emit: () => void;
    };
    store._setDoc(withLane);
    act(() => store._emit());

    expect(screen.getByTestId("fx-param-auto-decay")).toHaveTextContent("2.40 s");
  });
});
