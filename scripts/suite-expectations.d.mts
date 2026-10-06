export declare class ExpectationsError extends Error {}

export interface ParsedReport {
  files: number;
  passed: number;
  failed: number;
  skipped: number;
  failedIds: string[];
}

export interface LedgerEntry {
  id: string;
  owner: string;
  reason: string;
  addedAt?: string;
  /** Flaky entries are exempt from both ratchet directions (Chromium semantics). */
  flaky?: boolean;
  evidence?: string;
}

export interface Ledger {
  version: number;
  recordedAgainst: string;
  date: string;
  note: string;
  expectations: LedgerEntry[];
}

export interface DiffResult {
  newReds: string[];
  cured: string[];
  flakyRed: string[];
}

export declare const REPO_ROOT: string;
export declare const DEFAULT_REPORT: string;
export declare const DEFAULT_LEDGER: string;

export declare function normalizeFilePath(rawPath: string, root?: string): string;
export declare function parseVitestJsonReport(rawJson: string, root?: string): ParsedReport;
export declare function diffExpectations(failedIds: readonly string[], entries: readonly LedgerEntry[]): DiffResult;
export declare function ledgerViolations(entries: readonly LedgerEntry[]): string[];
export declare function regenerateLedger(
  existingEntries: readonly LedgerEntry[],
  failedIds: readonly string[],
  meta: { recordedAgainst: string; date: string },
): Ledger;
