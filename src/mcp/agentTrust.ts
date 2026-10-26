/**
 * AGENT TRUST LAYER (Wave 1/A) — the missing product layer over the MCP
 * surface: risk classification, session checkpoints and a local audit log.
 *
 * WHAT THIS IS
 * ------------
 * The MCP layer has had a single executor (`executeMcpTool`) for a while, and
 * destructive ops were gated behind one user flag with auto-checkpoints at a
 * handful of call sites. What was missing is what makes an agentic DAW
 * trustworthy rather than merely capable:
 *
 *  1. RISK CLASSIFICATION — every tool carries a machine-readable risk class
 *     (read / runtime / mutate / destructive). It feeds the MCP-standard
 *     `annotations` block on each tool definition (so external clients can
 *     decide autonomy per spec) and decides whether a call may mutate the
 *     document at all.
 *  2. SESSION CHECKPOINT — the FIRST mutating call of an agent session saves
 *     a checkpoint BEFORE it runs. One clone per session, not per call. That
 *     is what makes "revert everything this agent just did" a single action.
 *  3. AUDIT LOG — every call (all transports, including dry-runs and
 *     idempotent replays) appends a bounded, local-only entry: who, what,
 *     risk, whether it mutated, error code, duration. This is the raw
 *     material of the AI History panel.
 *
 * ETIQUETTE (same as the intent failure log): LOCAL ONLY, bounded (≤200
 * entries), defensive on read (storage is user-tamperable), no user content
 * beyond a capped scalar summary of the arguments.
 */

export type ToolRisk = "read" | "runtime" | "mutate" | "destructive";

/**
 * The risk table for the whole tool surface. Classification follows the
 * handler semantics (docs/MCP-AGENT-SURFACE-AUDIT-2026-10-06.md):
 *
 *  - "read"        never touches the document or runtime (state/meter/catalog)
 *  - "runtime"     drives runtime/network/file state but does NOT change the
 *                  document (transport, export, audio preview, gallery
 *                  publish, render/diagnose reports) — the same set the
 *                  dry-run policy refuses, because a dry-run cannot un-play a
 *                  note or un-write a file
 *  - "mutate"      changes the document through the command layer
 *  - "destructive" CONTAINS removal operations (gated by
 *                  `pf:mcp-allow-destructive` at the call site)
 *
 * A tool that is not listed is treated as "mutate": conservative by
 * construction, so a newly added tool can never ship as an unchecked read.
 * tests/agent-trust.test.ts pins full coverage of MCP_TOOLS.
 */
export const TOOL_RISK: Readonly<Record<string, ToolRisk>> = {
  // ── reads ────────────────────────────────────────────────────────────────
  kyx_state: "read",
  kyx_meter: "read",
  kyx_catalog: "read",
  // ── runtime / side effects on the outside world ──────────────────────────
  kyx_transport: "runtime",
  kyx_save: "runtime",
  kyx_export: "runtime",
  kyx_audio_preview: "runtime",
  kyx_publish_gallery: "runtime",
  kyx_render_summary: "runtime",
  kyx_diagnose_mix: "runtime",
  kyx_blind_ab: "runtime",
  // ── destructive (contain removals) ───────────────────────────────────────
  kyx_tracks: "destructive",
  kyx_fx: "destructive",
  kyx_clips: "destructive",
  kyx_takes: "destructive",
  kyx_master: "destructive",
  kyx_notes: "destructive",
  kyx_sections: "destructive",
  // ── mutations ────────────────────────────────────────────────────────────
  kyx_intent: "mutate",
  kyx_undo: "mutate",
  kyx_generate: "mutate",
  kyx_groove: "mutate",
  kyx_markers: "mutate",
  kyx_pattern: "mutate",
  kyx_steps: "mutate",
  kyx_music: "mutate",
  kyx_plugin_param: "mutate",
  kyx_instrument_param: "mutate",
  kyx_automation: "mutate",
  kyx_batch: "mutate",
  kyx_loudness: "mutate",
  kyx_import_sfz: "mutate",
  kyx_mix_idea: "mutate",
  kyx_checkpoint: "mutate",
  kyx_mix: "mutate",
  kyx_arrange: "mutate",
  kyx_song: "mutate",
  kyx_routing: "mutate",
  kyx_unsuno: "mutate",
};

/** Risk of a tool; unknown tools are conservatively "mutate". */
export function toolRisk(name: string): ToolRisk {
  return TOOL_RISK[name] ?? "mutate";
}

/**
 * Per-call refinement of the static class. This is the risk the executor
 * audits, starts a session checkpoint for, and publishes as `result.risk`
 * (and `_meta["kyx/risk"]` on the wire). The static `annotations` stay
 * conservative because a client reads them before it has arguments.
 *
 * The mappings below are deliberately operation-level: adding a track is not
 * a removal, listing is not an edit, `kyx_generate replace` overwrites content,
 * and a batch is as risky as its riskiest child.
 */
export function effectiveRisk(name: string, args: unknown): ToolRisk {
  const risk = toolRisk(name);
  const record =
    args != null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const op = typeof record.op === "string" ? record.op : typeof record.action === "string" ? record.action : "";
  switch (name) {
    case "kyx_checkpoint":
      return op === "save" || op === "list" || op === "diff" ? "read" : risk;
    case "kyx_generate":
      return record.replaceMode === "replace" ? "destructive" : "mutate";
    case "kyx_tracks":
      return op === "listPresets" ? "read" : op === "remove" ? "destructive" : "mutate";
    case "kyx_fx":
      return op === "remove" ? "destructive" : "mutate";
    case "kyx_sections":
      return op === "list" ? "read" : op === "remove" ? "destructive" : "mutate";
    case "kyx_markers":
      return op === "list" ? "read" : op === "remove" ? "destructive" : "mutate";
    case "kyx_pattern":
      return op === "list" ? "read" : "mutate";
    case "kyx_notes":
      return op === "list" ? "read" : op === "delete" ? "destructive" : "mutate";
    case "kyx_automation":
      return op === "listTargets" ? "read" : op === "clearLane" || op === "removeLane" ? "destructive" : "mutate";
    case "kyx_clips":
      if (op === "list" || op === "audioList" || op === "copy") return "read";
      if (op === "delete" || op === "cut" || op === "deleteRipple" || op === "audioDelete") return "destructive";
      return "mutate";
    case "kyx_routing":
      return op === "list" ? "read" : op === "removeReturn" ? "destructive" : "mutate";
    case "kyx_takes":
      return op === "list" ? "read" : op === "deleteTake" ? "destructive" : "mutate";
    case "kyx_master":
      if (op === "status") return "read";
      if (op === "stems") return "runtime";
      if (op === "remove") return "destructive";
      if (op === "ab") {
        const action = typeof record.action === "string" ? record.action : "list";
        if (action === "list" || action === "compare") return "read";
        if (action === "save") return "runtime";
      }
      return "mutate";
    case "kyx_loudness":
      return op === "measure" ? "runtime" : "mutate";
    case "kyx_mix_idea":
      if (record.apply === true) return "mutate";
      return record.preview === true ? "runtime" : "read";
    case "kyx_blind_ab":
      return op === "record" || op === "reset" ? "runtime" : "read";
    case "kyx_transport":
      return op === "state" ? "read" : "runtime";
    case "kyx_export":
      return record.autofix === true ? "mutate" : "runtime";
    case "kyx_unsuno":
      return op === "similarity" ? "read" : "mutate";
    case "kyx_batch": {
      if (!Array.isArray(record.calls)) return "mutate";
      const rank: Record<ToolRisk, number> = { read: 0, runtime: 1, mutate: 2, destructive: 3 };
      let highest: ToolRisk = "read";
      for (const entry of record.calls) {
        if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
          highest = "mutate";
          continue;
        }
        const call = entry as { tool?: unknown; args?: unknown };
        if (typeof call.tool !== "string") {
          highest = "mutate";
          continue;
        }
        const child = effectiveRisk(call.tool, call.args);
        if (rank[child] > rank[highest]) highest = child;
      }
      return highest;
    }
    default:
      return risk;
  }
}

/** True when a call with this risk changes the project document. */
export function mutatesDocument(risk: ToolRisk): boolean {
  return risk === "mutate" || risk === "destructive";
}

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/** MCP-standard annotations derived from the risk table (spec 2025-06-18). */
export function toolAnnotations(name: string): McpToolAnnotations {
  const risk = toolRisk(name);
  return {
    readOnlyHint: risk === "read",
    destructiveHint: risk === "destructive",
    idempotentHint: risk === "read",
  };
}

/**
 * Tools that can take a long time (the transports already classify them with
 * the extended 60 s call timeout — desktop/mcp-host-manager.cjs
 * LONG_RUNNING_MCP_TOOLS, server/mcp-core.mjs longCallTimeoutMs). Mirrored
 * here so the Job Center surfaces exactly the calls a user would wait on.
 */
export const LONG_RUNNING_AGENT_TOOLS: ReadonlySet<string> = new Set([
  "kyx_export",
  "kyx_audio_preview",
  "kyx_loudness",
  "kyx_import_sfz",
  "kyx_batch",
  "kyx_render_summary",
  "kyx_diagnose_mix",
  "kyx_arrange",
  "kyx_song",
]);

// ── Audit log ─────────────────────────────────────────────────────────────

export const AGENT_AUDIT_KEY = "pf:agent-audit-v1";
export const AGENT_AUDIT_CAP = 200;
/** A mutating call after this much silence starts a NEW session (and the
 *  next session's pre-checkpoint), so "revert session" never reaches across
 *  a coffee break into work the user actually meant. */
export const AGENT_SESSION_IDLE_MS = 15 * 60 * 1000;

const RISKS: ReadonlySet<string> = new Set(["read", "runtime", "mutate", "destructive"]);

export interface AgentAuditEntry {
  id: number;
  ts: number;
  agent: string;
  tool: string;
  risk: ToolRisk;
  depth: number;
  mutated: boolean;
  isError: boolean;
  errorCode?: string;
  durationMs: number;
  docId: string;
  docName?: string;
  replayed?: boolean;
  dryRun?: boolean;
  /** Session checkpoint saved by THIS call (first mutation of a session). */
  checkpoint?: string;
  /** Bounded scalar summary of the arguments — never the full payload. */
  summary?: string;
}

export interface AgentSession {
  id: string;
  agent: string;
  docId: string;
  docName: string;
  startedAt: number;
  lastAt: number;
  /** The checkpoint taken BEFORE this session's first mutation. */
  checkpointName: string;
  /** Set once the checkpoint was actually saved by the caller. */
  checkpointSaved: boolean;
  calls: number;
  mutations: number;
}

export interface AgentTrustSnapshot {
  session: AgentSession | null;
  entries: AgentAuditEntry[];
  /** Monotonic revision — cheap identity for React consumers. */
  revision: number;
}

// ── internal state ────────────────────────────────────────────────────────

let entries: AgentAuditEntry[] = [];
let session: AgentSession | null = null;
let nextEntryId = 1;
let sessionCounter = 0;
let revision = 0;
let snapshot: AgentTrustSnapshot = { session: null, entries: [], revision: 0 };
let loadedFromStorage = false;
const listeners = new Set<() => void>();

function isValidEntry(value: unknown): value is AgentAuditEntry {
  if (value == null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "number" &&
    typeof entry.ts === "number" &&
    typeof entry.agent === "string" &&
    typeof entry.tool === "string" &&
    typeof entry.risk === "string" &&
    RISKS.has(entry.risk) &&
    typeof entry.mutated === "boolean" &&
    typeof entry.isError === "boolean" &&
    typeof entry.durationMs === "number" &&
    typeof entry.docId === "string" &&
    (entry.depth === undefined || typeof entry.depth === "number")
  );
}

function safeRead(): AgentAuditEntry[] {
  try {
    const raw = localStorage.getItem(AGENT_AUDIT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

function safeWrite(list: AgentAuditEntry[]): void {
  try {
    localStorage.setItem(AGENT_AUDIT_KEY, JSON.stringify(list));
  } catch {
    /* quota/blocked — the log is best-effort */
  }
}

function ensureLoaded(): void {
  if (loadedFromStorage) return;
  loadedFromStorage = true;
  const stored = safeRead();
  if (stored.length > 0) {
    for (const entry of stored) nextEntryId = Math.max(nextEntryId, entry.id + 1);
    // Newest last; stored is already ordered oldest → newest.
    entries = stored.slice(-AGENT_AUDIT_CAP);
  }
}

function notify(): void {
  revision += 1;
  snapshot = { session, entries, revision };
  for (const listener of [...listeners]) listener();
}

/**
 * Bounded scalar summary of tool arguments for the audit log: primitives and
 * array lengths only, each capped, total capped. The audit NEVER stores full
 * payloads (a kyx_notes call can carry hundreds of notes).
 */
export function summarizeToolArgs(args: unknown, cap = 220): string {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === "requestId") continue;
    let rendered: string | null = null;
    if (typeof value === "string") rendered = `${key}="${value.slice(0, 48)}"`;
    else if (typeof value === "number" && Number.isFinite(value)) rendered = `${key}=${value}`;
    else if (typeof value === "boolean") rendered = `${key}=${value ? "true" : "false"}`;
    else if (Array.isArray(value)) rendered = `${key}=[${value.length}]`;
    else if (value != null && typeof value === "object") rendered = `${key}={…}`;
    if (rendered != null) parts.push(rendered);
    if (parts.join(" ").length >= cap) break;
  }
  return parts.join(" ").slice(0, cap);
}

export interface PrepareAgentCallInput {
  agent: string;
  tool: string;
  risk: ToolRisk;
  docId: string;
  docName: string;
}

export interface PrepareAgentCallResult {
  /** Non-null when the caller MUST save a checkpoint with this name BEFORE
   *  executing the call — the first mutation of a fresh session. */
  checkpointName: string | null;
  sessionId: string | null;
}

/**
 * Pre-dispatch hook. Starts a session (and requests the pre-session
 * checkpoint) on the first mutating call; touches `lastAt` otherwise.
 */
export function prepareAgentCall(input: PrepareAgentCallInput): PrepareAgentCallResult {
  ensureLoaded();
  const now = Date.now();
  if (!mutatesDocument(input.risk)) {
    if (session && session.docId === input.docId) session.lastAt = now;
    return { checkpointName: null, sessionId: session?.id ?? null };
  }
  const stale =
    session == null ||
    session.docId !== input.docId ||
    session.agent !== input.agent ||
    now - session.lastAt > AGENT_SESSION_IDLE_MS;
  if (stale) {
    sessionCounter += 1;
    session = {
      id: `s${now.toString(36)}-${sessionCounter}`,
      agent: input.agent,
      docId: input.docId,
      docName: input.docName,
      startedAt: now,
      lastAt: now,
      checkpointName: `agent-session-${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
      checkpointSaved: false,
      calls: 0,
      mutations: 0,
    };
    notify();
    return { checkpointName: session.checkpointName, sessionId: session.id };
  }
  const active = session;
  if (active == null) return { checkpointName: null, sessionId: null };
  active.lastAt = now;
  return { checkpointName: null, sessionId: active.id };
}

/** The caller saved the requested checkpoint — the session is recoverable. */
export function markSessionCheckpointSaved(sessionId: string): void {
  if (session == null || session.id !== sessionId) return;
  session.checkpointSaved = true;
  notify();
}

export type CompleteAgentCallInput = Omit<AgentAuditEntry, "id" | "ts">;

/** Post-dispatch hook: append the audit entry and update the session. */
export function completeAgentCall(input: CompleteAgentCallInput): void {
  ensureLoaded();
  const entry: AgentAuditEntry = { ...input, id: nextEntryId, ts: Date.now() };
  nextEntryId += 1;
  entries = [...entries, entry];
  while (entries.length > AGENT_AUDIT_CAP) entries.shift();
  safeWrite(entries);
  if (session != null && session.docId === input.docId) {
    session.calls += 1;
    if (input.mutated) session.mutations += 1;
    session.lastAt = Date.now();
  }
  notify();
}

/** End the current session (after a revert, or by explicit user action). */
export function endAgentSession(): AgentSession | null {
  const ended = session;
  session = null;
  if (ended != null) notify();
  return ended;
}

export function currentAgentSession(): AgentSession | null {
  ensureLoaded();
  return session;
}

/** Stable snapshot for `useSyncExternalStore` consumers. */
export function agentTrustSnapshot(): AgentTrustSnapshot {
  ensureLoaded();
  return snapshot;
}

export function subscribeAgentTrust(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readAgentAudit(): AgentAuditEntry[] {
  ensureLoaded();
  return [...entries];
}

export function clearAgentAudit(): void {
  entries = [];
  safeWrite(entries);
  notify();
}

/** Test/diagnostic hook — module state is per-window by design. */
export function resetAgentTrustForTests(): void {
  entries = [];
  session = null;
  nextEntryId = 1;
  sessionCounter = 0;
  revision = 0;
  snapshot = { session: null, entries: [], revision: 0 };
  loadedFromStorage = false;
  listeners.clear();
}
