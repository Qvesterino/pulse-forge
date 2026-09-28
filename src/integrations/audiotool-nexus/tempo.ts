import type { OfflineDocument, SyncedDocument } from "@audiotool/nexus";
import type { TimeSignature } from "../../project-model/types";

export interface AudiotoolProjectTempo {
  bpm: number;
  timeSignature: TimeSignature;
  /** True when the SDK document has no readable config and Audiotool defaults are shown. */
  isDefault: boolean;
}

/** Read the project's global tempo and meter without changing the document. */
export function readAudiotoolProjectTempo(
  document: Pick<SyncedDocument | OfflineDocument, "queryEntities">,
): AudiotoolProjectTempo {
  const configs = document.queryEntities.ofTypes("config").get();
  const config = configs.length === 1 ? configs[0] : undefined;
  const bpm = config?.fields.tempoBpm.value;
  const numerator = config?.fields.signatureNumerator.value;
  const denominator = config?.fields.signatureDenominator.value;
  const validBpm = typeof bpm === "number" && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400;
  const validNumerator = Number.isInteger(numerator) && (numerator ?? 0) >= 1 && (numerator ?? 0) <= 32;
  const validDenominator = [1, 2, 4, 8, 16].includes(denominator ?? 0);

  return {
    bpm: validBpm ? bpm : 125,
    timeSignature: {
      numerator: validNumerator ? (numerator as number) : 4,
      denominator: validDenominator ? (denominator as number) : 4,
    },
    isDefault: !config || !validBpm || !validNumerator || !validDenominator,
  };
}
