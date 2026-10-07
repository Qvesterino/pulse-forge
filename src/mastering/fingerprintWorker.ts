const BLOCK_BYTES = 64;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_FINGERPRINT_BYTES = 512 * 1024 * 1024;

interface WorkerScope extends EventTarget {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

const scope = self as unknown as WorkerScope;

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(BLOCK_BYTES);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private byteLength = 0n;
  private finalized = false;

  update(bytes: Uint8Array): void {
    if (this.finalized) throw new Error("Cannot update a finalized SHA-256 digest.");
    this.byteLength += BigInt(bytes.byteLength);
    let offset = 0;

    if (this.blockLength > 0) {
      const copied = Math.min(BLOCK_BYTES - this.blockLength, bytes.byteLength);
      this.block.set(bytes.subarray(0, copied), this.blockLength);
      this.blockLength += copied;
      offset += copied;
      if (this.blockLength === BLOCK_BYTES) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }

    while (offset + BLOCK_BYTES <= bytes.byteLength) {
      this.compress(bytes.subarray(offset, offset + BLOCK_BYTES));
      offset += BLOCK_BYTES;
    }
    if (offset < bytes.byteLength) {
      const remainder = bytes.subarray(offset);
      this.block.set(remainder, 0);
      this.blockLength = remainder.byteLength;
    }
  }

  digestHex(): string {
    if (this.finalized) throw new Error("SHA-256 digest was already finalized.");
    this.finalized = true;
    const bitLength = this.byteLength * 8n;
    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;

    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    for (let index = 0; index < 8; index++) {
      const shift = BigInt((7 - index) * 8);
      this.block[56 + index] = Number((bitLength >> shift) & 0xffn);
    }
    this.compress(this.block);

    let hex = "";
    for (const word of this.state) hex += word.toString(16).padStart(8, "0");
    return hex;
  }

  private compress(block: Uint8Array): void {
    const view = new DataView(block.buffer, block.byteOffset, BLOCK_BYTES);
    for (let index = 0; index < 16; index++) this.words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index++) {
      const previous15 = this.words[index - 15]!;
      const previous2 = this.words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      this.words[index] = (this.words[index - 16]! + sigma0 + this.words[index - 7]! + sigma1) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;

    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + ROUND_CONSTANTS[index]! + this.words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fingerprintBlob(blob: Blob, requestId: number): Promise<void> {
  if (blob.size <= 0 || blob.size > MAX_FINGERPRINT_BYTES) {
    scope.postMessage({
      type: "MASTER_FINGERPRINT_UNAVAILABLE",
      requestId,
      reason:
        blob.size <= 0
          ? "The exported file is empty."
          : `The file exceeds the ${Math.floor(MAX_FINGERPRINT_BYTES / (1024 * 1024))} MiB bounded fingerprint limit.`,
    });
    return;
  }

  const sha256 = new IncrementalSha256();
  for (let offset = 0; offset < blob.size; offset += READ_CHUNK_BYTES) {
    const end = Math.min(blob.size, offset + READ_CHUNK_BYTES);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    if (chunk.byteLength !== end - offset) throw new Error("The exported file changed while it was fingerprinted.");
    sha256.update(chunk);
    scope.postMessage({ type: "MASTER_FINGERPRINT_PROGRESS", requestId, progress: end / blob.size });
  }
  scope.postMessage({ type: "MASTER_FINGERPRINT_RESULT", requestId, sha256: sha256.digestHex() });
}

scope.onmessage = (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!isRecord(data) || data.type !== "MASTER_FINGERPRINT_START") return;
  if (!Number.isSafeInteger(data.requestId) || (data.requestId as number) <= 0) return;
  const requestId = data.requestId as number;
  if (typeof Blob === "undefined" || !(data.blob instanceof Blob)) {
    scope.postMessage({
      type: "MASTER_FINGERPRINT_ERROR",
      requestId,
      message: "The fingerprint worker requires a file Blob.",
    });
    return;
  }
  void fingerprintBlob(data.blob, requestId).catch((error: unknown) => {
    scope.postMessage({
      type: "MASTER_FINGERPRINT_ERROR",
      requestId,
      message: error instanceof Error ? error.message.slice(0, 500) : "The fingerprint worker failed.",
    });
  });
};
