import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { VerifyStampButton } from "../../src/ui/VerifyStampButton";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { buildRenderManifest, type LastRenderStamp } from "../../src/export/renderManifest";
import { cancelJob, jobSnapshot, resetJobCenterForTests } from "../../src/services/jobCenter";
import { verifyRenderStamp } from "../../src/export/verifyRenderStamp";

/**
 * WAVE 2/C — the VERIFY button. The stamp claims reproducibility; this is the
 * surface that checks it and reports the verdict honestly (match = proof,
 * mismatch = error-styled refusal, cancel = no verdict at all).
 */

vi.mock("../../src/export/verifyRenderStamp", () => ({ verifyRenderStamp: vi.fn() }));

function stampFor(): LastRenderStamp {
  const doc = createProjectFromTemplate("house");
  return {
    manifest: buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: 48000,
      bitDepth: 24,
      durationSec: 1,
      renderHash: "a".repeat(64),
    }),
    fileName: "beat-master.wav",
    recordedAt: Date.now(),
  };
}

beforeEach(() => {
  resetJobCenterForTests();
  vi.mocked(verifyRenderStamp).mockReset();
});

describe("VerifyStampButton", () => {
  it("renders nothing without a stamp (zero cost when nothing was exported)", () => {
    const { container } = renderWithContext(<VerifyStampButton stamp={null} />);
    expect(container.textContent).toBe("");
  });

  it("re-renders, compares and shows the bit-identical proof as a Job Center job", async () => {
    vi.mocked(verifyRenderStamp).mockResolvedValueOnce({
      status: "match",
      detail: "Bit-identical re-render (SHA-256 abc123).",
      reRendered: true,
      reRenderedHash: "abc123",
    });
    renderWithContext(<VerifyStampButton stamp={stampFor()} />, { services: mockServices() });

    fireEvent.click(screen.getByRole("button", { name: "VERIFY LAST EXPORT" }));

    expect(await screen.findByText(/Bit-identical re-render/)).toBeInTheDocument();
    const job = jobSnapshot().jobs.find((candidate) => candidate.kind === "verify");
    expect(job).toMatchObject({ status: "done", label: "Verify beat-master.wav" });
    expect(screen.getByRole("button", { name: "VERIFY LAST EXPORT" })).toBeEnabled();
  });

  it("reports a mismatch as an error instead of a silent pass", async () => {
    vi.mocked(verifyRenderStamp).mockResolvedValueOnce({
      status: "hash-mismatch",
      detail: "The re-render does not match (111 ≠ 222) — the project or its render settings changed.",
      reRendered: true,
      reRenderedHash: "111",
    });
    renderWithContext(<VerifyStampButton stamp={stampFor()} />, { services: mockServices() });

    fireEvent.click(screen.getByRole("button", { name: "VERIFY LAST EXPORT" }));

    expect(await screen.findByText(/does not match/)).toBeInTheDocument();
    expect(screen.queryByText(/Bit-identical/)).toBeNull();
    const job = jobSnapshot().jobs.find((candidate) => candidate.kind === "verify");
    expect(job).toMatchObject({ status: "failed" });
  });

  it("a cancel from the Activity Center settles cleanly — no verdict, no stuck button", async () => {
    vi.mocked(verifyRenderStamp).mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new DOMException("Export cancelled", "AbortError")));
        }),
    );
    renderWithContext(<VerifyStampButton stamp={stampFor()} />, { services: mockServices() });
    fireEvent.click(screen.getByRole("button", { name: "VERIFY LAST EXPORT" }));

    await waitFor(() => {
      const job = jobSnapshot().jobs.find((candidate) => candidate.kind === "verify");
      expect(job?.status).toBe("running");
    });
    const job = jobSnapshot().jobs.find((candidate) => candidate.kind === "verify")!;
    cancelJob(job.id);

    await waitFor(() => expect(screen.getByRole("button", { name: "VERIFY LAST EXPORT" })).toBeEnabled());
    expect(screen.queryByText(/Bit-identical/)).toBeNull();
    expect(jobSnapshot().jobs.find((candidate) => candidate.kind === "verify")?.status).toBe("cancelled");
  });
});
