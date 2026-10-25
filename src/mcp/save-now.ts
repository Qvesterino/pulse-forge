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
