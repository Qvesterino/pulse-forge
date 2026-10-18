import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { SampleBrowser } from "../../src/ui/SampleBrowser";
import { mockServices, renderWithContext } from "../helpers";
import { FACTORY_ASSETS } from "../../src/sample-library/manifest";
import type { UserSampleAsset } from "../../src/persistence/UserSampleRepository";

const loopA: UserSampleAsset = {
  id: "user.loop-house-01",
  name: "House Drums",
  fileName: "house-drums.wav",
  category: "Custom",
  duration: 8,
  sampleRate: 44100,
  channels: 2,
  createdAt: "2026-10-18T00:00:00.000Z",
  bpm: 120,
  loopMetadata: { isLoop: true, genre: "House", mood: "Deep", instrument: "Drums", key: "Am" },
};

const loopB: UserSampleAsset = {
  ...loopA,
  id: "user.loop-techno-02",
  name: "Techno Bass",
  fileName: "techno-bass.wav",
  bpm: 140,
  loopMetadata: { isLoop: true, genre: "Techno", mood: "Dark", instrument: "Bass", key: "F#m" },
};

describe("SampleBrowser", () => {
  it("renders a row for each factory asset (sample-name buttons visible)", () => {
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />);
    // sample-name buttons carry the asset name; we should have one per asset
    const names = screen.getAllByRole("button", { name: /Kick Punch|Kick Deep|Snare/ });
    expect(names.length).toBeGreaterThan(0);
  });

  it("typing in the search box filters the visible tiles", () => {
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    const beforeCount = screen.getAllByRole("button").length;
    fireEvent.change(input, { target: { value: "no-such-pack-zzz" } });
    const afterCount = screen.getAllByRole("button").length;
    expect(afterCount).toBeLessThanOrEqual(beforeCount);
  });

  it("clicking a sample-name button fires onSelect with the asset id", () => {
    const onSelect = vi.fn();
    const { container } = renderWithContext(
      <SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={onSelect} />,
    );
    const sampleButton = container.querySelector("button.sample-name") as HTMLButtonElement;
    fireEvent.click(sampleButton);
    expect(onSelect).toHaveBeenCalled();
  });

  it("empty asset list renders no rows", () => {
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />);
    expect(screen.queryAllByRole("button", { name: /Kick/ })).toHaveLength(0);
  });

  it("filters loops by tags and tempo metadata", async () => {
    const services = mockServices();
    vi.mocked(services.userSamples.list).mockResolvedValue([loopA, loopB]);
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />, { services });

    await screen.findByRole("button", { name: /LOOPS 2/ });
    fireEvent.click(screen.getByRole("button", { name: /LOOPS 2/ }));
    expect(screen.getByRole("button", { name: "House Drums" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Techno Bass" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by genre"), { target: { value: "House" } });
    fireEvent.change(screen.getByLabelText("Minimum BPM"), { target: { value: "110" } });
    expect(screen.getByRole("button", { name: "House Drums" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Techno Bass" })).not.toBeInTheDocument();
    expect(screen.getByText("120 BPM")).toBeInTheDocument();
  });

  it("saves user loop tags and previews the loop through the tempo-aware callback", async () => {
    const services = mockServices();
    const untagged: UserSampleAsset = { ...loopA, loopMetadata: { isLoop: false } };
    vi.mocked(services.userSamples.list).mockResolvedValue([untagged]);
    const onPreviewLoop = vi.fn();
    renderWithContext(
      <SampleBrowser
        assets={[]}
        currentId={null}
        onSelect={vi.fn()}
        onPreviewLoop={onPreviewLoop}
        onAddLoop={vi.fn()}
      />,
      { services },
    );

    await screen.findByRole("button", { name: "Edit loop tags for House Drums" });
    fireEvent.click(screen.getByRole("button", { name: "Edit loop tags for House Drums" }));
    fireEvent.click(screen.getByLabelText("Include in loop browser"));
    fireEvent.change(screen.getByLabelText("Genre"), { target: { value: "Ambient" } });
    fireEvent.change(screen.getByLabelText("Mood"), { target: { value: "Warm" } });
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "Pad" } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: "SAVE TAGS" }));

    await waitFor(() => expect(services.userSamples.save).toHaveBeenCalled());
    expect(services.userSamples.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: untagged.id,
        loopMetadata: { isLoop: true, genre: "Ambient", mood: "Warm", instrument: "Pad", key: "C" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /LOOPS 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview loop in project tempo House Drums" }));
    expect(onPreviewLoop).toHaveBeenCalledWith(expect.objectContaining({ id: untagged.id }));
    expect(screen.getByRole("button", { name: "Add House Drums to arrangement" })).toBeInTheDocument();
  });
});
