/**
 * Project-level metadata: the key and the tag list the exporters and the scorepack read.
 */
import type { Command } from "./types";
import type { MusicalKey, ProjectDocument } from "../project-model/types";
import { snapshot } from "./core";

/* ---------------- metadata & scorepack ---------------- */ export function setProjectKey(
  doc: ProjectDocument,
  key: MusicalKey | null,
): Command {
  const next: ProjectDocument = key
    ? { ...doc, key }
    : (() => {
        const { key: _drop, ...rest } = doc;
        return rest as ProjectDocument;
      })();
  // Delta snapshot — see setStepsLocks for why whole-doc pins are forbidden.
  return snapshot("setProjectKey", key ? `Set project key to ${key}` : "Clear project key", doc, next);
}
export function setProjectTags(doc: ProjectDocument, tags: string[]): Command {
  const prev = doc.tags;
  const cleaned = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  return {
    type: "setProjectTags",
    label: "Edit project tags",
    execute: (d) => ({ ...d, tags: cleaned }),
    undo: (d) =>
      prev
        ? { ...d, tags: prev }
        : (() => {
            const { tags: _drop, ...rest } = d;
            return rest as ProjectDocument;
          })(),
  };
}
