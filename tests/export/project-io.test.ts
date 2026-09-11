import { describe, expect, it, vi, afterEach } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { exportProject, importProject, MAX_PROJECT_IMPORT_BYTES } from "../../src/export/project-io";

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

    expect(mockAnchor.download).toContain(".kyx.json");
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

describe("importProject — size limit (release roadmap 1.4)", () => {
  it("rejects an oversized File fast, before reading its contents", async () => {
    const oversized = new File([new Uint8Array(1)], "huge.pulseforge.json");
    Object.defineProperty(oversized, "size", { value: MAX_PROJECT_IMPORT_BYTES + 1 });
    await expect(importProject(oversized)).rejects.toThrow(/too large/);
  });

  it("accepts a file at the size limit boundary", async () => {
    // Shape-invalid content is fine here — the point is the size gate lets
    // it through to the parser instead of rejecting on size.
    const atLimit = new File([new Uint8Array(1)], "ok.json");
    Object.defineProperty(atLimit, "size", { value: MAX_PROJECT_IMPORT_BYTES });
    await expect(importProject(atLimit)).rejects.toThrow(/Invalid JSON|not a valid project file/);
  });
});
