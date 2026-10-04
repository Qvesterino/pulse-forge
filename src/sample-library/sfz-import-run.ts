import type { SampleLayer } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import type { IUserSampleRepository } from "../persistence/contracts";
import { planSfzInstrumentImport, wavMeta, type SfzImportFile, type SfzImportPlan } from "../sample-library/sfz-import";

/**
 * SFZ INSTRUMENT IMPORT RUNNER — drives the user import end-to-end from a
 * folder-style File input: plan (SFZ regions → layers with keyzones/
 * velocity/roots), persist every sample (UserSampleRepository + bank), and
 * hand the layers to the caller for the one-undoable velocity-layers commit.
 *
 * The browser supplies Files from a webkitdirectory input; names carry
 * webkitRelativePath, which the planner uses for suffix resolution.
 */

export interface SfzImportRunResult {
  layers: SampleLayer[];
  fallbackSampleId: string | null;
  imported: number;
  /** Samples that failed to decode/save (the layers skip them). */
  failed: Array<{ file: string; reason: string }>;
  /** SFZ regions whose sample file was missing from the folder. */
  missing: Array<{ sample: string; fileName: string }>;
}

export interface SfzImportRunSinks {
  bank: SampleBank;
  userSamples: Pick<IUserSampleRepository, "save">;
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
}

const bytesOf = async (file: File): Promise<ArrayBuffer> => file.arrayBuffer();

export async function runSfzInstrumentImport(
  fileList: FileList | File[],
  sinks: SfzImportRunSinks,
  options: { instrumentName?: string } = {},
): Promise<SfzImportRunResult> {
  const files: SfzImportFile[] = [];
  const bytesByName = new Map<string, ArrayBuffer>();
  for (const file of Array.from(fileList)) {
    const name = file.webkitRelativePath || file.name;
    const data = await bytesOf(file);
    files.push({ name, data });
    bytesByName.set(name, data);
  }
  const sfzFile =
    files.find((f) => f.name.toLowerCase().endsWith(".sfz")) ??
    files.find((f) => f.name.toLowerCase().includes(".sfz"));
  if (!sfzFile) throw new Error("No .sfz file in the selected folder — pick the library root folder");

  const plan: SfzImportPlan = planSfzInstrumentImport(sfzFile.name, new TextDecoder().decode(sfzFile.data), files, {
    instrumentName: options.instrumentName,
  });

  const failed: SfzImportRunResult["failed"] = [];
  const layers: SampleLayer[] = [];
  let fallbackSampleId: string | null = null;

  for (const region of plan.regions) {
    const data = bytesByName.get(region.fileName);
    if (!data) {
      failed.push({ file: region.fileName, reason: "bytes missing after plan" });
      continue;
    }
    try {
      const decoded = await sinks.decode(data.slice(0));
      const meta = wavMeta(data);
      sinks.bank.add(region.sampleId, decoded);
      await sinks.userSamples.save(
        {
          id: region.sampleId,
          name: region.fileName,
          fileName: `${region.sampleId}.wav`,
          category: "Custom",
          duration: meta.duration,
          sampleRate: meta.sampleRate,
          channels: meta.channels,
          createdAt: new Date().toISOString(),
        },
        data,
      );
      layers.push(region.layer);
      fallbackSampleId = fallbackSampleId ?? region.sampleId;
    } catch (error) {
      failed.push({ file: region.fileName, reason: String((error as Error)?.message ?? error) });
    }
  }

  return {
    layers,
    fallbackSampleId,
    imported: layers.length,
    failed,
    missing: plan.missing,
  };
}

export type { SfzImportPlan };
