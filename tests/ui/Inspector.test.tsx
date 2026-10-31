import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { screen, fireEvent } from "@testing-library/react";
import { Inspector } from "../../src/ui/Inspector";
import { ServicesContext } from "../../src/ui/context";
import { clearVariationShelf, shelfVariations } from "../../src/generative/variationShelf";
import type { GenerativeVariation } from "../../src/generative/resample";
import { renderWithContext, mockServices } from "../helpers";
import type { Services } from "../../src/services";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { Track } from "../../src/project-model/types";

describe("Inspector", () => {
  function firstTrack(): Track {
    const doc = createProjectFromTemplate("house");
    const t = doc.tracks[0];
    if (!t) throw new Error("expected a track");
    return t;
  }

  it("renders the pad/track header and Volume slider", () => {
    const track = firstTrack();
    const pad = track.kind === "drum" ? track.pads[0] : undefined;
    const padId = pad?.id ?? "";
    renderWithContext(<Inspector track={track} selectedPadId={padId} />);
    // The drum Inspector focuses the SELECTED PAD (kicker "PAD" + the pad's
    // name, with the pad-source toggle); the instrument branch keeps the
    // instrument-name kicker + track name.
    if (pad) {
      expect(screen.getByText("PAD")).toBeInTheDocument();
      expect(screen.getAllByText(pad.name).length).toBeGreaterThan(0);
    } else {
      expect(screen.getAllByText(track.name).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("slider", { name: /Volume/i })).toBeInTheDocument();
  });

  it("renders the Plugin button when onOpenPlugin is provided", () => {
    const track = firstTrack();
    const padId = track.kind === "drum" ? (track.pads[0]?.id ?? "") : "";
    renderWithContext(<Inspector track={track} selectedPadId={padId} onOpenPlugin={vi.fn()} />);
    const pluginButtons = screen.getAllByTitle(/Open the (drum )?device chain/i);
    expect(pluginButtons.length).toBeGreaterThan(0);
  });

  it("clicking the Plugin button calls onOpenPlugin", () => {
    const track = firstTrack();
    const padId = track.kind === "drum" ? (track.pads[0]?.id ?? "") : "";
    const onOpen = vi.fn();
    renderWithContext(<Inspector track={track} selectedPadId={padId} onOpenPlugin={onOpen} />);
    const pluginButton = screen.getAllByTitle(/Open the (drum )?device chain/i)[0];
    fireEvent.click(pluginButton);
    expect(onOpen).toHaveBeenCalled();
  });
});

const GENERATIVE_STATUS_SNAPSHOT = { state: "idle" as const };

describe("Inspector — resample variations survive a track switch (CF-20)", () => {
  function generativeTrack(id: string, name: string): Track {
    const doc = createProjectFromTemplate("house");
    const base = doc.tracks.find((t) => t.kind === "instrument");
    if (!base) throw new Error("expected an instrument track");
    const generativeShape = {
      style: { kind: "text" as const, text: "loom ambient" },
      macros: { energy: 0.5, density: 0.5, variation: 0.5, texture: 0.5 },
      providerId: "mrt2",
      modelId: "v30-q8",
      latencyMode: "near-realtime" as const,
    };
    return {
      ...(base as unknown as Record<string, unknown>),
      id,
      name,
      kind: "generative",
      generative: generativeShape,
    } as unknown as Track;
  }

  function fakeVariation(id: string): GenerativeVariation {
    return {
      id,
      label: id.toUpperCase(),
      audio: {
        sampleRate: 48_000,
        channels: 1,
        frames: 96_000,
        durationSec: 2,
        data: new Float32Array(96_000),
        providerId: "mrt2",
        modelId: "v30-q8",
        inputHash: "hash-" + id,
      },
      input: {} as GenerativeVariation["input"],
    };
  }

  function renderInspectorFor(track: Track) {
    const base = mockServices();
    const services = {
      ...base,
      generativeProviders: {
        capabilities: vi.fn(() => null),
        register: vi.fn(),
        unregister: vi.fn(),
      },
      generativeRuntime: {
        ...(base.generativeRuntime ?? {}),
        subscribe: vi.fn(() => () => {}),
        // useSyncExternalStore requires a CACHED snapshot — a fresh object
        // per call loops React forever.
        getStatus: vi.fn(() => GENERATIVE_STATUS_SNAPSHOT),
        refreshAll: vi.fn(),
        stopAll: vi.fn(async () => {}),
      },
      generativeLatency: { getSnapshot: () => null },
    } as unknown as Services;
    const utils = renderWithContext(<Inspector track={track} selectedPadId="" />, { services });
    return { utils, services };
  }

  /** rerender must carry the SAME provider — a bare rerender drops it. */
  function rerenderFor(
    first: { utils: { rerender: (ui: React.ReactElement) => void }; services: Services },
    track: Track,
  ) {
    first.utils.rerender(
      createElement(
        ServicesContext.Provider,
        { value: first.services },
        createElement(Inspector, { track, selectedPadId: "" }),
      ),
    );
  }

  afterEach(() => clearVariationShelf());

  it("shelves the takes on switch and restores them with a notice on return", () => {
    const trackA = generativeTrack("gen-a", "LOOM");
    const trackB = generativeTrack("gen-b", "DRIFT");
    const takes = [fakeVariation("v1"), fakeVariation("v2")];

    // First mount: simulate a finished RESAMPLE run by shelving directly (the
    // unit suite covers the shelf; this spec covers the PANEL wiring).
    shelfVariations(trackA.id, takes);
    const first = renderInspectorFor(trackA);
    // The track has NO shelf to restore on the first visit — the takes arrive
    // from a run, not from the shelf.
    rerenderFor(first, trackB);
    rerenderFor(first, trackA);

    // Back on track A: the takes returned, and the panel SAYS so.
    expect(screen.getByText(/Restored 2 uncommitted variations/)).toBeInTheDocument();
    // The takes render as their PREVIEW buttons (label uppercase).
    expect(screen.getByRole("button", { name: "PREVIEW V1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PREVIEW V2" })).toBeInTheDocument();
  });

  it("NEGATIVE: a track with no shelf returns to no takes and no notice", () => {
    const trackA = generativeTrack("gen-a2", "LOOM");
    const trackB = generativeTrack("gen-b2", "DRIFT");
    shelfVariations(trackA.id, [fakeVariation("v1")]);
    const view = renderInspectorFor(trackA);
    rerenderFor(view, trackB);
    expect(screen.queryByText(/Restored/)).toBeNull();
  });
});
