import { describe, expect, it, vi, afterEach } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { exportProject, importProject } from "../../src/export/project-io";

describe("exportProject", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a downloadable JSON file", () => {
    const doc = createProjectFromTemplate("house");

    // Mock URL.createObjectURL
    const createObjectURL = vi.fn(() => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    // Mock anchor element
    const click = vi.fn();
    const remove = vi.fn();
    const mockAnchor = { href: "", download: "", click, remove, style: {} };
    vi.spyOn(document, "createElement").mockReturnValue(mockAnchor as any);
    vi.spyOn(document.body, "appendChild").mockImplementation(() => null as any);
    vi.spyOn(document.body, "removeChild").mockImplementation(() => null as any);

    exportProject(doc);

    expect(mockAnchor.download).toContain(".pulseforge.json");
    expect(click).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
  });
});

describe("importProject", () => {
  it("imports a valid JSON string", async () => {
    const doc = createProjectFromTemplate("house");
    const json = JSON.stringify(doc);
    const result = await importProject(json);
    expect(result.name).toBe(doc.name);
    expect(result.bpm).toBe(doc.bpm);
    expect(result.tracks.length).toBe(doc.tracks.length);
  });

  it("rejects invalid JSON", async () => {
    await expect(importProject("not json")).rejects.toThrow("Invalid JSON");
  });

  it("rejects invalid project structure", async () => {
    await expect(importProject('{"foo": "bar"}')).rejects.toThrow("Invalid project structure");
  });

  it("normalizes imported project", async () => {
    const doc = createProjectFromTemplate("house");
    const stripped = { ...doc, groove: undefined, midi: undefined };
    const json = JSON.stringify(stripped);
    const result = await importProject(json);
    expect(result.name).toBe(doc.name);
  });

  it("handles File import", async () => {
    const doc = createProjectFromTemplate("house");
    const json = JSON.stringify(doc);
    const file = new File([json], "test.pulseforge.json", { type: "application/json" });
    const result = await importProject(file);
    expect(result.name).toBe(doc.name);
  });

  it("rejects invalid File content", async () => {
    const file = new File(["not json"], "bad.json", { type: "application/json" });
    await expect(importProject(file)).rejects.toThrow("Invalid JSON");
  });

  it("preserves all project data through round-trip", async () => {
    const doc = createProjectFromTemplate("scene-score");
    const json = JSON.stringify(doc);
    const result = await importProject(json);
    expect(result.tracks.length).toBe(doc.tracks.length);
    expect(result.patterns.length).toBe(doc.patterns.length);
    expect(result.scenes.length).toBe(doc.scenes.length);
    expect(result.macros.length).toBe(doc.macros.length);
  });
});
