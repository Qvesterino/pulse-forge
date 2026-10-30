import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { mockServices, renderWithContext } from "../helpers";

vi.mock("../../src/intent/pipeline", async (original) => {
  const actual = await original<typeof import("../../src/intent/pipeline")>();
  return {
    ...actual,
    generateAsyncResult: async (
      doc: Parameters<typeof actual.generateLocalResult>[0],
      input: Parameters<typeof actual.generateLocalResult>[1],
    ) => actual.generateLocalResult(doc, input, "preview"),
  };
});

describe("protected pattern generation", () => {
  it("shows the protected drum track before the generated bass is used", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<IntentPanel />, { services });
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "generate bass, keep drums" } });
    fireEvent.click(screen.getByRole("button", { name: /GENERATE/i }));
    const disclosure = await screen.findByLabelText("Protected pattern content", {}, { timeout: 10000 });
    expect(disclosure.textContent).toContain("drums");
    expect(disclosure.textContent).toContain(doc.tracks.find((track) => track.kind === "drum")!.name);
    expect(services.store.execute).not.toHaveBeenCalled();
  });
});
