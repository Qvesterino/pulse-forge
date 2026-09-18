import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectStore } from "../../src/store/ProjectStore";
import { DiceProvider, useDice } from "../../src/ui/DiceContext";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { ServicesContext } from "../../src/ui/context";
import { mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { normalizeProject } from "../../src/project-model/schema";
import { canonicalizePattern, contentHash } from "../../src/ai/evaluation";
import { resetRankerClient } from "../../src/ai/ranking/ranker-client";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * Preview/apply identity at the UI layer:
 *  - Dice APPLY commits the exact previewed GenerationResult (no regeneration),
 *  - locked regions survive into the committed pattern with a truthful hash,
 *  - IntentPanel applies the engine result exactly once through the canonical path.
 */

function servicesWithRealStore(doc: ProjectDocument): { services: Services; store: ProjectStore } {
  const store = new ProjectStore(doc);
  const base = mockServices(doc);
  const services = { ...base, store: store as unknown as Services["store"] } as Services;
  return { services, store };
}

function DiceBinder({ onReady, services }: { onReady: (dice: ReturnType<typeof useDice>) => void; services: Services }) {
  const dice = useDice();
  onReady(dice);
  return (
    <div>
      <div data-testid="mode">{dice.preview.mode}</div>
      <div data-testid="hasPreview">{String(dice.preview.fullPattern !== null)}</div>
      <button type="button" onClick={() => dice.apply(services, services.store.doc)}>
        applyDice
      </button>
    </div>
  );
}

function renderDice(doc: ProjectDocument, services: Services, onReady: (d: ReturnType<typeof useDice>) => void) {
  return render(
    <DiceProvider doc={doc} active>
      <DiceBinder onReady={onReady} services={services} />
    </DiceProvider>,
  );
}

describe("Dice preview/apply identity", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });
  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  it("APPLY commits the exact previewed pattern (no regeneration)", async () => {
    const doc = createProjectFromTemplate("house");
    const { services, store } = servicesWithRealStore(doc);
    let dice: ReturnType<typeof useDice> | null = null;

    renderDice(doc, services, (d) => (dice = d));
    await waitFor(() => expect(screen.getByTestId("hasPreview")).toHaveTextContent("true"));

    const previewed = dice!.preview.fullPattern!;
    expect(previewed.proposal).toBeTruthy();
    const beforeCount = store.doc.patterns.length;

    await act(async () => {
      dice!.apply(services, store.doc);
    });

    const committed = store.doc.patterns[store.doc.patterns.length - 1];
    // The previewed pattern id is committed — a regenerated pattern would
    // carry a fresh uid.
    expect(committed.id).toBe(previewed.proposal!.pattern.id);
    expect(committed.generation?.outputContentHash).toBe(previewed.proposal!.pattern.generation?.outputContentHash);
    expect(committed.generation?.intentHash).toBe(previewed.plan.intentHash);
    expect(store.doc.activePatternId).toBe(committed.id);
    expect(store.doc.patterns.length).toBe(beforeCount + 1);
  });

  it("locked regions survive into the committed pattern and the content hash is truthful", async () => {
    const doc = createProjectFromTemplate("house");
    const { services, store } = servicesWithRealStore(doc);
    let dice: ReturnType<typeof useDice> | null = null;

    renderDice(doc, services, (d) => (dice = d));
    await waitFor(() => expect(screen.getByTestId("hasPreview")).toHaveTextContent("true"));

    // Lock ALL drums → the committed rows must equal the active pattern's rows.
    await act(async () => {
      dice!.toggleLockKey("drums");
    });
    await waitFor(() => expect(screen.getByTestId("hasPreview")).toHaveTextContent("true"));

    await act(async () => {
      dice!.apply(services, store.doc);
    });

    const committed = store.doc.patterns[store.doc.patterns.length - 1];
    // Apply commits the previewed locked pattern (not a regeneration).
    const previewPattern = dice!.preview.fullPattern!.proposal!.pattern;
    expect(committed.id).toBe(previewPattern.id);
    // Truthful provenance: the recorded hash describes the LOCKED content that
    // was previewed and committed (not the pre-lock generation).
    expect(committed.generation?.outputContentHash).toBe(contentHash(canonicalizePattern(doc, previewPattern)));
    // The committed content survives store normalization unchanged.
    const normalizedPreview = normalizeProject({
      ...doc,
      patterns: [...doc.patterns, previewPattern],
    }).patterns.find((p) => p.id === previewPattern.id)!;
    expect(contentHash(canonicalizePattern(store.doc, committed))).toBe(
      contentHash(canonicalizePattern(store.doc, normalizedPreview)),
    );
  });
});

describe("IntentPanel — canonical path integration", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });
  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  it("one GENERATE applies exactly one undoable command with the engine result", async () => {
    const doc = createProjectFromTemplate("house");
    const { services, store } = servicesWithRealStore(doc);

    render(
      <ServicesContext.Provider value={services}>
        <IntentPanel />
      </ServicesContext.Provider>,
    );

    const textarea = screen.getByLabelText("Intent description");
    fireEvent.change(textarea, { target: { value: "dark rolling techno at 140" } });
    fireEvent.click(screen.getByRole("button", { name: "GENERATE" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/pattern generated/), { timeout: 8000 });

    // One command, applied to the real store: pattern + scene added, undo works.
    expect(store.doc.patterns.length).toBe(doc.patterns.length + 1);
    expect(store.doc.scenes.length).toBe(doc.scenes.length + 1);
    expect(store.undoStackLength).toBe(1);
    const committed = store.doc.patterns[store.doc.patterns.length - 1];
    expect(committed.generation?.intent).toBeTruthy();
    // Ranker mode ≠ off records the ranker outcome (worker-less jsdom → fallback).
    expect(committed.generation?.ranker).toBeTruthy();
    expect(committed.generation?.ranker?.source).toBe("fallback");
    store.undo();
    expect(store.doc.patterns.length).toBe(doc.patterns.length);
  });
});
