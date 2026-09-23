import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectRack } from "../../src/ui/EffectRack";
import { applyFxIdea } from "../../src/ui/fxAddAssistant";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

/**
 * FX INTENT BAR — the persistent idea input in the rack header. The routing
 * helper is the contract: assistant plan first (device-aware, reviewable
 * values), production concepts as the fallback interpreter, honest
 * diagnostics when nothing understands the sentence. The component test pins
 * the wire-up: one text entry → ONE store.execute, or a visible explanation.
 */

function houseDoc() {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  return { doc, track };
}

describe("applyFxIdea routing", () => {
  it("routes assistant language to the device-aware plan (one command, one undo)", () => {
    const { doc, track } = houseDoc();
    const outcome = applyFxIdea(doc, track.id, "trochu teplejšie, ale nechaj výšky tak");
    expect(outcome.kind).toBe("command");
    if (outcome.kind !== "command") return;
    expect(outcome.interpreter).toBe("assistant");
    expect(outcome.summary).toContain("FX assistant:");
    // The command composes add/tune eagerly — executing it on the doc must
    // change the document exactly once.
    const next = outcome.command.execute(doc);
    expect(next).not.toBe(doc);
  });

  it("falls back to the production planner for concept language the catalog lacks", () => {
    const { doc, track } = houseDoc();
    const outcome = applyFxIdea(doc, track.id, "wobbly bass");
    expect(outcome.kind).toBe("command");
    if (outcome.kind !== "command") return;
    expect(outcome.interpreter).toBe("production");
    expect(outcome.summary).toContain("wobbly");
  });

  it("answers unknown sentences with guidance, not a throw", () => {
    const { doc, track } = houseDoc();
    const outcome = applyFxIdea(doc, track.id, "krrxyz blorptastic");
    expect(outcome.kind).toBe("unparsed");
    if (outcome.kind !== "unparsed") return;
    // The parser's own diagnostics name the unknown word — concrete beats generic.
    expect(outcome.message).toContain("nepoznám");
  });

  it("asks for more words when the entry is too short", () => {
    const { doc, track } = houseDoc();
    const outcome = applyFxIdea(doc, track.id, "  a  ");
    expect(outcome.kind).toBe("unparsed");
    if (outcome.kind !== "unparsed") return;
    expect(outcome.message).toContain("Napíš aspoň pár znakov");
  });
});

describe("FxIntentBar UI", () => {
  function setup() {
    const { doc, track } = houseDoc();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });
    return { services };
  }

  it("applies an idea through ONE store.execute and echoes the plan summary", async () => {
    const user = userEvent.setup();
    const { services } = setup();
    const input = screen.getByLabelText("FX idea — popíš zvuk slovami");
    await user.type(input, "more space");
    await user.click(screen.getByRole("button", { name: "Aplikovať" }));

    expect(services.store.execute).toHaveBeenCalledTimes(1);
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("FX assistant:");
  });

  it("shows the guidance message and does not touch the store on unknown words", async () => {
    const user = userEvent.setup();
    const { services } = setup();
    const input = screen.getByLabelText("FX idea — popíš zvuk slovami");
    await user.type(input, "krrxyz blorptastic");
    await user.click(screen.getByRole("button", { name: "Aplikovať" }));

    expect(services.store.execute).not.toHaveBeenCalled();
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("nepoznám");
  });

  it("keeps the text for editing when the idea was not understood", async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByLabelText("FX idea — popíš zvuk slovami") as HTMLInputElement;
    await user.type(input, "krrxyz");
    await user.click(screen.getByRole("button", { name: "Aplikovať" }));
    expect(input.value).toBe("krrxyz");
    // And clears it after a successful apply.
    await user.clear(input);
    await user.type(input, "more space");
    await user.click(screen.getByRole("button", { name: "Aplikovať" }));
    expect((screen.getByLabelText("FX idea — popíš zvuk slovami") as HTMLInputElement).value).toBe("");
  });

  it("registers without breaking the rack when the idea list stays empty", () => {
    const { services } = setup();
    expect(vi.isMockFunction(services.store.execute)).toBe(true);
    expect(screen.getByRole("button", { name: "✚ ADD FX" })).toBeInTheDocument();
  });
});
