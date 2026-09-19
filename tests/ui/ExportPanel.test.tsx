import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportPanel } from "../../src/ui/ExportPanel";
import { mockServices, renderWithContext } from "../helpers";

describe("ExportPanel", () => {
  it("renders the export region with the default FORMAT select", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.getByRole("region", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByLabelText("FORMAT")).toBeInTheDocument();
    expect(screen.getByLabelText("RATE")).toBeInTheDocument();
    expect(screen.getByLabelText("DEPTH")).toBeInTheDocument();
  });

  it("default export button is labelled EXPORT MASTER (WAV)", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.getByRole("button", { name: /^EXPORT MASTER/ })).toBeInTheDocument();
    // WAV doesn't get a suffix — only MP3 gets "(MP3)" appended for clarity.
    expect(screen.getByRole("button", { name: /^EXPORT MASTER/ })).toHaveTextContent("EXPORT MASTER");
  });

  it("switching FORMAT to MP3 192 updates the button label", async () => {
    const user = userEvent.setup();
    renderWithContext(<ExportPanel />, { services: mockServices() });
    await user.selectOptions(screen.getByLabelText("FORMAT"), "mp3-192");
    expect(screen.getByRole("button", { name: /^EXPORT MASTER.*MP3/ })).toBeInTheDocument();
  });

  it("switching RATE to 48 kHz records 48000 as selected value", async () => {
    const user = userEvent.setup();
    renderWithContext(<ExportPanel />, { services: mockServices() });
    await user.selectOptions(screen.getByLabelText("RATE"), "48000");
    expect(screen.getByLabelText("RATE")).toHaveValue("48000");
  });

  it("export-policy note is rendered so users can see CANCEL guidance", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.getByRole("note", { name: "Export policy" })).toBeInTheDocument();
  });

  it("global quality switch defaults to Studio HQ", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    const quality = screen.getByLabelText("QUALITY") as HTMLSelectElement;
    expect(quality.value).toBe("studio");
  });

  it("switching QUALITY to Live records live as selected value", async () => {
    const user = userEvent.setup();
    renderWithContext(<ExportPanel />, { services: mockServices() });
    await user.selectOptions(screen.getByLabelText("QUALITY"), "live");
    expect(screen.getByLabelText("QUALITY")).toHaveValue("live");
  });
});
