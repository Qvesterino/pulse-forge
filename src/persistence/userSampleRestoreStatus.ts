import type { SampleBank } from "../sample-library/factory";
import {
  retryUserSampleRestore,
  type UserSampleRestoreFailure,
  type UserSampleRestoreReport,
} from "./UserSampleRepository";

/**
 * The state of the boot-time restore of the user's own audio.
 *
 * Audit S-3: the restore was fire-and-forget AND silent. A sample that could
 * not be decoded was logged and skipped, so the recorded take that used it
 * was PERMANENTLY SILENT — and the user had no way to learn that the app had
 * thrown their audio away, because nothing was ever reported.
 *
 * This module is the one owner of that truth. The restore publishes here, the
 * UI reads it, and the retry updates it — so the studio chip and the project
 * browser banner cannot disagree about whether the user's audio came back.
 */
export type UserSampleRestoreState = "idle" | "restoring" | "ready";

export interface UserSampleRestoreStatus {
  state: UserSampleRestoreState;
  /** The samples that came back whole. */
  restored: string[];
  /** The samples that did not — the failure, named and counted. */
  failed: UserSampleRestoreFailure[];
}

const EMPTY: UserSampleRestoreStatus = { state: "idle", restored: [], failed: [] };

let status: UserSampleRestoreStatus = EMPTY;
const listeners = new Set<() => void>();

export function getUserSampleRestoreStatus(): UserSampleRestoreStatus {
  return status;
}

export function subscribeUserSampleRestoreStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish the outcome. The restore is the only writer. */
export function publishUserSampleRestoreStatus(next: UserSampleRestoreStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

/** Fold a restore report into the published status. */
export function publishUserSampleRestoreReport(report: UserSampleRestoreReport): void {
  publishUserSampleRestoreStatus({ state: "ready", restored: report.restored, failed: report.failed });
}

/**
 * Re-try the samples that did not come back.
 *
 * The BYTES ARE STILL THERE. A failed decode can be transient — the decoder
 * was not ready, the tab was under memory pressure, a chunk was damaged — and
 * the staged PCM blocks are only skipped past, never deleted. So a failure is
 * not the end of the story: the user gets a button, and the retry reports
 * what came back.
 */
export async function retryFailedUserSampleRestore(bank: SampleBank, ids: string[]): Promise<UserSampleRestoreStatus> {
  publishUserSampleRestoreStatus({ ...status, state: "restoring" });
  const report = await retryUserSampleRestore(bank, ids);
  const stillFailing = status.failed.filter((failure) => !report.restored.includes(failure.id));
  const merged: UserSampleRestoreStatus = {
    state: "ready",
    restored: [...status.restored.filter((id) => !ids.includes(id)), ...report.restored],
    failed: [...stillFailing, ...report.failed],
  };
  publishUserSampleRestoreStatus(merged);
  return merged;
}
