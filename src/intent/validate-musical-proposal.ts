import { parseProposalConstraints } from "./proposal-constraints";
import type { MusicalProposalV1 } from "./musical-proposal";

type Validation = { ok: true; proposal: MusicalProposalV1 } | { ok: false; reason: string };

/** Validate the complete external representation, including cross-field consistency. */
export function validateMusicalProposal(
  value: unknown,
  context?: { projectId: string; revision: number | null; trackIds: readonly string[] },
): Validation {
  try {
    const fail = (path: string): never => {
      throw new Error(`Invalid proposal: ${path}`);
    };
    const obj = (v: unknown, path: string): Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(path);
    const str = (v: unknown, path: string, empty = false): string =>
      typeof v === "string" && v.length <= 2000 && (empty || v.trim().length > 0) ? v : fail(path);
    const arr = (v: unknown, path: string, max: number): unknown[] =>
      Array.isArray(v) && v.length <= max ? v : fail(path);
    const num = (v: unknown, path: string, nullable = false): void => {
      if (!(nullable && v === null) && (typeof v !== "number" || !Number.isFinite(v))) fail(path);
    };
    const choice = (v: unknown, allowed: readonly string[], path: string): void => {
      if (typeof v !== "string" || !allowed.includes(v)) fail(path);
    };
    const strings = (v: unknown, path: string): void => {
      arr(v, path, 128).forEach((x) => str(x, path));
    };
    const keys = (v: Record<string, unknown>, allowed: string[], path: string): void => {
      if (Object.keys(v).some((key) => !allowed.includes(key))) fail(`${path}: unknown field`);
    };
    const root = obj(value, "root");
    keys(
      root,
      [
        "schema",
        "version",
        "id",
        "base",
        "scope",
        "intent",
        "constraints",
        "candidates",
        "evidence",
        "checks",
        "warnings",
      ],
      "root",
    );
    if (root.schema !== "kyx.musical-proposal" || root.version !== 1) fail("schema/version");
    str(root.id, "id");
    const base = obj(root.base, "base");
    keys(base, ["projectId", "revision", "freshness"], "base");
    str(base.projectId, "base.projectId");
    if (base.revision !== null && (!Number.isSafeInteger(base.revision) || (base.revision as number) < 0))
      fail("base.revision");
    choice(base.freshness, ["current", "stale", "unknown"], "base.freshness");
    if (base.freshness === "current" && base.revision === null) fail("base.revision is required for current freshness");
    if (context && base.projectId !== context.projectId) fail("base.projectId does not match project");
    if (context && base.revision !== null && context.revision !== null && base.revision !== context.revision)
      fail("base.revision is stale");
    const scope = obj(root.scope, "scope");
    keys(scope, ["audition", "writeScope", "targetTrackIds"], "scope");
    choice(scope.writeScope, ["unrestricted", "declared"], "scope.writeScope");
    strings(scope.targetTrackIds, "scope.targetTrackIds");
    if (context && (scope.targetTrackIds as string[]).some((id) => !context.trackIds.includes(id)))
      fail("scope.targetTrackIds contains an unknown track");
    if (scope.audition !== null) {
      const range = obj(scope.audition, "scope.audition");
      keys(range, ["startTick", "endTick"], "scope.audition");
      if (
        !Number.isSafeInteger(range.startTick) ||
        !Number.isSafeInteger(range.endTick) ||
        (range.startTick as number) < 0 ||
        (range.endTick as number) <= (range.startTick as number)
      )
        fail("scope.audition tick range");
    }
    const intent = obj(root.intent, "intent");
    keys(intent, ["label", "goals", "interpreter"], "intent");
    str(intent.label, "intent.label");
    strings(intent.goals, "intent.goals");
    str(intent.interpreter, "intent.interpreter");
    const constraints = obj(root.constraints, "constraints");
    if (constraints.status === "not_declared") {
      keys(constraints, ["status", "items"], "constraints");
      if (!Array.isArray(constraints.items) || constraints.items.length !== 0 || scope.writeScope !== "unrestricted")
        fail("constraints.items/writeScope");
    } else if (constraints.status === "declared") {
      keys(constraints, ["status", "rules"], "constraints");
      if (!parseProposalConstraints(constraints.rules) || scope.writeScope !== "declared")
        fail("constraints.rules/writeScope");
    } else fail("constraints.status");
    const candidates = arr(root.candidates, "candidates", 32);
    if (!candidates.length) fail("candidates must not be empty");
    const ids = new Set<string>();
    candidates.forEach((raw) => {
      const candidate = obj(raw, "candidate");
      keys(candidate, ["id", "changes"], "candidate");
      const id = str(candidate.id, "candidate.id");
      if (ids.has(id)) fail("duplicate candidate.id");
      ids.add(id);
      arr(candidate.changes, "candidate.changes", 512).forEach((entry) => {
        const change = obj(entry, "change");
        keys(change, ["trackId", "device", "parameterChanges", "description", "reason"], "change");
        const trackId = str(change.trackId, "change.trackId");
        if (!(scope.targetTrackIds as string[]).includes(trackId)) fail("change.trackId outside targetTrackIds");
        str(change.device, "change.device");
        str(change.description, "change.description", true);
        str(change.reason, "change.reason", true);
        arr(change.parameterChanges, "change.parameterChanges", 512).forEach((p) => {
          const param = obj(p, "parameterChange");
          keys(param, ["param", "before", "after"], "parameterChange");
          str(param.param, "parameterChange.param");
          num(param.before, "parameterChange.before", true);
          num(param.after, "parameterChange.after");
        });
      });
    });
    const evidence = arr(root.evidence, "evidence", 128);
    const evidenceIds = new Set<string>();
    evidence.forEach((entry) => {
      const item = obj(entry, "evidence item");
      keys(item, ["id", "kind", "source", "metric", "value", "uncertainty"], "evidence item");
      const id = str(item.id, "evidence.id");
      if (evidenceIds.has(id)) fail("duplicate evidence.id");
      evidenceIds.add(id);
      choice(item.kind, ["measurement"], "evidence.kind");
      choice(item.source, ["mix_preview_render"], "evidence.source");
      choice(item.metric, ["integrated_lufs"], "evidence.metric");
      num(item.value, "evidence.value", true);
      str(item.uncertainty, "evidence.uncertainty");
    });
    if (!evidenceIds.has("preview.before.lufs") || !evidenceIds.has("preview.after.lufs"))
      fail("before/after evidence required");
    if (evidence.length !== 2) fail("exactly two preview measurements required");
    const checks = obj(root.checks, "checks");
    keys(checks, ["structural", "acoustic", "subjective"], "checks");
    choice(checks.structural, ["not_checked"], "checks.structural");
    choice(checks.acoustic, ["preview_measured", "unavailable"], "checks.acoustic");
    choice(checks.subjective, ["not_judged"], "checks.subjective");
    if (checks.acoustic === "preview_measured" && evidence.some((item) => obj(item, "evidence").value === null))
      fail("checks.acoustic requires measurements");
    if (checks.acoustic === "unavailable" && evidence.every((item) => obj(item, "evidence").value !== null))
      fail("checks.acoustic contradicts measurements");
    strings(root.warnings, "warnings");
    return { ok: true, proposal: value as MusicalProposalV1 };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Invalid proposal" };
  }
}
