import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelPacksSection } from "../../src/ui/ModelPackCard";
import { SEMANTIC_PACK } from "../../src/ai/packs/registry";

/**
 * ModelPackCard component contract (ROADMAP-FULL-DAW Phase 5 UX): honest
 * status per pack, explicit DOWNLOAD with live progress, CANCEL mid-flight,
 * REMOVE when installed, capability guard, and a visible error on failure —
 * the manager itself is fully covered by tests/model-packs.test.ts; this
 * file pins what the user SEES.
 */

const managerMocks = vi.hoisted(() => ({
  packStatus: vi.fn(),
  downloadPack: vi.fn(),
  evictPack: vi.fn(),
}));

vi.mock("../../src/ai/packs/modelPackManager", () => managerMocks);

// jsdom has neither CacheStorage nor WebCrypto — the component gates its
// controls on both, so each test installs what it needs.
function stubCapabilities(present: boolean) {
  if (present) {
    (globalThis as Record<string, unknown>).caches = { open: vi.fn() };
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { digest: vi.fn() } },
      configurable: true,
    });
  } else {
    delete (globalThis as Record<string, unknown>).caches;
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  }
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  stubCapabilities(true);
});

async function renderSection() {
  const view = render(<ModelPacksSection />);
  await waitFor(() => expect(managerMocks.packStatus).toHaveBeenCalled());
  return view;
}

describe("ModelPacksSection — status surface", () => {
  it("renders the pack with purpose, size, license and NOT INSTALLED status", async () => {
    managerMocks.packStatus.mockResolvedValue("absent");
    await renderSection();
    expect(screen.getByText(/SEMANTIC EMBEDDING MODEL/i)).toBeTruthy();
    expect(screen.getByText(/≈118 MB/)).toBeTruthy();
    expect(screen.getByText(/Apache-2\.0/)).toBeTruthy();
    expect(screen.getByText(/NOT INSTALLED/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "DOWNLOAD" })).toBeTruthy();
  });

  it("READY packs show REMOVE and the offline promise", async () => {
    managerMocks.packStatus.mockResolvedValue("ready");
    await renderSection();
    expect(screen.getByText(/INSTALLED — works offline/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "REMOVE" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "DOWNLOAD" })).toBeNull();
  });

  it("without Cache Storage / WebCrypto the guard row appears and DOWNLOAD is hidden", async () => {
    stubCapabilities(false);
    await renderSection();
    expect(screen.getByText(/Downloads need Cache Storage \+ WebCrypto/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "DOWNLOAD" })).toBeNull();
  });
});

describe("ModelPacksSection — download flow", () => {
  it("DOWNLOAD streams progress into the UI and lands on INSTALLED", async () => {
    managerMocks.packStatus.mockResolvedValue("absent");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    managerMocks.downloadPack.mockImplementation(
      async (_pack, { onProgress }: { onProgress?: (p: unknown) => void }) => {
        onProgress?.({ bytesDone: 59_000_000, totalBytes: 118_000_000, fileIndex: 0, fileCount: 4 });
        await gate; // hold the download in flight so the progress row is assertable
      },
    );
    const user = userEvent.setup();
    await renderSection();
    await user.click(screen.getByRole("button", { name: "DOWNLOAD" }));
    expect(managerMocks.downloadPack).toHaveBeenCalledWith(
      SEMANTIC_PACK,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText(/50% — /)).toBeTruthy();
    expect(screen.getByText(/file 1\/4/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeTruthy();
    release(); // the download settles
    await waitFor(() => expect(screen.getByText(/INSTALLED — works offline/)).toBeTruthy());
  });

  it("CANCEL aborts the in-flight download and swallows the AbortError", async () => {
    managerMocks.packStatus.mockResolvedValue("absent");
    let release!: (reason: unknown) => void;
    const gate = new Promise<never>((_resolve, reject) => {
      release = reject;
    });
    let captured: { signal?: AbortSignal } = {};
    managerMocks.downloadPack.mockImplementation(
      async (_pack, opts: { signal?: AbortSignal; onProgress?: (p: unknown) => void }) => {
        captured = opts;
        opts.onProgress?.({ bytesDone: 1, totalBytes: 118_000_000, fileIndex: 0, fileCount: 4 });
        await gate; // rejects with AbortError once the test pulls the trigger
      },
    );
    const user = userEvent.setup();
    await renderSection();
    await user.click(screen.getByRole("button", { name: "DOWNLOAD" }));
    const cancel = await screen.findByRole("button", { name: "Cancel download" });
    await user.click(cancel);
    expect(captured.signal?.aborted).toBe(true);
    release(new DOMException("Aborted", "AbortError"));
    // Back to a clean DOWNLOAD state — cancellations are not errors.
    await waitFor(() => expect(screen.getByRole("button", { name: "DOWNLOAD" })).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failing download surfaces the error and re-probes status", async () => {
    managerMocks.packStatus.mockResolvedValue("absent");
    managerMocks.downloadPack.mockRejectedValue(
      new Error("model_quantized.onnx: integrity mismatch — download discarded"),
    );
    const user = userEvent.setup();
    await renderSection();
    await user.click(screen.getByRole("button", { name: "DOWNLOAD" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/integrity mismatch/);
    // After failure the pack goes back to a controllable state.
    expect(await screen.findByRole("button", { name: "DOWNLOAD" })).toBeTruthy();
  });

  it("REMOVE evicts the pack and returns to NOT INSTALLED", async () => {
    managerMocks.packStatus.mockResolvedValue("ready");
    managerMocks.evictPack.mockResolvedValue(undefined);
    const user = userEvent.setup();
    await renderSection();
    await user.click(screen.getByRole("button", { name: "REMOVE" }));
    expect(managerMocks.evictPack).toHaveBeenCalledWith(SEMANTIC_PACK);
    await waitFor(() => expect(screen.getByText(/NOT INSTALLED/)).toBeTruthy());
  });
});
