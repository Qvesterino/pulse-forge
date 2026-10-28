import { describe, expect, it } from "vitest";
import { checkProposalConstraints, parseProposalConstraints } from "../src/intent/proposal-constraints";
import type { ProjectDocument } from "../src/project-model/types";

const doc = (tracks: unknown) => ({ id: "project", tracks }) as ProjectDocument;

describe("proposal constraints", () => {
  it("rejects malformed rules and dangerous or empty paths", () => {
    expect(parseProposalConstraints({ allow: [[]] })).toBeNull();
    expect(parseProposalConstraints({ protect: [["__proto__"]] })).toBeNull();
    expect(parseProposalConstraints({ allow: [[{ id: "" }]] })).toBeNull();
    expect(parseProposalConstraints({ unknown: [] })).toBeNull();
    expect(parseProposalConstraints({ allow: [] })).toEqual({ allow: [] });
  });

  it("checks the actual document delta and refuses protected or out-of-scope changes", () => {
    const before = doc([
      { id: "kick", gain: 1 },
      { id: "bass", gain: 1 },
    ]);
    const after = doc([
      { id: "kick", gain: 1 },
      { id: "bass", gain: 0.5 },
    ]);
    expect(checkProposalConstraints(before, after, { allow: [["tracks", { id: "bass" }]] }).ok).toBe(true);
    expect(checkProposalConstraints(before, after, { protect: [["tracks", { id: "bass" }, "gain"]] }).ok).toBe(false);
    expect(checkProposalConstraints(before, after, { allow: [["tracks", { id: "kick" }]] }).ok).toBe(false);
    expect(checkProposalConstraints(before, after, { allow: [] }).ok).toBe(false);
    expect(checkProposalConstraints(before, before, { allow: [] }).ok).toBe(true);
    expect(checkProposalConstraints(before, { ...after, id: "other" }, {}).ok).toBe(false);
  });
});
