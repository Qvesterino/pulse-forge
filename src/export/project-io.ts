import type { ProjectDocument } from "../project-model/types";
import { validateProjectShape, migrateProject } from "../project-model/schema";

/**
 * Export a ProjectDocument as a downloadable JSON file.
 * Uses the same Blob → ObjectURL → <a>.click() pattern as downloadWav.
 */
export function exportProject(doc: ProjectDocument): void {
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sanitizeFilename(doc.name)}.pulseforge.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Import size ceiling (release roadmap 1.4): a project file becomes a JS
// string + parsed object (2–3× the byte size) before validation can reject
// it. Legit projects sit far below this — a hostile/accidental multi-hundred-
// MB file must fail FAST with a clear message instead of stalling/OOM-ing
// the tab.
export const MAX_PROJECT_IMPORT_BYTES = 10 * 1024 * 1024;

/**
 * Import a ProjectDocument from a File or string.
 * Validates shape, migrates schema, and normalizes.
 * Returns the cleaned document or throws with a descriptive error.
 */
export function importProject(input: File | string): Promise<ProjectDocument> {
  return new Promise((resolve, reject) => {
    if (input instanceof File) {
      if (input.size > MAX_PROJECT_IMPORT_BYTES) {
        reject(
          new Error(
            `Project file is too large (${(input.size / 1024 / 1024).toFixed(1)} MB — limit ${(
              MAX_PROJECT_IMPORT_BYTES /
              1024 /
              1024
            ).toFixed(0)} MB)`,
          ),
        );
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const doc = parseAndValidate(reader.result as string);
          resolve(doc);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsText(input);
    } else {
      try {
        const doc = parseAndValidate(input);
        resolve(doc);
      } catch (err) {
        reject(err);
      }
    }
  });
}

function parseAndValidate(json: string): ProjectDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON — not a valid project file");
  }

  if (!validateProjectShape(raw)) {
    throw new Error("Invalid project structure — file does not match PulseForge format");
  }

  try {
    return migrateProject(raw);
  } catch (err) {
    throw new Error(`Project migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "project"
  );
}
