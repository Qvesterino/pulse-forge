import type { ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { sanitizeFilename, downloadWav, encodeWavAsync, type WavBitDepth } from "../rendering/wav";
import { downloadBlob } from "../export/download";
import { analyzeMixHealthBuffer, buildMixCheckVerdict } from "../analysis/mixDoctor";

/**
 * QUICK BOUNCE — the shared render + encode + download pipeline behind
 * "export wav/mp3". Extracted from the IntentPanel export branch so the MCP
 * `kyx_export` tool drives the SAME path (docs/INTENT-MCP-EXPANSION-PLAN.md
 * D1: the download happens in the KYX app window; the returned string is the
 * honest completion report). Dynamic imports keep the landing bundle clean —
 * the renderer and LAME wasm only load when an export actually runs.
 */
export interface QuickBounceOptions {
  format: "wav" | "mp3";
  /** Render sample rate (default 44100). */
  sampleRate?: number;
  /** WAV bit depth (default 16; ignored for mp3). */
  bitDepth?: 16 | 24 | 32;
  /** Stem mode: render the non-empty stem groups (or one group id) into a
   * zip instead of the full mix. Stem projects bypass the master chain the
   * same way the ExportPanel's stem flow does. */
  stems?: "all" | "drums" | "bass" | "music";
}

export async function quickBounceDownload(
  doc: ProjectDocument,
  bank: SampleBank,
  options: QuickBounceOptions,
): Promise<string> {
  const baseName = sanitizeFilename(doc.name);
  const sampleRate = options.sampleRate ?? 44100;
  const { renderProject } = await import("../rendering/renderer");

  if (options.stems != null) {
    const { buildStemProject, nonEmptyStemGroups } = await import("../rendering/stems");
    const { buildZip } = await import("../export/zip");
    const groups = nonEmptyStemGroups(doc).filter((group) => options.stems === "all" || group.id === options.stems);
    if (groups.length === 0) {
      throw new Error("no non-empty stem groups match — the mix has no tracks for that stem");
    }
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    let totalSeconds = 0;
    for (const group of groups) {
      const stemDoc = buildStemProject(doc, group.filter);
      const buffer = await renderProject(stemDoc, bank, { mode: "song", sampleRate });
      totalSeconds = Math.max(totalSeconds, buffer.duration);
      const bytes = await encodeWavAsync(buffer, 24, {});
      entries.push({ name: `${baseName}-${group.label.toLowerCase()}.wav`, data: new Uint8Array(bytes) });
    }
    const zip = buildZip(entries);
    downloadBlob(zip, `${baseName}-stems.zip`);
    return `stems zip exported (${entries.length} stem(s): ${groups.map((g) => g.label).join(", ")}, ${totalSeconds.toFixed(1)}s, ${(zip.size / 1e6).toFixed(2)} MB)`;
  }

  const buffer = await renderProject(doc, bank, { mode: "song", sampleRate });
  // Per-render mix-doctor: every full-mix export carries the mix check in
  // its read-back so an agent (or the human reading the panel) can react —
  // the analysis is the same one the ExportPanel verdict line shows.
  const mixCheck = buildMixCheckVerdict(analyzeMixHealthBuffer(buffer));
  if (options.format === "mp3") {
    const { encodeMp3 } = await import("../export/mp3");
    const blob = await encodeMp3(buffer, { kbps: 320 });
    downloadBlob(blob, `${baseName}-320.mp3`);
    return `MP3 exported (${buffer.duration.toFixed(1)}s, 320 kbps, ${(blob.size / 1e6).toFixed(2)} MB) — ${mixCheck}`;
  }
  const bitDepth: WavBitDepth = options.bitDepth ?? 16;
  const wavBytes = await encodeWavAsync(buffer, bitDepth, {});
  downloadWav(wavBytes, `${baseName}-${bitDepth}bit.wav`);
  return `WAV exported (${buffer.duration.toFixed(1)}s, ${bitDepth}-bit @ ${sampleRate} Hz, ${(wavBytes.byteLength / 1e6).toFixed(2)} MB) — ${mixCheck}`;
}
