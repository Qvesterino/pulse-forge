import type { BufferSummary } from "../audio-engine/metering";
import type { MixHealthReport } from "../analysis/mixDoctor";
import type { ProjectDocument } from "../project-model/types";
import packageMetadata from "../../package.json";
import type { EncodedMasterInspection } from "./encodedInspection";
import { masterProfileProvenance, type MasterProfile } from "./profiles";
import type { MasterVerdict } from "../audio-engine/metering";
import type { LoudnessTimeline } from "../audio-engine/kweighting";

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

export interface MasterRenderReportV3 extends Omit<MasterRenderReportV2, "version"> {
  version: 3;
  /** Monotonic sample-bank revision used by the render, local to this app session. */
  sampleBankRevision: number;
}

export interface MasterRenderReportV4 extends Omit<MasterRenderReportV3, "version"> {
  version: 4;
  /** Profile-based checks computed from the exact PCM represented by measurements. */
  verdict: MasterVerdict;
}

export interface MasterRenderReportV5 extends Omit<MasterRenderReportV4, "version"> {
  version: 5;
  /** Named signal tap and encoding position for the report's primary PCM measurements. */
  measurementTap: {
    id: "master-output";
    position: "post-limiter";
    fileStage: "pre-encode";
  };
}

export interface MasterRenderReportV6 extends Omit<MasterRenderReportV5, "version" | "measurements"> {
  version: 6;
  measurements: BufferSummary & { loudnessRangeLu: number | null };
}

export interface MasterRenderReportV7 extends Omit<MasterRenderReportV6, "version"> {
  version: 7;
  /** Bounded short-term loudness overview, null for unmeasurable programmes. */
  loudnessTimeline: LoudnessTimeline | null;
}

export interface MasterRenderReportV8 extends Omit<MasterRenderReportV7, "version"> {
  version: 8;
}

export interface MasterRenderReportV9 extends Omit<MasterRenderReportV8, "version"> {
  version: 9;
}

export interface MasterRenderReportV10 extends Omit<MasterRenderReportV9, "version"> {
  version: 10;
}

export type MasterRenderReport = MasterRenderReportV10;

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
  input: Omit<MasterRenderReportV10, "version" | "runId" | "createdAt" | "encodedDelivery" | "measurementTap">,
): MasterRenderReportV10 {
  return {
    version: 10,
    runId: `master-render-${Date.now().toString(36)}-${nextRunId++}`,
    createdAt: new Date().toISOString(),
    encodedDelivery: null,
    measurementTap: { id: "master-output", position: "post-limiter", fileStage: "pre-encode" },
    ...input,
  };
}

/** Stable JSON sidecar envelope for sharing a measured project master. */
export function serializeMasterReportSidecar(report: MasterRenderReport, generatedAt = new Date()): string {
  return JSON.stringify(
    {
      schema: "kyx.master-report",
      schemaVersion: 10,
      generatedAt: generatedAt.toISOString(),
      application: {
        product: packageMetadata.productName,
        package: packageMetadata.name,
        version: packageMetadata.version,
      },
      projectRevisionScope: "local-app-session",
      sampleBankRevisionScope: "local-app-session",
      profileProvenance: masterProfileProvenance(report.profile.id, generatedAt.getTime()),
      report,
    },
    null,
    2,
  );
}
