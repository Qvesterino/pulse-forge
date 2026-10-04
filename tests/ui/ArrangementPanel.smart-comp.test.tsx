import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioTakeClip } from "../../src/commands/commands";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * SUGGEST COMP (ArrangementPanel) — the wiring the producer touches.
 *
 * The unit tests already pin the ranking (`tests/smart-comp-scoring.test.ts`)
 * and the planner+command (`tests/smart-comp-plan.test.ts`). What can only be
 * proven here is the panel contract: a two-take group offers the suggestion,
 * the card shows per-take evidence and the winning segments, CANCEL leaves
 * the document untouched, and APPLY dispatches exactly one store command.
 */

const SAMPLE_RATE = 48_000;

/** Minimal AudioBuffer stand-in — the panel only needs duration + PCM. */
function fakeBuffer(seconds: number, onGrid: boolean, noise = 0): AudioBuffer {
  const length = Math.round(seconds * SAMPLE_RATE);
  const data = new Float32Array(length);
  let seed = onGrid ? 12345 : 987654;
  for (let hit = 0; hit * 0.125 < seconds; hit++) {
    let jitter = 0;
    if (!onGrid) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      jitter = ((seed / 0xffffffff) * 2 - 1) * 0.05;
    }
    const start = Math.round((hit * 0.125 + jitter) * SAMPLE_RATE);
    for (let i = 0; i < 2400 && start + i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[start + i] += 0.8 * Math.exp(-i / 600) * ((seed / 0xffffffff) * 2 - 1);
    }
  }
  for (let i = 0; i < length; i++) data[i] += noise * Math.sin(i * 0.01);
  return {
    duration: seconds,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    length,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

function twoTakeDoc(): ProjectDocument {
  const base = createProjectFromTemplate("empty");
  const track = base.tracks[0];
  if (!track) throw new Error("empty template fixture missing a track");
  let doc: ProjectDocument = { ...base, arrangement: { ...base.arrangement, clips: [], audioClips: [] } };
  doc = addAudioTakeClip(doc, "ui-smart-group", "take-wandering", track.id, "audio.wandering", 0, 2).execute(doc);
  doc = addAudioTakeClip(doc, "ui-smart-group", "take-locked", track.id, "audio.locked", 0, 2).execute(doc);
  return doc;
}

describe("ArrangementPanel — SUGGEST COMP wiring", () => {
  function setup() {
    const doc = twoTakeDoc();
    const services = mockServices(doc);
    services.bank.add("audio.locked", fakeBuffer(2, true));
    services.bank.add("audio.wandering", fakeBuffer(2, false, 0.004));
    return { doc, services };
  }

  it("shows the evidence card for a selected two-take group, and CANCEL never dispatches", () => {
    const { services } = setup();
    renderWithContext(<ArrangementPanel />, { services });
    const executeSpy = vi.spyOn(services.store, "execute");

    // Selecting a take clip reveals the take-group toolbar.
    const clips = document.querySelectorAll(".arr-audio-clip");
    expect(clips.length).toBe(2);
    fireEvent.click(clips[0]!);

    const suggest = screen.getByRole("button", { name: /Suggest a comp from the best parts/i });
    fireEvent.click(suggest);

    const card = document.querySelector(".arr-smart-comp")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("SMART COMP SUGGESTION");
    // Evidence for BOTH takes, and the winner is the locked one.
    expect(document.querySelectorAll(".arr-smart-comp-take").length).toBe(2);
    expect(card.querySelector(".arr-smart-comp-take-name")!.textContent).toContain("TAKE 2");
    // Two bars, one winner, no seams — and it says so.
    expect(card.querySelector(".arr-smart-comp-segments")!.textContent).toContain("bars 1–2");
    // A suggestion is a PROPOSAL: nothing was written.
    expect(executeSpy).not.toHaveBeenCalled();

    // CANCEL discards it, still without writing.
    fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
    expect(document.querySelector(".arr-smart-comp")).toBeNull();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("APPLY COMP dispatches exactly one command that creates the comp take", () => {
    const { services } = setup();
    renderWithContext(<ArrangementPanel />, { services });
    const executeSpy = vi.spyOn(services.store, "execute");

    fireEvent.click(document.querySelectorAll(".arr-audio-clip")[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Suggest a comp from the best parts/i }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "APPLY COMP" }));
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const command = executeSpy.mock.calls[0]![0] as { type: string; label: string };
    expect(command.type).toBe("applySmartComp");
    expect(command.label).toMatch(/Smart comp/);
    // The card closes after applying — the proposal is spent.
    expect(document.querySelector(".arr-smart-comp")).toBeNull();
  });

  it("does not offer the suggestion for a single-take group", () => {
    const base = createProjectFromTemplate("empty");
    const track = base.tracks[0];
    if (!track) throw new Error("empty template fixture missing a track");
    const single: ProjectDocument = {
      ...base,
      arrangement: { ...base.arrangement, clips: [], audioClips: [] },
    };
    const doc = addAudioTakeClip(single, "solo-group", "take-only", track.id, "audio.only", 0, 2).execute(single);
    const services = mockServices(doc);
    services.bank.add("audio.only", fakeBuffer(2, true));
    renderWithContext(<ArrangementPanel />, { services });

    fireEvent.click(document.querySelectorAll(".arr-audio-clip")[0]!);
    // A one-take group has nothing to choose between — the control stays away
    // rather than pretending to be an assistant.
    expect(screen.queryByRole("button", { name: /Suggest a comp from the best parts/i })).toBeNull();
  });
});
