import type { RenderSummaryData } from "./render-summary";
import type { MusicalContextSnapshotV1, MusicalEvidence } from "../analysis/musical-context";

function renderEvidenceValue(summary: RenderSummaryData): unknown {
  const census = summary.arrangementCensus;
  const risk = summary.kickBassRisk;
  return {
    scope: summary.scope,
    signalStage: summary.range?.signalStage ?? null,
    range: summary.range ?? null,
    stripCoverage: summary.stripCoverage ?? null,
    master: summary.master,
    strips: summary.strips.slice(0, 32),
    arrangementCensus: census
      ? {
          analyzer: census.analyzer,
          projectRevision: census.projectRevision,
          window: census.window,
          counts: census.counts,
          energy: census.energy,
          clips: census.clips.slice(0, 64),
          truncated: census.truncated || census.clips.length > 64,
          caveats: census.caveats,
        }
      : null,
    kickBassRisk: risk
      ? {
          status: risk.status,
          reason: risk.reason ?? null,
          algorithm: risk.algorithm,
          window: risk.window,
          pair: risk.pair ?? null,
          measurement: risk.measurement,
          summary: risk.summary,
          events: risk.events.slice(0, 32),
          omittedEvents: Math.max(0, risk.events.length - 32),
          caveats: risk.caveats,
        }
      : null,
  };
}

function renderMeasurement(summary: RenderSummaryData, freshness: "current" | "unknown"): MusicalEvidence {
  return {
    id: "analysis.render-summary",
    kind: "measurement",
    claim: "Fresh render measurements for the requested timeline range",
    value: renderEvidenceValue(summary),
    provenance: {
      source: "kyx_render_summary",
      tool: "kyx_render_summary",
      path: "range/master/strips/arrangementCensus",
    },
    confidence: null,
    uncertainty:
      freshness === "unknown"
        ? "The transport has no comparable revision token; measurements are current to their render call but cannot be proven to match the captured project revision."
        : "Numeric render measures do not establish subjective musical quality.",
    invalidatedBy: ["project_revision", "source_audio", "render_chain", "tempo_map"],
  };
}

export function attachMusicalContextRenderEvidence(
  snapshot: MusicalContextSnapshotV1,
  summary: RenderSummaryData,
  currentProjectId: string,
  currentRevision: number | null,
): MusicalContextSnapshotV1 {
  const expectedWindow = { startTick: snapshot.scope.startTick, endTick: snapshot.scope.endTick };
  const actualWindow = summary.range?.window;
  const windowMatches =
    actualWindow?.startTick === expectedWindow.startTick && actualWindow.endTick === expectedWindow.endTick;
  const revisionConflict =
    snapshot.project.revision !== null &&
    (summary.range?.projectRevision !== snapshot.project.revision ||
      summary.range?.revisionAfterRender !== snapshot.project.revision ||
      currentRevision !== snapshot.project.revision);
  if (
    currentProjectId !== snapshot.project.id ||
    !windowMatches ||
    summary.range?.freshness === "stale" ||
    revisionConflict
  ) {
    return {
      ...snapshot,
      freshness: "stale",
      analysis: {
        status: "stale",
        requestedScope: snapshot.analysis.requestedScope,
        measuredScope: summary.scope,
        reason:
          "Project, range, or revision changed during analysis. Discard these measurements and read the current project again.",
      },
      limitations: [
        ...snapshot.limitations,
        "Render measurements were discarded because they do not match the captured project and range.",
      ],
    };
  }

  const freshness =
    snapshot.project.revision !== null && currentRevision === snapshot.project.revision ? "current" : "unknown";
  const measure = renderMeasurement(summary, freshness);
  const risk = summary.kickBassRisk;
  const estimate: MusicalEvidence | null = risk
    ? {
        id: "analysis.kick-bass-risk",
        kind: "estimate",
        claim: "Onset-aligned low-band kick/bass collision risk estimate",
        value: {
          status: risk.status,
          reason: risk.reason ?? null,
          algorithm: risk.algorithm,
          window: risk.window,
          pair: risk.pair ?? null,
          measurement: risk.measurement,
          summary: risk.summary,
          events: risk.events.slice(0, 32),
          omittedEvents: Math.max(0, risk.events.length - 32),
          caveats: risk.caveats,
        },
        provenance: { source: "kyx_render_summary", tool: risk.algorithm.name, path: "kickBassRisk" },
        confidence: null,
        uncertainty:
          "A risk candidate is a signal heuristic, not confirmation of audible masking; listen to a level-matched A/B.",
        invalidatedBy: ["project_revision", "source_audio", "render_chain", "tempo_map"],
      }
    : null;
  return {
    ...snapshot,
    freshness,
    evidence: [...snapshot.evidence, measure, ...(estimate ? [estimate] : [])],
    analysis: { status: "measured", requestedScope: snapshot.analysis.requestedScope, measuredScope: summary.scope },
    limitations:
      freshness === "unknown"
        ? [
            ...snapshot.limitations,
            "Render evidence freshness is unknown because this transport has no project revision token.",
          ]
        : snapshot.limitations,
  };
}
