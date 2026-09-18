import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { GenerateDialog } from "../../src/ui/GenerateDialog";
import { mockServices, renderWithContext } from "../helpers";
import type { GenerationResult } from "../../src/intent/types";
import type { GenerateOptions } from "../../src/ai/types";
import { createProjectFromTemplate } from "../../src/project-model/templates";

/**
 * Async preview race protection: an OLDER generation resolving LATER must
 * never overwrite a newer preview, and APPLY commits the previewed result.
 * The pipeline module is mocked so resolution order is fully controlled;
 * the returned results are real engine outputs (deterministic generator).
 */

vi.mock("../../src/intent/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/pipeline")>();
  return {
    ...actual,
    generateAsyncResult: vi.fn(),
  };
});

import { generateAsyncResult, generateLocalResultFromOptions } from "../../src/intent/pipeline";
const generateMock = vi.mocked(generateAsyncResult);

const BASE_OPTIONS: GenerateOptions = {
  genre: "house",
  seed: "race-seed",
  stepCount: 16,
  ghostWeight: 0.3,
  microWeight: 0.2,
  velocityVariation: 0.3,
  temperature: 1,
  replaceMode: "new",
};

function realResultFor(
  doc: ReturnType<typeof createProjectFromTemplate>,
  seed: string,
  evenVelocity: number,
): GenerationResult {
  const base = generateLocalResultFromOptions(doc, { ...BASE_OPTIONS, seed }, "preview");
  const pattern = base.proposal!.pattern;
  const firstPadId = Object.keys(pattern.rows)[0];
  const rows = {
    ...pattern.rows,
    [firstPadId]: pattern.rows[firstPadId].map((_, i) => (i % 2 === 0 ? evenVelocity : 0)),
  };
  return { ...base, proposal: { ...base.proposal!, pattern: { ...pattern, rows } } };
}

describe("GenerateDialog — async preview race protection", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it("an older preview resolving after a newer one cannot replace it, and APPLY commits the newer preview", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);

    let resolveA!: (r: GenerationResult) => void;
    let resolveB!: (r: GenerationResult) => void;
    const deferredA = new Promise<GenerationResult>((res) => (resolveA = res));
    const deferredB = new Promise<GenerationResult>((res) => (resolveB = res));
    const resultA = realResultFor(doc, "seed-A", 0.9); // grid cells titled …: 90%
    const resultB = realResultFor(doc, "seed-B", 0.5); // grid cells titled …: 50%
    generateMock.mockImplementationOnce(() => deferredA).mockImplementationOnce(() => deferredB);

    renderWithContext(<GenerateDialog open onClose={() => {}} />, { services });

    // First preview request fired for the initial options.
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));

    // Change the seed → a NEWER preview request supersedes the older one.
    const seedInput = document.querySelector<HTMLInputElement>(".generate-seed-input")!;
    fireEvent.change(seedInput, { target: { value: "seed-B" } });
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(2));

    // The newer (B) finishes first — preview shows B.
    resolveB(resultB);
    await waitFor(() => expect(screen.getAllByTitle(/: 50%/).length).toBeGreaterThan(0));

    // The OLDER (A) finishes later — it must NOT overwrite B's preview.
    resolveA(resultA);
    await waitFor(() => expect(screen.queryAllByTitle(/: 90%/)).toHaveLength(0));
    expect(screen.getAllByTitle(/: 50%/).length).toBeGreaterThan(0);

    // APPLY commits the previewed (newer) result, exactly once.
    const generateButton = screen.getByRole("button", { name: "GENERATE" });
    await waitFor(() => expect(generateButton).toBeEnabled());
    fireEvent.click(generateButton);
    expect(services.store.execute).toHaveBeenCalledTimes(1);
  });

  it("while a preview is pending the GENERATE button cannot commit a stale result", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    let resolveA!: (r: GenerationResult) => void;
    const deferredA = new Promise<GenerationResult>((res) => (resolveA = res));
    generateMock.mockImplementation(() => deferredA);

    renderWithContext(<GenerateDialog open onClose={() => {}} />, { services });
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));

    // Pending → button disabled and labelled busy; clicking is a no-op.
    const generateButton = screen.getByRole("button", { name: "…" });
    expect(generateButton).toBeDisabled();
    fireEvent.click(generateButton);
    expect(services.store.execute).not.toHaveBeenCalled();

    resolveA(realResultFor(doc, "seed-A", 0.5));
    await waitFor(() => expect(screen.getByRole("button", { name: "GENERATE" })).toBeEnabled());
  });
});
