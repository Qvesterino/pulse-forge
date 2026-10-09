import { memo, useCallback, useMemo, useState } from "react";
import { MASTER_EFFECT_OWNER_ID, type GroupTrack } from "../project-model/types";
import { MasterMeter } from "./MasterMeter";
import { ExportPanel, type MasteringWorkspaceState } from "./ExportPanel";
import { useDoc, useMaster } from "./context";
import { EffectRack } from "./EffectRack";
import { projectRevisionIdFor } from "../mastering/report";
import { isMasterProfileSourceReviewDue, MASTER_PROFILE_SOURCES, resolveDeliveryTarget } from "../mastering/profiles";
import { MasteringABCompare } from "./MasteringABCompare";
import { MasteringSignalFlow } from "./MasteringSignalFlow";
import { MasterProcessingControls } from "./MasterProcessingControls";
import { MasteringLoudnessTimeline } from "./MasteringLoudnessTimeline";
import { MAX_OFFLINE_RENDER_PCM_BYTES } from "../rendering/renderer";
import { MasteringFileSessionPanel } from "./MasteringFileSessionPanel";
import { MasterProfileFileGuidance } from "./MasterProfileFileGuidance";
import { MASTERING_RENDER_SAMPLE_RATE_LABELS, MASTERING_RENDER_SAMPLE_RATES } from "../mastering/sampleRates";

const StableMasterMeter = memo(MasterMeter);
const StableEffectRack = memo(EffectRack);

/** Dedicated final-output workspace: delivery checks above the final-sum inserts. */
export function MasteringPanel() {
  const doc = useDoc();
  const revisionId = projectRevisionIdFor(doc);
  const master = useMaster();
  const profile = resolveDeliveryTarget(master);
  const profileSource = MASTER_PROFILE_SOURCES[profile.id];
  const profileSourceReviewDue = profileSource ? isMasterProfileSourceReviewDue(profileSource) : false;
  const [workspaceState, setWorkspaceState] = useState<MasteringWorkspaceState | null>(null);
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [fileSessionBusy, setFileSessionBusy] = useState(false);
  const [controlView, setControlView] = useState<"simple" | "advanced">("simple");
  const renderPcmLimitMiB = MAX_OFFLINE_RENDER_PCM_BYTES / (1024 * 1024);
  const handleWorkspaceStateChange = useCallback((state: MasteringWorkspaceState) => {
    setWorkspaceState(state);
  }, []);
  const showAdvancedControls = useCallback(() => setControlView("advanced"), []);
  const report = workspaceState?.report ?? null;
  const renderDegradationCount = report
    ? report.renderDiagnostics.degradedEffects.length + report.renderDiagnostics.degradedMasterStages.length
    : 0;
  const reportIsStale = workspaceState?.reportStale ?? false;
  const isAnalyzing = workspaceState?.busy ?? false;
  const decodedDelivery = report?.encodedDelivery?.decode.status === "measured" ? report.encodedDelivery.decode : null;
  const overviewMeasurements = decodedDelivery?.measurements ?? report?.measurements ?? null;
  const overviewMixHealth = decodedDelivery?.mixHealth ?? report?.mixHealth ?? null;
  const overviewVerdict = decodedDelivery?.verdict ?? report?.verdict ?? null;
  const loudnessRangeLu = overviewMeasurements?.loudnessRangeLu ?? null;
  const loudnessTimeline = decodedDelivery
    ? (decodedDelivery.loudnessTimeline ?? null)
    : (report?.loudnessTimeline ?? null);
  const finalFileNotMeasured = Boolean(report?.encodedDelivery && !decodedDelivery);
  const reportTap = report
    ? `${report.measurementTap.id.toUpperCase()} · ${report.measurementTap.position.toUpperCase()} · ${report.measurementTap.fileStage.toUpperCase()}`
    : null;
  const measurementSource = decodedDelivery
    ? "FINAL FILE · POST-DECODE"
    : finalFileNotMeasured
      ? `SOURCE PCM · ${reportTap} · FINAL FILE AUDIO NOT MEASURED`
      : `SOURCE PCM · ${reportTap ?? "PRE-ENCODE"}`;
  const reportStatus = isAnalyzing
    ? { label: "ANALYZING", state: "busy" }
    : reportIsStale
      ? { label: "STALE · ANALYZE AGAIN", state: "stale" }
      : report
        ? finalFileNotMeasured
          ? { label: "FINAL FILE AUDIO NOT MEASURED", state: "warn" }
          : overviewVerdict?.level === "ok"
            ? { label: `${decodedDelivery ? "FINAL FILE" : "SOURCE PCM"} · WITHIN PROFILE TARGETS`, state: "ok" }
            : overviewVerdict?.level === "warn"
              ? { label: `${decodedDelivery ? "FINAL FILE" : "SOURCE PCM"} · REVIEW RECOMMENDED`, state: "warn" }
              : overviewVerdict?.level === "bad"
                ? { label: `${decodedDelivery ? "FINAL FILE" : "SOURCE PCM"} · NEEDS ATTENTION`, state: "bad" }
                : { label: `${decodedDelivery ? "FINAL FILE" : "SOURCE PCM"} · INCOMPLETE`, state: "idle" }
        : workspaceState?.statusKind === "error"
          ? { label: "ANALYSIS ERROR", state: "bad" }
          : workspaceState?.statusKind === "cancelled"
            ? { label: "ANALYSIS CANCELLED", state: "idle" }
            : { label: "NOT ANALYZED", state: "idle" };
  const loudnessMeasured = Boolean(overviewMeasurements && overviewMeasurements.lufsIntegrated > -119);
  const measurementDurationSeconds = decodedDelivery?.durationSeconds ?? report?.durationSeconds ?? null;
  const loudnessRangeUnavailableReason =
    measurementDurationSeconds != null && measurementDurationSeconds < 3
      ? "Needs a programme of at least 3 s"
      : !loudnessMeasured
        ? "No measurable signal"
        : "No 3 s windows passed the EBU gates";
  const loudnessDelta = overviewVerdict?.loudnessDeltaDb ?? null;
  const truePeakMargin =
    overviewMeasurements && report ? report.profile.maxTruePeakDb - overviewMeasurements.truePeakDb : null;
  const stereoFindings = overviewVerdict?.checks.filter((check) =>
    /phase|mono fold-down|L\/R balance/i.test(check.line),
  );
  const hasPhaseIssue = stereoFindings?.some(
    (check) => check.line.startsWith("Phase issues") && check.status === "fail",
  );
  const hasMonoWarning = stereoFindings?.some(
    (check) => check.line.startsWith("Mono fold-down") && check.status !== "pass",
  );
  const hasBalanceWarning = stereoFindings?.some(
    (check) => check.line.startsWith("Left/right balance") && check.status !== "pass",
  );
  const stereoLabel =
    !overviewMeasurements || overviewMeasurements.channelCount < 2
      ? "NOT MEASURED"
      : hasPhaseIssue
        ? "PHASE FLAG"
        : hasMonoWarning
          ? "MONO LOSS FLAG"
          : hasBalanceWarning
            ? "BALANCE FLAG"
            : "NO FLAG";
  const mixFindingCount = overviewMixHealth?.flags.length ?? null;
  const deliveryFindingCount =
    overviewVerdict?.checks.filter((check) => check.status === "warn" || check.status === "fail").length ?? null;
  const findingCount =
    mixFindingCount == null || deliveryFindingCount == null ? null : mixFindingCount + deliveryFindingCount;
  const findingsAreCurrent = Boolean(report && !reportIsStale && !isAnalyzing);
  const findingActionLabel = isAnalyzing
    ? "Mastering analysis is in progress"
    : reportIsStale
      ? "Mastering findings are stale; analyze again before reviewing them"
      : findingCount == null
        ? "Mastering findings are available after analysis"
        : findingCount === 0
          ? "No mastering findings to review"
          : `Jump to ${findingCount} current mastering finding${findingCount === 1 ? "" : "s"}`;
  const findingDetail = isAnalyzing
    ? "Wait for the current analysis to finish"
    : reportIsStale
      ? "Earlier analysis · analyze again before review"
      : findingCount == null
        ? "Run an offline analysis"
        : `${mixFindingCount} Mix Doctor · ${deliveryFindingCount} delivery flag${deliveryFindingCount === 1 ? "" : "s"}`;
  const focusReviewFindings = useCallback(() => {
    const target = document.getElementById("mastering-review-findings");
    if (!target) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }, []);
  const masterTrack = useMemo<GroupTrack>(
    () => ({
      id: MASTER_EFFECT_OWNER_ID,
      kind: "group",
      name: "MASTER",
      gain: master.masterGain ?? 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: master.effects ?? [],
      sends: {},
    }),
    [master.effects, master.masterGain],
  );

  return (
    <section className="mastering-panel" aria-label="Mastering workspace">
      <header className="mastering-panel-intro">
        <div>
          <span className="mastering-panel-kicker">FINAL OUTPUT</span>
          <h2>Mastering — {doc.name}</h2>
          <p>Check the full mix, review the real signal path, then shape the final stereo output.</p>
        </div>
        <p className="mastering-profile-note">
          {profile.intendedUse} {profile.note} Delivery profiles set measurement targets only; they do not change the
          sound or certify that a master meets every destination requirement.
          {profileSource && (
            <span className="mastering-profile-source" data-review-due={profileSourceReviewDue}>
              {" "}
              <a href={profileSource.url} target="_blank" rel="noopener noreferrer">
                {profileSource.label}
              </a>{" "}
              · checked {profileSource.checkedAt}.
              {profileSourceReviewDue && " Source review is due before relying on this target."}
            </span>
          )}
          <MasterProfileFileGuidance profile={profile} />
        </p>
        <p className="mastering-monitor-note" role="note">
          Master A/B and reference audition play through the active browser output. Open Studio I/O in the top bar to
          choose an output where supported and view browser-reported latency. KYX does not measure hardware round-trip
          latency or calibrate monitor response; check the result on a known monitor or headphone chain.
        </p>
      </header>
      <section className="mastering-overview" aria-label="Mastering analysis overview">
        <div className="mastering-overview-heading">
          <div>
            <span className="mastering-panel-kicker">MASTER CHECK</span>
            <h3>Analysis overview</h3>
          </div>
          <span className="mastering-overview-status" data-state={reportStatus.state}>
            {reportStatus.label}
          </span>
        </div>
        <div className="mastering-overview-context">
          <span>
            <strong>PROFILE</strong> {profile.label} · {profile.targetLufs} LUFS · {profile.maxTruePeakDb} dBTP
          </span>
          <label className="mastering-overview-scope">
            <strong>SCOPE</strong>
            <select
              aria-label="Analysis scope"
              disabled={!workspaceState || isAnalyzing}
              value={workspaceState?.mode ?? "song"}
              onChange={(event) => workspaceState?.setMode(event.target.value as "song" | "pattern")}
            >
              <option value="song">Full song</option>
              <option value="pattern">Active pattern</option>
            </select>
          </label>
          <label className="mastering-overview-select">
            <strong>RATE</strong>
            <select
              aria-label="Analysis sample rate"
              disabled={!workspaceState || isAnalyzing}
              value={workspaceState?.sampleRate ?? 44100}
              onChange={(event) => workspaceState?.setSampleRate(Number(event.target.value))}
            >
              {MASTERING_RENDER_SAMPLE_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {MASTERING_RENDER_SAMPLE_RATE_LABELS[rate]}
                </option>
              ))}
            </select>
          </label>
          <label className="mastering-overview-select">
            <strong>QUALITY</strong>
            <select
              aria-label="Analysis render quality"
              disabled={!workspaceState || isAnalyzing}
              value={workspaceState?.quality ?? "studio"}
              onChange={(event) => workspaceState?.setQuality(event.target.value as "live" | "studio")}
            >
              <option value="studio">Studio HQ</option>
              <option value="live">Live (faster)</option>
            </select>
          </label>
          {workspaceState && (
            <span
              className="mastering-overview-render-budget"
              data-state={workspaceState.renderPcmWithinBudget ? "ok" : "warn"}
              aria-label={
                workspaceState.renderPcmWithinBudget
                  ? `Estimated stereo PCM is within the ${renderPcmLimitMiB} mebibyte render limit`
                  : `Estimated stereo PCM is unavailable or exceeds the ${renderPcmLimitMiB} mebibyte render limit`
              }
            >
              <strong>RENDER PCM</strong>{" "}
              {Number.isFinite(workspaceState.renderPcmBytes) && workspaceState.renderPcmBytes > 0
                ? `${(workspaceState.renderPcmBytes / (1024 * 1024)).toFixed(1)} MiB`
                : "Estimate unavailable"}{" "}
              / {renderPcmLimitMiB.toFixed(0)} MiB · stereo
            </span>
          )}
          {workspaceState?.sampleRate === 96_000 && (
            <span className="mastering-overview-rate-note" role="note">
              96 kHz uses more render memory and cannot restore detail missing from the source.
            </span>
          )}
          <span>
            <strong>LAST ANALYSIS</strong> {report ? new Date(report.createdAt).toLocaleString() : "None yet"}
          </span>
          {report && (
            <span>
              <strong>MEASUREMENT</strong> {measurementSource}
            </span>
          )}
          {report && (
            <span>
              <strong>PROGRAM</strong> {report.durationSeconds.toFixed(1)} s · {report.sampleRate} Hz ·{" "}
              {report.quality === "studio" ? "Studio HQ" : "Live"}
            </span>
          )}
          {report && (
            <span className="mastering-overview-runtime" data-state={renderDegradationCount > 0 ? "warn" : "ok"}>
              <strong>RENDER RUNTIME</strong>{" "}
              {renderDegradationCount > 0
                ? `${renderDegradationCount} fallback status${renderDegradationCount === 1 ? "" : "es"} · details below`
                : "No fallback reported"}
            </span>
          )}
          {report && reportIsStale && (
            <span className="mastering-overview-stale">
              This report belongs to an earlier project, bank or render setting.
            </span>
          )}
        </div>
        <div className="mastering-overview-metrics">
          <div className="mastering-overview-metric">
            <span>INTEGRATED LOUDNESS</span>
            <strong>
              {loudnessMeasured && overviewMeasurements
                ? `${overviewMeasurements.lufsIntegrated.toFixed(1)} LUFS`
                : "NOT MEASURED"}
            </strong>
            <small>
              {loudnessMeasured && loudnessDelta != null
                ? `${loudnessDelta > 0 ? "+" : ""}${loudnessDelta.toFixed(1)} LU vs ${report?.profile.targetLufs} LUFS target`
                : "Programme may be too short or silent"}
            </small>
          </div>
          <div className="mastering-overview-metric">
            <span>TRUE PEAK / MARGIN</span>
            <strong>
              {overviewMeasurements ? `${overviewMeasurements.truePeakDb.toFixed(1)} dBTP` : "NOT MEASURED"}
            </strong>
            <small>
              {truePeakMargin != null && report
                ? `${truePeakMargin >= 0 ? "+" : ""}${truePeakMargin.toFixed(1)} dB to ${report.profile.maxTruePeakDb} dBTP ceiling`
                : "Run an offline analysis"}
            </small>
          </div>
          <div
            className="mastering-overview-metric"
            data-state={hasPhaseIssue || hasMonoWarning || hasBalanceWarning ? "warn" : ""}
          >
            <span>STEREO / MONO</span>
            <strong>{stereoLabel}</strong>
            <small>
              {overviewMeasurements && overviewMeasurements.channelCount >= 2
                ? `Correlation ${overviewMeasurements.correlation.toFixed(2)} · mono loss ${overviewMeasurements.monoLossDb.toFixed(1)} dB${overviewMeasurements.lrImbalanceDb == null ? "" : ` · L/R ${overviewMeasurements.lrImbalanceDb.toFixed(1)} dB`}`
                : "Stereo compatibility needs a stereo programme"}
            </small>
          </div>
          <button
            type="button"
            className="mastering-overview-metric mastering-overview-findings-action"
            disabled={!findingsAreCurrent || findingCount == null || findingCount === 0}
            aria-label={findingActionLabel}
            onClick={focusReviewFindings}
          >
            <span>FINDINGS TO REVIEW</span>
            <strong>{findingCount == null || reportIsStale ? "—" : findingCount}</strong>
            <small>{findingDetail}</small>
          </button>
          <div className="mastering-overview-metric">
            <span>LOUDNESS RANGE</span>
            <strong>{loudnessRangeLu == null ? "NOT MEASURED" : `${loudnessRangeLu.toFixed(1)} LU`}</strong>
            <small>
              {loudnessRangeLu == null
                ? loudnessRangeUnavailableReason
                : "EBU Tech 3342 · supplementary dynamics descriptor, not a target"}
            </small>
          </div>
        </div>
        {report && <MasteringLoudnessTimeline timeline={loudnessTimeline} />}
        <div className="mastering-overview-action">
          <p aria-live={isAnalyzing ? "off" : "polite"}>
            {isAnalyzing
              ? (workspaceState?.activity ?? "Rendering and measuring the current master…")
              : reportIsStale
                ? "Changes were detected after this measurement. Analyze again before relying on these results."
                : finalFileNotMeasured
                  ? `The exported file was header checked only. Values above describe source PCM. ${report?.encodedDelivery?.decode.reason ?? "Post-encode audio was not measured."}`
                  : workspaceState && !workspaceState.renderPcmWithinBudget
                    ? Number.isFinite(workspaceState.renderPcmBytes) && workspaceState.renderPcmBytes > 0
                      ? `This programme exceeds the ${renderPcmLimitMiB} MiB offline PCM limit. Choose Active pattern or shorten the song${workspaceState.sampleRate > 44100 ? ", or lower the sample rate" : ""} before rendering.`
                      : "KYX cannot estimate this render. Check the project tempo and selected scope before rendering."
                    : (overviewVerdict?.headline ??
                      workspaceState?.activity ??
                      "Analyze the rendered programme to create a current report.")}
          </p>
          <button
            type="button"
            className="btn btn-export mastering-overview-analyze"
            disabled={
              !workspaceState ||
              isAnalyzing ||
              comparisonBusy ||
              fileSessionBusy ||
              !workspaceState.renderPcmWithinBudget
            }
            onClick={() => workspaceState?.analyze()}
          >
            {isAnalyzing
              ? "ANALYZING…"
              : workspaceState?.mode === "pattern"
                ? "ANALYZE ACTIVE PATTERN"
                : "ANALYZE FULL SONG"}
          </button>
        </div>
      </section>
      <StableMasterMeter />
      <MasteringSignalFlow master={master} onShowAdvanced={showAdvancedControls} />
      <section className="mastering-core-controls" aria-labelledby="mastering-core-controls-title">
        <div className="mastering-core-controls-heading">
          <div>
            <span className="mastering-panel-kicker">BUILT-IN PROCESSING</span>
            <h3 id="mastering-core-controls-title">Core master controls</h3>
            <p>
              {controlView === "simple"
                ? "Simple view shows the main level controls. Other enabled processors keep their saved state."
                : "Advanced view exposes each built-in stage and device; changes edit the same project settings as MIX."}
            </p>
          </div>
          <div className="mastering-control-view" role="group" aria-label="Master controls view">
            <button
              type="button"
              className={`btn btn-small${controlView === "simple" ? " active-solo" : ""}`}
              aria-pressed={controlView === "simple"}
              onClick={() => setControlView("simple")}
            >
              Simple
            </button>
            <button
              type="button"
              className={`btn btn-small${controlView === "advanced" ? " active-solo" : ""}`}
              aria-pressed={controlView === "advanced"}
              onClick={() => setControlView("advanced")}
            >
              Advanced
            </button>
          </div>
        </div>
        <MasterProcessingControls view={controlView} />
      </section>
      {controlView === "advanced" ? (
        <div id="master-insert-controls" className="mastering-insert-controls" tabIndex={-1}>
          <StableEffectRack track={masterTrack} mode="devices" isMaster />
        </div>
      ) : (
        <div className="mastering-advanced-summary">
          <p>
            {master.effects?.length
              ? `${master.effects.length} master insert${master.effects.length === 1 ? "" : "s"} remain active in the signal path.`
              : "No user master inserts are active."}{" "}
            Open Advanced to adjust the built-in stages and insert devices.
          </p>
          <button type="button" className="btn btn-small" onClick={showAdvancedControls}>
            Open advanced controls
          </button>
        </div>
      )}
      {(isAnalyzing || comparisonBusy || fileSessionBusy) && (
        <p className="mastering-overview-stale" role="status" aria-live="polite" aria-atomic="true">
          A MASTER offline task is running. Other analyses, comparisons and external file renders wait until it
          finishes.
        </p>
      )}
      <MasteringABCompare
        doc={doc}
        revisionId={revisionId ?? `${doc.id}:${doc.updatedAt}`}
        blockNewWork={isAnalyzing || fileSessionBusy}
        onBusyChange={setComparisonBusy}
      />
      <section className="mastering-render-section" aria-label="Master render analysis and delivery">
        <header>
          <span className="mastering-panel-kicker">OFFLINE CHECK</span>
          <h3>Analyze and deliver</h3>
          <p>
            Set WAV/FLAC/MP3 format and bit depth here. Scope, rate and render quality are above; Export Master checks
            the encoded file and measures its decoded audio when browser memory allows.
          </p>
        </header>
        <ExportPanel
          masteringMode
          revisionId={revisionId}
          blockMasteringWork={comparisonBusy || fileSessionBusy}
          onMasteringWorkspaceStateChange={handleWorkspaceStateChange}
        />
      </section>
      <MasteringFileSessionPanel blockNewWork={comparisonBusy || isAnalyzing} onBusyChange={setFileSessionBusy} />
    </section>
  );
}
