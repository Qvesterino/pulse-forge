/**
 * TRUST REPORT — one artifact that says "we don't lose your work and we don't
 * lie to you", and can be handed to someone else.
 *
 * WHY ONE ARTIFACT
 * ----------------
 * The durability and honesty machinery this app has grown is scattered by
 * design (each piece lives where its data lives): the crash journal knows how
 * the last session ended, the snapshot repository knows the safety net, the
 * freeze signatures know which frozen track is stale, the agent audit knows
 * what an agent did, the job center knows what ran, the RT monitor knows
 * whether the audio actually held together, the render stamp knows what the
 * last export was. On its own each is an answer to a question nobody asked at
 * the right moment. Together they are a REPORT — and a report is something a
 * studio, a school or a label can actually receive.
 *
 * THE ONE RULE
 * ------------
 * A verdict line is emitted only from data that was READ. Missing data is
 * `unknown` ("not available here"), never a quiet ✓ — the report is worthless
 * the first time it claims a check it did not run. The same rule applies to
 * the "what this file contains" section: it says exactly what it carries,
 * including the uncomfortable part (agent action summaries can contain a short
 * prompt fragment).
 */
import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import { buildZip } from "../export/zip";
import { collectAiAssetReceipts, collectAiPatternReceipts, collectAiTrackReceipts } from "../export/renderManifest";
import { freezeSignature, freezeStaleness } from "../rendering/freezeSignature";
import { agentTrustSnapshot, currentAgentSession } from "../mcp/agentTrust";
import { jobSnapshot } from "./jobCenter";
import { lastRenderStamp } from "../export/renderManifest";
import { readIntentMiningLog } from "../intent/failure-log";
import { readRecoveryBuffer } from "../persistence/recoveryBuffer";
import { KYX_MANIFEST_FORMAT } from "../export/renderManifest";
import { downloadBlob } from "../export/download";

export const TRUST_REPORT_VERSION = 1;

export type TrustLevel = "ok" | "warn" | "unknown";

export interface TrustVerdictLine {
  level: TrustLevel;
  text: string;
}

export interface TrustReportFrozenTrack {
  name: string;
  staleness: "fresh" | "stale" | "unknown";
}

export interface TrustReportInput {
  docName: string;
  docId: string;
  generatedAt: Date;
  /** Canonical content hash of the document (freezeSignature). */
  contentHash: string | null;
  save: {
    status: string;
    /** Last successful save anywhere in the journal (cross-session). */
    lastSaveOkAt: string | null;
    /** null = the journal has no opinion (empty/absent). */
    lastSessionClean: boolean | null;
    lastSaveFailure: string | null;
  };
  snapshots: { count: number; latestAt: string | null } | null;
  recovery: { buffered: boolean } | null;
  frozen: TrustReportFrozenTrack[];
  audio: {
    state: string | null;
    xruns: number | null;
    maxGapMs: number | null;
    schedulerFailures: number | null;
    processorErrors: number | null;
  } | null;
  ai: { assets: number; patterns: number; tracks: number; models: string[] } | null;
  agent: {
    agent: string | null;
    sessionCalls: number;
    sessionMutations: number;
    checkpointSaved: boolean;
    destructiveEntries: number;
    errorEntries: number;
    totalEntries: number;
  } | null;
  jobs: Array<{ kind: string; status: string }>;
  exportStamp: { fileName: string; hash: string | null; renderedAt: string } | null;
  intentFailures: { total: number; latestReason: string | null } | null;
}

export interface TrustReport {
  version: number;
  generatedAt: string;
  /**
   * The top-line honesty label:
   *  - "clean"    every check ran, none warned.
   *  - "partial"  nothing warned, but some checks could not run here — the
   *               report says so instead of borrowing credibility from the
   *               checks that did run.
   *  - "warnings" something needs a human look.
   *  - "unknown"  nothing could be checked at all.
   */
  level: "clean" | "partial" | "warnings" | "unknown";
  verdict: TrustVerdictLine[];
  markdown: string;
  json: Record<string, unknown>;
}

function line(level: TrustLevel, text: string): TrustVerdictLine {
  return { level, text };
}

const GLYPH: Record<TrustLevel, string> = { ok: "✓", warn: "⚠", unknown: "?" };

export function buildTrustReport(input: TrustReportInput): TrustReport {
  const verdict: TrustVerdictLine[] = [];

  // ── durability ──────────────────────────────────────────────────────────
  if (input.save.status === "saved") {
    verdict.push(
      line("ok", `saved${input.save.lastSaveOkAt ? ` (last successful save ${input.save.lastSaveOkAt})` : ""}`),
    );
  } else if (input.save.status === "dirty" || input.save.status === "saving") {
    verdict.push(line("warn", `unsaved changes right now (save status: ${input.save.status})`));
  } else {
    verdict.push(line("warn", `the last save reported an ERROR: ${input.save.lastSaveFailure ?? input.save.status}`));
  }
  if (input.save.lastSessionClean === true) {
    verdict.push(line("ok", "the previous session ended through the app"));
  } else if (input.save.lastSessionClean === false) {
    verdict.push(
      line(
        "warn",
        "the previous session did NOT end through the app (tab closed, crash or refresh) — the journal cannot tell which, so check the newest snapshot before assuming anything is lost",
      ),
    );
  } else {
    verdict.push(line("unknown", "the session journal has no verdict yet (nothing recorded)"));
  }
  if (input.snapshots == null) {
    verdict.push(line("unknown", "snapshot history is not available here"));
  } else if (input.snapshots.count > 0) {
    verdict.push(
      line("ok", `${input.snapshots.count} snapshot(s) available (newest ${input.snapshots.latestAt ?? "?"})`),
    );
  } else {
    verdict.push(line("warn", "no snapshots for this project yet — the restore-to-yesterday net is empty"));
  }
  if (input.recovery?.buffered === true) {
    verdict.push(line("warn", "an UNSAVED recovery copy of this project exists — open the project to be offered it"));
  }

  // ── this session ────────────────────────────────────────────────────────
  if (input.audio == null) {
    verdict.push(line("unknown", "audio runtime health is not available here"));
  } else if ((input.audio.xruns ?? 0) > 0) {
    verdict.push(
      line(
        "warn",
        `${input.audio.xruns} audio dropout(s) this session (worst delivery gap ${input.audio.maxGapMs ?? "?"} ms)`,
      ),
    );
  } else {
    verdict.push(line("ok", `no audio dropouts this session (context: ${input.audio.state ?? "unknown"})`));
  }
  if (input.audio != null && (input.audio.schedulerFailures ?? 0) > 0) {
    verdict.push(
      line("warn", `${input.audio.schedulerFailures} scheduler window failure(s) — playback may have skipped events`),
    );
  }
  if (input.agent == null) {
    verdict.push(line("unknown", "agent activity is not available here"));
  } else if (input.agent.sessionCalls > 0 || input.agent.totalEntries > 0) {
    verdict.push(
      line(
        input.agent.errorEntries > 0 ? "warn" : "ok",
        `${input.agent.sessionCalls} agent call(s) this session (${input.agent.sessionMutations} applied), ` +
          `${input.agent.destructiveEntries} destructive and ${input.agent.errorEntries} failed in the retained log` +
          `${input.agent.checkpointSaved ? " — a pre-session checkpoint exists, so the session can be reverted" : ""}`,
      ),
    );
  } else {
    verdict.push(line("ok", "no agent activity recorded"));
  }

  // ── freeze integrity ────────────────────────────────────────────────────
  const stale = input.frozen.filter((track) => track.staleness === "stale");
  const unknownFrozen = input.frozen.filter((track) => track.staleness === "unknown");
  if (input.frozen.length === 0) {
    verdict.push(line("ok", "no frozen tracks"));
  } else if (stale.length > 0) {
    verdict.push(
      line(
        "warn",
        `${stale.length} frozen track(s) edited since the freeze (${stale.map((track) => track.name).join(", ")}) — live playback uses the frozen render while the export re-renders`,
      ),
    );
  } else {
    verdict.push(line("ok", `${input.frozen.length} frozen track(s), all matching the current project`));
  }
  if (unknownFrozen.length > 0) {
    verdict.push(
      line(
        "unknown",
        `${unknownFrozen.length} frozen track(s) have no recorded signature (pre-protocol or after a storage reset)`,
      ),
    );
  }

  // ── provenance + export ─────────────────────────────────────────────────
  if (input.ai == null) {
    verdict.push(line("unknown", "AI provenance is not available here"));
  } else {
    const total = input.ai.assets + input.ai.patterns + input.ai.tracks;
    verdict.push(
      line(
        "ok",
        total === 0
          ? "no AI-generated material is placed in this project"
          : `${total} AI receipt(s): ${input.ai.assets} asset(s), ${input.ai.patterns} pattern(s), ${input.ai.tracks} track(s)` +
              `${input.ai.models.length > 0 ? ` — models: ${input.ai.models.join(", ")}` : ""}`,
      ),
    );
  }
  if (input.exportStamp == null) {
    verdict.push(line("unknown", "no export was stamped this session — export a WAV to get a reproducible hash"));
  } else {
    verdict.push(
      line(
        "ok",
        `last export "${input.exportStamp.fileName}" carried a render hash (${input.exportStamp.hash ? input.exportStamp.hash.slice(0, 12) : "unavailable — insecure context"})`,
      ),
    );
  }
  if (input.intentFailures != null && input.intentFailures.total > 0) {
    verdict.push(
      line(
        "unknown",
        `${input.intentFailures.total} prompt(s) the local parser could not resolve${input.intentFailures.latestReason ? ` (latest: ${input.intentFailures.latestReason})` : ""}`,
      ),
    );
  }

  const warnings = verdict.filter((entry) => entry.level === "warn").length;
  const okCount = verdict.filter((entry) => entry.level === "ok").length;
  const unknownCount = verdict.filter((entry) => entry.level === "unknown").length;
  const level: TrustReport["level"] =
    warnings > 0 ? "warnings" : okCount === 0 ? "unknown" : unknownCount > 0 ? "partial" : "clean";

  const json: Record<string, unknown> = {
    format: "kyx-trust-report/1",
    version: TRUST_REPORT_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    level,
    project: { id: input.docId, name: input.docName, contentHash: input.contentHash },
    save: input.save,
    snapshots: input.snapshots,
    recovery: input.recovery,
    frozen: input.frozen,
    audio: input.audio,
    ai: input.ai,
    agent: input.agent,
    jobs: input.jobs,
    exportStamp: input.exportStamp,
    intentFailures: input.intentFailures,
    verdict,
  };

  const verdictLines = verdict.map((entry) => `- ${GLYPH[entry.level]} ${entry.text}`).join("\n");

  const markdown = [
    `# KYX Trust Report — "${input.docName}"`,
    "",
    `Generated ${input.generatedAt.toISOString()} · project \`${input.docId}\`${
      input.contentHash ? ` · content \`${input.contentHash.slice(0, 12)}\`` : ""
    }`,
    "",
    `**${okCount} check(s) ok · ${warnings} warning(s) · ${unknownCount} not available in this environment.**`,
    "",
    "## Verdict",
    "",
    verdictLines,
    "",
    "## Durability",
    "",
    `- Save status: \`${input.save.status}\`${input.save.lastSaveOkAt ? ` · last successful save (journal): ${input.save.lastSaveOkAt}` : ""}`,
    `- Previous session ended through the app: ${
      input.save.lastSessionClean === null
        ? "not recorded"
        : input.save.lastSessionClean
          ? "yes"
          : "no (tab closed, crash or refresh — the journal cannot tell which)"
    }`,
    `- Snapshots: ${input.snapshots == null ? "not available here" : `${input.snapshots.count} (newest ${input.snapshots.latestAt ?? "?"})`}`,
    `- Recovery copy of unsaved edits: ${input.recovery == null ? "not available here" : input.recovery.buffered ? "EXISTS (open the project to be offered it)" : "none"}`,
    "",
    "## This session",
    "",
    `- Jobs seen: ${input.jobs.length === 0 ? "none" : input.jobs.map((job) => `${job.kind}:${job.status}`).join(", ")}`,
    `- Agent activity: ${
      input.agent == null
        ? "not available here"
        : `${input.agent.sessionCalls} call(s) this session by ${input.agent.agent ?? "(none)"}, ${input.agent.sessionMutations} applied` +
          ` · retained log: ${input.agent.totalEntries} entries, ${input.agent.destructiveEntries} destructive, ${input.agent.errorEntries} failed` +
          ` · pre-session checkpoint: ${input.agent.checkpointSaved ? "yes" : "no"}`
    }`,
    `- Audio runtime: ${
      input.audio == null
        ? "not available here"
        : `context ${input.audio.state ?? "unknown"} · ${input.audio.xruns ?? "?"} dropout(s) · worst delivery gap ${input.audio.maxGapMs ?? "?"} ms` +
          ` · scheduler failures ${input.audio.schedulerFailures ?? "?"} · processor errors ${input.audio.processorErrors ?? "?"}`
    }`,
    `- Prompts the local parser could not resolve: ${input.intentFailures == null ? "not available here" : input.intentFailures.total}`,
    "",
    "## Freeze integrity",
    "",
    input.frozen.length === 0
      ? "- No frozen tracks."
      : input.frozen.map((track) => `- "${track.name}": ${track.staleness}`).join("\n"),
    "",
    "> A frozen track marked `stale` was edited after it was frozen: live playback keeps using the frozen",
    "> render, while the export re-renders the edited track. Re-freeze to make what you hear match what you ship.",
    "",
    "## AI provenance (receipts for what the models contributed)",
    "",
    input.ai == null
      ? "- Not available in this environment."
      : input.ai.models.length === 0
        ? "- No AI-generated material is placed in this project."
        : input.ai.models.map((model) => `- ${model}`).join("\n"),
    "",
    "## Export",
    "",
    input.exportStamp == null
      ? "- No export stamped this session."
      : [
          `- File: \`${input.exportStamp.fileName}\` (rendered ${input.exportStamp.renderedAt})`,
          `- Render hash: \`${input.exportStamp.hash ?? "unavailable (insecure context)"}\``,
          `- Verify it yourself: \`node tools/kyx-verify.mjs <file.wav>\` — the manifest format is documented in docs/KYX-REPRODUCIBILITY-PROTOCOL.md (${KYX_MANIFEST_FORMAT}).`,
        ].join("\n"),
    "",
    "## What this file contains — and what it never contains",
    "",
    "Contains: project name and id, a content hash, counts, timings, model/provider identifiers,",
    "track names of frozen tracks, file names of exports, and bounded agent action summaries.",
    "Agent summaries are scalar argument fragments (for `kyx_intent` that can include a SHORT prompt fragment).",
    "",
    "Never contains: audio, note data, project file contents, or anything from the learning ledgers",
    "(the reaction and audio-fit ledgers are prose-free by construction and are not part of this report).",
    "",
    "## How to read the levels",
    "",
    "- `✓` a check ran and passed · `⚠` a check ran and found something to look at · `?` the check could not run here.",
    "- A missing check is never reported as a pass; rerun the report in the environment that has the data.",
    "",
  ].join("\n");

  return {
    version: TRUST_REPORT_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    level,
    verdict,
    markdown,
    json,
  };
}

/** One downloadable artifact: the human-readable markdown plus the machine JSON. */
export function buildTrustReportZip(report: TrustReport, docName: string): { blob: Blob; filename: string } {
  const safeName =
    docName
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project";
  const date = report.generatedAt.slice(0, 10);
  return {
    blob: buildZip([
      { name: "trust-report.md", data: new TextEncoder().encode(report.markdown) },
      { name: "trust-report.json", data: new TextEncoder().encode(`${JSON.stringify(report.json, null, 2)}\n`) },
    ]),
    filename: `kyx-trust-${safeName}-${date}.zip`,
  };
}

/**
 * The whole flow in one call, shared by every surface that offers the report
 * (the export panel and the activity panel). Returns the file name it saved.
 */
export async function downloadTrustReport(services: Services): Promise<string> {
  const input = await collectTrustReportInput(services);
  const report = buildTrustReport(input);
  const { blob, filename } = buildTrustReportZip(report, input.docName);
  downloadBlob(blob, filename);
  return filename;
}

/**
 * Read every source the report needs. Each read is individually guarded and
 * reports its own absence as `null` — a failed read must degrade the report,
 * never break it (the report is exactly the thing you open when something is
 * wrong).
 */
export async function collectTrustReportInput(services: Services, now: Date = new Date()): Promise<TrustReportInput> {
  const doc: ProjectDocument = services.store.getDoc();

  const [journal, snapshots, contentHash] = await Promise.all([
    // Each read is wrapped in `Promise.resolve().then(...)` so a source that is
    // MISSING (not just one that throws) degrades to null instead of taking
    // the whole report down — a minimal host has every right to a report.
    Promise.resolve()
      .then(() => services.core.crashJournal.read())
      .catch(() => null),
    Promise.resolve()
      .then(() => services.core.snapshots.list(doc.id, 50))
      .then((rows) => ({
        count: rows.length,
        latestAt: rows.reduce<string | null>(
          (latest, row) => (row.createdAt && (!latest || row.createdAt > latest) ? row.createdAt : latest),
          null,
        ),
      }))
      .catch(() => null),
    freezeSignature(doc).catch(() => null),
  ]);

  const recovery = (() => {
    try {
      const buffer = readRecoveryBuffer();
      return { buffered: buffer != null && buffer.projectId === doc.id };
    } catch {
      return null;
    }
  })();

  const frozen: TrustReportFrozenTrack[] = [];
  for (const track of doc.tracks) {
    if (!("frozen" in track) || track.frozen == null) continue;
    frozen.push({
      name: track.name,
      staleness: await freezeStaleness(doc, track.frozen.bufferId).catch(() => "unknown" as const),
    });
  }

  const rt = (() => {
    try {
      return services.engine.getRtLoad();
    } catch {
      return null;
    }
  })();
  const diagnostics = (() => {
    try {
      return services.engine.getDiagnostics() as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const numeric = (key: string): number | null => {
    const value = diagnostics?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const audio: TrustReportInput["audio"] = {
    state: typeof diagnostics?.["contextState"] === "string" ? (diagnostics["contextState"] as string) : null,
    xruns: rt?.xruns ?? null,
    maxGapMs: rt?.maxGapMs ?? null,
    schedulerFailures: numeric("schedulerFailedWindows"),
    processorErrors: numeric("processorErrors"),
  };

  const assets = await Promise.resolve()
    .then(() => services.userSamples.list())
    .then((list) => collectAiAssetReceipts(doc, list))
    .catch(() => null);
  const ai =
    assets == null
      ? null
      : (() => {
          const patterns = collectAiPatternReceipts(doc);
          const tracks = collectAiTrackReceipts(doc);
          const models = new Set<string>();
          for (const asset of assets) models.add(`${asset.providerId}/${asset.modelId}`);
          for (const track of tracks) models.add(`${track.providerId}/${track.modelId}`);
          for (const pattern of patterns) models.add(`${pattern.engineId}@${pattern.engineVersion}`);
          return {
            assets: assets.length,
            patterns: patterns.length,
            tracks: tracks.length,
            models: [...models].sort(),
          };
        })();

  const session = currentAgentSession();
  const trust = agentTrustSnapshot();
  const agent: TrustReportInput["agent"] = {
    agent: session?.agent ?? null,
    sessionCalls: session?.calls ?? 0,
    sessionMutations: session?.mutations ?? 0,
    checkpointSaved: session?.checkpointSaved ?? false,
    destructiveEntries: trust.entries.filter((entry) => entry.risk === "destructive").length,
    errorEntries: trust.entries.filter((entry) => entry.isError).length,
    totalEntries: trust.entries.length,
  };

  const miningLog = (() => {
    try {
      const events = readIntentMiningLog();
      // "unresolved ask" has an exact meaning in this log's vocabulary:
      // `clarify` (the parser could not decide) or `model-miss` (the action
      // model missed and it fell back). A `clarify-picked` entry means the
      // human then CHOSE an interpretation — resolved, not a failure.
      const unresolved = events.filter((event) => event.outcome === "clarify" || event.outcome === "model-miss");
      const latestClarify = [...events].reverse().find((event) => event.outcome === "clarify" && event.reason);
      return {
        total: unresolved.length,
        latestReason: latestClarify?.reason ?? null,
      };
    } catch {
      return null;
    }
  })();

  const stamp = lastRenderStamp();

  return {
    docName: doc.name,
    docId: doc.id,
    generatedAt: now,
    contentHash,
    save: {
      status: services.store.saveStatus,
      lastSaveOkAt: journal?.lastSaveOk?.t ?? null,
      lastSessionClean: journal?.lastEvent == null ? null : journal.lastSessionClean,
      lastSaveFailure: journal?.lastEvent?.kind === "save-fail" ? (journal.lastEvent.message ?? "unknown error") : null,
    },
    snapshots,
    recovery,
    frozen,
    audio,
    ai,
    agent,
    jobs: jobSnapshot().jobs.map((job) => ({ kind: job.kind, status: job.status })),
    exportStamp:
      stamp == null
        ? null
        : { fileName: stamp.fileName, hash: stamp.manifest.hash.value, renderedAt: stamp.manifest.renderedAt },
    intentFailures: miningLog,
  };
}
