/**
 * KYX MCP — PERMISSION LATTICE (ADR 0065).
 *
 * The trust layer classifies every call but never DECIDES anything.
 * `effectiveRisk()` answers "how dangerous is this?" — the lattice answers
 * "what happens now?". Before this module, the answer was implicit:
 * a `destructive` call needed a standing user flag, and everything else —
 * including 21 MUTATING calls — applied without asking anyone.
 *
 * The audit that produced this (AAW frontier program, 2026-10-25) found the
 * gap in code, not in theory: of the 39 MCP tools, 3 are `read`, 8 are
 * `runtime`, 21 are `mutate` and 7 are `destructive`. Only the 7 destructive
 * ones were gated. The other 21 could rewrite the user's project with no
 * consent of any kind — the mitigations (checkpoint, audit log, undo frame,
 * read-back) are RECOVERY mechanisms, not CONSENT mechanisms.
 *
 * THE DESIGN
 * ----------
 * The lattice reuses the vocabulary that already exists — `ToolRisk`
 * (read | runtime | mutate | destructive) — because a second taxonomy would
 * be a second truth. It adds exactly one new concept: a DECISION.
 *
 *   auto     — apply it
 *   confirm  — the user must say yes (a proposal the user approves)
 *   forbid   — do not apply it, and say why
 *
 * The rules are ordered, total and PURE: same inputs, same decision, always.
 * That is what makes the lattice testable without a store, a DOM, or a model.
 *
 * THE TRANSPORT SPLIT — the one decision that matters
 * --------------------------------------------------
 * An agent arriving over the MCP relay (`web-relay`, `desktop-stdio`, `qmr`,
 * `headless`) is NOT the person sitting in the app. ZYVO already learned this
 * the hard way: its external MCP surface is draft-only, autonomy is not
 * forwarded across the stdio boundary, and acceptance is a UI click.
 * KYX did not have that. So:
 *
 *   local      (the human in the UI, or a test) → mutating calls stay `auto`;
 *               the in-app intent flow already previews and applies through
 *               the human's own hands.
 *   external   (an agent over a transport)      → mutating calls need the
 *               user's standing consent, OFF by default.
 *
 * `forbid` is used for the two cases that must never be a yes/no prompt:
 * a locked destructive call, and a write whose declared revision no longer
 * matches the live one.
 */
import type { ToolRisk } from "./agentTrust";
import { mcpAllowMutations } from "./flags";

/** What the lattice decided to do with a call. */
export type PermissionDecision = "auto" | "confirm" | "forbid";

/** Why — a stable code the caller can branch on, plus a human-readable line. */
export type PermissionCode = "OK" | "MUTATIONS_NOT_ALLOWED" | "CONFIRMATION_REQUIRED" | "STALE_REVISION";

export interface PermissionOutcome {
  decision: PermissionDecision;
  code: PermissionCode;
  /** One line, safe to show a user or an agent. */
  reason: string;
  /** The risk class the decision was made from. */
  risk: ToolRisk;
}

/**
 * The user-side autonomy policy. It is a VERSIONED, user-controlled object:
 * a model may never raise it, and it never survives a project switch without
 * the user re-confirming it. It is read from the same localStorage flags the
 * product already uses for its trust toggles.
 */
export interface AutonomyPolicy {
  version: 1;
  /** Standing consent for EXTERNAL agents to apply mutating calls. */
  allowExternalMutations: boolean;
}

/**
 * The default is the CONSERVATIVE one for external agents and the LEGACY one
 * for the human: an external agent may not mutate until the user says so.
 */
export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  version: 1,
  allowExternalMutations: false,
};

/**
 * True when the call came from an agent over a transport rather than from the
 * human working the app. `local` (and an absent id — headless tests) are the
 * human's own surface.
 */
export function isExternalAgent(agentId: string | null | undefined): boolean {
  return typeof agentId === "string" && agentId !== "" && agentId !== "local";
}

export interface PermissionInput {
  /** The risk class of the call (from `effectiveRisk`). */
  risk: ToolRisk;
  /** The attributed caller: "local" for the human, a transport id otherwise. */
  agentId?: string | null;
  /** The user's standing consent. */
  policy: AutonomyPolicy;
  /**
   * The revision the caller says it planned against. When present AND the
   * live revision is known, a mismatch means the plan was computed against a
   * document that no longer exists. Absent = the caller did not opt in.
   */
  declaredRevision?: number | null;
  /** The live revision. Absent = the transport cannot report one. */
  currentRevision?: number | null;
}

/**
 * THE DECISION FUNCTION. Pure, total, ordered.
 *
 * The order matters and is not arbitrary:
 *   1. a stale revision is refused before consent is even considered — a
 *      consent given for an old document is not consent for this one,
 *   2. an EXTERNAL agent's document change needs the user's standing consent,
 *   3. everything else is allowed.
 *
 * WHAT THE LATTICE DOES NOT DECIDE — and why.
 *
 * The D4 destructive lock is NOT here. It stays in the tool layer, at each
 * destructive SITE, because it is finer-grained than this function can be:
 * `effectiveRisk()` classifies a whole TOOL, while the lock is per OPERATION
 * (a tool that also has a safe op is not wholly destructive), it runs AFTER
 * the tool validates its arguments (so a malformed request is still reported
 * as malformed, not as a policy problem), and it carries the auto-checkpoint
 * side effect. A central gate here would be coarser, would fire earlier, and
 * would break both of those contracts.
 *
 * The lattice owns what only it can own: the external-transport consent and
 * the revision check.
 */
export function decidePermission(input: PermissionInput): PermissionOutcome {
  const { risk, agentId, policy, declaredRevision, currentRevision } = input;

  if (
    typeof declaredRevision === "number" &&
    typeof currentRevision === "number" &&
    declaredRevision !== currentRevision
  ) {
    return {
      decision: "forbid",
      code: "STALE_REVISION",
      reason: `This plan was computed against revision ${declaredRevision}, but the project is now at revision ${currentRevision}. Re-read the project and plan again.`,
      risk,
    };
  }

  if (isExternalAgent(agentId) && (risk === "mutate" || risk === "destructive") && !policy.allowExternalMutations) {
    return {
      decision: "confirm",
      code: "MUTATIONS_NOT_ALLOWED",
      reason:
        "An external agent asked to change the project. The user has not allowed agent-driven edits yet — enable them in the KYX MCP panel, or ask the user to run this change.",
      risk,
    };
  }

  return {
    decision: "auto",
    code: "OK",
    reason: risk === "mutate" || risk === "destructive" ? "In-app edit." : "No document change.",
    risk,
  };
}

/**
 * Read the revision a caller declared, if any. The envelope may carry
 * `projectRevision` — the revision the plan was computed against. A caller
 * that does not declare one opts out of the staleness rule entirely.
 */
export function readDeclaredRevision(envelope: Record<string, unknown>): number | null {
  const raw = envelope["projectRevision"];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Where the standing consent comes from.
 *
 * The MCP CONTEXT is the injection point — the same kind of hook the
 * pre-existing destructive gate already uses (`ctx.allowDestructive?.()`). A
 * host, a test or an embedder can therefore override the consent without
 * touching the persisted flags. The persisted flag is the FALLBACK, used
 * only when the context does not answer.
 *
 * This matters: a lattice that read `localStorage` behind the context's back
 * would refuse calls the host had explicitly unlocked — two sources of truth
 * for one consent.
 */
export interface PermissionPolicySource {
  /** ADR 0065: standing consent for an external agent to apply mutating calls. */
  allowMutations?: () => boolean;
}

/**
 * Read the user's standing consent.
 *
 * This is the ONLY impure function in this module: `decidePermission` stays
 * pure so the decision table can be tested without a DOM, a store, or a
 * model. The flag is read LIVE on every call, so flipping a toggle takes
 * effect immediately without rebinding the host.
 */
export function readAutonomyPolicy(source?: PermissionPolicySource): AutonomyPolicy {
  return {
    version: 1,
    allowExternalMutations: source?.allowMutations?.() ?? mcpAllowMutations(),
  };
}
