import type { Command } from "./types";
import { snapshot } from "./core";
import { sanitizeProjectProducerBrief } from "../project-model/producer-brief";
import type { ProjectDocument, ProjectProducerBriefFact, ProjectProducerBriefV1 } from "../project-model/types";

/** Explicit user action: attach approved structured creative context to this project. */
export function saveProjectProducerBriefCommand(doc: ProjectDocument, brief: ProjectProducerBriefV1): Command {
  const cleaned = sanitizeProjectProducerBrief(brief);
  if (!cleaned) throw new Error("Cannot save an empty or invalid Producer Brief.");
  return snapshot("saveProjectProducerBrief", "Save Producer Brief to project", doc, {
    ...doc,
    producerBrief: cleaned,
  });
}

/** Explicit user action: remove the project-local brief; undo restores it. */
export function clearProjectProducerBriefCommand(doc: ProjectDocument): Command {
  const next = { ...doc };
  delete next.producerBrief;
  return snapshot("clearProjectProducerBrief", "Clear project Producer Brief", doc, next);
}

/** Explicitly forget one project-local brief field; undo restores the fact. */
export function removeProjectProducerBriefFactCommand(
  doc: ProjectDocument,
  field: ProjectProducerBriefFact["field"],
): Command {
  if (!doc.producerBrief) throw new Error("This project has no saved Producer Brief.");
  const facts = doc.producerBrief.facts.filter((fact) => fact.field !== field);
  const next: ProjectDocument = { ...doc };
  if (facts.length === 0) {
    delete next.producerBrief;
  } else {
    next.producerBrief = { ...doc.producerBrief, savedAt: new Date().toISOString(), facts };
  }
  return snapshot("removeProjectProducerBriefFact", `Forget project brief: ${field}`, doc, next);
}
