import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { FreesoundSection } from "../../src/ui/FreesoundSection";
import { renderWithContext, mockServices } from "../helpers";
import { saveFreesoundToken } from "../../src/samples/freesound";

const REAL_FETCH = globalThis.fetch;

function mockSearchResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        {
          id: 99,
          name: "Crispy Snare",
          username: "beatmaker",
          duration: 0.8,
          previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/99/hq.mp3" },
          license: "cc0",
        },
      ],
    }),
    arrayBuffer: async () => new ArrayBuffer(64),
  };
}

beforeEach(() => {
  localStorage.clear();
  saveFreesoundToken("test-token");
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  localStorage.clear();
});

describe("FreesoundSection", () => {
  it("renders collapsed, opens with the toggle", () => {
    renderWithContext(<FreesoundSection onImport={vi.fn()} />);
    expect(screen.queryByLabelText("Search freesound")).toBeNull();
    fireEvent.click(screen.getByText("FREESOUND · CC0"));
    expect(screen.getByLabelText("Search freesound")).toBeInTheDocument();
  });

  it("searches on Enter and renders results with import buttons", async () => {
    const fetchMock = vi.fn(async () => mockSearchResponse() as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithContext(<FreesoundSection onImport={vi.fn()} />);
    fireEvent.click(screen.getByText("FREESOUND · CC0"));
    const input = screen.getByLabelText("Search freesound");
    fireEvent.change(input, { target: { value: "snare" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText(/Crisply Snare|Crispy Snare/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "IMPORT" })).toBeInTheDocument();
  });

  it("imports a result into the bank + user samples and calls onImport", async () => {
    globalThis.fetch = vi.fn(async () => mockSearchResponse() as unknown as Response);
    const services = mockServices();
    const onImport = vi.fn();

    renderWithContext(<FreesoundSection onImport={onImport} />, { services });
    fireEvent.click(screen.getByText("FREESOUND · CC0"));
    fireEvent.change(screen.getByLabelText("Search freesound"), { target: { value: "snare" } });
    fireEvent.click(screen.getByRole("button", { name: "GO" }));
    await waitFor(() => screen.getByRole("button", { name: "IMPORT" }));

    fireEvent.click(screen.getByRole("button", { name: "IMPORT" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(services.bank.add).toHaveBeenCalled());
    await waitFor(() => expect(services.userSamples.save).toHaveBeenCalled());

    const asset = onImport.mock.calls[0][0];
    expect(asset.id).toMatch(/^fs-99-/);
    expect(asset.name).toContain("Crispy Snare");
    // Button flips to imported state.
    await waitFor(() => expect(screen.getByText("✓")).toBeInTheDocument());
  });
});
