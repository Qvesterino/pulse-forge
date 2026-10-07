import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Mixer } from "../../src/ui/Mixer";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";

describe("Mixer performance workflow", () => {
  it("surfaces the first four performance macros in the mixer", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(<Mixer />, { services: mockServices(doc) });

    expect(screen.getByRole("group", { name: "Performance macros" })).toBeInTheDocument();
    expect(screen.getByText("DRUMS")).toBeInTheDocument();
    expect(screen.getByText("BASS")).toBeInTheDocument();
    expect(screen.getByText("MUSIC")).toBeInTheDocument();
    expect(screen.getByText("WIDTH")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Macro DRUMS" })).toHaveAttribute("aria-valuenow", "0.5");
  });

  it("reports the actual selected-track count in the batch FX toolbar", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });

    expect(screen.getByText("BATCH FX → 3 TRACKS")).toBeInTheDocument();
  });

  it("reveals the FX rack after a batch add (device UI becomes visible)", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const onOpenFxPanel = vi.fn();
    renderWithContext(<Mixer onOpenFxPanel={onOpenFxPanel} />, { services });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch effect type" }), "kaskada");
    await user.click(screen.getByRole("button", { name: /ADD TO/ }));

    expect(onOpenFxPanel).toHaveBeenCalledTimes(1);
  });

  it("toggles the master buss glue through one command", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });

    const user = userEvent.setup();
    const glue = screen.getByRole("button", { name: "Master glue" });
    expect(glue).toHaveAttribute("aria-pressed", "true");
    await user.click(glue);

    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string },
    );
    expect(executed.some((c) => c.type === "setMasterConfig")).toBe(true);
  });

  it("shows the master TILT/TRIM knobs with the document's current values", () => {
    // Sound-quality pass: the song builder pre-sets tilt (genre tone) and the
    // loudness trim (genre reference) — the master strip must DISPLAY them.
    const doc = createProjectFromTemplate("house");
    const withKnobs = {
      ...doc,
      master: { ...doc.master, tiltDb: 1.5, loudnessTrimDb: -5.7 },
    };
    renderWithContext(<Mixer />, { services: mockServices(withKnobs) });

    expect(screen.getByRole("slider", { name: "TILT" })).toHaveAttribute("aria-valuenow", "1.5");
    expect(screen.getByRole("slider", { name: "TRIM" })).toHaveAttribute("aria-valuenow", "-5.7");
  });

  it("TILT/TRIM read 0 on a project that never touched the sound-quality pass", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(<Mixer />, { services: mockServices(doc) });

    expect(screen.getByRole("slider", { name: "TILT" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("slider", { name: "TRIM" })).toHaveAttribute("aria-valuenow", "0");
  });
});

/* -----------------------------------------------------------------------
 * Wave D (2026-10-07): track reorder drag. Dropping a strip onto a
 * non-group strip reorders (left half = before, right half = after);
 * dropping onto a GROUP strip keeps the established add-to-group meaning.
 */
describe("Mixer track reorder drag (Wave D)", () => {
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = undefined;
  });
  function wideStrips(): void {
    // jsdom rects are zero-sized, which the drop handler treats as "no side
    // pickable" — give strips a 100 px rect so clientX 40 = left half,
    // clientX 60 = right half.
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 400,
      width: 100,
      height: 400,
      toJSON: () => ({}),
    } as DOMRect);
  }
  // Track strips in DOC order (house has no groups — nothing collapsed), so
  // index i maps to doc.tracks[i]. Names are abbreviated in the DOM ("DR"),
  // order is the stable identity here.
  const trackStrip = (index: number): HTMLElement => {
    const strips = Array.from(document.querySelectorAll<HTMLElement>(".channel-strip")).filter(
      (candidate) => !candidate.className.includes("return-strip") && !candidate.className.includes("master-strip"),
    );
    const el = strips[index];
    if (!el) throw new Error(`track strip ${index} not found`);
    return el;
  };
  const dispatched = (services: ReturnType<typeof mockServices>): Array<Record<string, unknown>> =>
    (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as Record<string, unknown>);
  // fireEvent.drop(el, { clientX }) does NOT propagate coordinates in jsdom
  // (the DragEvent constructor drops unknown props) — build the event manually
  // so the handler actually sees the pointer position.
  const dropEvent = (draggedId: string, clientX: number): Event =>
    Object.assign(new Event("drop", { bubbles: true }), {
      clientX,
      dataTransfer: { setData: vi.fn(), getData: vi.fn(() => draggedId), dropEffect: "", effectAllowed: "" },
    }) as unknown as Event;

  it("drop on a strip's left half lands the dragged track before it", () => {
    const doc = createProjectFromTemplate("house"); // Drums, 808, Chords
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });
    wideStrips();
    const [drums] = doc.tracks;
    fireEvent.dragStart(trackStrip(0), {
      dataTransfer: { setData: vi.fn(), getData: vi.fn(), dropEffect: "", effectAllowed: "" },
    });
    fireEvent(trackStrip(2), dropEvent(drums!.id, 40));
    const cmd = dispatched(services).find((c) => c.type === "moveTrackAdjacent");
    expect(cmd).toBeDefined();
    // Execute the dispatched command against the real doc — the dispatch
    // must carry the full intent, not just a type tag.
    const next = (cmd as unknown as { execute: (d: ProjectDocument) => ProjectDocument }).execute(doc);
    expect(next.tracks.map((t) => t.id)).toEqual([doc.tracks[1]!.id, doc.tracks[0]!.id, doc.tracks[2]!.id]);
  });

  it("drop on a strip's right half lands the dragged track after it", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });
    wideStrips();
    const [, , chords] = doc.tracks;
    fireEvent.dragStart(trackStrip(2), {
      dataTransfer: { setData: vi.fn(), getData: vi.fn(), dropEffect: "", effectAllowed: "" },
    });
    fireEvent(trackStrip(0), dropEvent(chords!.id, 60));
    const cmd = dispatched(services).find((c) => c.type === "moveTrackAdjacent");
    expect(cmd).toBeDefined();
    const next = (cmd as unknown as { execute: (d: ProjectDocument) => ProjectDocument }).execute(doc);
    expect(next.tracks.map((t) => t.id)).toEqual([doc.tracks[0]!.id, doc.tracks[2]!.id, doc.tracks[1]!.id]);
  });

  it("a drop with no measurable width degrades to 'before' instead of guessing", () => {
    const doc = createProjectFromTemplate("house"); // NO rect spy — jsdom zero rects
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });
    const [drums] = doc.tracks;
    fireEvent.dragStart(trackStrip(0), {
      dataTransfer: { setData: vi.fn(), getData: vi.fn(), dropEffect: "", effectAllowed: "" },
    });
    fireEvent(trackStrip(2), dropEvent(drums!.id, 60)); // right-half px, but no rect
    const cmd = dispatched(services).find((c) => c.type === "moveTrackAdjacent") as unknown as {
      label: string;
      execute: (d: ProjectDocument) => ProjectDocument;
    };
    expect(cmd).toBeDefined();
    // Degrades to "before" (never picks a side it cannot see) — Drums before
    // Chords is a real move (808, Drums, Chords), so NOT a no-op entry.
    expect(cmd.label).not.toContain("(no-op)");
    const next = cmd.execute(doc);
    expect(next.tracks.map((t) => t.id)).toEqual([doc.tracks[1]!.id, doc.tracks[0]!.id, doc.tracks[2]!.id]);
  });
});
