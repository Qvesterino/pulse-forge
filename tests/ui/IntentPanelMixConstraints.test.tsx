import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { classifyPads } from "../../src/assist/patternOps";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { mockServices, renderWithContext } from "../helpers";

const mocks = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("../../src/mcp/mix-preview", async (original) => ({
  ...(await original<typeof import("../../src/mcp/mix-preview")>()),
  previewMixIdea: mocks.preview,
}));

function makeProject() {
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((track) => track.kind === "drum")!;
  if (drum.kind !== "drum") throw new Error("missing drum track");
  const kick = classifyPads(drum.pads).kicks[0];
  drum.pads = drum.pads.filter((pad) => !classifyPads([pad]).kicks.length || pad.id === kick.id);
  return { doc, drum, kick };
}

afterEach(() => mocks.preview.mockReset());

describe("Intent panel protected mix request", () => {
  it.each(["DO IT", "GENERATE"])("routes %s through audition instead of a direct write", async (button) => {
    const { doc } = makeProject();
    const services = mockServices(doc);
    mocks.preview.mockResolvedValue({ ok: true, lane: {}, studioBound: true });
    renderWithContext(<IntentPanel />, { services });
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "warmer bass, keep kick" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(button, "i") }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    expect(mocks.preview).toHaveBeenCalledWith(services, { idea: "warmer bass, keep kick" });
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(await screen.findByText(/Náhľad je pripravený/)).toBeTruthy();
  });

  it("shows choices for ambiguous kicks and performs no write", async () => {
    const { doc, drum, kick } = makeProject();
    drum.pads.push({ ...kick, id: "kick-second", name: "Kick second" });
    const services = mockServices(doc);
    mocks.preview.mockResolvedValue({ ok: true, lane: {}, studioBound: true });
    renderWithContext(<IntentPanel />, { services });
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "warmer bass, keep kick" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    const choice = await screen.findByRole("button", { name: /kick-second/i });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(services.store.execute).not.toHaveBeenCalled();
    fireEvent.click(choice);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    expect(mocks.preview.mock.calls[0][1].idea).toContain('"kick-second"');
    expect(services.store.execute).not.toHaveBeenCalled();
  });
});
