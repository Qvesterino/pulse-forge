import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inspector } from "../../src/ui/Inspector";
import { TrackTabs } from "../../src/ui/TrackTabs";
import { createInstrumentTrackModel } from "../../src/project-model/schema";
import { createInstrumentTrack } from "../../src/commands/commands";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { Services } from "../../src/services";
import type { InstrumentTrack } from "../../src/project-model/types";

function servicesWithTrack(track: InstrumentTrack): Services {
  const services = mockServices();
  (services as any).userSamples = {
    list: vi.fn(async () => []),
    save: vi.fn(),
    remove: vi.fn(),
  };
  // PresetBrowser expects a promise from core.presets.list()
  (services.core as any).presets = {
    save: vi.fn(),
    load: vi.fn(),
    list: vi.fn(async () => []),
  };
  // useLibrary() subscribes via useSyncExternalStore — the snapshot must be
  // referentially stable or React loops. mockServices returns a fresh object
  // per get() call, so pin one stable snapshot here.
  const librarySnapshot = {
    favoriteAssets: [] as string[],
    recentAssets: [] as string[],
    favoritePresets: [] as string[],
    recentPresets: [] as string[],
  };
  (services as any).library = {
    get: () => librarySnapshot,
    subscribe: () => () => {},
    toggleAssetFavorite: vi.fn(),
    togglePresetFavorite: vi.fn(),
    recordAsset: vi.fn(),
    recordPreset: vi.fn(),
  };
  (services.core as any).library = (services as any).library;
  (services as any).bank = {
    get: vi.fn(() => null),
    add: vi.fn(),
    size: 0,
    entries: () => [],
  };
  const doc = services.store.doc;
  const withTrack = { ...doc, tracks: [...doc.tracks, track] };
  (services.store as any).getDoc = () => withTrack;
  Object.defineProperty(services.store, "doc", { get: () => withTrack });
  return services;
}

function instrumentTrack(kind: InstrumentTrack["instrument"]): InstrumentTrack {
  const track = createInstrumentTrackModel(kind, 9);
  return track;
}

describe("TrackTabs: new instrument options", () => {
  it("lists Wavetable and Granular in the add-track picker", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const onSelect = vi.fn();
    renderWithContext(<TrackTabs selectedTrackId={doc.tracks[0].id} onSelectTrack={onSelect} />, { services });
    const picker = screen.getByLabelText("Add track");
    expect(picker).toBeInTheDocument();
    const options = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("Wavetable Synth");
    expect(options).toContain("Granular Synth");
  });

  it("dispatches createInstrumentTrack with the granular kind", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const user = userEvent.setup();
    renderWithContext(<TrackTabs selectedTrackId={doc.tracks[0].id} onSelectTrack={() => {}} />, { services });
    await user.selectOptions(screen.getByLabelText("Add track"), "granular");
    expect(services.store.execute).toHaveBeenCalled();
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(command.type).toMatch(/create/i);
  });
});

describe("Inspector: wavetable track", () => {
  it("shows the wavetable source browser, preview canvas and params", () => {
    const services = servicesWithTrack(instrumentTrack("wavetable"));
    renderWithContext(<Inspector track={services.store.doc.tracks.at(-1)!} selectedPadId="pad-1" />, { services });
    expect(screen.getByText("WAVETABLE SOURCE")).toBeInTheDocument();
    expect(screen.getByLabelText("Instrument preview")).toBeInTheDocument();
    // param sliders render from the registry definition
    expect(screen.getByText("MORPH")).toBeInTheDocument();
    expect(screen.getByText("TABLE")).toBeInTheDocument();
    // track section still present
    expect(screen.getByText(/VOLUME/i)).toBeInTheDocument();
  });
});

describe("Inspector: granular track", () => {
  it("shows the grain source browser, preview canvas and params", () => {
    const services = servicesWithTrack(instrumentTrack("granular"));
    renderWithContext(<Inspector track={services.store.doc.tracks.at(-1)!} selectedPadId="pad-1" />, { services });
    expect(screen.getByText("GRAIN SOURCE")).toBeInTheDocument();
    expect(screen.getByLabelText("Instrument preview")).toBeInTheDocument();
    expect(screen.getByText("POSITION")).toBeInTheDocument();
    expect(screen.getByText("JITTER")).toBeInTheDocument();
  });

  it("defaults the source to a factory tonal sample", () => {
    const track = instrumentTrack("granular");
    expect(track.sampleId).toBe("factory.tonal.keys");
    const wt = instrumentTrack("wavetable");
    expect(wt.sampleId).toBeNull();
  });
});

describe("createInstrumentTrack command", () => {
  it("creates a valid wavetable track with default params", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const command = createInstrumentTrack(services.store.doc, "wavetable");
    const next = command.execute(services.store.doc);
    const track = next.tracks.at(-1);
    expect(track && track.kind === "instrument" && track.instrument === "wavetable").toBe(true);
    if (track && track.kind === "instrument") {
      expect(track.params.table).toBe(0);
      expect(track.params.morph).toBeCloseTo(0.3, 5);
    }
  });
});
