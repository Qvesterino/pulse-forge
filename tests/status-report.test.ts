import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildStatusReport, type StatusClaim, type ManualGate } from "../src/services/statusReport";

/**
 * STATUS REPORT — the honesty rules of the public proof page.
 *
 * The load-bearing specs: a PENDING manual gate never renders as a pass, a
 * failed command never renders as a pass, and the stable JSON payload does not
 * contain a timestamp — which is what lets the drift gate compare it with HEAD
 * at all. A volatile "status" file would be unverifiable by construction.
 */

function claim(overrides: Partial<StatusClaim> = {}): StatusClaim {
  return {
    id: "c1",
    claim: "Something holds",
    command: "npm run something",
    state: "pass",
    summary: "exit 0",
    freshness: "drift-checked",
    ...overrides,
  };
}

function gate(overrides: Partial<ManualGate> = {}): ManualGate {
  return { id: "g1", claim: "A human gate", command: "manual", state: "pending", note: "", ...overrides };
}

function report(overrides: Partial<Parameters<typeof buildStatusReport>[0]> = {}) {
  return buildStatusReport({
    generatedAt: new Date("2026-10-17T17:00:00.000Z"),
    claims: [claim()],
    manualGates: [gate()],
    runByCi: [{ claim: "Full suite", command: "npm run test:expectations" }],
    ...overrides,
  });
}

describe("buildStatusReport — honesty of the rows", () => {
  it("renders a pending manual gate as PENDING and NEVER as a pass", () => {
    const built = report({ manualGates: [gate({ state: "pending", note: "not run yet" })] });
    expect(built.markdown).toContain("… PENDING");
    expect(built.markdown).not.toContain("✓ PASS | A human gate");
    expect(built.markdown).toContain("not run yet");
    expect(built.counts).toMatchObject({ pass: 1, pending: 1 });
  });

  it("renders a failed command as FAIL, with the measured summary", () => {
    const built = report({ claims: [claim({ state: "fail", summary: "exit 1 · 2 mismatches" })] });
    expect(built.markdown).toContain("✗ FAIL");
    expect(built.markdown).toContain("exit 1 · 2 mismatches");
    expect(built.counts.fail).toBe(1);
  });

  it("never fabricates a result for the commands it refuses to run", () => {
    const built = report({ runByCi: [{ claim: "Full suite", command: "npm run test:expectations" }] });
    const section = built.markdown.split("## Deliberately not run")[1] ?? "";
    expect(section).toContain("npm run test:expectations");
    // The line is a command, not a claim of a result.
    expect(section).not.toContain("PASS");
    expect(section).not.toContain("exit 0");
  });

  it("states the freshness contract on the page itself", () => {
    const built = report();
    expect(built.markdown).toContain("drift-checked");
    expect(built.markdown).toContain("at-generation");
    expect(built.markdown).toContain("A row is PASS only from a real exit code");
  });
});

describe("buildStatusReport — the stable payload the drift gate compares", () => {
  it("does NOT contain a timestamp in the JSON (a volatile file cannot be verified)", () => {
    const first = report({ generatedAt: new Date("2026-10-17T17:00:00.000Z") });
    const second = report({ generatedAt: new Date("2027-01-01T09:30:00.000Z") });
    expect(JSON.stringify(second.json)).toBe(JSON.stringify(first.json));
    // …while the human page does carry when it was generated.
    expect(first.markdown).toContain("2026-10-17T17:00:00.000Z");
    expect(second.markdown).toContain("2027-01-01T09:30:00.000Z");
  });

  it("changes the payload when a claim changes (the gate can actually fire)", () => {
    const pass = report({ claims: [claim({ state: "pass" })] });
    const fail = report({ claims: [claim({ state: "fail" })] });
    expect(JSON.stringify(fail.json)).not.toBe(JSON.stringify(pass.json));
  });
});

describe("the committed status artifact", () => {
  it("exists, parses, and is honest about the manual gates", () => {
    const committed = JSON.parse(readFileSync("docs/status.json", "utf8")) as {
      claims: StatusClaim[];
      manualGates: ManualGate[];
      runByCi: Array<{ claim: string; command: string }>;
    };
    expect(committed.claims.length).toBeGreaterThanOrEqual(4);
    for (const row of committed.claims) {
      // Only a real state is allowed in the artifact.
      expect(["pass", "fail", "pending", "not-run"]).toContain(row.state);
      expect(row.command.length).toBeGreaterThan(0);
    }
    // The owner gates are the OWNER's to close: until they do, this file says so.
    for (const gate of committed.manualGates) {
      if (gate.state === "pass") expect(gate.note, `${gate.id} claims pass without evidence`).not.toBe("");
    }
    expect(committed.runByCi.length).toBeGreaterThan(0);
  });
});
