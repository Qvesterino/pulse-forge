import { trainPersonalModel, shouldInstallPersonalModel, type PersonalTrainStatus } from "./personal-melodic-training";
import { buildFavoriteRankerGroups, type RankerFavoriteGroups } from "./ranker-favorites";
import { putPersonalModel, type PersonalModelRecord } from "../persistence/PersonalModelRepository";
import { readFavoriteLedger, buildFavoritesPack } from "./favorites";
import { personalWeightsFromJson } from "./personal-melodic-onnx";
import { PERSONAL_MIN_ENTRIES } from "./personal-melodic-trainer";
import { assetUrl } from "../shared/assetUrls";

/**
 * W3 "NAUČ SA MA" — the one-click personalization flow.
 *
 * This is the orchestrator the UI button calls: it reads the ★ ledger, trains
 * the personal melodic prior IN THE BROWSER (fine-tuned from the shipped
 * weights), measures the A/B proof, and installs the model only when the proof
 * clears the honesty bar. It ALSO builds the ranker preference groups — the
 * same artifact `train-intent-ranker.py --favorites` consumes — so the ranker
 * retrain is one export away, not a second manual pipeline.
 *
 * Nothing here trains the ranker in-browser: the shipped ranker is a 54→…→1
 * ONNX artifact and there is no ONNX exporter in JS BY DESIGN (the repo's
 * artifact pipeline is Python-only). The honest split is:
 *   - melodic personal prior  → trained + installed in-browser (this file),
 *   - ranker preference groups → built in-browser, exported for the offline
 *     `npm run favorites:retrain` step (reported as `ranker` in the result).
 *
 * Every failure is a typed status, never a throw.
 */

export interface PersonalTrainingRun {
  status: PersonalTrainStatus;
  /** True when the model was installed into the personal store. */
  installed: boolean;
  /** Why installation was refused (when it was). */
  installBlocked?: string;
  /** Ranker preference groups built from the same ledger. */
  ranker: RankerFavoriteGroups | null;
  /** Human-readable summary for the panel status line. */
  summary: string;
}

/** Fetch the shipped ONNX bytes for the melodic artifact the personal model targets. */
async function fetchShippedOnnx(modelPath: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(assetUrl(modelPath));
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Resolve the shipped melodic v2 manifest (the artifact the personal model
 * targets by default). The path matches prior-client's constant; a missing
 * manifest means the models were never fetched and the flow refuses cleanly.
 */
export async function resolveShippedMelodicManifest(): Promise<{
  kind: string;
  modelPath: string;
  modelHash: string;
  featureCount: number;
  degreeClasses: number;
  durationClasses: number;
  hidden: readonly [number, number];
} | null> {
  try {
    const response = await fetch(assetUrl("/models/symbolic-melodic-v2.manifest.json"));
    if (!response.ok) return null;
    const manifest = (await response.json()) as {
      kind?: string;
      modelPath?: string;
      modelHash?: string;
      featureVersion?: string;
      featureCount?: number;
      degreeClasses?: number;
      durationClasses?: number;
      hidden?: number[];
    };
    if (manifest.kind !== "melodic-v2") return null;
    if (typeof manifest.modelPath !== "string" || typeof manifest.modelHash !== "string") return null;
    if (typeof manifest.featureCount !== "number" || typeof manifest.degreeClasses !== "number") return null;
    if (typeof manifest.durationClasses !== "number") return null;
    if (!Array.isArray(manifest.hidden) || manifest.hidden.length !== 2) return null;
    return {
      kind: manifest.kind,
      modelPath: manifest.modelPath,
      modelHash: manifest.modelHash,
      featureCount: manifest.featureCount,
      degreeClasses: manifest.degreeClasses,
      durationClasses: manifest.durationClasses,
      hidden: [manifest.hidden[0], manifest.hidden[1]],
    };
  } catch {
    return null;
  }
}

/**
 * Convenience entry point for the UI button: resolve the shipped manifest,
 * then run the full flow. Refuses cleanly when the model pack is absent.
 */
export async function runPersonalTrainingFromShipped(): Promise<PersonalTrainingRun> {
  const manifest = await resolveShippedMelodicManifest();
  if (!manifest) {
    return {
      status: { ok: false, reason: "shipped-model-mismatch", detail: "melodic v2 manifest unavailable" },
      installed: false,
      ranker: null,
      summary: "Shipnutý melodic model nie je dostupný (chýba manifest).",
    };
  }
  return runPersonalTraining(manifest);
}

/**
 * Run the full personalization flow for the SHIPPED melodic prior.
 *
 * `manifest` identifies the artifact; its `featureCount`/`hidden` are trusted
 * ONLY after the manifest bytes on disk are re-read and cross-checked — a
 * caller holding a stale manifest object must not be able to train a model
 * whose width no longer matches what the prior worker will load.
 */
export async function runPersonalTraining(manifest: {
  kind: string;
  modelPath: string;
  modelHash: string;
  featureCount: number;
  degreeClasses: number;
  durationClasses: number;
  hidden: readonly [number, number];
}): Promise<PersonalTrainingRun> {
  const entries = readFavoriteLedger();
  const emptyRanker: RankerFavoriteGroups | null = null;

  if (entries.length < PERSONAL_MIN_ENTRIES) {
    return {
      status: { ok: false, reason: "not-enough-favorites", needed: PERSONAL_MIN_ENTRIES, have: entries.length },
      installed: false,
      ranker: emptyRanker,
      summary: `Potrebujem aspoň ${PERSONAL_MIN_ENTRIES} ★ (máš ${entries.length}) — ★-ni pár rollov a skús znova.`,
    };
  }

  // Re-read the shipped manifest and cross-check the caller's copy. The
  // artifact on disk is the source of truth for width/architecture.
  let effective = { ...manifest };
  try {
    const response = await fetch(assetUrl(manifest.modelPath.replace(/\.onnx$/, ".manifest.json")));
    if (response.ok) {
      const disk = (await response.json()) as {
        modelHash?: string;
        featureCount?: number;
        degreeClasses?: number;
        durationClasses?: number;
        hidden?: number[];
      };
      if (
        typeof disk.featureCount === "number" &&
        typeof disk.degreeClasses === "number" &&
        typeof disk.durationClasses === "number" &&
        Array.isArray(disk.hidden) &&
        disk.hidden.length === 2
      ) {
        effective = {
          ...effective,
          // The disk hash wins: a personal model is keyed by what actually
          // ships, not what the caller cached.
          modelHash: typeof disk.modelHash === "string" ? disk.modelHash : effective.modelHash,
          featureCount: disk.featureCount,
          degreeClasses: disk.degreeClasses,
          durationClasses: disk.durationClasses,
          hidden: [disk.hidden[0], disk.hidden[1]],
        };
      }
    }
  } catch {
    /* offline / blocked storage — use the caller's manifest as-is */
  }

  const shippedOnnx = await fetchShippedOnnx(effective.modelPath);
  if (!shippedOnnx) {
    return {
      status: { ok: false, reason: "shipped-model-mismatch", detail: "shipped ONNX could not be fetched" },
      installed: false,
      ranker: emptyRanker,
      summary: "Shipnutý model sa nepodarilo načítať — skús znova neskôr.",
    };
  }

  const status = trainPersonalModel({
    shippedOnnx,
    manifest: {
      kind: effective.kind,
      featureCount: effective.featureCount,
      degreeClasses: effective.degreeClasses,
      durationClasses: effective.durationClasses,
      hidden: effective.hidden,
      modelHash: effective.modelHash,
    },
    entries,
  });

  // Ranker preference groups are built regardless of the melodic outcome —
  // they come from the same ledger and the offline retrain is a separate step.
  let ranker: RankerFavoriteGroups | null = null;
  try {
    ranker = buildFavoriteRankerGroups(buildFavoritesPack());
  } catch {
    ranker = null;
  }

  if (!status.ok) {
    return { status, installed: false, ranker, summary: `Tréning sa nedokončil (${status.reason}).` };
  }

  const verdict = shouldInstallPersonalModel(status.proof, entries.length);
  if (!verdict.ok) {
    return {
      status,
      installed: false,
      installBlocked: verdict.why,
      ranker,
      summary: `Model sa NEinštaloval: ${verdict.why}.`,
    };
  }

  // The payload must survive the store's own validation before install; if it
  // does not, the store refuses and we report the same honest non-install.
  const payload = personalWeightsFromJson(status.payload);
  if (!payload) {
    return {
      status,
      installed: false,
      installBlocked: "payload failed store validation",
      ranker,
      summary: "Model sa NEinštaloval (validácia zlyhala).",
    };
  }

  const record: PersonalModelRecord = {
    payload,
    base: { kind: effective.kind, baseModelHash: effective.modelHash },
    favoritesUsed: entries.length,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
    report: {
      finalLoss: status.result.finalLoss,
      epochs: status.result.epochs,
      steps: status.result.steps,
      topOneWins: status.proof.personalHits,
      topOneCases: status.proof.cases,
    },
  };
  const installed = await putPersonalModel(record);

  const rate = status.proof.cases > 0 ? Math.round((status.proof.personalHits / status.proof.cases) * 100) : 0;
  return {
    status,
    installed,
    ...(installed ? {} : { installBlocked: "store rejected the record" }),
    ranker,
    summary: installed
      ? `Hotovo: osobný prior z ${entries.length} ★ — top-1 ${rate}% (shipnutý ${status.proof.shippedHits}/${status.proof.cases}).`
      : "Model sa nepodarilo uložiť (IndexedDB).",
  };
}
