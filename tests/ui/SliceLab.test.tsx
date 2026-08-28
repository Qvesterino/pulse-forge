import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SliceLab } from "../../src/ui/SliceLab";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";

describe("SliceLab", () => {
  it("opens as a modal and exposes factory/user sample workflow controls", async () => {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((track) => track.kind === "drum")!;
    const services = mockServices(doc);
    const buffer = {
      duration: 1,
      sampleRate: 44100,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(44100),
    } as unknown as AudioBuffer;
    (services.bank.get as any).mockReturnValue(buffer);
    (services.userSamples.list as any).mockResolvedValue([
      {
        id: "user.break",
        name: "Break",
        fileName: "break.wav",
        category: "Custom",
        duration: 1,
        sampleRate: 44100,
        channels: 1,
        createdAt: "2026-01-01",
      },
    ]);

    renderWithContext(<SliceLab track={drum} onClose={() => undefined} />, { services });

    expect(screen.getByRole("dialog", { name: "Sample to beat editor" })).toBeInTheDocument();
    expect(screen.getByText("SAMPLE TO BEAT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CHOP + PATTERN" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "LOOP PREVIEW" })).toBeInTheDocument();
    expect(screen.getByLabelText("Sample waveform with slice markers")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Break")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "CHOP + PATTERN" }));
    expect(services.store.execute).toHaveBeenCalledTimes(1);
  });

  it("stops preview when the modal is closed", async () => {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((track) => track.kind === "drum")!;
    const services = mockServices(doc);
    const onClose = vi.fn();
    renderWithContext(<SliceLab track={drum} onClose={onClose} />, { services });

    await waitFor(() => expect(screen.getAllByText("SOURCE UNAVAILABLE").length).toBeGreaterThan(0));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(services.engine.stopPreview as any).toHaveBeenCalled();
  });
});
