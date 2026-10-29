/**
 * The last audible-verification comparison, published for the studio shell.
 *
 * The MCP verification tool already renders before/after PCM; this store is
 * the human-facing receipt: the TopBar badge can say "AUDIBLE ✓ −1.8 dB @
 * 2.4 kHz" without the user reading the agent's transcript. It is keyed by
 * document revision, so an edit after the comparison hides the badge instead
 * of showing a stale claim.
 */
export interface AudibleVerificationNotice {
  docId: string;
  revision: number | null;
  scopeLabel: string;
  audibleChanged: boolean;
  verified: boolean;
  lufsDelta: number | null;
  nullResidualDb: number | null;
  dominantBand: { band: "low" | "mid" | "high"; centerHz: number; deltaDb: number } | null;
  at: number;
}

let notice: AudibleVerificationNotice | null = null;
const listeners = new Set<() => void>();

export function publishAudibleVerification(next: AudibleVerificationNotice): void {
  notice = next;
  for (const listener of listeners) listener();
}

export function clearAudibleVerification(): void {
  notice = null;
  for (const listener of listeners) listener();
}

export function getAudibleVerification(): AudibleVerificationNotice | null {
  return notice;
}

export function subscribeAudibleVerification(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
