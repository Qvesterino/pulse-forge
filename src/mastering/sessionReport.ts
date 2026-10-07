import packageMetadata from "../../package.json";
import type { MixHealthReport } from "../analysis/mixDoctor";
import type { BufferSummary } from "../audio-engine/metering";
import type { LoudnessTimeline } from "../audio-engine/kweighting";
import type { MasterConfig } from "../project-model/types";
import type { EncodedMasterInspection } from "./encodedInspection";
import { masterProfileProvenance, type DeliveryVerdict, type MasterProfile } from "./profiles";
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
  inputBaseline: ExternalMasteringInputBaseline | null;
  inspection: EncodedMasterInspection;
  exportedFileName: string;
  deliveryVerdict: DeliveryVerdict;
}

export interface ExternalMasteringInputBaseline {
  sessionId: string;
  sourceHash: string;
  measuredAt: string;
  decodedSampleRate: number;
  measurements: BufferSummary;
  mixHealth: MixHealthReport;
  loudnessTimeline: LoudnessTimeline | null;
}

/** JSON handoff for a checked external-session WAV, MP3 or FLAC; source audio itself is never included. */
export function serializeExternalMasteringReport(
  input: ExternalMasteringReportInput,
  generatedAt = new Date(),
): string {
  const { session, masterConfig, profile, inspection } = input;
  const decoded = inspection.decode.status === "measured";
  const inputBaselineMatchesSession =
    input.inputBaseline?.sessionId === session.id && input.inputBaseline?.sourceHash === session.sourceHash;
  return JSON.stringify(
    {
      schema: "kyx.external-mastering-report",
      schemaVersion: 5,
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
      inputBaseline:
        inputBaselineMatchesSession && input.inputBaseline
          ? {
              status: "measured",
              sessionId: input.inputBaseline.sessionId,
              sourceSha256: input.inputBaseline.sourceHash,
              measuredAt: input.inputBaseline.measuredAt,
              decodedSampleRate: input.inputBaseline.decodedSampleRate,
              measurements: input.inputBaseline.measurements,
              mixHealth: input.inputBaseline.mixHealth,
              loudnessTimeline: input.inputBaseline.loudnessTimeline,
            }
          : {
              status: "not-measured",
              reason: input.inputBaseline
                ? "Input baseline source fingerprint does not match this delivery session; it was excluded."
                : "Input baseline analysis was not run before this delivery export.",
            },
      mastering: {
        configRevision: input.renderConfigRevision,
        config: masterConfig,
        profile,
        profileProvenance: masterProfileProvenance(profile.id, generatedAt.getTime()),
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
        fingerprint: inspection.fingerprint,
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
        measurementBasis: decoded ? "decoded-exported-file" : "pre-encode-render-pcm-only",
        verdict: input.deliveryVerdict,
      },
    },
    null,
    2,
  );
}
