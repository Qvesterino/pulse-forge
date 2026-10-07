import packageMetadata from "../../package.json";
import type { MixHealthReport } from "../analysis/mixDoctor";
import type { BufferSummary } from "../audio-engine/metering";
import type { LoudnessTimeline } from "../audio-engine/kweighting";
import type { MasterConfig } from "../project-model/types";
import type { EncodedMasterInspection } from "./encodedInspection";
import type { DeliveryVerdict, MasterProfile } from "./profiles";
import type { MasteringSessionRecord } from "./sessionStore";

export interface ExternalMasteringReportInput {
  session: MasteringSessionRecord;
  masterConfig: MasterConfig;
  profile: MasterProfile;
  renderedAt: string;
  renderConfigRevision: number;
  sampleRate: number;
  durationSeconds: number;
  sourceMeasurements: BufferSummary;
  sourceMixHealth: MixHealthReport;
  sourceLoudnessTimeline: LoudnessTimeline | null;
  inspection: EncodedMasterInspection;
  exportedFileName: string;
  deliveryVerdict: DeliveryVerdict;
}

/** JSON handoff for a verified external-session WAV; source audio itself is never included. */
export function serializeExternalMasteringReport(
  input: ExternalMasteringReportInput,
  generatedAt = new Date(),
): string {
  const { session, masterConfig, profile, inspection } = input;
  const decoded = inspection.decode.status === "measured";
  return JSON.stringify(
    {
      schema: "kyx.external-mastering-report",
      schemaVersion: 1,
      generatedAt: generatedAt.toISOString(),
      application: {
        product: packageMetadata.productName,
        package: packageMetadata.name,
        version: packageMetadata.version,
      },
      session: {
        id: session.id,
        revision: session.configRevision,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      source: {
        fileName: session.fileName,
        mimeType: session.mimeType,
        byteLength: session.byteLength,
        sha256: session.sourceHash,
        durationSeconds: session.durationSeconds,
        channels: session.channels,
        sampleRate: session.sourceSampleRate,
      },
      mastering: {
        configRevision: input.renderConfigRevision,
        config: masterConfig,
        profile,
      },
      render: {
        renderedAt: input.renderedAt,
        quality: "studio",
        sampleRate: input.sampleRate,
        durationSeconds: input.durationSeconds,
        sourcePcmMeasurements: input.sourceMeasurements,
        sourcePcmMixHealth: input.sourceMixHealth,
        sourcePcmLoudnessTimeline: input.sourceLoudnessTimeline,
      },
      delivery: {
        fileName: input.exportedFileName,
        format: inspection.format,
        byteLength: inspection.byteLength,
        file: inspection.file,
        postEncode: {
          status: inspection.decode.status,
          decoder: inspection.decode.decoder,
          sampleRate: inspection.decode.sampleRate ?? null,
          channels: inspection.decode.channels ?? null,
          durationSeconds: inspection.decode.durationSeconds ?? null,
          measurements: inspection.decode.measurements ?? null,
          mixHealth: inspection.decode.mixHealth ?? null,
          loudnessTimeline: inspection.decode.loudnessTimeline ?? null,
          reason: inspection.decode.reason ?? null,
          warnings: inspection.decode.warnings,
        },
        measurementBasis: decoded ? "decoded-exported-file" : "source-pcm-only",
        verdict: input.deliveryVerdict,
      },
    },
    null,
    2,
  );
}
