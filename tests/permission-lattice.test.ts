import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTONOMY_POLICY,
  decidePermission,
  isExternalAgent,
  readDeclaredRevision,
  type AutonomyPolicy,
} from "../src/mcp/permissionLattice";
import {
  checkCommandScope,
  pathContains,
  readScopeDeclaration,
  scopeAllows,
  verifyScope,
  type ScopeDeclaration,
} from "../src/mcp/scope-guard";
import { createDefaultProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";
import type { Command } from "../src/commands/types";
import type { DeltaPath } from "../src/commands/docDelta";

/**
 * PERMISSION LATTICE + SCOPE GUARD (ADR 0065).
 *
 * The lattice is a PURE decision function, so the whole trust table is
 * testable without a store, a DOM or a model. The scope guard is tested on
 * the command's own words — its `base` and its `ops` — because that is the
 * evidence a scoped write carries.
 *
 * The store test is the one that matters most: the revision counter is the
 * substrate the staleness rule stands on, and a counter that moves for the
 * wrong reasons would refuse honest writes.
 */

const CONSENTED: AutonomyPolicy = {
  version: 1,
  allowExternalMutations: true,
  allowDestructive: true,
};

function renameCommand(doc: ProjectDocument, name: string): Command {
  const previous = doc.name;
  return {
    type: "project.rename",
    label: "Rename project",
    execute: (d: ProjectDocument) => ({ ...d, name }),
    undo: (d: ProjectDocument) => ({ ...d, name: previous }),
  };
}

const NOOP: Command = {
  type: "test.noop",
  label: "No-op",
  execute: (d: ProjectDocument) => d,
  undo: (d: ProjectDocument) => d,
};

beforeEach(() => {
  localStorage.clear();
});

describe("permission lattice — the decision table", () => {
  it("never asks for anything on a read", () => {
    const outcome = decidePermission({
      risk: "read",
      agentId: "web-relay",
      policy: DEFAULT_AUTONOMY_POLICY,
    });
    expect(outcome.decision).toBe("auto");
    expect(outcome.code).toBe("OK");
  });

  it("never asks for anything on a runtime call", () => {
    const outcome = decidePermission({
      risk: "runtime",
      agentId: "desktop-stdio",
      policy: DEFAULT_AUTONOMY_POLICY,
    });
    expect(outcome.decision).toBe("auto");
  });

  it("asks before an EXTERNAL agent changes the document", () => {
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "web-relay",
      policy: DEFAULT_AUTONOMY_POLICY,
    });
    expect(outcome.decision).toBe("confirm");
    expect(outcome.code).toBe("MUTATIONS_NOT_ALLOWED");
    expect(outcome.reason).toContain("MCP panel");
  });

  it("asks on every external transport, not just the web relay", () => {
    for (const agentId of ["web-relay", "desktop-stdio", "qmr", "headless"]) {
      const outcome = decidePermission({
        risk: "mutate",
        agentId,
        policy: DEFAULT_AUTONOMY_POLICY,
      });
      expect(outcome.decision, agentId).toBe("confirm");
    }
  });

  it("applies an external agent's write once the user consents", () => {
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "web-relay",
      policy: CONSENTED,
    });
    expect(outcome.decision).toBe("auto");
  });

  it("does not gate the human's own in-app edit", () => {
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "local",
      policy: DEFAULT_AUTONOMY_POLICY,
    });
    expect(outcome.decision).toBe("auto");
  });

  it("REFUSES a locked destructive call instead of prompting for it", () => {
    const outcome = decidePermission({
      risk: "destructive",
      agentId: "web-relay",
      policy: DEFAULT_AUTONOMY_POLICY,
    });
    expect(outcome.decision).toBe("forbid");
    expect(outcome.code).toBe("DESTRUCTIVE_LOCKED");
  });

  it("lets a destructive call through once the user unlocked it", () => {
    const outcome = decidePermission({
      risk: "destructive",
      agentId: "web-relay",
      policy: CONSENTED,
    });
    expect(outcome.decision).toBe("auto");
  });

  it("refuses a write whose declared revision the document has left behind", () => {
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "web-relay",
      policy: CONSENTED,
      declaredRevision: 12,
      currentRevision: 13,
    });
    expect(outcome.decision).toBe("forbid");
    expect(outcome.code).toBe("STALE_REVISION");
    expect(outcome.reason).toContain("12");
    expect(outcome.reason).toContain("13");
  });

  it("refuses a stale write BEFORE consent is considered", () => {
    // Even with consent, a plan computed against an old document is refused:
    // consent given for one document is not consent for another.
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "web-relay",
      policy: CONSENTED,
      declaredRevision: 4,
      currentRevision: 5,
    });
    expect(outcome.code).toBe("STALE_REVISION");
  });

  it("lets a write with a matching revision through", () => {
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "web-relay",
      policy: CONSENTED,
      declaredRevision: 7,
      currentRevision: 7,
    });
    expect(outcome.decision).toBe("auto");
  });

  it("skips the staleness rule when the caller declares nothing", () => {
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "web-relay",
      policy: CONSENTED,
      declaredRevision: null,
      currentRevision: 99,
    });
    expect(outcome.decision).toBe("auto");
  });

  it("skips the staleness rule when the transport cannot report a revision", () => {
    const outcome = decidePermission({
      risk: "mutate",
      agentId: "web-relay",
      policy: CONSENTED,
      declaredRevision: 3,
      currentRevision: null,
    });
    expect(outcome.decision).toBe("auto");
  });
});

describe("isExternalAgent", () => {
  it("treats only a real transport id as external", () => {
    expect(isExternalAgent("web-relay")).toBe(true);
    expect(isExternalAgent("desktop-stdio")).toBe(true);
    expect(isExternalAgent("qmr")).toBe(true);
    expect(isExternalAgent("local")).toBe(false);
    expect(isExternalAgent(null)).toBe(false);
    expect(isExternalAgent(undefined)).toBe(false);
    expect(isExternalAgent("")).toBe(false);
  });
});

describe("readDeclaredRevision", () => {
  it("reads a declared revision and refuses everything else", () => {
    expect(readDeclaredRevision({ projectRevision: 5 })).toBe(5);
    expect(readDeclaredRevision({ projectRevision: "5" })).toBeNull();
    expect(readDeclaredRevision({ projectRevision: Number.NaN })).toBeNull();
    expect(readDeclaredRevision({})).toBeNull();
  });
});

describe("scope guard", () => {
  const trackPath: DeltaPath = ["tracks", { id: "t1" }];
  const gainPath: DeltaPath = ["tracks", { id: "t1" }, "gain"];

  it("knows when one path contains another", () => {
    expect(pathContains(trackPath, gainPath)).toBe(true);
    expect(pathContains(gainPath, trackPath)).toBe(false);
    expect(pathContains(trackPath, trackPath)).toBe(true);
    expect(pathContains(["tracks"], ["tracks", { id: "t1" }])).toBe(true);
    expect(pathContains(["tracks", { id: "t1" }], ["tracks", { id: "t2" }])).toBe(false);
  });

  it("treats a missing allow-list as unrestricted", () => {
    expect(scopeAllows(null, gainPath)).toBe(true);
    expect(scopeAllows({}, gainPath)).toBe(true);
    expect(scopeAllows({ allow: [] }, gainPath)).toBe(true);
  });

  it("honours an allow-list", () => {
    expect(scopeAllows({ allow: [trackPath] }, gainPath)).toBe(true);
    expect(scopeAllows({ allow: [["tracks", { id: "t2" }]] }, gainPath)).toBe(false);
  });

  it("catches a write that leaves its declared scope", () => {
    const base = createDefaultProject();
    const command: Command = {
      type: "test.set",
      label: "Set gain",
      base,
      ops: [{ k: "set", path: gainPath, value: 0.5 }],
      execute: (d: ProjectDocument) => d,
      undo: (d: ProjectDocument) => d,
    };
    const violations = checkCommandScope(command, { allow: [["tracks", { id: "t2" }]] });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("out-of-scope");
  });

  it("catches a write that would touch a protected path", () => {
    const base = createDefaultProject();
    const command: Command = {
      type: "test.set",
      label: "Set gain",
      base,
      ops: [{ k: "set", path: gainPath, value: 0.5 }],
      execute: (d: ProjectDocument) => d,
      undo: (d: ProjectDocument) => d,
    };
    const violations = checkCommandScope(command, { protect: [gainPath] });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("protected-targeted");
  });

  it("reports a protected path that changed, seen AFTER the write", () => {
    const base = createDefaultProject();
    const after = { ...base, name: "changed" } as ProjectDocument;
    const verdict = verifyScope(base, after, [{ k: "set", path: ["name"], value: "changed" }], {
      protect: [["name"]],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0].kind).toBe("protected-changed");
  });

  it("says honestly that a command with no paths cannot be checked", () => {
    const verdict = verifyScope(createDefaultProject(), createDefaultProject(), [], { protect: [["name"]] });
    expect(verdict.ok).toBe(true);
    expect(verdict.verifiable).toBe(false);
  });

  it("reads a scope declaration out of an envelope", () => {
    const scope = readScopeDeclaration({
      scope: { allow: [["tracks", { id: "t1" }]], protect: [["master"]] },
    });
    expect(scope).not.toBeNull();
    expect(scope?.allow).toHaveLength(1);
    expect(scope?.protect).toHaveLength(1);
  });

  it("ignores an envelope with no scope", () => {
    expect(readScopeDeclaration({})).toBeNull();
    expect(readScopeDeclaration({ scope: "nonsense" })).toBeNull();
    expect(readScopeDeclaration({ scope: { allow: "nonsense" } })).toBeNull();
  });

  it("treats a scope with no allow-list as unrestricted but still protects", () => {
    const scope: ScopeDeclaration = { protect: [["name"]] };
    expect(scopeAllows(scope, gainPath)).toBe(true);
  });
});

describe("the document revision (ADR 0065)", () => {
  it("starts at zero and bumps on every applied change", () => {
    const store = new ProjectStore(createDefaultProject());
    expect(store.getRevision()).toBe(0);
    store.execute(renameCommand(store.getDoc(), "Renamed"));
    expect(store.getRevision()).toBe(1);
  });

  it("bumps on undo too — the document moved", () => {
    const store = new ProjectStore(createDefaultProject());
    store.execute(renameCommand(store.getDoc(), "Renamed"));
    const after = store.getRevision();
    store.undo();
    expect(store.getRevision()).toBe(after + 1);
  });

  it("does NOT bump when the command changed nothing", () => {
    const store = new ProjectStore(createDefaultProject());
    store.execute(NOOP);
    expect(store.getRevision()).toBe(0);
  });

  it("bumps once per applied change, not once per read", () => {
    const store = new ProjectStore(createDefaultProject());
    store.getDoc();
    store.getDoc();
    expect(store.getRevision()).toBe(0);
    store.execute(renameCommand(store.getDoc(), "Renamed"));
    expect(store.getRevision()).toBe(1);
  });
});
