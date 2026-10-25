import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TsarPanel } from "../../src/ui/TsarPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { createInstrumentTrackModel } from "../../src/project-model/schema";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";
import { goldenVoices, TSAR_GOLDEN_SAMPLE_RATE } from "../tsar/golden-voices";

/**
 * WAVE 3 — FORGE CANDIDATES IN THE PANEL.
 *
 * The panel contract (the one the roadmap asks for: "zdroje a viac možností
 * z Forge"):
 *  - ONE import produces SEVERAL readings, not one plan;
 *  - a reading can be HEARD before it is applied — the audition must not
 *    touch the project, or the producer would be judging a sound that is
 *    already in the patch;
 *  - the audition uses the reading's OWN source, so a Source B reading is
 *    heard with the sound it will be applied with;
 *  - applying is ONE command into the reading's OWN slot.
 */

function tsarDoc(): ProjectDocument {
  const base = createProjectFromTemplate("empty");
  const track = createInstrumentTrackModel("tsar", 1);
  track.id = "tsar-ui-track";
  track.name = "TSAR Lead";
  return { ...base, tracks: [track] };
}

/**
 * A services mock whose decoder returns REAL audio.
 *
 * The default mock decodes silence, which the Forge correctly refuses — a UI
 * test that could only ever see the refusal would prove nothing about the
 * candidate list. The golden `saw-c3` fixture is pitched and sustained, so
 * every reading the evidence licenses is offered.
 */
function forgeServices() {
  const services = mockServices(tsarDoc());
  const pcm = goldenVoices.get("saw-c3")!;
  const buffer = {
    duration: pcm.length / TSAR_GOLDEN_SAMPLE_RATE,
    sampleRate: TSAR_GOLDEN_SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => pcm,
  };
  Object.defineProperty(services.engine, "context", {
    configurable: true,
    get: () => ({ decodeAudioData: vi.fn(async () => buffer) }),
  });
  const previewSpy = vi.fn();
  (services.engine as unknown as { previewInstrumentWithSources: unknown }).previewInstrumentWithSources = previewSpy;
  return { services, previewSpy };
}

/** Drop a WAV into the Forge and wait for the readings to appear. */
async function importIntoForge() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array(256)], "saw-c3.wav", { type: "audio/wav" });
  fireEvent.change(input, { target: { files: [file] } });
  const list = await screen.findByRole("list", { name: "Forge candidates" });
  return list;
}

describe("TsarPanel — Forge candidates", () => {
  it("one import offers several readings and changes nothing yet", async () => {
    const { services } = forgeServices();
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    const list = await importIntoForge();
    const items = within(list).getAllByRole("listitem");
    // A pitched, sustained source licenses more than one reading.
    expect(items.length).toBeGreaterThan(1);
    // Every reading explains itself — a label alone is not an offer.
    for (const item of items) {
      expect(item.querySelector(".tsar-candidate-reason")?.textContent?.length ?? 0).toBeGreaterThan(0);
    }
    // THE contract: nothing is applied before the producer chooses.
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("a reading can be heard before it is applied, and the audition does not touch the project", async () => {
    const user = userEvent.setup();
    const { services, previewSpy } = forgeServices();
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    const list = await importIntoForge();
    const hear = within(list).getAllByRole("button", { name: /HEAR/ })[0]!;
    await user.click(hear);

    expect(previewSpy).toHaveBeenCalledTimes(1);
    // The audition carries the reading's OWN source — a Source A reading is
    // heard with the newly imported sample, not with the track's old one.
    const [, , , sources] = previewSpy.mock.calls[0]! as [
      string,
      number,
      Record<string, number>,
      { sampleId?: string; sampleIdB?: string },
    ];
    expect(sources.sampleId).toMatch(/^user\./);
    expect(sources.sampleIdB).toBeUndefined();
    // Hearing is not applying.
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("applying a reading is ONE command that lands the source in the chosen slot", async () => {
    const user = userEvent.setup();
    const { services } = forgeServices();
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    const list = await importIntoForge();
    const apply = within(list).getAllByRole("button", { name: /APPLY → A/ })[0]!;
    await user.click(apply);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const command = executeSpy.mock.calls[0]![0] as {
      type: string;
      execute: (doc: ProjectDocument) => ProjectDocument;
    };
    expect(command.type).toBe("applyForgeCandidate");
    const next = command.execute(services.store.doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-ui-track")!;
    expect(track.sampleId).toMatch(/^user\./);
    expect(track.sampleIdB ?? null).toBeNull();
  });

  it("a Source B reading is heard with the B source and lands in B", async () => {
    const user = userEvent.setup();
    const { services, previewSpy } = forgeServices();
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    // The producer targets Source B BEFORE the import.
    await user.selectOptions(screen.getByLabelText("Forge target source"), "1");

    const list = await importIntoForge();
    const hear = within(list).getAllByRole("button", { name: /HEAR/ })[0]!;
    await user.click(hear);
    const [, , , sources] = previewSpy.mock.calls[0]! as [
      string,
      number,
      Record<string, number>,
      { sampleId?: string; sampleIdB?: string },
    ];
    // The B reading is auditioned with the NEW B source. Without this the
    // producer would pick by ear against the track's OLD B sound.
    expect(sources.sampleIdB).toMatch(/^user\./);
    expect(sources.sampleId).toBeUndefined();

    const apply = within(list).getAllByRole("button", { name: /APPLY → B/ })[0]!;
    await user.click(apply);
    const command = executeSpy.mock.calls[0]![0] as {
      type: string;
      execute: (doc: ProjectDocument) => ProjectDocument;
    };
    const next = command.execute(services.store.doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-ui-track")!;
    expect(track.sampleIdB).toMatch(/^user\./);
    expect(track.sampleId).toBeNull();
  });

  it("a silent source is refused with an explanation, not a list of readings", async () => {
    const services = mockServices(tsarDoc());
    // The default mock decoder returns silence.
    renderWithContext(<TsarPanel />, { services });

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array(256)], "silence.wav", { type: "audio/wav" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/Nothing to forge/i)).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: "Forge candidates" })).not.toBeInTheDocument();
  });

  it("the imported sound gets a source record: identity, measured root and content hash", async () => {
    const { services } = forgeServices();
    renderWithContext(<TsarPanel />, { services });

    await importIntoForge();
    const line = document.querySelector(".tsar-source-line")!;
    expect(line.textContent).toMatch(/READING SOURCE/);
    // The source is described by its CONTENT, not by the import moment.
    expect(line.textContent).toMatch(/#[0-9a-f]{8}/);
    // The measured root is stated with its confidence, not as a bare note.
    expect(line.textContent).toMatch(/root MIDI 48/);
  });

  it("a patch source whose audio is gone is shown as missing, not as silence", () => {
    const doc = tsarDoc();
    doc.tracks = doc.tracks.map((track) => ({ ...track, sampleId: "user.gone-1" }));
    const services = mockServices(doc);
    renderWithContext(<TsarPanel />, { services });

    const line = document.querySelector(".tsar-source-line")!;
    expect(line.textContent).toMatch(/PATCH SOURCE/);
    expect(line.textContent).toMatch(/user\.gone-1/);
    expect(line.textContent).toMatch(/missing/);
    // The hint must be actionable, not just a verdict.
    expect(line.textContent).toMatch(/not in your library/);
  });
});
