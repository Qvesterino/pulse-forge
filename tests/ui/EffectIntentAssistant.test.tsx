import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectRack } from "../../src/ui/EffectRack";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { EffectType } from "../../src/project-model/types";

function setup(type: EffectType) {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  track.effects = [
    {
      id: `fx-${type}`,
      type,
      bypassed: false,
      params: type === "eq" ? { lowShelfGain: 0, highShelfGain: 0 } : { mix: 0.3, decay: 1.8, tone: 6000 },
    },
  ];
  const services = mockServices(doc);
  const rendered = renderWithContext(<EffectRack track={track} />, { services });
  return { doc, track, services, unmount: rendered.unmount };
}

async function request(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole("button", { name: /Ask FX/ }));
  await user.type(screen.getByLabelText("Čo chceš zmeniť?"), text);
  await user.click(screen.getByRole("button", { name: "Navrhnúť zmenu" }));
}

describe("Effect Intent Assistant UI", () => {
  it("shows a pilot parameter diff and its review warning without mutating the project", async () => {
    const user = userEvent.setup();
    const { services } = setup("eq");
    await request(user, "trochu teplejšie, ale nechaj výšky tak");

    expect(screen.getByText("EQ: teplejšie")).toBeInTheDocument();
    expect(screen.getByText("LOW SHELF", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("HIGH SHELF", { selector: "strong" })).toBeNull();
    expect(screen.getByText(/blind golden review/)).toBeInTheDocument();
    expect(screen.getByText(/Projekt sa zatiaľ nezmenil/)).toBeInTheDocument();
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(services.engine.beginEffectIntentPreview).not.toHaveBeenCalled();
  });

  it("auditions transient values and restores the document values on cancel", async () => {
    const user = userEvent.setup();
    const { services } = setup("reverb");
    await request(user, "more space");
    await user.click(screen.getByRole("button", { name: "Vypočuť" }));

    expect(services.engine.beginEffectIntentPreview).toHaveBeenCalledTimes(1);
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(screen.getByText(/dočasný návrh/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zastaviť preview" }));
    expect(services.engine.cancelEffectIntentPreview).toHaveBeenCalledTimes(1);
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(screen.getByText(/projekt ostal nezmenený/)).toBeInTheDocument();
  });

  it("restores a live preview when the panel closes", async () => {
    const user = userEvent.setup();
    const { services } = setup("eq");
    await request(user, "brighter");
    await user.click(screen.getByRole("button", { name: "Vypočuť" }));
    await user.click(screen.getByRole("button", { name: "Close FX intent" }));

    expect(services.engine.cancelEffectIntentPreview).toHaveBeenCalledTimes(1);
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /Ask FX/ })).toBeNull();
  });

  it("restores a live preview when the FX rack unmounts", async () => {
    const user = userEvent.setup();
    const { services, unmount } = setup("eq");
    await request(user, "brighter");
    await user.click(screen.getByRole("button", { name: "Vypočuť" }));

    unmount();

    expect(services.engine.cancelEffectIntentPreview).toHaveBeenCalledTimes(1);
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("applies the previewed proposal as one undoable command", async () => {
    const user = userEvent.setup();
    const { services } = setup("reverb");
    await request(user, "more space");
    await user.click(screen.getByRole("button", { name: "Apply zmeny" }));

    expect(services.store.execute).toHaveBeenCalledTimes(1);
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as { type: string };
    expect(command.type).toBe("applyEffectIntentProposal");
  });

  it("replans at the chosen intensity and previews/applies only checked parameters", async () => {
    const user = userEvent.setup();
    const { doc, services } = setup("reverb");
    await request(user, "more space");

    fireEvent.change(screen.getByRole("slider", { name: "Intenzita návrhu" }), { target: { value: "100" } });
    expect(screen.getByText("100 %")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Zahrnúť MIX" }));
    await user.click(screen.getByRole("button", { name: "Vypočuť" }));

    const beginPreview = services.engine.beginEffectIntentPreview as ReturnType<typeof vi.fn>;
    const previewValues = beginPreview.mock.calls[0][2] as Record<string, number>;
    expect(previewValues).toHaveProperty("decay");
    expect(previewValues).not.toHaveProperty("mix");

    await user.click(screen.getByRole("button", { name: "Zastaviť preview" }));
    await user.click(screen.getByRole("button", { name: "Apply zmeny" }));
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      execute: (current: typeof doc) => typeof doc;
    };
    const applied = command.execute(doc);
    const effect = applied.tracks.flatMap((track) => track.effects).find((candidate) => candidate.id === "fx-reverb")!;
    const original = doc.tracks.flatMap((track) => track.effects).find((candidate) => candidate.id === "fx-reverb")!;

    expect(effect.params.decay).toBeGreaterThan(original.params.decay);
    expect(effect.params.mix).toBe(original.params.mix);
  });

  it("ends the audition when transport starts and keeps the proposal unapplied", async () => {
    const user = userEvent.setup();
    const { services } = setup("eq");
    await request(user, "brighter");
    await user.click(screen.getByRole("button", { name: "Vypočuť" }));

    const begin = services.engine.beginEffectIntentPreview as ReturnType<typeof vi.fn>;
    const onEnded = begin.mock.calls[0][3] as (reason: "transportStarted") => void;
    act(() => onEnded("transportStarted"));

    expect(screen.getByRole("button", { name: "Vypočuť" })).toBeInTheDocument();
    expect(screen.getByText(/zastavilo pri spustení prehrávania/)).toBeInTheDocument();
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("shows a truthful warning when the runtime cannot restore preview values", async () => {
    const user = userEvent.setup();
    const { services } = setup("eq");
    await request(user, "brighter");
    await user.click(screen.getByRole("button", { name: "Vypočuť" }));

    const begin = services.engine.beginEffectIntentPreview as ReturnType<typeof vi.fn>;
    const onEnded = begin.mock.calls[0][3] as (reason: "restoreFailed") => void;
    act(() => onEnded("restoreFailed"));

    expect(screen.getByText(/Plugin odmietol obnoviť pôvodné audio hodnoty/)).toBeInTheDocument();
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("does not expose the assistant for an effect without reviewed mappings", () => {
    setup("delay");
    expect(screen.queryByRole("button", { name: /Ask FX/ })).toBeNull();
  });
});
