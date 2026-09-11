import { describe, expect, it } from "vitest";
import { buildZip } from "../src/export/zip";
import { buildScorepack } from "../src/export/scorepack";
import { SampleBank } from "../src/sample-library/factory";
import { createProjectFromTemplate } from "../src/project-model/templates";

describe("ZIP encoder", () => {
  it("produces a valid ZIP file with correct structure", async () => {
    const entries = [
      { name: "test.txt", data: new TextEncoder().encode("Hello World") },
      { name: "sub/nested.json", data: new TextEncoder().encode('{"key":"value"}') },
    ];
    const blob = buildZip(entries);
    expect(blob.type).toBe("application/zip");
    const ab = await blob.arrayBuffer();
    const view = new DataView(ab);

    // Check RIFF-like ZIP magic
    const magic = view.getUint32(0, true);
    expect(magic).toBe(0x04034b50); // PK local file header

    // Check the file entries exist by scanning for the local file headers
    let offset = 0;
    let fileCount = 0;
    while (offset < ab.byteLength - 4) {
      const sig = view.getUint32(offset, true);
      if (sig === 0x04034b50) {
        fileCount++;
        const nameLen = view.getUint16(offset + 26, true);
        const extraLen = view.getUint16(offset + 28, true);
        const dataSize = view.getUint32(offset + 18, true);
        offset += 30 + nameLen + extraLen + dataSize;
      } else if (sig === 0x02014b50) {
        break; // central directory
      } else {
        break;
      }
    }
    expect(fileCount).toBe(2);

    // Check EOCD
    const eocdOffset = ab.byteLength - 22;
    const eocdSig = view.getUint32(eocdOffset, true);
    expect(eocdSig).toBe(0x06054b50);
    const numEntries = view.getUint16(eocdOffset + 8, true);
    expect(numEntries).toBe(2);
  });

  it("CRC-32 is computed correctly for known data", async () => {
    // CRC of "Hello" = 0xF7D18982 (known value)
    const entries = [{ name: "hello.txt", data: new TextEncoder().encode("Hello") }];
    const blob = buildZip(entries);
    const ab = await blob.arrayBuffer();
    const view = new DataView(ab);
    const crc = view.getUint32(14, true);
    expect(crc).toBe(0xf7d18982);
  });
});

describe("scorepack export cancellation", () => {
  it("honors an already-aborted signal before the first offline render", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildScorepack(createProjectFromTemplate("house"), new SampleBank(), undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
