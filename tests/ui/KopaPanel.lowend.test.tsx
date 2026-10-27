import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { KopaPanel } from "../../src/ui/KopaPanel";
import { lowEndPlan } from "../../src/instruments/lowEnd";
import { forgeLowEndStackCommand } from "../../src/commands/instrument";
import { parseKey } from "../../src/project-model/scales";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack, MusicalKey, ProjectDocument } from "../../src/project-model/types";
import { mockServices, renderWithContext } from "../helpers";

/** `kind` alone does not discriminate the Track union — guard explicitly. */
const isInstrument = (t: ProjectDocument["tracks"][number]): t is InstrumentTrack => t.kind === "instrument";

/**
 * THE LOW-END STACK CARD — the user-facing seam of the KOPA+KOREŇ+sidechain
 * system. Two rules from the seam ledger apply:
 *
 *  - ENTER: the specs drive the real BUILD/RE-TUNE button click and execute
 *    the command the click dispatched against the real document — a passing
 *    assertion here means the gesture, not just the command, works.
 *  - ASSERT THE NEGATIVE: an already-wired stack must not accumulate a
 *    second sidechain/KOREŇ when the card is used again.
 */

function docWithKey(key: MusicalKey | undefined): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  if (key !== undefined) doc.key = key;
  doc.tracks = doc.tracks.filter((t) => !(isInstrument(t) && (t.instrument === "kopa" || t.instrument === "808")));
  return doc;
}

const kickOf = (doc: ProjectDocument): InstrumentTrack | undefined =>
  doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "kopa");
const bassOf = (doc: ProjectDocument): InstrumentTrack | undefined =>
  doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "808");

describe("the LOW-END STACK card", () => {
  it("offers BUILD THE STACK in the no-KOPA empty state and the click builds the real system", () => {
    const doc = docWithKey("A Natural Minor");
    const services = mockServices(doc);
    renderWithContext(<KopaPanel />, { services });

    // The old panel dead-ended at "No KOPA track" — the builder must be
    // reachable exactly there, where it is needed most.
    const button = screen.getByRole("button", { name: /BUILD THE STACK/i });
    fireEvent.click(button);
    expect(services.store.execute).toHaveBeenCalledTimes(1);

    // The dispatched payload materializes the whole system, tuned to the A tonic.
    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("forgeLowEndStack");
    const next = command.execute(services.store.doc);
    const kick = kickOf(next);
    const bass = bassOf(next);
    expect(kick).toBeTruthy();
    expect(bass).toBeTruthy();
    expect(kick!.params.bodyTune).toBe(-3); // A, one octave below the C anchor
    const effects = bass!.effects ?? [];
    expect(effects.some((fx) => fx.type === "bassHarmonic")).toBe(true);
    expect(effects.find((fx) => fx.type === "sidechain")?.sidechainTrackId).toBe(kick!.id);
    // And the plan agrees it is wired — the same read the card's label uses.
    expect(lowEndPlan(next).sidechainWired).toBe(true);
  });

  it("an already-wired stack does not duplicate the wiring when the card is used again", () => {
    const doc = docWithKey("C Major");
    const root = parseKey("C Major")?.root ?? 0;
    const stacked = forgeLowEndStackCommand(doc, { keyRootPc: root }).execute(doc);
    const services = mockServices(stacked);
    renderWithContext(<KopaPanel />, { services });

    // Idempotency is surfaced: the wired stack shows RE-TUNE, not BUILD.
    const button = screen.getByRole("button", { name: /RE-TUNE TO KEY/i });
    fireEvent.click(button);
    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("forgeLowEndStack");
    const next = command.execute(stacked);
    const effects = bassOf(next)!.effects ?? [];
    expect(effects.filter((fx) => fx.type === "sidechain")).toHaveLength(1);
    expect(effects.filter((fx) => fx.type === "bassHarmonic")).toHaveLength(1);
  });

  it("SEED BASSLINE does nothing without an 808 track and seeds the real line when wired", () => {
    const bare = docWithKey("C Major");
    const bareServices = mockServices(bare);
    renderWithContext(<KopaPanel />, { services: bareServices });
    // The negative: no bass track → the button is disabled, nothing dispatches.
    expect(screen.getByRole("button", { name: /SEED BASSLINE/i })).toBeDisabled();
    expect(bareServices.store.execute).not.toHaveBeenCalled();
    cleanup();

    const root = parseKey("C Major")?.root ?? 0;
    const stacked = forgeLowEndStackCommand(docWithKey("C Major"), { keyRootPc: root }).execute(docWithKey("C Major"));
    const services = mockServices(stacked);
    renderWithContext(<KopaPanel />, { services });
    fireEvent.click(screen.getByRole("button", { name: /SEED BASSLINE/i }));
    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("seedBassline");
    const next = command.execute(stacked);
    const bass = bassOf(next)!;
    const notes = next.patterns.find((p) => p.id === next.activePatternId)?.notes[bass.id] ?? [];
    expect(notes.length).toBeGreaterThan(0);
    // The pitch is the tonic the stack was built for: C Major → C2 = MIDI 36.
    expect(new Set(notes.map((note) => note.pitch % 12))).toEqual(new Set([0]));
  });

  it("CHECK THE FIT surfaces the measured verdict, and says honestly when the render tier is unavailable", async () => {
    const root = parseKey("C Major")?.root ?? 0;
    const stacked = forgeLowEndStackCommand(docWithKey("C Major"), { keyRootPc: root }).execute(docWithKey("C Major"));
    const services = mockServices(stacked);
    renderWithContext(<KopaPanel />, { services });
    fireEvent.click(screen.getByRole("button", { name: /CHECK THE FIT/i }));
    const status = screen.getByRole("status");
    // No bass notes yet → the honest SILENT verdict, with the seed hint.
    expect(status).toHaveTextContent(/SILENT/i);
    // jsdom has no OfflineAudioContext: the render tier must SAY SO, not
    // silently show nothing (the model verdict above still stands).
    expect(await screen.findByText(/Render measurement unavailable/i)).toBeInTheDocument();
  });
});
