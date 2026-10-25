import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyKitToDrumTrack } from "../../src/commands/drumContent";
import { FACTORY_ASSETS } from "../../src/sample-library/manifest";
import { projectSoundContext } from "../../src/sample-library/projectFit";
import { KIT_PRESETS } from "../../src/project-model/kit-presets";
import { ProjectStore } from "../../src/store/ProjectStore";
import { KitAuditionBrowser } from "../../src/ui/KitAuditionBrowser";
import { mockServices, renderWithContext } from "../helpers";

function drumTrackOf(services: ReturnType<typeof mockServices>) {
  const track = services.store.getDoc().tracks.find((candidate) => candidate.kind === "drum");
  if (!track || track.kind !== "drum") throw new Error("drum fixture missing");
  return track;
}

function fillFactoryBank(services: ReturnType<typeof mockServices>) {
  for (const asset of FACTORY_ASSETS) services.bank.add(asset.id, {} as AudioBuffer);
  for (const asset of FACTORY_ASSETS) {
    services.bank.add(`${asset.id}.rr2`, {} as AudioBuffer);
    services.bank.add(`${asset.id}.rr3`, {} as AudioBuffer);
  }
}

describe("KitAuditionBrowser", () => {
  it("auditions a whole kit through a runtime project override without changing project or undo", async () => {
    const services = mockServices();
    (services.transport as any).playing = true;
    services.store = new ProjectStore(services.store.getDoc());
    fillFactoryBank(services);
    const sourceDoc = services.store.getDoc();
    const track = drumTrackOf(services);
    const scheduled: Array<{ tick: number; listener: (boundary: { tick: number; audioTime: number }) => void }> = [];
    services.scheduler.subscribeTickBoundary = vi.fn((tick, listener) => {
      scheduled.push({ tick, listener });
      return () => {};
    }) as any;

    renderWithContext(
      <KitAuditionBrowser
        track={track}
        query=""
        genre="all"
        mood="all"
        projectContext={projectSoundContext(sourceDoc)}
      />,
      { services },
    );

    fireEvent.click(screen.getAllByRole("button", { name: "PREVIEW 2 BARS" })[0]!);
    await waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled[0]!.listener({ tick: scheduled[0]!.tick, audioTime: 0 });

    await waitFor(() => expect(services.setPlaybackProjectAudition).toHaveBeenCalledWith(expect.any(Object)));
    const auditionDoc = vi.mocked(services.setPlaybackProjectAudition).mock.calls[0]![0]!;
    const previewTrack = auditionDoc.tracks.find((candidate) => candidate.id === track.id);
    expect(previewTrack?.kind).toBe("drum");
    if (previewTrack?.kind === "drum") {
      expect(previewTrack.pads[0]?.assetId).toBe(KIT_PRESETS[0]?.pads[0]?.assetId);
    }
    expect(auditionDoc.arrangement).toBe(sourceDoc.arrangement);
    expect(services.store.getDoc()).toBe(sourceDoc);
    expect(services.store.undoStackLength).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "STOP" }));
    expect(services.setPlaybackProjectAudition).toHaveBeenLastCalledWith(null);
    expect(services.store.getDoc()).toBe(sourceDoc);
    expect(services.store.undoStackLength).toBe(0);
  });

  it("applies a selected kit as exactly one undoable project edit", async () => {
    const services = mockServices();
    services.store = new ProjectStore(services.store.getDoc());
    fillFactoryBank(services);
    const sourceDoc = services.store.getDoc();
    const track = drumTrackOf(services);

    renderWithContext(
      <KitAuditionBrowser
        track={track}
        query=""
        genre="all"
        mood="all"
        projectContext={projectSoundContext(sourceDoc)}
      />,
      { services },
    );

    const technoKit = screen.getByText("Techno Drive").closest("article");
    if (!technoKit) throw new Error("techno kit card missing");
    fireEvent.click(within(technoKit).getByRole("button", { name: "APPLY" }));
    await waitFor(() => expect(services.store.undoStackLength).toBe(1));
    expect(services.store.getDoc()).not.toBe(sourceDoc);
    expect(services.store.getDoc().tracks.find((candidate) => candidate.id === track.id)?.kind).toBe("drum");
    services.store.undo();
    expect(services.store.getDoc()).toEqual(sourceDoc);
  });

  it("keeps synth-only kit pads instead of treating them as an empty mapping", () => {
    const services = mockServices();
    const sourceDoc = services.store.getDoc();
    const track = drumTrackOf(services);
    const synthKit = KIT_PRESETS.find((kit) => kit.id === "minimal");
    if (!synthKit) throw new Error("minimal kit fixture missing");

    const next = applyKitToDrumTrack(sourceDoc, track.id, synthKit.name, synthKit.pads).execute(sourceDoc);
    const result = next.tracks.find((candidate) => candidate.id === track.id);
    expect(result?.kind).toBe("drum");
    if (result?.kind === "drum") {
      expect(result.pads[2]?.assetId).toBeNull();
      expect(result.pads[2]?.synth?.type).toBe("kick");
    }
  });
});
