import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * B1 gallery REGEN — `?regen=1` boot stashes `pf-intent-regen`; the panel
 * consumes it on mount, pre-fills the beat's own character and auto-runs
 * ONE fresh-seed generation.
 *
 * Lives in its OWN file: the auto-run is guarded by a module-level
 * `regenAutoRan` singleton (StrictMode protection), which would swallow any
 * second regen test in the same module.
 */
describe("IntentPanel — B1 regenerate with intent", () => {
  it("auto-runs one fresh-seed generation from the imported beat's provenance", async () => {
    const base = createProjectFromTemplate("house");
    const doc: ProjectDocument = {
      ...base,
      patterns: base.patterns.map((p, index) =>
        index === 0
          ? { ...p, intent: { genre: "trap", energy: 0.9, density: 0.6, seed: "orig", bpmRange: [130, 145] } }
          : p,
      ),
    } as ProjectDocument;

    sessionStorage.setItem("pf-intent-regen", "1");
    renderWithContext(<IntentPanel />, { services: mockServices(doc) });

    // The character line lands in the field immediately…
    const textarea = (await screen.findByLabelText(/Intent description/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("trap 145 high energy"));
    // …and the auto-generation (real, deterministic engine) completes into
    // a candidate bank — the same terminal status a manual generate produces.
    await waitFor(
      () => {
        const status = screen.getByRole("status").textContent ?? "";
        expect(status).toMatch(/candidates|pattern generated/);
      },
      { timeout: 20000 },
    );
    expect(screen.queryByText(/no intent provenance/i)).toBeNull();
  }, 40000);
});
