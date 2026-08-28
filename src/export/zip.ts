/**
 * Minimal ZIP file writer (store method, no compression).
 * Only enough to package a scorepack: JSON files + WAV audio.
 * No external dependencies.
 */

const PK_SIGNATURE = 0x04034b50;
const CD_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** CRC-32 lookup table, pre-computed. */
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeString(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Build a ZIP file from an array of entries (stored, no compression).
 * Returns a Blob suitable for download.
 */
export function buildZip(entries: ZipEntry[]): Blob {
  // 1. Encode all names and compute CRC-32 for each entry.
  const encodedNames = entries.map((e) => encodeString(e.name));
  const crcs = entries.map((e) => crc32(e.data));

  // 2. Compute offsets and sizes.
  const localHeaders: { offset: number; nameLen: number; extraLen: number; size: number; crc: number }[] = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const nameLen = encodedNames[i].length;
    const size = entries[i].data.length;
    localHeaders.push({ offset, nameLen, extraLen: 0, size, crc: crcs[i] });
    // 30-byte local header + name + data
    offset += 30 + nameLen + size;
  }

  // 3. Build local file records + data.
  const dataParts: Uint8Array[] = [];
  for (let i = 0; i < entries.length; i++) {
    const hdr = new Uint8Array(30 + localHeaders[i].nameLen);
    const view = new DataView(hdr.buffer);
    view.setUint32(0, PK_SIGNATURE, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, 0, true); // compression: stored
    view.setUint16(10, 0, true); // mod time
    view.setUint16(12, 0, true); // mod date
    view.setUint32(14, localHeaders[i].crc, true);
    view.setUint32(18, localHeaders[i].size, true); // uncompressed
    view.setUint32(22, localHeaders[i].size, true); // compressed
    view.setUint16(26, localHeaders[i].nameLen, true);
    view.setUint16(28, 0, true); // extra field length
    hdr.set(encodedNames[i], 30);
    dataParts.push(hdr, entries[i].data);
  }

  // 4. Central directory.
  const cdOffset = offset;
  const cdParts: Uint8Array[] = [];
  for (let i = 0; i < entries.length; i++) {
    const hdr = new Uint8Array(46 + localHeaders[i].nameLen);
    const view = new DataView(hdr.buffer);
    view.setUint32(0, CD_SIGNATURE, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0, true); // flags
    view.setUint16(10, 0, true); // compression
    view.setUint16(12, 0, true); // mod time
    view.setUint16(14, 0, true); // mod date
    view.setUint32(16, localHeaders[i].crc, true);
    view.setUint32(20, localHeaders[i].size, true);
    view.setUint32(24, localHeaders[i].size, true);
    view.setUint16(28, localHeaders[i].nameLen, true);
    view.setUint16(30, 0, true); // extra field length
    view.setUint16(32, 0, true); // file comment length
    view.setUint16(34, 0, true); // disk number start
    view.setUint16(36, 0, true); // internal file attributes
    view.setUint32(38, 0, true); // external file attributes
    view.setUint32(42, localHeaders[i].offset, true);
    hdr.set(encodedNames[i], 46);
    cdParts.push(hdr);
  }
  const cdSize = cdParts.reduce((s, p) => s + p.length, 0);

  // 5. End of central directory record (22 bytes).
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(4, 0, true); // disk number
  eocdView.setUint16(6, 0, true); // disk with CD
  eocdView.setUint16(8, entries.length, true); // entries on this disk
  eocdView.setUint16(10, entries.length, true); // total entries
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true); // comment length

  return new Blob([...dataParts, ...cdParts, eocd] as BlobPart[], { type: "application/zip" });
}
