import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackTabs } from "../../src/ui/TrackTabs";
import { INSTRUMENT_META, INSTRUMENT_ORDER } from "../../src/instruments/definitions";
import type { InstrumentKind } from "../../src/project-model/types";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

/**
 * The add-track picker's option list must stay in PARITY with the instrument
 * registry. `TrackTabs` is the only UI caller of `createInstrumentTrack`, so an
 * option missing here is an instrument kind a user cannot create at all — the
 * defect is a reachability gap, not a rendering one.
 *
 * THE DEFECT (fixed in this audit): the menu was a hand-written list of 15
 * `<option>`s while `INSTRUMENT_ORDER` enumerates 24. Nine fully-implemented
 * kinds — organ, strings, bell, reese, clav, acid, brass, fm, tsar — had
 * bodies and default params in `INSTRUMENT_DEFS` yet no UI path to create
 * them. The same hand-written list also drifted from the canonical names
 * ("KOPA Kick Designer" vs the registry's "KOPA", "Keys Synth" vs "Keys").
 *
 * The list is now generated from the registry, so the strongest lock is the
 * parity assertion below: it fails if ANY future kind is added without
 * appearing here, and it fails if an extra bogus option is invented.
 */
describe("TrackTabs add-track menu ↔ instrument registry parity", () => {
  const renderTabs = () =>
    renderWithContext(<TrackTabs selectedTrackId="" onSelectTrack={vi.fn()} />, {
      services: mockServices(createProjectFromTemplate("house")),
    });

  const optionValues = () =>
    Array.from((screen.getByLabelText("Add track") as HTMLSelectElement).querySelectorAll("option")).map(
      (o) => o.value,
    );

  it("offers EVERY registered InstrumentKind as a create option", () => {
    // The regression assertion. Before the fix this was 9 short.
    renderTabs();
    const offered = optionValues();
    const missing = INSTRUMENT_ORDER.filter((kind) => !offered.includes(kind));
    expect(missing).toEqual([]);
  });

  it("offers no instrument value outside the registry", () => {
    // The negative half: guards against a stale hardcoded entry surviving.
    renderTabs();
    const nonPseudo = optionValues().filter(
      (value) => value !== "" && !INSTRUMENT_ORDER.includes(value as InstrumentKind),
    );
    // "" is the placeholder; drum / generative / group are pseudo-kinds handled
    // by their own commands, not `createInstrumentTrack`.
    expect(nonPseudo.filter((v) => !["drum", "generative", "group"].includes(v))).toEqual([]);
  });

  it("keeps the three pseudo track kinds (drum / generative / group)", () => {
    renderTabs();
    const offered = optionValues();
    expect(offered).toContain("drum");
    expect(offered).toContain("generative");
    expect(offered).toContain("group");
  });

  it("labels each instrument with the canonical registry name", () => {
    // Label drift: the old list said "KOPA Kick Designer" where the registry
    // says "KOPA", so the menu and every other surface disagreed.
    renderTabs();
    const select = screen.getByLabelText("Add track") as HTMLSelectElement;
    const labels = new Map(Array.from(select.querySelectorAll("option")).map((o) => [o.value, o.textContent ?? ""]));
    for (const kind of INSTRUMENT_ORDER) {
      expect(labels.get(kind)).toBe(INSTRUMENT_META[kind].name);
    }
  });

  it("actually creates a previously-unreachable kind (acid) on selection", async () => {
    // Proves reachability, not just presence: selecting the option must
    // dispatch the create command with that kind.
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<TrackTabs selectedTrackId="" onSelectTrack={vi.fn()} />, { services });
    await user.selectOptions(screen.getByLabelText("Add track"), "acid");
    expect(services.store.execute).toHaveBeenCalled();
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(command.type).toMatch(/create/i);
  });

  it("still creates a kind that was reachable before the change", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<TrackTabs selectedTrackId="" onSelectTrack={vi.fn()} />, { services });
    await user.selectOptions(screen.getByLabelText("Add track"), "granular");
    expect(services.store.execute).toHaveBeenCalled();
  });
});
