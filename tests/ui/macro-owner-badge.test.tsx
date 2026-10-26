/**
 * The "KTO RIADI" badge — the disclosure half of the modulation precedence
 * (ADR 0067, audit F-11).
 *
 * Before the ADR the losing source was dropped SILENTLY: the user moved the
 * macro and nothing happened, with nothing on screen saying that an
 * automation lane was holding the parameter. The badge names the owner.
 *
 * It is read from the SAME read model the engine's write gate applies
 * (`modulation-precedence.ts`), so the badge can never disagree with the
 * engine about who owns a parameter.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { MacroPerformanceBar } from "../../src/ui/MacroPerformanceBar";
import { ModPanel } from "../../src/ui/ModPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { AutomationTarget, ProjectDocument } from "../../src/project-model/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const FX_ID = "fx-trem";

/** A house project whose first macro maps an effect parameter. */
function docWithMacro(onFxParam: { lane: boolean }): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  const trackId = doc.tracks[0].id;
  (doc.tracks[0] as { effects: unknown[] }).effects = [
    { id: FX_ID, type: "tremolo", bypassed: false, params: { rate: 5, depth: 0.5, shape: 0, mode: 0, mix: 1 } },
  ];
  const target: AutomationTarget = { kind: "fxParam", trackId, fxId: FX_ID, paramId: "depth" };
  doc.macros = [
    {
      id: "macro-1",
      name: "M",
      value: 0.5,
      mappings: [{ id: "map-1", trackId, param: "fxParam", amount: 1, source: "macro", target }],
    },
  ];
  doc.automation = onFxParam.lane ? [{ id: "lane-1", target, points: [{ tick: 0, value: 0.3 }] }] : [];
  return doc;
}

describe("the modulation owner badge (F-11)", () => {
  it("names the automation lane that outranks the macro", () => {
    const doc = docWithMacro({ lane: true });
    renderWithContext(<MacroPerformanceBar />, { services: mockServices(doc) });

    const badge = screen.getByTestId("mod-owner-badge");
    expect(badge).toHaveTextContent("AUTO");
    expect(badge.getAttribute("title")).toContain("automatická dráha");
  });

  it("shows nothing when the macro owns its parameter — nothing outranks it", () => {
    const doc = docWithMacro({ lane: false });
    renderWithContext(<MacroPerformanceBar />, { services: mockServices(doc) });

    expect(screen.queryByTestId("mod-owner-badge")).not.toBeInTheDocument();
  });

  it("FOLLOWS the lane slice — a lane added later shows the badge at once", () => {
    // The lane lives in `doc.automation` and leaves `doc.tracks` untouched, so
    // a surface that only watched the tracks would keep showing nothing. The
    // tracks slice is deliberately NOT replaced here, so the re-render can
    // only come from the ownership subscription.
    const doc = docWithMacro({ lane: false });
    const services = mockServices(doc);
    renderWithContext(<MacroPerformanceBar />, { services });
    expect(screen.queryByTestId("mod-owner-badge")).not.toBeInTheDocument();

    const store = services.store as unknown as {
      _setDoc: (next: ProjectDocument) => void;
      _emit: () => void;
    };
    store._setDoc(docWithMacro({ lane: true }));
    act(() => store._emit());

    expect(screen.getByTestId("mod-owner-badge")).toHaveTextContent("AUTO");
  });

  it("the MOD panel names the owner on the mapping row", () => {
    const doc = docWithMacro({ lane: true });
    renderWithContext(<ModPanel />, { services: mockServices(doc) });

    expect(screen.getByTestId("mod-owner-badge")).toHaveTextContent("AUTO");
  });

  it("the MOD panel names no owner when the macro holds the parameter", () => {
    const doc = docWithMacro({ lane: false });
    renderWithContext(<ModPanel />, { services: mockServices(doc) });

    expect(screen.queryByTestId("mod-owner-badge")).not.toBeInTheDocument();
  });
});
