import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { normalizeProject, ticksPerBar } from "../project-model/schema";
import { analyzeMixHealth } from "../analysis/mixDoctor";
import { resolveAnalysisWindow } from "../analysis/contract";
import type { MixIdeaPlan, MixIdeaStep } from "./mix-idea";
import type { Services } from "../services";
import { storeRevision } from "./revision";
import type { MusicalProposalV1 } from "../intent/musical-proposal";
import {
  checkProposalConstraints,
  parseProposalConstraints,
  type ProposalConstraints,
} from "../intent/proposal-constraints";
import { validateMusicalProposal } from "../intent/validate-musical-proposal";
import { deepEqualRef } from "../commands/docDelta";
import { snapshot } from "../commands/core";

/**
 * kyx_mix_idea PREVIEW — the auto-rendered before/after A/B.
 *
 * Planning is already pure; this adds the listening half of the loop:
 * it renders the CURRENT master and the PLANNED master (the plan command
 * folded over a local doc — still nothing applied), measures both with the
 * mix-doctor's BS.1770 loudness, computes the level-match playback gain so
 * neither side is privileged, and arms a session PREVIEW LANE the studio
 * UI picks up — ▶ Before / ▶ After for the human, with Apply (one undo
 * step) and Dismiss.
 *
 * The lane registry is in-page session state (same lifecycle as the blind
 * A/B trial store): the web relay runs tools inside the app page, so the
 * chip sees it instantly. A desktop-stdio transport arms the lane in the
 * host process where the studio UI cannot bind it — the tool says so
 * honestly instead of pretending the human can listen.
 */

export interface MixPreviewStats {
  beforeLufs: number | null;
  afterLufs: number | null;
  /** Playback gain for the AFTER side that evens the comparison (±12 dB cap). */
  matchGainDb: number;
  seconds: number;
}

export interface MixPreviewWindow {
  startTick: number;
  endTick: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  startSample: number;
  endSample: number;
  sampleRate: number;
}

export interface MixPreviewLane {
  id: string;
  idea: string;
  label: string;
  targets: string[];
  goals: string[];
  interpreter: "production" | "assistant";
  /** Exact planned effect parameter changes shown before the human applies. */
  steps: MixIdeaStep[];
  /** Planner caveats, including element-level changes without parameter diffs. */
  warnings: string[];
  /** Frozen copy of the pre-idea project — re-renderable for ▶ BEFORE. */
  beforeDoc: ProjectDocument;
  /** The plan folded over the project — ▶ AFTER. Applying never happened yet. */
  afterDoc: ProjectDocument;
  /** The ONE-undo command the Apply button executes. */
  command: Command;
  constraints?: ProposalConstraints;
  stats: MixPreviewStats;
  /** Null means whole-project preview; a range is measured and auditioned in isolation. */
  window?: MixPreviewWindow | null;
  projectRevision?: number | null;
  revisionAfterRender?: number | null;
  freshness?: "current" | "stale" | "unknown";
  createdAt: string;
}

export interface MixPreviewVerification {
  projectId: string;
  label: string;
  targets: string[];
  goals: string[];
  window: MixPreviewWindow | null;
  status: "measured" | "stale" | "unavailable" | "unknown";
  freshness: "current" | "stale" | "unknown";
  structureMatchesPlan: boolean;
  beforeLufs: number | null;
  previewAfterLufs: number | null;
  actualAfterLufs: number | null;
  previewDeltaLufs: number | null;
  actualDeltaLufs: number | null;
  differenceFromPreviewLufs: number | null;
  previewRevision: number | null;
  appliedRevision: number | null;
  revisionAfterRender: number | null;
  reason?: string;
}

/** Translate the existing preview into the shared, read-only proposal contract. */
export function mixPreviewProposal(lane: MixPreviewLane): MusicalProposalV1 {
  const uncertainty = "Integrated loudness alone does not determine whether a mix sounds better.";
  return {
    schema: "kyx.musical-proposal",
    version: 1,
    id: lane.id,
    base: {
      projectId: lane.beforeDoc.id,
      revision: lane.revisionAfterRender ?? lane.projectRevision ?? null,
      freshness: lane.freshness ?? "unknown",
    },
    scope: {
      audition: lane.window ? { startTick: lane.window.startTick, endTick: lane.window.endTick } : null,
      writeScope: lane.constraints ? "declared" : "unrestricted",
      targetTrackIds: [...new Set(lane.steps.map((step) => step.trackId))],
    },
    intent: { label: lane.label, goals: [...lane.goals], interpreter: lane.interpreter },
    constraints: lane.constraints
      ? { status: "declared", rules: structuredClone(lane.constraints) }
      : { status: "not_declared", items: [] },
    candidates: [
      {
        id: lane.id,
        changes: lane.steps.map((step) => ({
          trackId: step.trackId,
          device: step.device,
          parameterChanges: structuredClone(step.changes),
          description: step.params,
          reason: step.reason,
        })),
      },
    ],
    evidence: [
      {
        id: "preview.before.lufs",
        kind: "measurement",
        source: "mix_preview_render",
        metric: "integrated_lufs",
        value: lane.stats.beforeLufs,
        uncertainty,
      },
      {
        id: "preview.after.lufs",
        kind: "measurement",
        source: "mix_preview_render",
        metric: "integrated_lufs",
        value: lane.stats.afterLufs,
        uncertainty,
      },
    ],
    checks: {
      structural: "not_checked",
      acoustic: lane.stats.beforeLufs !== null && lane.stats.afterLufs !== null ? "preview_measured" : "unavailable",
      subjective: "not_judged",
    },
    warnings: [...lane.warnings],
  };
}

export type MixPreviewOutcome =
  { ok: true; lane: MixPreviewLane; studioBound: boolean } | { ok: false; reason: string };

// ── session lane registry (pub/sub, one lane at a time) ────────────────────

export type MixPreviewListener = (lane: MixPreviewLane | null) => void;

let currentLane: MixPreviewLane | null = null;
let latestVerification: MixPreviewVerification | null = null;
let verificationGeneration = 0;
const previewConstraints = new WeakMap<MixPreviewLane, ProposalConstraints | null>();
const listeners = new Set<MixPreviewListener>();

export function armMixPreviewLane(lane: MixPreviewLane): void {
  currentLane = lane;
  for (const listener of [...listeners]) {
    try {
      listener(lane);
    } catch {
      /* a dead listener must never break the arm */
    }
  }
}

export function clearMixPreviewLane(): void {
  currentLane = null;
  for (const listener of [...listeners]) {
    try {
      listener(null);
    } catch {
      /* ignore */
    }
  }
}

export function currentMixPreviewLane(): MixPreviewLane | null {
  return currentLane;
}

export function onMixPreviewLane(listener: MixPreviewListener): () => void {
  listeners.add(listener);
  try {
    listener(currentLane);
  } catch {
    /* the immediate replay follows the same dead-listener rule as arm/clear */
  }
  return () => listeners.delete(listener);
}

export function hasMixPreviewListener(): boolean {
  return listeners.size > 0;
}

/** Apply the armed preview and measure the actual rendered result on the same scope. */
export async function applyAndVerifyMixPreview(
  services: Services,
  lane: MixPreviewLane,
): Promise<{ applied: boolean; verification?: MixPreviewVerification; reason?: string }> {
  const beforeApply = structuredClone(services.store.getDoc());
  const revisionBeforeApply = storeRevision(services.store);
  if (previewConstraints.has(lane) && !deepEqualRef(previewConstraints.get(lane), lane.constraints ?? null)) {
    return { applied: false, reason: "Preview constraints changed; create a new preview." };
  }
  if (lane.freshness === "stale") return { applied: false, reason: "Preview is stale; create a new preview." };
  if (!mixPreviewMatchesProject(lane, beforeApply, revisionBeforeApply))
    return { applied: false, reason: "Project changed after preview; create a new preview." };
  const validation = validateMusicalProposal(mixPreviewProposal(lane), {
    projectId: beforeApply.id,
    revision: revisionBeforeApply,
    trackIds: beforeApply.tracks.map((track) => track.id),
  });
  if (!validation.ok) return { applied: false, reason: validation.reason };
  const candidate = normalizeProject(lane.command.execute(structuredClone(beforeApply)));
  if (!deepEqualRef(candidate, lane.afterDoc))
    return { applied: false, reason: "The command no longer produces the previewed project." };
  if (lane.constraints) {
    const checked = checkProposalConstraints(beforeApply, candidate, lane.constraints);
    if (!checked.ok)
      return {
        applied: false,
        reason: checked.reason ?? `Constraint violation: ${checked.violations.map((v) => v.path).join(", ")}`,
      };
  }

  const generation = ++verificationGeneration;
  latestVerification = null;
  // Commit the exact checked candidate for constrained previews. Re-executing
  // an arbitrary command after checking it could produce a different write.
  const command = lane.constraints
    ? {
        ...snapshot(lane.command.type, lane.command.label, beforeApply, candidate),
        detail: lane.command.detail,
        clamps: lane.command.clamps,
      }
    : lane.command;
  services.store.execute(command);
  clearMixPreviewLane();
  const appliedDoc = structuredClone(services.store.getDoc());
  const appliedRevision = storeRevision(services.store);
  const structureMatchesPlan = JSON.stringify(appliedDoc) === JSON.stringify(lane.afterDoc);
  let actualAfterLufs: number | null = null;
  let reason: string | undefined;
  try {
    const { renderProject } = await import("../rendering/renderer");
    const mode = appliedDoc.arrangement.clips.length > 0 ? ("song" as const) : ("pattern" as const);
    const rendered = await renderProject(appliedDoc, services.bank, {
      mode,
      sampleRate: 44100,
      tailSeconds: 0.6,
      ...(lane.window ? { minimumDurationTicks: lane.window.endTick, arrangementOnly: true } : {}),
    });
    if (lane.window) assertPreviewWindow(rendered, lane.window, "post-apply");
    actualAfterLufs = await measureLufs(rendered, lane.window);
    if (actualAfterLufs === null) reason = "fresh render did not contain enough measurable audio for integrated LUFS";
  } catch (error) {
    reason = `fresh render unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const revisionAfterRender = storeRevision(services.store);
  const sameSnapshotWithoutRevision =
    (appliedRevision === null || revisionAfterRender === null) &&
    JSON.stringify(services.store.getDoc()) === JSON.stringify(appliedDoc);
  const freshness =
    appliedRevision !== null && revisionAfterRender !== null
      ? appliedRevision === revisionAfterRender
        ? "current"
        : "stale"
      : sameSnapshotWithoutRevision
        ? "current"
        : "unknown";
  if (freshness === "stale") reason = "project changed while the post-apply render was running";
  const previewDeltaLufs =
    lane.stats.beforeLufs === null || lane.stats.afterLufs === null
      ? null
      : lane.stats.afterLufs - lane.stats.beforeLufs;
  const actualDeltaLufs =
    lane.stats.beforeLufs === null || actualAfterLufs === null ? null : actualAfterLufs - lane.stats.beforeLufs;
  const differenceFromPreviewLufs =
    lane.stats.afterLufs === null || actualAfterLufs === null ? null : actualAfterLufs - lane.stats.afterLufs;
  const status =
    freshness === "stale"
      ? "stale"
      : actualAfterLufs === null
        ? "unavailable"
        : freshness === "unknown"
          ? "unknown"
          : "measured";
  const verification: MixPreviewVerification = {
    projectId: appliedDoc.id,
    label: lane.label,
    targets: [...lane.targets],
    goals: [...lane.goals],
    window: lane.window ?? null,
    status,
    freshness,
    structureMatchesPlan,
    beforeLufs: lane.stats.beforeLufs,
    previewAfterLufs: lane.stats.afterLufs,
    actualAfterLufs,
    previewDeltaLufs,
    actualDeltaLufs,
    differenceFromPreviewLufs,
    previewRevision: lane.revisionAfterRender ?? lane.projectRevision ?? null,
    appliedRevision,
    revisionAfterRender,
    ...(reason ? { reason } : {}),
  };
  if (generation === verificationGeneration) latestVerification = verification;
  return { applied: true, verification };
}

/** Consume the receipt only for the same project and exact analyzed scope. */
export function takeMixPreviewVerification(
  projectId: string,
  window: { startTick: number; endTick: number } | null,
  currentRevision: number | null,
): MixPreviewVerification | null {
  const receipt = latestVerification;
  if (!receipt || receipt.projectId !== projectId) return null;
  const sameWindow =
    receipt.window === null
      ? window === null
      : window !== null && receipt.window.startTick === window.startTick && receipt.window.endTick === window.endTick;
  if (!sameWindow) return null;
  latestVerification = null;
  if (
    receipt.revisionAfterRender !== null &&
    currentRevision !== null &&
    receipt.revisionAfterRender !== currentRevision
  ) {
    return {
      ...receipt,
      status: "stale",
      freshness: "stale",
      reason: "project changed after the post-apply verification render",
    };
  }
  if (receipt.revisionAfterRender === null || currentRevision === null) {
    return { ...receipt, status: "unknown", freshness: "unknown" };
  }
  return receipt;
}

// ── preview build ──────────────────────────────────────────────────────────

interface RenderedBufferLike {
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
  sampleRate: number;
  duration: number;
}

const MATCH_GAIN_MAX_DB = 12;
const RANGE_PREVIEW_MAX_BARS = 16;
const RANGE_PREVIEW_MAX_END_BARS = 64;

/** Level-match playback gain for the AFTER side (louder side is pulled down). */
export function previewMatchGainDb(beforeLufs: number | null, afterLufs: number | null): number {
  if (beforeLufs == null || afterLufs == null || !Number.isFinite(beforeLufs) || !Number.isFinite(afterLufs)) {
    return 0;
  }
  const gain = beforeLufs - afterLufs;
  return Math.max(-MATCH_GAIN_MAX_DB, Math.min(MATCH_GAIN_MAX_DB, gain));
}

async function measureLufs(buffer: RenderedBufferLike, window?: MixPreviewWindow | null): Promise<number | null> {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    const start = window ? Math.max(0, Math.min(data.length, window.startSample)) : 0;
    const end = window ? Math.max(start, Math.min(data.length, window.endSample)) : data.length;
    channels.push(data.subarray(start, end));
  }
  if (channels.length === 0 || channels[0]?.length === 0) return null;
  const report = analyzeMixHealth(channels, buffer.sampleRate);
  return report.integratedLufs;
}

function assertPreviewWindow(buffer: RenderedBufferLike, window: MixPreviewWindow, side: string): void {
  if (buffer.sampleRate !== window.sampleRate) {
    throw new Error(
      `${side} render sample rate ${buffer.sampleRate} does not match range alignment ${window.sampleRate}`,
    );
  }
  if (buffer.numberOfChannels === 0) throw new Error(`${side} render has no audio channels`);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    if (buffer.getChannelData(channel).length < window.endSample) {
      throw new Error(`${side} render ended before range sample ${window.endSample}`);
    }
  }
}

/**
 * Render the before/after pair and assemble the lane. Pure over the project:
 * the plan command folds over the doc read-only, the before doc is frozen
 * via structuredClone, and nothing is applied to the store.
 */
export async function buildMixPreview(
  doc: ProjectDocument,
  plan: Extract<MixIdeaPlan, { ok: true }>,
  renderDoc: (doc: ProjectDocument) => Promise<RenderedBufferLike>,
  options: {
    window?: MixPreviewWindow | null;
    projectRevision?: number | null;
    constraints?: ProposalConstraints;
  } = {},
): Promise<MixPreviewLane> {
  const afterDoc = normalizeProject(plan.command.execute(structuredClone(doc)));
  if (options.constraints) {
    const checked = checkProposalConstraints(doc, afterDoc, options.constraints);
    if (!checked.ok)
      throw new Error(checked.reason ?? `Constraint violation: ${checked.violations.map((v) => v.path).join(", ")}`);
  }
  const [beforeBuffer, afterBuffer] = await Promise.all([renderDoc(doc), renderDoc(afterDoc)]);
  if (options.window) {
    assertPreviewWindow(beforeBuffer, options.window, "before");
    assertPreviewWindow(afterBuffer, options.window, "after");
  }
  const beforeLufs = await measureLufs(beforeBuffer, options.window);
  const afterLufs = await measureLufs(afterBuffer, options.window);
  const lane: MixPreviewLane = {
    id: `mixprev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    idea: "",
    label: plan.label,
    targets: [...plan.targets],
    goals: [...plan.goals],
    interpreter: plan.interpreter,
    steps: structuredClone(plan.steps),
    warnings: [...plan.warnings],
    beforeDoc: structuredClone(doc),
    afterDoc,
    command: plan.command,
    ...(options.constraints ? { constraints: structuredClone(options.constraints) } : {}),
    stats: {
      beforeLufs,
      afterLufs,
      matchGainDb: previewMatchGainDb(beforeLufs, afterLufs),
      seconds: Math.round((options.window?.durationSec ?? afterBuffer.duration) * 10) / 10,
    },
    window: options.window ?? null,
    projectRevision: options.projectRevision ?? null,
    revisionAfterRender: options.projectRevision ?? null,
    freshness: options.projectRevision === undefined || options.projectRevision === null ? "unknown" : "current",
    createdAt: new Date().toISOString(),
  };
  previewConstraints.set(lane, options.constraints ? structuredClone(options.constraints) : null);
  return lane;
}

/**
 * Host entry (wired like diagnoseMix): plan → render pair → measure → arm
 * the lane. Read-only over the project; the human decides via the chip.
 */
export async function previewMixIdea(
  services: Services,
  request: { idea: string; target?: string; startTick?: number; endTick?: number; constraints?: ProposalConstraints },
  signal?: AbortSignal,
): Promise<MixPreviewOutcome> {
  const doc = structuredClone(services.store.getDoc());
  const projectRevision = storeRevision(services.store);
  const constraints = request.constraints === undefined ? undefined : parseProposalConstraints(request.constraints);
  if (constraints === null) return { ok: false, reason: "Invalid constraint declaration." };
  for (const path of [...(constraints?.allow ?? []), ...(constraints?.protect ?? [])]) {
    if (path[0] === "tracks" && path.length > 1 && typeof path[1] !== "object") {
      return { ok: false, reason: "Track constraints must use a stable {id} selector." };
    }
    if (
      path[0] === "tracks" &&
      typeof path[1] === "object" &&
      !doc.tracks.some((track) => track.id === (path[1] as { id: string }).id)
    ) {
      return { ok: false, reason: `Unknown track in constraint: ${(path[1] as { id: string }).id}` };
    }
  }
  const hasStartTick = request.startTick !== undefined;
  const hasEndTick = request.endTick !== undefined;
  if (hasStartTick !== hasEndTick) return { ok: false, reason: "range preview needs both startTick and endTick" };
  if (
    hasStartTick &&
    (!Number.isSafeInteger(request.startTick) ||
      !Number.isSafeInteger(request.endTick) ||
      (request.startTick as number) < 0 ||
      (request.endTick as number) <= (request.startTick as number))
  ) {
    return { ok: false, reason: "range preview needs non-negative integer ticks with endTick > startTick" };
  }
  if (hasStartTick && doc.arrangement.clips.length === 0) {
    return { ok: false, reason: "range preview needs arrangement clips; pattern-mode projects have no song range" };
  }
  if (hasStartTick && request.startTick !== undefined && request.endTick !== undefined) {
    const barTicks = ticksPerBar(doc);
    if (request.endTick - request.startTick > RANGE_PREVIEW_MAX_BARS * barTicks) {
      return { ok: false, reason: `range preview is limited to ${RANGE_PREVIEW_MAX_BARS} bars` };
    }
    if (request.endTick > RANGE_PREVIEW_MAX_END_BARS * barTicks) {
      return {
        ok: false,
        reason: `range preview can render only the first ${RANGE_PREVIEW_MAX_END_BARS} arrangement bars`,
      };
    }
  }
  let previewWindow: MixPreviewWindow | null = null;
  if (hasStartTick && request.startTick !== undefined && request.endTick !== undefined) {
    const resolved = resolveAnalysisWindow(
      doc,
      {
        window: { startTick: request.startTick, endTick: request.endTick },
        scope: { kind: "master" },
        ...(projectRevision === null ? {} : { revision: projectRevision }),
      },
      44100,
    );
    if (resolved.endSample <= resolved.startSample) {
      return { ok: false, reason: "range preview resolved to fewer than one audio sample" };
    }
    previewWindow = {
      startTick: request.startTick,
      endTick: request.endTick,
      startSec: resolved.startSec,
      endSec: resolved.endSec,
      durationSec: resolved.endSec - resolved.startSec,
      startSample: resolved.startSample,
      endSample: resolved.endSample,
      sampleRate: 44100,
    };
  }
  // The planner is loaded at the moment of the call, not at boot: mix-idea
  // carries the intent routing table (91 KB built) and the FX add assistant,
  // and a chip that only shows a lane must not pay for them on every studio
  // boot. Same seam as the renderer below.
  const { planMixIdea } = await import("./mix-idea");
  const plan = planMixIdea(doc, request.idea, request.target);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const { renderProject, throwIfAborted } = await import("../rendering/renderer");
  throwIfAborted(signal);
  const mode = doc.arrangement.clips.length > 0 ? ("song" as const) : ("pattern" as const);
  const lane = await buildMixPreview(
    doc,
    plan,
    (render) =>
      renderProject(render, services.bank, {
        mode,
        sampleRate: 44100,
        tailSeconds: 0.6,
        ...(previewWindow ? { minimumDurationTicks: previewWindow.endTick, arrangementOnly: true } : {}),
        signal,
      }),
    { window: previewWindow, projectRevision, ...(constraints ? { constraints } : {}) },
  );
  const revisionAfterRender = storeRevision(services.store);
  lane.revisionAfterRender = revisionAfterRender;
  lane.freshness =
    projectRevision === null || revisionAfterRender === null
      ? "unknown"
      : projectRevision === revisionAfterRender
        ? "current"
        : "stale";
  const snapshotChangedWithoutRevision =
    (projectRevision === null || revisionAfterRender === null) &&
    JSON.stringify(services.store.getDoc()) !== JSON.stringify(doc);
  if (lane.freshness === "stale" || snapshotChangedWithoutRevision) {
    return { ok: false, reason: "project changed while the before/after preview rendered; nothing was armed" };
  }
  lane.idea = request.idea;
  const validation = validateMusicalProposal(mixPreviewProposal(lane), {
    projectId: doc.id,
    revision: revisionAfterRender,
    trackIds: doc.tracks.map((track) => track.id),
  });
  if (!validation.ok) return { ok: false, reason: validation.reason };
  armMixPreviewLane(lane);
  return { ok: true, lane, studioBound: hasMixPreviewListener() };
}

/** Reject Apply if the project changed after the lane was rendered. */
export function mixPreviewMatchesProject(
  lane: MixPreviewLane,
  currentDoc: ProjectDocument,
  currentRevision: number | null,
): boolean {
  if (currentDoc.id !== lane.beforeDoc.id) return false;
  if (lane.revisionAfterRender != null && currentRevision != null) {
    return lane.revisionAfterRender === currentRevision;
  }
  return JSON.stringify(currentDoc) === JSON.stringify(lane.beforeDoc);
}

/** Agent-facing preview report. */
export function formatMixPreview(outcome: MixPreviewOutcome): string {
  if (!outcome.ok) return outcome.reason;
  const { stats } = outcome.lane;
  const lufs = (value: number | null) => (value != null ? `${value.toFixed(1)} LUFS-I` : "LUFS n/a");
  const lines = [
    `PREVIEW armed — nothing applied yet: "${outcome.lane.label}"`,
    `before ${lufs(stats.beforeLufs)} · after ${lufs(stats.afterLufs)} (after playback is level-matched ${stats.matchGainDb >= 0 ? "+" : ""}${stats.matchGainDb.toFixed(1)} dB) · ${stats.seconds}s render`,
    outcome.lane.window
      ? `measured/auditioned ticks ${outcome.lane.window.startTick}..${outcome.lane.window.endTick} (${outcome.lane.window.startSec.toFixed(3)}..${outcome.lane.window.endSec.toFixed(3)} s)`
      : "measured/auditioned full project",
    `project revision: ${outcome.lane.projectRevision ?? "unknown"} → ${outcome.lane.revisionAfterRender ?? "unknown"} (${outcome.lane.freshness ?? "unknown"})`,
    ...outcome.lane.steps.map((step, index) => {
      const changes = step.changes
        .map(({ param, before, after }) => `${param} ${before === null ? "unset" : before} → ${after}`)
        .join(" · ");
      return `${index + 1}. ${step.track}: ${step.device} — ${changes || step.params}`;
    }),
    ...outcome.lane.warnings.map((warning) => `warning: ${warning}`),
    "Apply checks that the project still matches the preview; rerun after any edit.",
    outcome.studioBound
      ? "the studio now shows the MIX PREVIEW card — the human listens (▶ Before / ▶ After) and decides: Apply lands the plan as ONE undo step, Dismiss throws it away"
      : "no studio UI is bound to this transport (desktop stdio) — the numbers above are the comparison; run again with apply:true when the human agrees",
  ];
  return lines.join("\n");
}
