import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assignLivePad, createLiveSet, setLiveSetOptions } from "../../src/commands/commands";
import { BAR_TICKS } from "../../src/project-model/types";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { LivePadsPanel } from "../../src/ui/LivePadsPanel";
import { mockServices, renderWithContext } from "../helpers";

describe("LivePadsPanel", () => {
  it("assigns a dragged browser asset to a saved pad slot", async () => {
    const base = createProjectFromTemplate("house");
    const doc = createLiveSet(base).execute(base);
    const set = doc.liveSets![0]!;
    const services = mockServices(doc);
    renderWithContext(<LivePadsPanel />, { services });
    await act(async () => {
      await Promise.resolve();
    });
    const cell = screen.getAllByRole("gridcell")[0]!;

    act(() => {
      fireEvent.drop(cell, {
        dataTransfer: {
          types: ["application/kyx-sample"],
          getData: (type: string) => (type === "application/kyx-sample" ? "user.loop-demo" : ""),
        },
      });
    });

    const command = vi.mocked(services.store.execute).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("assignLivePad");
    expect(command?.execute(doc).liveSets?.find((candidate) => candidate.id === set.id)?.pads).toEqual([
      { slot: 0, bufferId: "user.loop-demo", name: "user.loop-demo" },
    ]);
  });

  it("does not launch an empty pad", async () => {
    const base = createProjectFromTemplate("house");
    const doc = createLiveSet(base).execute(base);
    const services = mockServices(doc);
    renderWithContext(<LivePadsPanel />, { services });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: /^Empty pad 1,/i })).toBeDisabled();
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(services.playback.playPause).not.toHaveBeenCalled();
  });

  it("launches an assigned loop at the bar boundary as an editable song clip", async () => {
    const base = createProjectFromTemplate("house");
    const withSet = createLiveSet(base, "Demo").execute(base);
    const set = withSet.liveSets![0]!;
    const shortSet = setLiveSetOptions(withSet, set.id, { loopBars: 2 }).execute(withSet);
    const doc = assignLivePad(shortSet, set.id, {
      slot: 3,
      bufferId: "user.loop-demo",
      name: "Demo Loop",
      bpm: 120,
      loop: true,
    }).execute(withSet);
    const services = mockServices(doc);
    services.bank.add("user.loop-demo", { duration: 8 } as AudioBuffer);
    renderWithContext(<LivePadsPanel />, { services });

    await userEvent.setup().click(screen.getByRole("button", { name: /Launch pad 4, Demo Loop/i }));
    expect(await screen.findByText(/Queued Demo Loop for bar 1/i)).toBeInTheDocument();
    expect(services.playback.setMode).toHaveBeenCalledWith("song");
    expect(services.playback.seek).toHaveBeenCalledWith(0);
    expect(services.playback.playPause).toHaveBeenCalledTimes(1);

    const command = vi.mocked(services.store.execute).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("addAudioClip");
    const launched = command!.execute(doc);
    expect(launched.arrangement.audioClips?.[0]).toMatchObject({
      bufferId: "user.loop-demo",
      startBar: 0,
      lengthBars: 4,
      loop: true,
      stretchMode: "stretch",
      liveSetId: set.id,
      livePadSlot: 3,
    });
  });

  it("queues a pad launch to the next bar while transport is rolling", async () => {
    const base = createProjectFromTemplate("house");
    const withSet = createLiveSet(base, "On the beat").execute(base);
    const set = withSet.liveSets![0]!;
    const doc = assignLivePad(withSet, set.id, {
      slot: 0,
      bufferId: "user.loop-live",
      name: "Rolling Loop",
      bpm: 120,
      loop: true,
    }).execute(withSet);
    const services = mockServices(doc);
    services.bank.add("user.loop-live", { duration: 8 } as AudioBuffer);
    Object.defineProperty(services.transport, "playing", { configurable: true, value: true });
    Object.defineProperty(services.transport, "position", { configurable: true, value: 2 * BAR_TICKS + 90 });
    renderWithContext(<LivePadsPanel />, { services });

    await userEvent.setup().click(screen.getByRole("button", { name: /Launch pad 1, Rolling Loop/i }));
    expect(await screen.findByText(/Queued Rolling Loop for bar 4/i)).toBeInTheDocument();
    expect(services.playback.seek).not.toHaveBeenCalled();
    expect(services.playback.playPause).not.toHaveBeenCalled();

    const command = vi.mocked(services.store.execute).mock.calls.at(-1)?.[0];
    expect(command!.execute(doc).arrangement.audioClips?.[0]?.startBar).toBe(3);
  });
});
