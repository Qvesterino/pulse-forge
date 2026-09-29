import type { ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { sanitizeFilename, downloadWav, encodeWavAsync, type WavBitDepth } from "../rendering/wav";
import { downloadBlob } from "../export/download";

/**
 * QUICK BOUNCE — the shared render + encode + download pipeline behind
 * "export wav/mp3". Extracted from the IntentPanel export branch so the MCP
 * `kyx_export` tool drives the SAME path (docs/INTENT-MCP-EXPANSION-PLAN.md
 * D1: the download happens in the KYX app window; the returned string is the
 * honest completion report). Dynamic imports keep the landing bundle clean —
 * the renderer and LAME wasm only load when an export actually runs.
 */
export async function quickBounceDownload(
  doc: ProjectDocument,
  bank: SampleBank,
  format: "wav" | "mp3",
): Promise<string> {
  const baseName = sanitizeFilename(doc.name);
  const { renderProject } = await import("../rendering/renderer");
  const buffer = await renderProject(doc, bank, { mode: "song", sampleRate: 44100 });
  if (format === "mp3") {
    const { encodeMp3 } = await import("../export/mp3");
    const blob = await encodeMp3(buffer, { kbps: 320 });
    downloadBlob(blob, `${baseName}-320.mp3`);
    return `MP3 exported (${buffer.duration.toFixed(1)}s, 320 kbps, ${(blob.size / 1e6).toFixed(2)} MB)`;
  }
  const bitDepth: WavBitDepth = 16;
  const wavBytes = await encodeWavAsync(buffer, bitDepth, {});
  downloadWav(wavBytes, `${baseName}-master.wav`);
  return `WAV exported (${buffer.duration.toFixed(1)}s, 16-bit, ${(wavBytes.byteLength / 1e6).toFixed(2)} MB)`;
}
