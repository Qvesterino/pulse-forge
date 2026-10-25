import type { Services } from "../services";

/**
 * Force the app's autosave pipeline to flush. The store owns the status;
 * `flushSave()` resolves after the repository transaction (or the queued
 * follow-up) finishes, so the returned status is the durable observation, not
 * an optimistic acknowledgement.
 */
export async function flushServicesSave(services: Pick<Services, "flushSave" | "store">): Promise<{
  ok: boolean;
  saveStatus: "saved" | "dirty" | "saving" | "syncing" | "error";
  lastSavedAt: string | null;
  error?: string;
}> {
  try {
    await services.flushSave();
    const saveStatus = services.store.getSaveStatus();
    return {
      ok: saveStatus !== "error",
      saveStatus,
      lastSavedAt: services.store.getLastSavedAt(),
      ...(saveStatus === "error" ? { error: "the repository reported a save error" } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      saveStatus: "error",
      lastSavedAt: services.store.getLastSavedAt(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SavedProjectSummary {
  id: string;
  name: string;
  bpm: number;
  trackCount: number;
  updatedAt: string;
}

/** Read-only project library discovery. No switch, no open. */
export async function listSavedProjects(services: Pick<Services, "repo">): Promise<SavedProjectSummary[]> {
  const projects = await services.repo.listAll();
  return projects.map(({ id, name, bpm, trackCount, updatedAt }) => ({ id, name, bpm, trackCount, updatedAt }));
}

/**
 * Save-As as a COPY: the current project stays open. Switching the open
 * document is a services-level lifecycle step owned by the app shell, not an
 * MCP tool; a copy is the safe, durable equivalent an agent can request.
 *
 * The current document is flushed first, then `duplicate` clones the stored
 * record under a new id, and `rename` gives the copy its requested name
 * without moving the "most recent" pointer away from the original.
 */
export async function saveProjectAsCopy(
  services: Pick<Services, "flushSave" | "store" | "repo" | "collab">,
  name: string,
): Promise<{ ok: boolean; projectId?: string; name?: string; lastSavedAt?: string | null; error?: string }> {
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, error: "a non-empty project name is required" };
  if (services.collab != null) {
    return { ok: false, error: "save-as is unavailable while a collaboration session is active" };
  }
  try {
    await services.flushSave();
    const current = services.store.getDoc();
    const copy = await services.repo.duplicate(current.id);
    if (copy == null) return { ok: false, error: "the current project could not be duplicated" };
    const renamed = await services.repo.rename(copy.id, trimmed);
    return {
      ok: true,
      projectId: copy.id,
      name: renamed?.name ?? trimmed,
      lastSavedAt: services.store.getLastSavedAt(),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
