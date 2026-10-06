import type { BufferSummary } from "../audio-engine/metering";
import type { MixHealthReport } from "../analysis/mixDoctor";
import type { ProjectDocument } from "../project-model/types";
import type { MasterProfile } from "./profiles";

export interface MasterRenderReportV1 {
  version: 1;
  runId: string;
  projectId: string;
  projectName: string;
  projectRevisionId: string;
  scope: "song" | "pattern";
  sampleRate: number;
  quality: "live" | "studio";
  durationSeconds: number;
  sampleRange: { startFrame: 0; endFrame: number };
  createdAt: string;
  profile: MasterProfile;
  measurements: BufferSummary;
  mixHealth: MixHealthReport;
}

export type MasterRenderReport = MasterRenderReportV1;

let nextRunId = 1;
let nextRevisionId = 1;
const projectRevisionIds = new WeakMap<ProjectDocument, string>();

/** Stable within this app session and unique for each immutable project revision. */
export function projectRevisionIdFor(doc: ProjectDocument): string {
  const existing = projectRevisionIds.get(doc);
  if (existing) return existing;
  const revisionId = `${doc.id}:r${nextRevisionId++}`;
  projectRevisionIds.set(doc, revisionId);
  return revisionId;
}

export function createMasterRenderReport(
  input: Omit<MasterRenderReportV1, "version" | "runId" | "createdAt">,
): MasterRenderReportV1 {
  return {
    version: 1,
    runId: `master-render-${Date.now().toString(36)}-${nextRunId++}`,
    createdAt: new Date().toISOString(),
    ...input,
  };
}
