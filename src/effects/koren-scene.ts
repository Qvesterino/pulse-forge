/**
 * GROW (bassHarmonic) scene state — the deviceState payload the SCENE PACK
 * command writes and the panel reads back.
 *
 * Deliberately a tiny module: the command barrel imports this for the kind
 * literal, while the pack DATA lives in koren-scene-pack.ts (lazy panel
 * chunk). Keeping the two apart means the eager command graph never carries
 * the nine pairs.
 */

export const KOREN_SCENE_KIND = "koren-scene-v1";

export interface KorenSceneState {
  /** Raw A/B param maps (the pair that was applied; CUSTOM otherwise). */
  slots: { A?: Record<string, number>; B?: Record<string, number> };
}

/** Read the sanitized deviceState blob into the panel's scene model. */
export function readKorenSceneState(
  deviceState?: { kind: string; data: Record<string, unknown> } | null,
): KorenSceneState | undefined {
  if (!deviceState || deviceState.kind !== KOREN_SCENE_KIND) return undefined;
  const raw = deviceState.data.slots;
  if (typeof raw !== "object" || raw === null) return undefined;
  const slots: KorenSceneState["slots"] = {};
  for (const slot of ["A", "B"] as const) {
    const value = (raw as Record<string, unknown>)[slot];
    if (typeof value === "object" && value !== null) {
      slots[slot] = value as Record<string, number>;
    }
  }
  return { slots };
}
