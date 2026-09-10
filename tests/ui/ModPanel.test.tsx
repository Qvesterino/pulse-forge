import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModPanel } from "../../src/ui/ModPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("ModPanel", () => {
  it("renders with correct aria label", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByRole("region", { name: /Automation, LFOs and macros/ })).toBeInTheDocument();
  });

  it("renders AUTOMATION section", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByText("AUTOMATION")).toBeInTheDocument();
  });

  it("renders MODULATORS section (LFO / S&H / Step / Env Follower)", () => {
    const { container } = renderWithContext(<ModPanel />);
    expect(screen.getByText("MODULATORS")).toBeInTheDocument();
    // Kind picker groups all four modulator families per track (value-encoded).
    const picker = container.querySelector('select[aria-label="Add modulator"]');
    expect(picker).not.toBeNull();
    const values = [...(picker?.querySelectorAll("option") ?? [])].map((o) => o.value);
    expect(values.some((v) => v.startsWith("osc:"))).toBe(true);
    expect(values.some((v) => v.startsWith("random:"))).toBe(true);
    expect(values.some((v) => v.startsWith("step:"))).toBe(true);
    expect(values.some((v) => v.startsWith("envFollower:"))).toBe(true);
  });

  it("renders MACROS section", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByText("MACROS")).toBeInTheDocument();
  });

  it("renders SCENES section", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByText("SCENES")).toBeInTheDocument();
  });
});

describe("ModPanel — Ultina deep-parameter lane targets (phase U1)", () => {
  const user = userEvent.setup();

  function docWithUltina() {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks[0];
    (track as { effects: unknown[] }).effects = [
      { id: "fx-u1", type: "ultina", bypassed: false, params: {} },
    ];
    return doc;
  }

  it("offers grouped deep parameters with a filter input when an Ultina is present", async () => {
    const doc = docWithUltina();
    const { container } = renderWithContext(<ModPanel />, { services: mockServices(doc) });

    // Filter input appears only for tracks hosting an Ultina.
    const filter = screen.getByLabelText("Filter VLYX parameters") as HTMLInputElement;

    const picker = container.querySelector('select[aria-label="Automation target parameter"]')!;
    const optgroups = [...picker.querySelectorAll("optgroup")].map((g) => g.getAttribute("label"));
    expect(optgroups.some((l) => l === "VLYX · Comp")).toBe(true);
    expect(optgroups.some((l) => l === "VLYX · EQ")).toBe(true);

    const values = [...picker.querySelectorAll("option")].map((o) => o.value);
    expect(values).toContain("fxParam:fx-u1:comp.thresholdDb");
    expect(values).toContain("fxParam:fx-u1:eq.band3.gainDb");

    // Filtering narrows to matching labels/ids only.
    await user.type(filter, "threshold");
    const narrowed = [...picker.querySelectorAll("option")].map((o) => o.value);
    expect(narrowed).toContain("fxParam:fx-u1:comp.thresholdDb");
    expect(narrowed).not.toContain("fxParam:fx-u1:comp.attackMs");
  });

  it("no filter input and no deep groups without an Ultina on the track", () => {
    const doc = createProjectFromTemplate("house");
    const { container } = renderWithContext(<ModPanel />, { services: mockServices(doc) });
    expect(screen.queryByLabelText("Filter VLYX parameters")).toBeNull();
    const picker = container.querySelector('select[aria-label="Automation target parameter"]')!;
    const labels = [...picker.querySelectorAll("optgroup")].map((g) => g.getAttribute("label") ?? "");
    expect(labels.every((l) => !l.startsWith("VLYX"))).toBe(true);
  });

  it("adds a deep-parameter lane through the picker", async () => {
    const doc = docWithUltina();
    const { services } = renderWithContext(<ModPanel />, { services: mockServices(doc) });
    const targetPicker = screen.getByLabelText("Automation target parameter") as HTMLSelectElement;
    await user.selectOptions(targetPicker, "fxParam:fx-u1:comp.thresholdDb");
    // "+ LANE" appears in several sections — take the automation section's own button.
    await user.click(screen.getAllByRole("button", { name: "+ LANE" })[0]);
    // The mock store records the command; executing it on the real doc proves
    // the picker produced the right target.
    const { vi: vitest } = await import("vitest");
    const calls = (services.store.execute as ReturnType<typeof vitest.fn>).mock.calls;
    const addLaneCall = calls.find(
      (c) => (c[0] as { type: string }).type === "addAutomationLane",
    );
    expect(addLaneCall).toBeDefined();
    const next = (addLaneCall![0] as { execute: (d: typeof doc) => typeof doc }).execute(doc);
    const lane = next.automation.find(
      (l) => l.target.kind === "fxParam" && l.target.paramId === "comp.thresholdDb",
    );
    expect(lane).toBeDefined();
    expect(lane!.target.fxId).toBe("fx-u1");
  });
});
