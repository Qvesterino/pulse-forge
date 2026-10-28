/** A read-only, versioned description of a proposal; it does not execute commands. */
export interface MusicalProposalV1 {
  schema: "kyx.musical-proposal";
  version: 1;
  id: string;
  base: { projectId: string; revision: number | null; freshness: "current" | "stale" | "unknown" };
  scope: {
    /** Listening and measurement range, not a restriction on writes. */
    audition: { startTick: number; endTick: number } | null;
    writeScope: "unrestricted";
    targetTrackIds: string[];
  };
  intent: { label: string; goals: string[]; interpreter: string };
  constraints: { status: "not_declared"; items: [] };
  candidates: Array<{
    id: string;
    changes: Array<{
      trackId: string;
      device: string;
      parameterChanges: Array<{ param: string; before: number | null; after: number }>;
      description: string;
      reason: string;
    }>;
  }>;
  evidence: Array<{
    id: string;
    kind: "measurement";
    source: "mix_preview_render";
    metric: "integrated_lufs";
    value: number | null;
    uncertainty: string;
  }>;
  checks: { structural: "not_checked"; acoustic: "preview_measured" | "unavailable"; subjective: "not_judged" };
  warnings: string[];
}
