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

/**
 * Import a ProjectDocument from a File or string.
 * Validates shape, migrates schema, and normalizes.
 * Returns the cleaned document or throws with a descriptive error.
 */
export function importProject(input: File | string): Promise<ProjectDocument> {
  return new Promise((resolve, reject) => {
    if (input instanceof File) {
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
