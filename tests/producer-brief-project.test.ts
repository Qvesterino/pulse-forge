import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  clearProjectProducerBriefCommand,
  removeProjectProducerBriefFactCommand,
  saveProjectProducerBriefCommand,
} from "../src/commands/producerBriefCommands";
import { ProjectRepository } from "../src/persistence/ProjectRepository";
import {
  createProjectBriefFromContract,
  mergeProjectProducerBrief,
  projectBriefConflictsFor,
  projectBriefCorrectionsFor,
  projectBriefIntentPatch,
} from "../src/intent/project-brief";
import { compileBriefContract } from "../src/intent/brief-contract";
import { sanitizeProjectProducerBrief } from "../src/project-model/producer-brief";
import { migrateProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { BriefContract } from "../src/intent/brief-contract";
import type { ProjectProducerBriefV1 } from "../src/project-model/types";
import type { ParsedIntent } from "../src/intent/text-parser";

const contract: BriefContract = {
  conflicts: [],
  statements: [
    { id: "bpm", section: "hard", label: "140 BPM", origin: "prompt", confidence: "parsed", patch: null },
    { id: "key", section: "hard", label: "C Natural Minor", origin: "prompt", confidence: "parsed", patch: null },
    { id: "genre", section: "preference", label: "žáner: trap", origin: "prompt", confidence: "parsed", patch: null },
    { id: "style", section: "preference", label: "štýl: dark", origin: "user", confidence: "confirmed", patch: null },
    {
      id: "character",
      section: "preference",
      label: "energia 70 %",
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    },
    { id: "roles", section: "hard", label: "generovať: bicie", origin: "prompt", confidence: "parsed", patch: null },
    {
      id: "preserve-bass",
      section: "preserve",
      label: "ponechám basu",
      origin: "prompt",
      confidence: "parsed",
      patch: null,
      role: "bass",
    },
    {
      id: "no-chords",
      section: "prohibition",
      label: "žiadne akordy",
      origin: "prompt",
      confidence: "parsed",
      patch: null,
      role: "chords",
    },
    {
      id: "unknown",
      section: "unknown",
      label: "odhad",
      origin: "session",
      confidence: "inferred",
      patch: { mood: "dark" },
    },
  ],
};

const input = {
  bpmRange: [140, 140] as [number, number],
  key: "C Natural Minor" as const,
  genre: "trap" as const,
  style: "dark",
  energy: 0.7,
  roles: ["drums"] as const,
  preserve: ["bass"] as const,
  text: "private lyric that must not be persisted",
  seed: "ephemeral-seed",
};

const savedBrief = (): ProjectProducerBriefV1 => {
  const brief = createProjectBriefFromContract(contract, input, "2026-10-02T10:00:00.000Z");
  if (!brief) throw new Error("expected explicit brief facts");
  return brief;
};

describe("project Producer Brief persistence", () => {
  it("stores only explicit/corrected structured facts and restores an intent patch", () => {
    const brief = savedBrief();
    expect(brief.facts.map(({ field }) => field)).toEqual([
      "bpmRange",
      "key",
      "genre",
      "style",
      "energy",
      "roles",
      "preserve",
      "prohibitedRoles",
    ]);
    expect(JSON.stringify(brief)).not.toContain("private lyric");
    expect(JSON.stringify(brief)).not.toContain("ephemeral-seed");
    expect(brief.facts.find((fact) => fact.field === "style")).toMatchObject({
      origin: "user",
      confidence: "confirmed",
    });
    expect(brief.facts.find((fact) => fact.field === "prohibitedRoles")).toMatchObject({ value: ["chords"] });
    expect(projectBriefIntentPatch(brief)).toEqual({
      input: {
        bpmRange: [140, 140],
        key: "C Natural Minor",
        genre: "trap",
        style: "dark",
        energy: 0.7,
        roles: ["drums"],
        preserve: ["bass"],
      },
      prohibitedRoles: ["chords"],
    });
  });

  it("sanitizes imported data, rejects malformed facts, and drops unknown payloads", () => {
    const raw = {
      ...savedBrief(),
      rawPrompt: "do not retain me",
      audioBase64: "not allowed",
      facts: [
        ...savedBrief().facts,
        { field: "key", section: "hard", value: "not a musical key", origin: "prompt", confidence: "parsed" },
        { field: "mood", section: "unknown", value: "private text", origin: "prompt", confidence: "parsed" },
        { field: "undeclared", section: "preference", value: "x", origin: "prompt", confidence: "parsed" },
      ],
    };
    const cleaned = sanitizeProjectProducerBrief(raw);
    expect(cleaned).toBeDefined();
    expect(cleaned).not.toHaveProperty("rawPrompt");
    expect(cleaned).not.toHaveProperty("audioBase64");
    expect(cleaned?.facts.filter((fact) => fact.field === "key")).toHaveLength(1);
    expect(cleaned?.facts).toHaveLength(8);
  });

  it("uses saved fields as defaults but flags a current prompt that conflicts with protected roles", () => {
    const parsed: ParsedIntent = {
      input: { bpmRange: [120, 120], roles: ["bass"] },
      detected: ["BPM 120", "add bass"],
      prohibitedRoles: [],
      conflicts: [],
    };
    const brief = savedBrief();
    const inherited = projectBriefCorrectionsFor(parsed, brief);
    expect(inherited).toMatchObject({ genre: "trap", style: "dark", preserve: ["bass"] });
    expect(inherited).not.toHaveProperty("bpmRange");
    expect(inherited).not.toHaveProperty("roles");

    expect(projectBriefConflictsFor(parsed, brief)).toEqual([
      { id: "project-brief-preserve-vs-addition-bass", role: "bass", kind: "preserve-vs-addition" },
    ]);
    const compiled = compileBriefContract(parsed, { projectBrief: brief });
    expect(compiled.conflicts).toHaveLength(1);
    expect(compiled.statements.find((statement) => statement.id === "preserve-bass")).toMatchObject({
      origin: "project",
      confidence: "confirmed",
    });
  });

  it("merges new explicit facts over the project memory without losing untouched facts", () => {
    const previous = savedBrief();
    const replacement = createProjectBriefFromContract(
      {
        conflicts: [],
        statements: [
          {
            id: "mood",
            section: "preference",
            label: "mood: confident",
            origin: "prompt",
            confidence: "parsed",
            patch: null,
          },
        ],
      },
      { mood: "confident" },
      "2026-10-02T11:00:00.000Z",
    );
    expect(replacement).not.toBeNull();
    const merged = mergeProjectProducerBrief(previous, replacement!, "2026-10-02T12:00:00.000Z");
    expect(merged.savedAt).toBe("2026-10-02T12:00:00.000Z");
    expect(merged.facts.find((fact) => fact.field === "bpmRange")).toMatchObject({ value: [140, 140] });
    expect(merged.facts.find((fact) => fact.field === "mood")).toMatchObject({ value: "confident" });
  });

  it("round-trips through the project schema and upgrades schema v9 without inventing a brief", () => {
    const doc = createProjectFromTemplate("house");
    expect(SCHEMA_VERSION).toBe(10);
    const v9 = { ...doc, schemaVersion: 9 };
    const upgraded = migrateProject(v9);
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(upgraded).not.toHaveProperty("producerBrief");

    const withBrief = migrateProject({ ...v9, producerBrief: savedBrief() });
    expect(withBrief.producerBrief).toEqual(savedBrief());
    expect(JSON.parse(JSON.stringify(withBrief)).producerBrief).toEqual(savedBrief());

    const malformed = normalizeProject({
      ...withBrief,
      producerBrief: { version: 1, facts: [{ prompt: "bad" }] } as never,
    });
    expect(malformed).not.toHaveProperty("producerBrief");
  });

  it("persists the approved brief through IndexedDB and removes it on explicit clear", async () => {
    const repo = new ProjectRepository();
    const doc = createProjectFromTemplate("house");
    const withBrief = saveProjectProducerBriefCommand(doc, savedBrief()).execute(doc);

    await repo.save(withBrief);
    const reopened = await repo.load(doc.id);
    expect(reopened?.producerBrief).toEqual(savedBrief());

    const cleared = clearProjectProducerBriefCommand(reopened!).execute(reopened!);
    await repo.save(cleared);
    const reopenedCleared = await repo.load(doc.id);
    expect(reopenedCleared).not.toHaveProperty("producerBrief");
  });

  it("saves and clears through one undoable command each", () => {
    const doc = createProjectFromTemplate("house");
    const save = saveProjectProducerBriefCommand(doc, savedBrief());
    const saved = save.execute(doc);
    expect(saved.producerBrief).toEqual(savedBrief());
    expect(save.undo(saved)).toEqual(doc);
    expect(save.execute(doc)).toEqual(saved);

    const clear = clearProjectProducerBriefCommand(saved);
    const cleared = clear.execute(saved);
    expect(cleared).not.toHaveProperty("producerBrief");
    expect(clear.undo(cleared)).toEqual(saved);
  });

  it("forgets one field with undo and removes the memory container when the last fact is removed", () => {
    const doc = createProjectFromTemplate("house");
    const saved = saveProjectProducerBriefCommand(doc, savedBrief()).execute(doc);
    const forgetMood = removeProjectProducerBriefFactCommand(saved, "mood");
    const withoutMood = forgetMood.execute(saved);
    expect(withoutMood.producerBrief?.facts.some((fact) => fact.field === "mood")).toBe(false);
    expect(withoutMood.producerBrief?.facts.some((fact) => fact.field === "bpmRange")).toBe(true);
    expect(forgetMood.undo(withoutMood)).toEqual(saved);

    const oneFact: ProjectProducerBriefV1 = {
      version: 1,
      savedAt: "2026-10-02T10:00:00.000Z",
      facts: [{ field: "mood", section: "preference", value: "dark", origin: "user", confidence: "confirmed" }],
    };
    const onlyMood = { ...doc, producerBrief: oneFact };
    expect(removeProjectProducerBriefFactCommand(onlyMood, "mood").execute(onlyMood)).not.toHaveProperty(
      "producerBrief",
    );
  });
});
