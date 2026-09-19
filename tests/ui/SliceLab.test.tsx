import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SliceLab } from "../../src/ui/SliceLab";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { FACTORY_ASSETS } from "../../src/sample-library/manifest";
import type { DrumTrack } from "../../src/project-model/types";

function fakeBuffer(durationSec = 2, sampleRate = 44100) {
  const length = Math.round(durationSec * sampleRate);
  return {
    duration: durationSec,
    sampleRate,
    numberOfChannels: 1,
    length,
    getChannelData: () => new Float32Array(length),
  };
}

describe("SliceLab", () => {
  function drumTrack(): DrumTrack {
    const doc = createProjectFromTemplate("house");
    const t = doc.tracks.find((tr): tr is DrumTrack => tr.kind === "drum");
    if (!t) throw new Error("expected drum track");
    return t;
  }

  function servicesWithBuffer() {
    const services = mockServices();
    const buf = fakeBuffer(2, 44100) as unknown as AudioBuffer;
    (services.bank as unknown as { get: (id: string) => unknown }).get = vi.fn((id: string) =>
      id === FACTORY_ASSETS[0].id ? buf : undefined,
    );
    return services;
  }

  it("renders the SliceLab header and Close button", () => {
    renderWithContext(<SliceLab track={drumTrack()} onClose={vi.fn()} />, { services: servicesWithBuffer() });
    expect(screen.getByRole("heading", { name: /SLICE LAB/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Close sample to beat editor/i })).toBeInTheDocument();
  });

  it("clicking Close calls the onClose handler", () => {
    const onClose = vi.fn();
    renderWithContext(<SliceLab track={drumTrack()} onClose={onClose} />, { services: servicesWithBuffer() });
    fireEvent.click(screen.getByRole("button", { name: /Close sample to beat editor/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders mode toggle buttons (1/16, 1/8, HITS) when a buffer is loaded", () => {
    renderWithContext(<SliceLab track={drumTrack()} onClose={vi.fn()} />, { services: servicesWithBuffer() });
    expect(screen.getByRole("button", { name: "1/16" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1/8" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "HITS" })).toBeInTheDocument();
  });

  it("changing to HITS mode activates the HITS toggle", () => {
    renderWithContext(<SliceLab track={drumTrack()} onClose={vi.fn()} />, { services: servicesWithBuffer() });
    const hitsBtn = screen.getByRole("button", { name: "HITS" });
    fireEvent.click(hitsBtn);
    expect(hitsBtn).toHaveClass("active");
  });
});
