import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserStrip } from "../../src/ui/BrowserStrip";
import { KYX_SAMPLE_MIME, sampleIdFromDrag } from "../../src/ui/SampleBrowser";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

const drumTrackOf = (doc: ReturnType<typeof createProjectFromTemplate>) => doc.tracks.find((t) => t.kind === "drum")!;
const instrumentTrackOf = (doc: ReturnType<typeof createProjectFromTemplate>) =>
  doc.tracks.find((t) => t.kind === "instrument")!;

function renderStrip(trackKind: "drum" | "instrument") {
  const doc = createProjectFromTemplate("house");
  const services = mockServices(doc);
  const track = trackKind === "drum" ? drumTrackOf(doc) : instrumentTrackOf(doc);
  const padId = track.kind === "drum" ? track.pads[0].id : "";
  return { doc, track, ...renderWithContext(<BrowserStrip track={track} selectedPadId={padId} />, { services }) };
}

describe("BrowserStrip (ROADMAP-UI-2027 V4)", () => {
  beforeEach(() => window.localStorage.removeItem("pf-browser-strip-v1"));

  it("mounts expanded by default and lazy-loads the sample browser", async () => {
    renderStrip("drum");
    expect(screen.getByLabelText("Sounds")).toBeInTheDocument();
    // The lazy browser chunk resolves async — its search box is the proof.
    await waitFor(() => expect(screen.getByLabelText("Search samples")).toBeInTheDocument(), { timeout: 4000 });
  });

  it("collapses to the labelled rail and back, persisting the state", async () => {
    const user = userEvent.setup();
    renderStrip("drum");
    await user.click(screen.getByRole("button", { name: "Collapse sounds browser" }));
    expect(screen.getByRole("button", { name: "Open sounds browser" })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("pf-browser-strip-v1")!)).toBe(false);
    await user.click(screen.getByRole("button", { name: "Open sounds browser" }));
    expect(screen.getByLabelText("Sounds")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("pf-browser-strip-v1")!)).toBe(true);
  });

  it("assigns a clicked sound to the selected drum pad", async () => {
    const { services, doc, track } = renderStrip("drum");
    await waitFor(() => expect(screen.getByLabelText("Search samples")).toBeInTheDocument(), { timeout: 4000 });
    // Any library sample-name button (not preview, not favorite).
    const sampleButton = screen.getAllByTitle(/— click to assign/)[0];
    await userEvent.setup().click(sampleButton);
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      type: string;
      execute: (d: typeof doc) => typeof doc;
    };
    expect(command.type).toBe("setPadParams");
    // The padId rides inside the command's withPad scope — the observable
    // contract is that executing it repoints the SELECTED pad's assetId.
    const nextDoc = command.execute(doc);
    const nextPad = nextDoc.tracks
      .find((t) => t.kind === "drum")!
      .pads.find((pad: { id: string }) => pad.id === (track as { pads: { id: string }[] }).pads[0].id)!;
    expect(nextPad.assetId).toBeTruthy();
  });

  it("assigns a clicked sound to the selected instrument track", async () => {
    const { services } = renderStrip("instrument");
    await waitFor(() => expect(screen.getByLabelText("Search samples")).toBeInTheDocument(), { timeout: 4000 });
    const sampleButton = screen.getAllByTitle(/— click to assign/)[0];
    await userEvent.setup().click(sampleButton);
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { type: string };
    expect(command.type).toBe("setInstrumentSample");
  });
});

describe("sample drag payload", () => {
  // jsdom ships no DataTransfer — a minimal setData/getData stub is all the
  // helper touches.
  const fakeTransfer = (entries: Record<string, string> = {}): DataTransfer =>
    ({
      getData: (type: string) => entries[type] ?? "",
    }) as DataTransfer;

  it("reads the custom MIME first, falls back to an id-shaped text/plain", () => {
    expect(sampleIdFromDrag(fakeTransfer({ [KYX_SAMPLE_MIME]: "kick-punch-v1" }))).toBe("kick-punch-v1");
    expect(sampleIdFromDrag(fakeTransfer({ "text/plain": "snare-vintage-01" }))).toBe("snare-vintage-01");
    expect(sampleIdFromDrag(fakeTransfer({ "text/plain": "hello world" }))).toBeNull();
    expect(sampleIdFromDrag(fakeTransfer())).toBeNull();
  });
});
