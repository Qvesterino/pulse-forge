import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { ServicesContext } from "../../src/ui/context";
import { lastGeneration, rememberGeneration } from "../../src/intent/session-context";
import { normalizeIntent } from "../../src/intent/normalize";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument, ProjectProducerBriefV1 } from "../../src/project-model/types";
import { mockServices, renderWithContext } from "../helpers";

function projectWithBrief(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const producerBrief: ProjectProducerBriefV1 = {
    version: 1,
    savedAt: "2026-10-02T10:00:00.000Z",
    facts: [
      { field: "genre", section: "preference", value: "trap", origin: "user", confidence: "confirmed" },
      { field: "bpmRange", section: "hard", value: [140, 140], origin: "user", confidence: "confirmed" },
      { field: "mood", section: "preference", value: "dark", origin: "user", confidence: "confirmed" },
      { field: "preserve", section: "preserve", value: ["bass"], origin: "user", confidence: "confirmed" },
    ],
  };
  return { ...base, producerBrief };
}

describe("IntentPanel — project Producer Brief", () => {
  it("saves only explicit structured facts through the undoable project command", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<IntentPanel />, { services });

    fireEvent.change(screen.getByLabelText(/Intent description/i), {
      target: { value: "dark trap at 142 bpm, keep my bass" },
    });
    const saveButton = screen.getByRole("button", { name: /SAVE TO PROJECT/i });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    expect(services.store.execute).toHaveBeenCalledTimes(1);
    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command).toBeDefined();
    expect(command!.type).toBe("saveProjectProducerBrief");
    const saved = command!.execute(doc);
    expect(saved.producerBrief?.facts.map((fact) => fact.field)).toContain("genre");
    expect(saved.producerBrief?.facts.map((fact) => fact.field)).toContain("bpmRange");
    expect(saved.producerBrief?.facts.map((fact) => fact.field)).toContain("preserve");
    expect(JSON.stringify(saved.producerBrief)).not.toContain("dark trap at 142 bpm");
  });

  it("can generate from saved project facts with no prompt and can opt out", async () => {
    const doc = projectWithBrief();
    const services = mockServices(doc);
    rememberGeneration({
      text: "",
      intent: normalizeIntent({}),
      candidates: [],
      appliedIndex: null,
      docId: doc.id,
      at: 0,
    });
    renderWithContext(<IntentPanel />, { services });

    const memoryToggle = screen.getByRole("checkbox", { name: "Use saved project Producer Brief for generation" });
    expect(memoryToggle).toBeChecked();
    expect(screen.getByRole("button", { name: "GENERATE" })).toBeEnabled();

    fireEvent.click(memoryToggle);
    expect(screen.getByRole("button", { name: "GENERATE" })).toBeDisabled();
    fireEvent.click(memoryToggle);
    fireEvent.click(screen.getByRole("button", { name: "GENERATE" }));

    await waitFor(() => expect(lastGeneration()?.docId).toBe(doc.id), { timeout: 20000 });
    expect(lastGeneration()?.intent.genre).toBe("trap");
    expect(lastGeneration()?.intent.bpmRange).toEqual([140, 140]);
    expect(lastGeneration()?.intent.mood).toBe("dark");
    expect(lastGeneration()?.intent.preserve).toEqual(["bass"]);

    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "house at 124 bpm" } });
    fireEvent.click(screen.getByRole("button", { name: "GENERATE" }));
    await waitFor(() => expect(lastGeneration()?.intent.genre).toBe("house"), { timeout: 20000 });
    expect(lastGeneration()?.intent.bpmRange).toEqual([124, 124]);
    expect(lastGeneration()?.intent.preserve).toEqual(["bass"]);
  }, 40000);

  it("does not inherit saved facts after the creator turns project memory off", async () => {
    const doc = projectWithBrief();
    const services = mockServices(doc);
    rememberGeneration({
      text: "",
      intent: normalizeIntent({}),
      candidates: [],
      appliedIndex: null,
      docId: `${doc.id}-stale`,
      at: 0,
    });
    renderWithContext(<IntentPanel />, { services });

    fireEvent.click(screen.getByRole("checkbox", { name: "Use saved project Producer Brief for generation" }));
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "house at 124 bpm" } });
    fireEvent.click(screen.getByRole("button", { name: "GENERATE" }));

    await waitFor(() => expect(lastGeneration()?.docId).toBe(doc.id), { timeout: 20000 });
    expect(lastGeneration()?.intent.genre).toBe("house");
    expect(lastGeneration()?.intent.bpmRange).toEqual([124, 124]);
    expect(lastGeneration()?.intent.mood).not.toBe("dark");
    expect(lastGeneration()?.intent.preserve ?? []).not.toContain("bass");
  }, 40000);

  it("blocks generation when the current prompt violates the saved preserve rule", () => {
    const doc = projectWithBrief();
    const services = mockServices(doc);
    rememberGeneration({
      text: "",
      intent: normalizeIntent({}),
      candidates: [],
      appliedIndex: null,
      docId: `${doc.id}-stale`,
      at: 0,
    });
    renderWithContext(<IntentPanel />, { services });

    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "add bass" } });
    expect(screen.getByRole("alert", { name: "Rozpory v zadaní" })).toHaveTextContent(
      /zachovať basu a zároveň pridať/i,
    );
    fireEvent.click(screen.getByRole("button", { name: "GENERATE" }));

    expect(
      screen.getByText(
        "Zadanie si protirečí. Uprav konfliktné požiadavky v texte alebo odstráň ochranný čip pred generovaním.",
      ),
    ).toBeInTheDocument();
    expect(lastGeneration()?.docId).toBe(`${doc.id}-stale`);
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("does not carry the active-memory toggle into a different project", async () => {
    const firstDoc = projectWithBrief();
    const rendered = renderWithContext(<IntentPanel />, { services: mockServices(firstDoc) });
    expect(screen.getByRole("checkbox", { name: "Use saved project Producer Brief for generation" })).toBeChecked();

    const secondDoc = createProjectFromTemplate("house");
    const secondServices = mockServices({ ...secondDoc, id: `${secondDoc.id}-other` });
    rendered.rerender(
      <ServicesContext.Provider value={secondServices}>
        <IntentPanel />
      </ServicesContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.queryByRole("checkbox", { name: "Use saved project Producer Brief for generation" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "GENERATE" })).toBeDisabled();
  });

  it("lets the creator inspect and forget one saved fact while memory is off", () => {
    const doc = projectWithBrief();
    const services = mockServices(doc);
    renderWithContext(<IntentPanel />, { services });

    fireEvent.click(screen.getByRole("checkbox", { name: "Use saved project Producer Brief for generation" }));
    fireEvent.click(screen.getByText(/PROJECT MEMORY · 4 FACTS/));
    expect(screen.getByText("trap")).toBeInTheDocument();
    expect(screen.getByText("140 BPM")).toBeInTheDocument();
    expect(screen.getAllByText("potvrdené tebou · confirmed")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Remove saved project brief fact: mood" }));
    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("removeProjectProducerBriefFact");
    const updated = command!.execute(doc);
    expect(updated.producerBrief?.facts.some((fact) => fact.field === "mood")).toBe(false);
    expect(updated.producerBrief?.facts.some((fact) => fact.field === "preserve")).toBe(true);
  });
});
