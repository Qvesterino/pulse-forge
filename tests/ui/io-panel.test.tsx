import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IoPanel } from "../../src/ui/IoPanel";
import { renderWithContext, mockServices } from "../helpers";

/**
 * Honest-degradation pins for the Studio I/O panel (jsdom: no setSinkId,
 * no real mediaDevices, no kyxDesktop bridge — exactly the surfaces the
 * panel must describe truthfully instead of failing into).
 */

async function renderPanel() {
  const services = mockServices();
  renderWithContext(<IoPanel />, { services });
  await act(async () => {
    await Promise.resolve();
  });
  return services;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Studio I/O panel", () => {
  it("renders OUTPUT and INPUT sections with honest notes", async () => {
    await renderPanel();
    expect(screen.getByText("OUTPUT")).toBeInTheDocument();
    expect(screen.getByText("INPUT")).toBeInTheDocument();
    // jsdom has no setSinkId — the unsupported note MUST be visible.
    expect(screen.getByText(/cannot switch outputs/)).toBeInTheDocument();
  });

  it("hides the ASIO section without the desktop bridge (web honesty)", async () => {
    await renderPanel();
    expect(screen.queryByText("ASIO DRIVERS")).not.toBeInTheDocument();
  });

  it("changing the input persists the device choice", async () => {
    const user = userEvent.setup();
    // jsdom enumerateDevices stub: one named input.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: async () => [{ kind: "audioinput", deviceId: "mic-1", label: "UA Volt" }] },
    });
    await renderPanel();
    await waitFor(() => expect(screen.getByRole("option", { name: "UA Volt" })).toBeInTheDocument());
    await user.selectOptions(screen.getAllByRole("combobox")[1], "mic-1");
    expect(window.localStorage.getItem("pf:recording-input-device")).toBe("mic-1");
  });

  it("keeps a missing saved input and output visible without silently selecting defaults", async () => {
    window.localStorage.setItem("pf:audio-output-device", "gone-output");
    window.localStorage.setItem("pf:recording-input-device", "gone-input");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audiooutput", deviceId: "available-output", label: "Speakers" },
          { kind: "audioinput", deviceId: "available-input", label: "Microphone" },
        ],
      },
    });

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Saved output unavailable" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Saved input unavailable" })).toBeInTheDocument();
    });
    const selectedDeviceIds = screen.getAllByRole("combobox").map((select) => (select as HTMLSelectElement).value);
    expect(selectedDeviceIds).toEqual(["gone-output", "gone-input"]);
    expect(screen.getByText(/saved output is not currently listed/i)).toBeInTheDocument();
    expect(screen.getByText(/will not switch inputs silently/i)).toBeInTheDocument();
  });

  it("TEST TONE is disabled without a live context — honest gate, no silent click", async () => {
    await renderPanel();
    // jsdom has no AudioContext, so the panel must not pretend the tone can play.
    expect(screen.getByRole("button", { name: "TEST TONE" })).toBeDisabled();
  });

  it("shows the ASIO section when the desktop bridge exists", async () => {
    const bridge = {
      list: vi.fn().mockResolvedValue({
        registry: { status: "ok", names: ["FlexASIO"] },
        details: {
          status: "ok",
          drivers: [{ name: "FlexASIO", inputChannels: 2, outputChannels: 2, sampleRate: 48000 }],
        },
      }),
    };
    (window as { kyxDesktop?: unknown }).kyxDesktop = { asio: bridge };
    try {
      await renderPanel();
      expect(screen.getByText("ASIO DRIVERS")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText("FlexASIO")).toBeInTheDocument());
      expect(screen.getByText(/2in · 2out/)).toBeInTheDocument();
      // The honest matrix note is part of the contract.
      expect(screen.getByText(/Discovery only \(ADR 0017\)/)).toBeInTheDocument();
    } finally {
      delete (window as { kyxDesktop?: unknown }).kyxDesktop;
    }
  });
});
