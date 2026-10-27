/**
 * The fallback disclosure in the effect rack (audit F-18).
 *
 * A runtime that fell back to the 1:1 passthrough IGNORES every
 * `setParameter` — so the knob still reads the document while the audio
 * passes through untouched. The user saw a parameter set that had no effect
 * on the sound, and the only warning sat on the device header, a poll away.
 *
 * The disclosure now sits AT the controls, in the same words the flagship
 * panels already use, and the device state chip says what the audio really
 * does instead of "ACTIVE".
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { EffectRack } from "../../src/ui/EffectRack";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";

const FX_ID = "fx-trem";
const REASON = "AudioWorklet unavailable — tremolo bypassed (1:1 signal)";

function docWithTremolo(): { doc: ProjectDocument; track: ProjectDocument["tracks"][number] } {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind === "instrument")!;
  track.effects = [
    {
      id: FX_ID,
      type: "tremolo" as const,
      bypassed: false,
      params: { rate: 5, depth: 0.5, shape: 0, mode: 0, mix: 1 },
    },
  ];
  return { doc, track };
}

function degrade(services: unknown, fxId = FX_ID): void {
  (
    services as { engine: { _setDegradedFx: (items: { fxId: string; reason: string }[]) => void } }
  ).engine._setDegradedFx([{ fxId, reason: REASON }]);
}

describe("the fallback disclosure in the effect rack (F-18)", () => {
  it("says AT THE CONTROLS that the runtime is a 1:1 passthrough", async () => {
    const { doc, track } = docWithTremolo();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });

    // Nothing is disclosed while the runtime is healthy.
    expect(screen.queryByTestId("fx-params-degraded")).not.toBeInTheDocument();

    degrade(services);

    const banner = await screen.findByTestId("fx-params-degraded", {}, { timeout: 5000 });
    expect(banner).toHaveTextContent(REASON);
  });

  it("the device state chip says PASSTHROUGH instead of ACTIVE", async () => {
    const { doc, track } = docWithTremolo();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });

    expect(screen.getByText("ACTIVE")).toBeInTheDocument();

    degrade(services);

    await screen.findByTestId("fx-params-degraded", {}, { timeout: 5000 });
    expect(screen.getByText("PASSTHROUGH")).toBeInTheDocument();
    expect(screen.queryByText("ACTIVE")).not.toBeInTheDocument();
  });

  it("the knob still shows the committed value — the document keeps it", async () => {
    const { doc, track } = docWithTremolo();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });

    degrade(services);
    await screen.findByTestId("fx-params-degraded", {}, { timeout: 5000 });

    // The value is stored in the project and applies when the module lands;
    // the disclosure (not a dead control) is what tells the truth.
    const depth = screen.getByRole("slider", { name: /depth/i });
    expect(depth.getAttribute("aria-valuenow")).toContain("0.5");
  });
});
