import type { RenderSummaryData } from "./render-summary";
import type { MusicalContextSnapshotV1, MusicalEvidence } from "../analysis/musical-context";

function renderMeasurementsValue(summary: RenderSummaryData): unknown {
  return {
    scope: summary.scope,
    signalStage: summary.range?.signalStage ?? null,
    range: summary.range ?? null,
    stripCoverage: summary.stripCoverage ?? null,
    master: summary.master,
    strips: summary.strips.slice(0, 32),
  };
}

function renderMeasurement(summary: RenderSummaryData, freshness: "current" | "unknown"): MusicalEvidence {
  return {
    id: "analysis.render-summary",
    kind: "measurement",
    claim: "Fresh master and per-strip audio measurements for the requested timeline range",
    value: renderMeasurementsValue(summary),
    provenance: {
      source: "kyx_render_summary",
      tool: "kyx_render_summary",
      path: "range/master/strips",
    },
    confidence: null,
    uncertainty:
      freshness === "unknown"
        ? "The transport has no comparable revision token; measurements are current to their render call but cannot be proven to match the captured project revision."
        : "Numeric render measures do not establish subjective musical quality or arrangement intent.",
    invalidatedBy: ["project_revision", "source_audio", "render_chain", "tempo_map"],
  };
}

function arrangementCensusEvidence(summary: RenderSummaryData): MusicalEvidence | null {
  const census = summary.arrangementCensus;
  if (!census) return null;
  return {
    id: "analysis.arrangement-census",
    kind: "measurement",
    claim: "Bounded arrangement counts and per-clip energy for the requested range",
    value: {
      analyzer: census.analyzer,
      projectRevision: census.projectRevision,
      window: census.window,
      counts: census.counts,
      energy: census.energy,
      clips: census.clips.slice(0, 64),
      truncated: census.truncated || census.clips.length > 64,
      caveats: census.caveats,
    },
    provenance: { source: "kyx_render_summary", tool: "kyx_render_summary", path: "arrangementCensus" },
    confidence: null,
    uncertainty:
      census.caveats.length > 0
        ? census.caveats.join(" ")
        : "Structural counts and energy are not music-role recognition; do not name a drop or chorus unless the project labels it.",
    invalidatedBy: ["project_revision", "source_audio", "tempo_map"],
  };
}

function kickBassRiskEvidence(summary: RenderSummaryData): MusicalEvidence | null {
  const risk = summary.kickBassRisk;
  if (!risk) return null;
  return {
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
  };
}

function mixVerificationEvidence(
  snapshot: MusicalContextSnapshotV1,
  summary: RenderSummaryData,
): MusicalEvidence | null {
  const receipt = summary.mixVerification;
  if (
    !receipt ||
    receipt.status !== "measured" ||
    receipt.freshness !== "current" ||
    receipt.projectId !== snapshot.project.id ||
    snapshot.project.revision === null ||
    receipt.revisionAfterRender !== snapshot.project.revision ||
    receipt.appliedRevision !== snapshot.project.revision ||
    receipt.window?.startTick !== snapshot.scope.startTick ||
    receipt.window.endTick !== snapshot.scope.endTick
  ) {
    return null;
  }
  return {
    id: "analysis.mix-verification",
    kind: "measurement",
    claim: "Fresh post-apply loudness measurement compared with the preview for this project range",
    value: structuredClone(receipt),
    provenance: { source: "kyx_render_summary", tool: "kyx_render_summary", path: "mixVerification" },
    confidence: null,
    uncertainty:
      "LUFS measures loudness only. Structural agreement and loudness changes do not establish that the requested musical goal was achieved; use a human level-matched A/B verdict.",
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
  const measurements = renderMeasurement(summary, freshness);
  const census = arrangementCensusEvidence(summary);
  const risk = kickBassRiskEvidence(summary);
  const verification = mixVerificationEvidence(snapshot, summary);
  return {
    ...snapshot,
    freshness: freshness === "current" ? "current_at_capture" : "unknown",
    evidence: [
      ...snapshot.evidence,
      measurements,
      ...(census ? [census] : []),
      ...(risk ? [risk] : []),
      ...(verification ? [verification] : []),
    ],
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
