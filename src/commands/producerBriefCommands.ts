import type { Command } from "./types";
import { snapshot } from "./commands";
import { sanitizeProjectProducerBrief } from "../project-model/producer-brief";
import type { ProjectDocument, ProjectProducerBriefV1 } from "../project-model/types";

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
