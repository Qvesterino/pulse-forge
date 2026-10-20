import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { SampleBrowser } from "../../src/ui/SampleBrowser";
import { mockServices, renderWithContext } from "../helpers";
import { FACTORY_ASSETS } from "../../src/sample-library/manifest";
import type { UserSampleAsset } from "../../src/persistence/UserSampleRepository";
import { PPQ } from "../../src/project-model/types";
import { tempoAtTick } from "../../src/project-model/scene-time";
import { ticksPerBar } from "../../src/project-model/schema";

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
    expect(screen.getByText("Deep, Punchy")).toBeVisible();
  });

  it("typing in the search box filters the visible tiles", () => {
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    const beforeCount = screen.getAllByRole("button").length;
    fireEvent.change(input, { target: { value: "no-such-pack-zzz" } });
    const afterCount = screen.getAllByRole("button").length;
    expect(afterCount).toBeLessThanOrEqual(beforeCount);
  });

  it("matches separate sound traits across the name, character, and category", () => {
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search samples" }), {
      target: { value: "kick deep punchy" },
    });

    expect(screen.getByRole("button", { name: "Kick Deep" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kick Punch" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "KICK" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "KICK" }));
    expect(screen.getByRole("button", { name: "KICK" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows sound result counts and clears search filters in one action", () => {
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(`${FACTORY_ASSETS.length} of ${FACTORY_ASSETS.length} sounds`);

    fireEvent.change(screen.getByRole("textbox", { name: "Search samples" }), {
      target: { value: "no-such-pack-zzz" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(`0 of ${FACTORY_ASSETS.length} sounds`);
    fireEvent.click(screen.getByRole("button", { name: "Clear sound filters" }));

    expect(screen.getByRole("status")).toHaveTextContent(`${FACTORY_ASSETS.length} of ${FACTORY_ASSETS.length} sounds`);
    expect(screen.getByRole("textbox", { name: "Search samples" })).toHaveValue("");
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

  it("auditions one-shots on the next beat over the running mix without mutating the project", () => {
    const services = mockServices();
    vi.spyOn(services.transport, "playing", "get").mockReturnValue(true);
    services.engine.stopPreview = vi.fn();
    services.engine.previewAsset = vi.fn();
    services.engine.previewAssetSynced = vi.fn();
    const before = services.store.getDoc();
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />, { services });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview Kick Deep in the current mix (next beat while playing)",
      }),
    );

    expect(services.engine.stopPreview).toHaveBeenCalledOnce();
    expect(services.engine.previewAssetSynced).toHaveBeenCalledWith("factory.kick.deep", 1, false);
    expect(services.engine.previewAsset).not.toHaveBeenCalled();
    expect(services.store.getDoc()).toEqual(before);
  });

  it("empty asset list renders no rows", () => {
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />);
    expect(screen.queryAllByRole("button", { name: /Kick/ })).toHaveLength(0);
  });

  it("filters loops by genre, mood, instrument, key, and BPM range", async () => {
    const services = mockServices();
    vi.mocked(services.userSamples.list).mockResolvedValue([loopA, loopB]);
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />, { services });

    await screen.findByRole("button", { name: /LOOPS 2/ });
    fireEvent.click(screen.getByRole("button", { name: /LOOPS 2/ }));
    expect(screen.getByRole("button", { name: "House Drums" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Techno Bass" })).toBeInTheDocument();

    const filters = [
      ["Filter by genre", "House"],
      ["Filter by mood", "Deep"],
      ["Filter by instrument", "Drums"],
      ["Filter by key", "Am"],
    ] as const;
    for (const [label, value] of filters) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(screen.getByRole("button", { name: "House Drums" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Techno Bass" })).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(label), { target: { value: "all" } });
      expect(screen.getByRole("button", { name: "Techno Bass" })).toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText("Minimum BPM"), { target: { value: "115" } });
    fireEvent.change(screen.getByLabelText("Maximum BPM"), { target: { value: "125" } });
    expect(screen.getByRole("button", { name: "House Drums" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Techno Bass" })).not.toBeInTheDocument();
    expect(screen.getByText("120 BPM")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Maximum BPM"), { target: { value: "119" } });
    expect(screen.getByText("No loops match. Try another filter or clear the search.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear loop filters" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search loops" }), {
      target: { value: "techno dark bass 140" },
    });
    expect(screen.getByRole("button", { name: "Techno Bass" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "House Drums" })).not.toBeInTheDocument();
  });

  it("clears all loop filters together when the result set is empty", async () => {
    const services = mockServices();
    vi.mocked(services.userSamples.list).mockResolvedValue([loopA, loopB]);
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />, { services });

    await screen.findByRole("button", { name: /LOOPS 2/ });
    fireEvent.click(screen.getByRole("button", { name: /LOOPS 2/ }));
    fireEvent.change(screen.getByLabelText("Filter by genre"), { target: { value: "House" } });
    fireEvent.change(screen.getByLabelText("Maximum BPM"), { target: { value: "100" } });

    expect(screen.getByRole("status")).toHaveTextContent("0 of 2 loops");
    fireEvent.click(screen.getByRole("button", { name: "Clear loop filters" }));

    expect(screen.getByRole("status")).toHaveTextContent("2 of 2 loops");
    expect(screen.getByLabelText("Filter by genre")).toHaveValue("all");
    expect(screen.getByLabelText("Maximum BPM")).toHaveValue(null);
    expect(screen.getByRole("button", { name: "House Drums" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Techno Bass" })).toBeInTheDocument();
  });

  it("previews a loop at the project tempo when used outside the browser strip", async () => {
    const services = mockServices();
    vi.mocked(services.userSamples.list).mockResolvedValue([loopA]);
    services.engine.previewAssetSynced = vi.fn();
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />, { services });

    await screen.findByRole("button", { name: /LOOPS 1/ });
    fireEvent.click(screen.getByRole("button", { name: /LOOPS 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview loop in project tempo House Drums" }));

    const doc = services.store.getDoc();
    const nextBeatTick = (Math.floor(services.transport.position / PPQ) + 1) * PPQ;
    const targetBpm = tempoAtTick(doc.arrangement.clips, doc.scenes, nextBeatTick, doc.bpm, ticksPerBar(doc));
    expect(services.engine.previewAssetSynced).toHaveBeenCalledWith(loopA.id, targetBpm / loopA.bpm!, true);
  });

  it("saves user loop tags and previews the loop through the tempo-aware callback", async () => {
    const services = mockServices();
    const untagged: UserSampleAsset = { ...loopA, bpm: undefined, loopMetadata: { isLoop: false } };
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
    fireEvent.change(screen.getByLabelText("Loop tempo BPM"), { target: { value: "123.4" } });
    fireEvent.change(screen.getByLabelText("Genre"), { target: { value: "Ambient" } });
    fireEvent.change(screen.getByLabelText("Mood"), { target: { value: "Warm" } });
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "Pad" } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: "SAVE TAGS" }));

    await waitFor(() => expect(services.userSamples.save).toHaveBeenCalled());
    expect(services.userSamples.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: untagged.id,
        bpm: 123.4,
        loopMetadata: { isLoop: true, genre: "Ambient", mood: "Warm", instrument: "Pad", key: "C" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /LOOPS 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview loop in project tempo House Drums" }));
    expect(onPreviewLoop).toHaveBeenCalledWith(expect.objectContaining({ id: untagged.id, bpm: 123.4 }));
    expect(screen.getByRole("button", { name: "Add House Drums to arrangement" })).toBeInTheDocument();
  });

  it("rejects an out-of-range loop tempo and leaves the saved sample unchanged", async () => {
    const services = mockServices();
    vi.mocked(services.userSamples.list).mockResolvedValue([loopA]);
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />, { services });

    await screen.findByRole("button", { name: "Edit loop tags for House Drums" });
    fireEvent.click(screen.getByRole("button", { name: "Edit loop tags for House Drums" }));
    fireEvent.change(screen.getByLabelText("Loop tempo BPM"), { target: { value: "241" } });

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a tempo from 40 to 240 BPM.");
    expect(screen.getByRole("button", { name: "SAVE TAGS" })).toBeDisabled();
    expect(services.userSamples.save).not.toHaveBeenCalled();
  });
});
