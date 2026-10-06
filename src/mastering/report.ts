import type { BufferSummary } from "../audio-engine/metering";
import type { MixHealthReport } from "../analysis/mixDoctor";
import type { ProjectDocument } from "../project-model/types";
import packageMetadata from "../../package.json";
import type { EncodedMasterInspection } from "./encodedInspection";
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

export interface MasterRenderReportV2 extends Omit<MasterRenderReportV1, "version"> {
  version: 2;
  /** Null for an analysis-only run; populated only after the encoded file is inspected. */
  encodedDelivery: EncodedMasterInspection | null;
}

export type MasterRenderReport = MasterRenderReportV2;

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
  input: Omit<MasterRenderReportV2, "version" | "runId" | "createdAt" | "encodedDelivery">,
): MasterRenderReportV2 {
  return {
    version: 2,
    runId: `master-render-${Date.now().toString(36)}-${nextRunId++}`,
    createdAt: new Date().toISOString(),
    encodedDelivery: null,
    ...input,
  };
}

/** Stable JSON sidecar envelope for sharing a measured project master. */
export function serializeMasterReportSidecar(report: MasterRenderReport, generatedAt = new Date()): string {
  return JSON.stringify(
    {
      schema: "kyx.master-report",
      schemaVersion: 1,
      generatedAt: generatedAt.toISOString(),
      application: {
        product: packageMetadata.productName,
        package: packageMetadata.name,
        version: packageMetadata.version,
      },
      projectRevisionScope: "local-app-session",
      report,
    },
    null,
    2,
  );
}
