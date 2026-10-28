import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTONOMY_POLICY,
  decidePermission,
  isExternalAgent,
  readAutonomyPolicy,
  readDeclaredRevision,
  type AutonomyPolicy,
} from "../src/mcp/permissionLattice";
import { executeMcpTool } from "../src/mcp/tools";
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
import { withAgentWriter } from "./helpers/mcpAgentWriter";

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
    // The D4 destructive lock is NOT the lattice's rule — it lives at each
    // destructive SITE in the tool layer (it is per-op, runs after argument
    // validation, and carries the auto-checkpoint). This test pins that
    // boundary: the lattice must not pre-empt it.
    const outcome = decidePermission({
      risk: "destructive",
      agentId: "web-relay",
      policy: CONSENTED,
    });
    expect(outcome.decision).toBe("auto");
  });

  it("still asks before an EXTERNAL agent's destructive call without consent", () => {
    const outcome = decidePermission({
      risk: "destructive",
      agentId: "web-relay",
      policy: DEFAULT_AUTONOMY_POLICY,
    });
    expect(outcome.decision).toBe("confirm");
    expect(outcome.code).toBe("MUTATIONS_NOT_ALLOWED");
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

describe("readAutonomyPolicy — the CONTEXT is the source of truth", () => {
  it("reads the external-mutation consent from the context, not from localStorage", () => {
    // The lattice must read the SAME truth the host injected. A lattice that
    // read the persisted flag behind the context's back would refuse calls
    // the host had explicitly unlocked — two truths for one consent.
    const policy = readAutonomyPolicy({ allowMutations: () => true });
    expect(policy.allowExternalMutations).toBe(true);
  });

  it("lets the context REFUSE external mutations even when the persisted flag is on", () => {
    localStorage.setItem("pf:mcp-allow-mutations", "1");
    const policy = readAutonomyPolicy({ allowMutations: () => false });
    expect(policy.allowExternalMutations).toBe(false);
  });

  it("falls back to the persisted flag when the context does not answer", () => {
    localStorage.setItem("pf:mcp-allow-mutations", "1");
    const policy = readAutonomyPolicy();
    expect(policy.allowExternalMutations).toBe(true);
  });

  it("defaults to no consent at all when nothing says otherwise", () => {
    const policy = readAutonomyPolicy();
    expect(policy.allowExternalMutations).toBe(false);
  });
});

describe("the lattice inside the MCP write path", () => {
  it("does not let the lattice pre-empt the tool's own destructive gate", async () => {
    // The regression this pins: the lattice used to read the persisted flag
    // directly and refuse every destructive-classified call the host had
    // unlocked — before the tool's own per-op D4 gate ever ran.
    const store = new ProjectStore(createDefaultProject());
    const result = await executeMcpTool(
      withAgentWriter({
        getDoc: () => store.getDoc(),
        execute: (command) => store.execute(command),
        undo: () => store.undo(),
        redo: () => store.redo(),
        undoStackLength: () => store.undoStackLength,
        historyLabels: () => store.history.map((entry) => entry.label),
        isMicRecordingActive: () => false,
        transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
        allowDestructive: () => true,
      }),
      "kyx_tracks",
      { op: "addDrum" },
    );
    expect(result.errorCode).toBeUndefined();
    expect(result.isError).toBeFalsy();
    expect(result.mutated).toBe(true);
  });

  it("refuses an external agent's mutating call without standing consent", async () => {
    const store = new ProjectStore(createDefaultProject());
    const result = await executeMcpTool(
      withAgentWriter({
        getDoc: () => store.getDoc(),
        execute: (command) => store.execute(command),
        undo: () => store.undo(),
        redo: () => store.redo(),
        undoStackLength: () => store.undoStackLength,
        historyLabels: () => store.history.map((entry) => entry.label),
        isMicRecordingActive: () => false,
        transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
        agentId: "web-relay",
        allowMutations: () => false,
      }),
      "kyx_tracks",
      { op: "addDrum" },
    );
    expect(result.errorCode).toBe("CONFIRMATION_REQUIRED");
    expect(result.isError).toBe(true);
    expect(result.mutated).toBe(false);
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
