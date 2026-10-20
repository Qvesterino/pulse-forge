/** One effect's exemption trail, as separated from the unexplained zero. */
export interface HostExemptEntry {
  type: string;
  reason: string;
  /** Whether the effect moved the output anyway once it was engaged. */
  hostProcesses: boolean;
}

export interface AuditGateStats {
  effects: number;
  instruments: number;
  interactions: boolean;
  deadParameters: number;
  deadByEffect: { type: string; dead: number }[];
  /** Parameters that are inert only while a sibling switch is off. */
  gatedParameters: number;
  gatedByEffect: { type: string; gated: number }[];
  /** Effects with a zero host delta and NO documented reason. */
  notProcessing: string[];
  /** Effects whose zero host delta is the correct, documented outcome. */
  hostExempt: HostExemptEntry[];
  silentInstruments: string[];
}

export interface AuditGateResult {
  ok: boolean;
  failures: string[];
  stats: AuditGateStats;
}

export declare const HARNESS_SOURCES: string[];
export declare function computeHarnessHash(root: string): string;
export declare function evaluateAuditGate(report: unknown): AuditGateResult;
