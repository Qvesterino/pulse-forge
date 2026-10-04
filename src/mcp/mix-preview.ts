import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { analyzeMixHealth } from "../analysis/mixDoctor";
import { planMixIdea, type MixIdeaPlan } from "./mix-idea";
import type { Services } from "../services";

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

export interface MixPreviewLane {
  id: string;
  idea: string;
  label: string;
  targets: string[];
  goals: string[];
  interpreter: "production" | "assistant";
  /** Frozen copy of the pre-idea project — re-renderable for ▶ BEFORE. */
  beforeDoc: ProjectDocument;
  /** The plan folded over the project — ▶ AFTER. Applying never happened yet. */
  afterDoc: ProjectDocument;
  /** The ONE-undo command the Apply button executes. */
  command: Command;
  stats: MixPreviewStats;
  createdAt: string;
}

export type MixPreviewOutcome =
  { ok: true; lane: MixPreviewLane; studioBound: boolean } | { ok: false; reason: string };

// ── session lane registry (pub/sub, one lane at a time) ────────────────────

export type MixPreviewListener = (lane: MixPreviewLane | null) => void;

let currentLane: MixPreviewLane | null = null;
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

// ── preview build ──────────────────────────────────────────────────────────

interface RenderedBufferLike {
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
  sampleRate: number;
  duration: number;
}

const MATCH_GAIN_MAX_DB = 12;

/** Level-match playback gain for the AFTER side (louder side is pulled down). */
export function previewMatchGainDb(beforeLufs: number | null, afterLufs: number | null): number {
  if (beforeLufs == null || afterLufs == null || !Number.isFinite(beforeLufs) || !Number.isFinite(afterLufs)) {
    return 0;
  }
  const gain = beforeLufs - afterLufs;
  return Math.max(-MATCH_GAIN_MAX_DB, Math.min(MATCH_GAIN_MAX_DB, gain));
}

async function measureLufs(buffer: RenderedBufferLike): Promise<number | null> {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(buffer.getChannelData(channel));
  }
  const report = analyzeMixHealth(channels, buffer.sampleRate);
  return report.integratedLufs;
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
): Promise<MixPreviewLane> {
  const afterDoc = plan.command.execute(doc);
  const [beforeBuffer, afterBuffer] = await Promise.all([renderDoc(doc), renderDoc(afterDoc)]);
  const beforeLufs = await measureLufs(beforeBuffer);
  const afterLufs = await measureLufs(afterBuffer);
  return {
    id: `mixprev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    idea: "",
    label: plan.label,
    targets: [...plan.targets],
    goals: [...plan.goals],
    interpreter: plan.interpreter,
    beforeDoc: structuredClone(doc),
    afterDoc,
    command: plan.command,
    stats: {
      beforeLufs,
      afterLufs,
      matchGainDb: previewMatchGainDb(beforeLufs, afterLufs),
      seconds: Math.round(afterBuffer.duration * 10) / 10,
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Host entry (wired like diagnoseMix): plan → render pair → measure → arm
 * the lane. Read-only over the project; the human decides via the chip.
 */
export async function previewMixIdea(
  services: Services,
  request: { idea: string; target?: string },
): Promise<MixPreviewOutcome> {
  const doc = services.store.getDoc();
  const plan = planMixIdea(doc, request.idea, request.target);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const { renderProject } = await import("../rendering/renderer");
  const mode = doc.arrangement.clips.length > 0 ? ("song" as const) : ("pattern" as const);
  const lane = await buildMixPreview(doc, plan, (render) =>
    renderProject(render, services.bank, { mode, sampleRate: 44100, tailSeconds: 0.6 }),
  );
  lane.idea = request.idea;
  armMixPreviewLane(lane);
  return { ok: true, lane, studioBound: hasMixPreviewListener() };
}

/** Agent-facing preview report. */
export function formatMixPreview(outcome: MixPreviewOutcome): string {
  if (!outcome.ok) return outcome.reason;
  const { stats } = outcome.lane;
  const lufs = (value: number | null) => (value != null ? `${value.toFixed(1)} LUFS-I` : "LUFS n/a");
  const lines = [
    `PREVIEW armed — nothing applied yet: "${outcome.lane.label}"`,
    `before ${lufs(stats.beforeLufs)} · after ${lufs(stats.afterLufs)} (after playback is level-matched ${stats.matchGainDb >= 0 ? "+" : ""}${stats.matchGainDb.toFixed(1)} dB) · ${stats.seconds}s render`,
    outcome.studioBound
      ? "the studio now shows the MIX PREVIEW card — the human listens (▶ Before / ▶ After) and decides: Apply lands the plan as ONE undo step, Dismiss throws it away"
      : "no studio UI is bound to this transport (desktop stdio) — the numbers above are the comparison; run again with apply:true when the human agrees",
  ];
  return lines.join("\n");
}
