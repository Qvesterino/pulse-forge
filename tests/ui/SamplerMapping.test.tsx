import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Inspector } from "../../src/ui/Inspector";
import { createInstrumentTrack } from "../../src/commands/commands";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { UserSampleAsset } from "../../src/persistence/UserSampleRepository";
import type { InstrumentTrack } from "../../src/project-model/types";
import { mockServices, renderWithContext } from "../helpers";

vi.mock("../../src/ui/FreesoundSection", () => ({
  FreesoundSection: () => null,
}));

vi.mock("../../src/ui/DropZone", () => ({
  DropZone: ({
    onImport,
    onBatchImport,
  }: {
    onImport: (asset: UserSampleAsset) => void;
    onBatchImport?: (assets: UserSampleAsset[]) => void;
  }) => {
    const assets: UserSampleAsset[] = [
      {
        id: "user.piano-c3",
        name: "piano_C3",
        fileName: "piano_C3.wav",
        category: "Custom",
        duration: 1,
        sampleRate: 44100,
        channels: 1,
        createdAt: "2026-09-11T00:00:00.000Z",
      },
      {
        id: "user.piano-c4",
        name: "piano_C4",
        fileName: "piano_C4.wav",
        category: "Custom",
        duration: 1,
        sampleRate: 44100,
        channels: 1,
        createdAt: "2026-09-11T00:00:01.000Z",
      },
    ];
    return (
      <button
        type="button"
        aria-label="Mock multi-sample drop"
        onClick={() => {
          assets.forEach(onImport);
          onBatchImport?.(assets);
        }}
      >
        MOCK DROP
      </button>
    );
  },
}));

function samplerDoc(): { track: InstrumentTrack; doc: ReturnType<typeof createProjectFromTemplate> } {
  let doc = createProjectFromTemplate("empty");
  doc = createInstrumentTrack(doc, "sampler").execute(doc);
  const track = doc.tracks.at(-1);
  if (!track || track.kind !== "instrument") throw new Error("sampler track missing");
  return { track, doc };
}

describe("Sampler AutoMap UI contract", () => {
  it("keeps multi-file import as a proposal and applies it in one command", async () => {
    const user = userEvent.setup();
    const { track, doc } = samplerDoc();
    const services = mockServices(doc);
    renderWithContext(<Inspector track={track} selectedPadId="pad-1" />, { services });

    await user.click(screen.getByRole("button", { name: "Mock multi-sample drop" }));
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "Sampler mapping preview" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "PREVIEW" }));
    expect(services.engine.previewAsset).toHaveBeenCalledWith("user.piano-c3");

    await user.click(screen.getByRole("button", { name: "APPLY MAP" }));
    expect(services.store.execute).toHaveBeenCalledTimes(1);
    const executeMock = services.store.execute as ReturnType<typeof vi.fn>;
    expect(executeMock.mock.calls[0][0]).toMatchObject({ type: "setVelocityLayers" });
    expect(screen.queryByRole("dialog", { name: "Sampler mapping preview" })).toBeNull();
  });

  it("cancels the mapping proposal without touching project history", async () => {
    const user = userEvent.setup();
    const { track, doc } = samplerDoc();
    const services = mockServices(doc);
    renderWithContext(<Inspector track={track} selectedPadId="pad-1" />, { services });

    await user.click(screen.getByRole("button", { name: "Mock multi-sample drop" }));
    await user.click(screen.getByRole("button", { name: "CANCEL" }));
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Sampler mapping preview" })).toBeNull();
  });
});
