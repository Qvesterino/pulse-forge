import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { MusicalContextSnapshotV1 } from "../src/analysis/musical-context";
import type { ProjectDocument } from "../src/project-model/types";

process.on("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  process.exit(1);
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function projectDigest(doc: ProjectDocument): string {
  return sha256(doc);
}

async function importWithin<T>(label: string, load: () => Promise<T>): Promise<T> {
  const trace = process.env.KYX_CONTEXT_SMOKE_TRACE === "1";
  if (trace) process.stderr.write(`loading ${label}\n`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      load(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`loading ${label} exceeded its 20 second budget`)), 20_000);
      }),
    ]);
    if (trace) process.stderr.write(`loaded ${label}\n`);
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const { deterministicTestDoc, placeClipAt, sceneAt, useDeterministicIds } = await importWithin(
    "test fixture",
    () => import("../tests/fixtures/doc"),
  );
  const { ticksPerBar } = await importWithin("project schema", () => import("../src/project-model/schema"));
  const { buildMusicalContextSnapshot, parseMusicalContextRequest, MusicalContextInputError } = await importWithin(
    "MusicalContext v1 builder",
    () => import("../src/analysis/musical-context"),
  );
  const restoreIds = useDeterministicIds();
  let cases = 0;

  try {
    const doc = deterministicTestDoc();
    const scene = sceneAt(doc, 0);
    const clipDoc = placeClipAt(doc, scene.id, 0, 8);
    const expectedClipId = clipDoc.arrangement.clips[0]?.id;
    assert.ok(expectedClipId, "fixture must contain the selected eight-bar clip");

    const initialProjectDigest = projectDigest(clipDoc);
    const barTicks = ticksPerBar(clipDoc);
    const request = {
      fromBar: 1,
      toBar: 8,
      goals: ["Increase energy while keeping the vocal forward"],
      protectedElements: ["Do not change the drum groove"],
    };

    const makeSnapshot = (input: Record<string, unknown>): MusicalContextSnapshotV1 =>
      buildMusicalContextSnapshot(clipDoc, parseMusicalContextRequest(clipDoc, input), {
        revision: 0,
        recordingActive: false,
      });

    const first = makeSnapshot(request);
    assert.equal(first.schema, "kyx.musical-context");
    assert.equal(first.version, 1);
    assert.equal(first.project.revisionSource, "project_store");
    assert.equal(first.project.revision, 0);
    assert.equal(first.freshness, "current_at_capture");
    assert.equal(first.scope.startTick, 0);
    assert.equal(first.scope.endTick, 8 * barTicks);
    assert.equal(first.scope.startBar, 1);
    assert.equal(first.scope.endBar, 8);
    assert.equal(first.scope.barAligned, true);
    assert.deepEqual(first.scope.includedClipIds, [expectedClipId]);
    assert.equal(first.time.renderedAudioRange.sampleRate, 44_100);
    assert.equal(first.time.renderedAudioRange.startSample, 0);
    assert.equal(first.time.renderedAudioRange.endExclusive, true);
    assert.equal(first.assistantContract.mode, "read_only_production_notes");
    assert.equal(first.assistantContract.citeEvidenceIds, true);
    assert.equal(first.assistantContract.answerShape.maxFindings, 3);
    assert.equal(first.analysis.status, "not_requested");
    assert.equal(first.evidence.find((item) => item.id === "request.goal.1")?.kind, "preference");
    assert.equal(first.evidence.find((item) => item.id === "request.goal.1")?.provenance.source, "user_request");
    assert.equal(first.evidence.find((item) => item.id === "request.protected.1")?.kind, "preference");
    assert.equal(first.evidence.find((item) => item.id === "request.protected.1")?.provenance.source, "user_request");
    for (const item of first.evidence) {
      assert.ok(["project_fact", "measurement", "estimate", "preference"].includes(item.kind));
      assert.ok(
        ["project_document", "user_request", "runtime_state", "kyx_render_summary"].includes(item.provenance.source),
      );
      assert.ok(Array.isArray(item.invalidatedBy));
    }
    assert.equal(projectDigest(clipDoc), initialProjectDigest, "context snapshot changed the project document");
    cases += 1;

    const selectedTrackId = clipDoc.tracks[0]?.id;
    assert.ok(selectedTrackId, "fixture must contain a track");
    const trackScoped = makeSnapshot({ ...request, trackIds: [selectedTrackId] });
    assert.deepEqual(trackScoped.scope.requestedTrackIds, [selectedTrackId]);
    assert.ok(trackScoped.scope.includedTrackIds.includes(selectedTrackId));
    assert.equal(trackScoped.scope.trackScope, "explicit_tracks");
    assert.equal(
      projectDigest(clipDoc),
      initialProjectDigest,
      "track-scoped context snapshot changed the project document",
    );
    cases += 1;

    const renderRequested = makeSnapshot({ ...request, renderScope: "all" });
    assert.equal(renderRequested.analysis.status, "unavailable");
    assert.equal(renderRequested.analysis.requestedScope, "all");
    assert.match(renderRequested.analysis.reason ?? "", /has not run/i);
    assert.equal(
      renderRequested.evidence.some((item) => item.provenance.source === "kyx_render_summary"),
      false,
      "no render-summary evidence may appear without a renderer",
    );
    assert.equal(
      projectDigest(clipDoc),
      initialProjectDigest,
      "render-unavailable context snapshot changed the project document",
    );
    cases += 1;

    assert.throws(() => makeSnapshot({ fromBar: 1, toBar: 65 }), MusicalContextInputError);
    assert.equal(projectDigest(clipDoc), initialProjectDigest, "invalid context request changed the project document");
    cases += 1;

    const repeated = makeSnapshot(request);
    assert.equal(sha256({ ...first, capturedAt: undefined }), sha256({ ...repeated, capturedAt: undefined }));
    assert.equal(
      projectDigest(clipDoc),
      initialProjectDigest,
      "repeated context snapshot changed the project document",
    );
    cases += 1;

    const report = {
      benchmark: "kyx.musical-context-builder-smoke",
      version: 1,
      result: "passed",
      interpretation:
        "Core snapshot-builder checks only; the MCP transport and musical quality or listener outcome were not evaluated.",
      audioRendered: false,
      mcpTransportExercised: false,
      projectSha256: initialProjectDigest,
      snapshotSha256: sha256({ ...first, capturedAt: undefined }),
      checksPassed: cases,
      checks: [
        "selected range and arrangement clip are represented exactly",
        "user goals and protected elements retain preference provenance",
        "snapshot freshness, revision and read-only assistant contract are explicit",
        "track scoping includes the requested track",
        "a render request remains unavailable without fabricated render-summary evidence",
        "invalid ranges are rejected without changing the fixture document",
        "repeated requests produce the same snapshot content apart from capture time",
      ],
    };
    await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, resolve));
  } finally {
    restoreIds();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
