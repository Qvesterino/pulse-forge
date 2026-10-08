import { createHash } from "node:crypto";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

function readMasterWavFacts(bytes: Buffer) {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The delivered master is not a RIFF/WAVE file.");
  }
  const declaredEnd = bytes.readUInt32LE(4) + 8;
  if (declaredEnd !== bytes.length) throw new Error("The delivered master RIFF length does not match its file size.");

  let formatCode = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataBytes = 0;
  let dataOffset = 0;
  let bextVersion = 0;
  let offset = 12;
  while (offset + 8 <= declaredEnd) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    const end = body + size;
    if (end > declaredEnd) throw new Error(`The delivered master ${id} chunk exceeds the RIFF boundary.`);
    if (id === "fmt ") {
      if (size < 16) throw new Error("The delivered master format chunk is incomplete.");
      formatCode = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bitDepth = bytes.readUInt16LE(body + 14);
    } else if (id === "bext") {
      if (size < 602) throw new Error("The delivered master BWF chunk is incomplete.");
      bextVersion = bytes.readUInt16LE(body + 346);
    } else if (id === "data") {
      dataBytes = size;
      dataOffset = body;
    }
    offset = end + (size % 2);
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  if (!formatCode || !channels || !sampleRate || !blockAlign || !dataBytes || dataBytes % blockAlign !== 0) {
    throw new Error("The delivered master is missing aligned audio format or sample data.");
  }
  let peak = 0;
  let sumSquares = 0;
  const sampleCount = dataBytes / bytesPerSample;
  for (let index = 0; index < sampleCount; index++) {
    const at = dataOffset + index * bytesPerSample;
    let sample = 0;
    if (formatCode === 3 && bitDepth === 32) sample = bytes.readFloatLE(at);
    else if (formatCode === 1 && bitDepth === 16) sample = bytes.readInt16LE(at) / 0x8000;
    else if (formatCode === 1 && bitDepth === 24) sample = (bytes.readUIntLE(at, 3) << 8) >> 8;
    else throw new Error(`Unsupported delivered master encoding (${formatCode}, ${bitDepth}-bit).`);
    if (bitDepth === 24) sample /= 0x800000;
    if (!Number.isFinite(sample)) throw new Error("The delivered master contains a non-finite sample.");
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
  }
  return {
    formatCode,
    channels,
    sampleRate,
    bitDepth,
    dataBytes,
    frames: dataBytes / blockAlign,
    bextVersion,
    peak,
    rms: Math.sqrt(sumSquares / sampleCount),
  };
}

function readFlacFacts(bytes: Buffer) {
  if (bytes.length < 42 || bytes.toString("ascii", 0, 4) !== "fLaC") {
    throw new Error("The delivered master is not a FLAC stream.");
  }

  let metadataOffset = 4;
  let streamInfo: Buffer | null = null;
  let hasLastMetadataBlock = false;
  while (!hasLastMetadataBlock && metadataOffset + 4 <= bytes.length) {
    const header = bytes[metadataOffset]!;
    const blockType = header & 0x7f;
    const blockLength = bytes.readUIntBE(metadataOffset + 1, 3);
    const blockStart = metadataOffset + 4;
    const blockEnd = blockStart + blockLength;
    if (blockEnd > bytes.length) throw new Error("A delivered master FLAC metadata block is truncated.");
    if (blockType === 0) {
      if (blockLength !== 34) throw new Error("The delivered master FLAC STREAMINFO block is incomplete.");
      streamInfo = bytes.subarray(blockStart, blockEnd);
    }
    hasLastMetadataBlock = (header & 0x80) !== 0;
    metadataOffset = blockEnd;
  }

  if (!streamInfo || !hasLastMetadataBlock) throw new Error("The delivered master is missing FLAC STREAMINFO.");
  const sampleRate = streamInfo[10]! * 4096 + streamInfo[11]! * 16 + (streamInfo[12]! >>> 4);
  const channels = ((streamInfo[12]! >>> 1) & 0x07) + 1;
  const bitDepth = (((streamInfo[12]! & 0x01) << 4) | (streamInfo[13]! >>> 4)) + 1;
  const frames = Number((BigInt(streamInfo[13]! & 0x0f) << 32n) | BigInt(streamInfo.readUInt32BE(14)));
  if (!sampleRate || !channels || !bitDepth || !frames) {
    throw new Error("The delivered master FLAC STREAMINFO fields are invalid.");
  }
  return { sampleRate, channels, bitDepth, frames };
}

function readMp3Facts(bytes: Buffer) {
  let audioOffset = 0;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") {
    if (bytes.length < 10) throw new Error("The delivered MP3 ID3 header is incomplete.");
    const tagSize =
      ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    audioOffset = 10 + tagSize + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
    if (audioOffset >= bytes.length) throw new Error("The delivered MP3 contains no audio frames after its ID3 tag.");
  }

  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  for (let offset = audioOffset; offset + 4 <= bytes.length; offset++) {
    const header = bytes.readUInt32BE(offset);
    const versionBits = (header >>> 19) & 0b11;
    const layerBits = (header >>> 17) & 0b11;
    const bitrateIndex = (header >>> 12) & 0b1111;
    const sampleRateIndex = (header >>> 10) & 0b11;
    if (
      header >>> 21 !== 0x7ff ||
      versionBits === 1 ||
      layerBits !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      sampleRateIndex === 3
    ) {
      continue;
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex]!;
    const bitrateKbps = (version === 1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex]!;
    return {
      sampleRate: baseSampleRate / (version === 1 ? 1 : version === 2 ? 2 : 4),
      channels: ((header >>> 6) & 0b11) === 3 ? 1 : 2,
      bitrateKbps,
      version,
      layer: 3,
    };
  }
  throw new Error("The delivered MP3 contains no valid MPEG Layer III frame.");
}

function makeStereoTestWav(durationSeconds = 1): Buffer {
  const sampleRate = 44_100;
  const channels = 2;
  const bitsPerSample = 16;
  const frames = sampleRate * durationSeconds;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataBytes = frames * blockAlign;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const left = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 0.12 * 0x7fff);
    const right = Math.round(Math.sin((2 * Math.PI * 443 * frame) / sampleRate) * 0.1 * 0x7fff);
    wav.writeInt16LE(left, 44 + frame * blockAlign);
    wav.writeInt16LE(right, 44 + frame * blockAlign + 2);
  }
  return wav;
}

async function markMasteringMemoryStage(stage: string): Promise<void> {
  const markerPath = process.env.KYX_MASTERING_MEMORY_MARKER;
  if (markerPath) await writeFile(markerPath, stage, "utf8");
}

function makeMinimalFlac(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  const packed = (BigInt(44_100) << 44n) | (1n << 41n) | (23n << 36n) | 44_100n;
  for (let index = 0; index < 8; index++) {
    bytes[18 + index] = Number((packed >> BigInt((7 - index) * 8)) & 0xffn);
  }
  bytes.set([0xff, 0xf8, 0, 0, 0, 0], 42);
  return bytes;
}

async function makeBrowserFlacSource(page: Page): Promise<Buffer> {
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
  const bytes = await page.evaluate(async () => {
    const encoderPath = ["/src", "export", "flac.ts"].join("/");
    const { encodeFlac } = await import(encoderPath);
    const sampleRate = 44_100;
    const source = new AudioBuffer({ length: sampleRate, numberOfChannels: 2, sampleRate });
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
      const samples = source.getChannelData(channel);
      const frequency = channel === 0 ? 440 : 443;
      for (let frame = 0; frame < samples.length; frame++) {
        samples[frame] = 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
      }
    }
    const encoded = await encodeFlac(source, { bitDepth: 16 });
    return Array.from(new Uint8Array(await encoded.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

async function installMasteringSessionRenderGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type RenderGate = {
      armed: boolean;
      arm: () => void;
      waitForStart: () => Promise<void>;
    };
    let startedResolve: (() => void) | null = null;
    let started = Promise.resolve();
    const gate: RenderGate = {
      armed: false,
      arm: () => {
        started = new Promise<void>((resolve) => {
          startedResolve = resolve;
        });
        gate.armed = true;
      },
      waitForStart: () => started,
    };
    Object.defineProperty(window, "__masteringSessionRenderGate", { configurable: true, value: gate });

    const prototype = OfflineAudioContext.prototype;
    const originalStartRendering = prototype.startRendering;
    Object.defineProperty(prototype, "startRendering", {
      configurable: true,
      writable: true,
      value: function (this: OfflineAudioContext): Promise<AudioBuffer> {
        if (!gate.armed) return originalStartRendering.call(this);
        gate.armed = false;
        startedResolve?.();
        startedResolve = null;
        return new Promise<AudioBuffer>(() => undefined);
      },
    });
  });
}

async function armMasteringSessionRenderGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (window as Window & { __masteringSessionRenderGate?: { arm: () => void } })
      .__masteringSessionRenderGate;
    if (!gate) throw new Error("The mastering-session render gate was not installed.");
    gate.arm();
  });
}

async function waitForMasteringSessionRenderStart(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const gate = (window as Window & { __masteringSessionRenderGate?: { waitForStart: () => Promise<void> } })
      .__masteringSessionRenderGate;
    if (!gate) throw new Error("The mastering-session render gate was not installed.");
    await gate.waitForStart();
  });
}

async function installMasteringSessionExportGates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ExportGate = {
      encodeArmed: boolean;
      inspectionArmed: boolean;
      armEncode: () => void;
      armInspection: () => void;
      waitForEncode: () => Promise<void>;
      waitForInspection: () => Promise<void>;
    };
    let encodeStartedResolve: (() => void) | null = null;
    let encodeStarted = Promise.resolve();
    let inspectionStartedResolve: (() => void) | null = null;
    let inspectionStarted = Promise.resolve();
    const gate: ExportGate = {
      encodeArmed: false,
      inspectionArmed: false,
      armEncode: () => {
        encodeStarted = new Promise<void>((resolve) => {
          encodeStartedResolve = resolve;
        });
        gate.encodeArmed = true;
      },
      armInspection: () => {
        inspectionStarted = new Promise<void>((resolve) => {
          inspectionStartedResolve = resolve;
        });
        gate.inspectionArmed = true;
      },
      waitForEncode: () => encodeStarted,
      waitForInspection: () => inspectionStarted,
    };
    Object.defineProperty(window, "__masteringSessionExportGates", { configurable: true, value: gate });

    const originalSetTimeout = window.setTimeout.bind(window) as (handler: TimerHandler, timeout?: number) => number;
    Object.defineProperty(window, "setTimeout", {
      configurable: true,
      writable: true,
      value: function (this: Window, handler: TimerHandler, timeout?: number): number {
        const stack = new Error().stack ?? "";
        if (
          gate.encodeArmed &&
          timeout === 0 &&
          (stack.includes("yieldForNextTask") || stack.includes("quantizeChannelAsync"))
        ) {
          gate.encodeArmed = false;
          encodeStartedResolve?.();
          encodeStartedResolve = null;
          // Hold the encoder's next cooperative yield until Cancel clears this timer.
          return originalSetTimeout(() => undefined, 60_000);
        }
        return originalSetTimeout(handler, timeout);
      },
    });

    const prototype = OfflineAudioContext.prototype;
    const originalDecode = prototype.decodeAudioData;
    Object.defineProperty(prototype, "decodeAudioData", {
      configurable: true,
      writable: true,
      value: function (this: OfflineAudioContext, encodedBytes: ArrayBuffer): Promise<AudioBuffer> {
        if (!gate.inspectionArmed) return originalDecode.call(this, encodedBytes);
        const bytes = new Uint8Array(encodedBytes);
        const hasRiffWaveHeader =
          bytes.length > 44 &&
          bytes[0] === 0x52 &&
          bytes[1] === 0x49 &&
          bytes[2] === 0x46 &&
          bytes[3] === 0x46 &&
          bytes[8] === 0x57 &&
          bytes[9] === 0x41 &&
          bytes[10] === 0x56 &&
          bytes[11] === 0x45;
        let hasBext = false;
        for (let index = 12; index + 4 <= Math.min(bytes.length, 4096); index++) {
          if (
            bytes[index] === 0x62 &&
            bytes[index + 1] === 0x65 &&
            bytes[index + 2] === 0x78 &&
            bytes[index + 3] === 0x74
          ) {
            hasBext = true;
            break;
          }
        }
        let mp3Offset = 0;
        if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10) {
          const tagSize =
            ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
          mp3Offset = 10 + tagSize + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
        }
        const hasMpegLayer3Frame =
          mp3Offset + 4 <= bytes.length &&
          (() => {
            const header = new DataView(bytes.buffer, bytes.byteOffset + mp3Offset, 4).getUint32(0, false);
            const versionBits = (header >>> 19) & 0b11;
            const layerBits = (header >>> 17) & 0b11;
            const bitrateIndex = (header >>> 12) & 0b1111;
            const sampleRateIndex = (header >>> 10) & 0b11;
            return (
              header >>> 21 === 0x7ff &&
              versionBits !== 1 &&
              layerBits === 1 &&
              bitrateIndex !== 0 &&
              bitrateIndex !== 15 &&
              sampleRateIndex !== 3
            );
          })();
        if (!((hasRiffWaveHeader && hasBext) || hasMpegLayer3Frame)) return originalDecode.call(this, encodedBytes);
        gate.inspectionArmed = false;
        inspectionStartedResolve?.();
        inspectionStartedResolve = null;
        return new Promise<AudioBuffer>(() => undefined);
      },
    });
  });
}

async function armMasteringSessionExportGate(page: Page, stage: "encode" | "inspection"): Promise<void> {
  await page.evaluate((gateStage) => {
    const gate = (
      window as Window & {
        __masteringSessionExportGates?: { armEncode: () => void; armInspection: () => void };
      }
    ).__masteringSessionExportGates;
    if (!gate) throw new Error("The mastering-session export gates were not installed.");
    if (gateStage === "encode") gate.armEncode();
    else gate.armInspection();
  }, stage);
}

async function waitForMasteringSessionExportGate(page: Page, stage: "encode" | "inspection"): Promise<void> {
  await page.evaluate(async (gateStage) => {
    const gate = (
      window as Window & {
        __masteringSessionExportGates?: { waitForEncode: () => Promise<void>; waitForInspection: () => Promise<void> };
      }
    ).__masteringSessionExportGates;
    if (!gate) throw new Error("The mastering-session export gates were not installed.");
    await (gateStage === "encode" ? gate.waitForEncode() : gate.waitForInspection());
  }, stage);
}

async function installMasteringDecodeGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type DecodeGate = {
      armed: boolean;
      waitForStart: () => Promise<void>;
      arm: (byteLength: number) => void;
      release: () => void;
    };
    let expectedByteLength = 0;
    let startedResolve: (() => void) | null = null;
    let started = Promise.resolve();
    let releaseDecode: (() => void) | null = null;
    const gate: DecodeGate = {
      armed: false,
      waitForStart: () => started,
      arm: (byteLength) => {
        started = new Promise<void>((resolve) => {
          startedResolve = resolve;
        });
        expectedByteLength = byteLength;
        gate.armed = true;
      },
      release: () => releaseDecode?.(),
    };
    Object.defineProperty(window, "__masteringDecodeGate", { configurable: true, value: gate });

    const prototype = OfflineAudioContext.prototype;
    const originalDecode = prototype.decodeAudioData;
    Object.defineProperty(prototype, "decodeAudioData", {
      configurable: true,
      writable: true,
      value: function (this: OfflineAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
        if (!gate.armed || bytes.byteLength !== expectedByteLength) return originalDecode.call(this, bytes);
        gate.armed = false;
        const decode = originalDecode.call(this, bytes);
        return new Promise<AudioBuffer>((resolve, reject) => {
          releaseDecode = () => {
            releaseDecode = null;
            void decode.then(resolve, reject);
          };
          startedResolve?.();
          startedResolve = null;
        });
      },
    });
  });
}

async function installMasteringHashGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type HashGate = {
      armed: boolean;
      arm: (byteLength: number) => void;
      waitForStart: () => Promise<void>;
      release: () => void;
    };
    let expectedByteLength = 0;
    let startedResolve: (() => void) | null = null;
    let started = Promise.resolve();
    let releaseDigest: (() => void) | null = null;
    const gate: HashGate = {
      armed: false,
      arm: (byteLength) => {
        expectedByteLength = byteLength;
        started = new Promise<void>((resolve) => {
          startedResolve = resolve;
        });
        gate.armed = true;
      },
      waitForStart: () => started,
      release: () => releaseDigest?.(),
    };
    Object.defineProperty(window, "__masteringHashGate", { configurable: true, value: gate });

    const prototype = SubtleCrypto.prototype;
    const originalDigest = prototype.digest;
    Object.defineProperty(prototype, "digest", {
      configurable: true,
      writable: true,
      value: function (this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
        if (!gate.armed || data.byteLength !== expectedByteLength) return originalDigest.call(this, algorithm, data);
        gate.armed = false;
        const digest = originalDigest.call(this, algorithm, data);
        return new Promise<ArrayBuffer>((resolve, reject) => {
          releaseDigest = () => {
            releaseDigest = null;
            void digest.then(resolve, reject);
          };
          startedResolve?.();
          startedResolve = null;
        });
      },
    });
  });
}

async function installMasteringFileReadGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type FileReadGate = {
      armed: boolean;
      arm: (byteLength: number) => void;
      waitForStart: () => Promise<void>;
      release: () => void;
    };
    let expectedByteLength = 0;
    let startedResolve: (() => void) | null = null;
    let started = Promise.resolve();
    let releaseRead: (() => void) | null = null;
    const gate: FileReadGate = {
      armed: false,
      arm: (byteLength) => {
        expectedByteLength = byteLength;
        started = new Promise<void>((resolve) => {
          startedResolve = resolve;
        });
        gate.armed = true;
      },
      waitForStart: () => started,
      release: () => releaseRead?.(),
    };
    Object.defineProperty(window, "__masteringFileReadGate", { configurable: true, value: gate });

    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      configurable: true,
      writable: true,
      value: function (this: Blob): Promise<ArrayBuffer> {
        if (!gate.armed || this.size !== expectedByteLength) return originalArrayBuffer.call(this);
        gate.armed = false;
        const read = originalArrayBuffer.call(this);
        return new Promise<ArrayBuffer>((resolve, reject) => {
          releaseRead = () => {
            releaseRead = null;
            void read.then(resolve, reject);
          };
          startedResolve?.();
          startedResolve = null;
        });
      },
    });
  });
}

async function installMasteringAnalysisGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type AnalysisGate = {
      armed: boolean;
      waitForStart: () => Promise<void>;
      arm: () => void;
      release: () => void;
    };
    let startedResolve: (() => void) | null = null;
    let started = Promise.resolve();
    let releaseAnalysis: (() => void) | null = null;
    const gate: AnalysisGate = {
      armed: false,
      waitForStart: () => started,
      arm: () => {
        started = new Promise<void>((resolve) => {
          startedResolve = resolve;
        });
        gate.armed = true;
      },
      release: () => releaseAnalysis?.(),
    };
    Object.defineProperty(window, "__masteringAnalysisGate", { configurable: true, value: gate });

    const originalPostMessage = Worker.prototype.postMessage;
    Object.defineProperty(Worker.prototype, "postMessage", {
      configurable: true,
      writable: true,
      value: function (this: Worker, message: unknown, ...options: unknown[]): void {
        if (
          gate.armed &&
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "MASTER_ANALYSIS_START"
        ) {
          gate.armed = false;
          const deferredMessage = message;
          const deferredOptions = options;
          releaseAnalysis = () => {
            releaseAnalysis = null;
            try {
              Reflect.apply(originalPostMessage, this, [deferredMessage, ...deferredOptions]);
            } catch {
              // Cancellation may terminate this worker before the test releases the held request.
            }
          };
          startedResolve?.();
          startedResolve = null;
          return;
        }
        Reflect.apply(originalPostMessage, this, [message, ...options]);
      },
    });
  });
}

test.describe("17 — mastering workspace", () => {
  test.describe.configure({ timeout: 120_000 });

  test("master bus carries an injected tone through its native processing path", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const facts = await page.evaluate(async () => {
      const audioEngineModulePath = ["/src", "audio-engine", "AudioEngine.ts"].join("/");
      const templatesModulePath = ["/src", "project-model", "templates.ts"].join("/");
      const [{ AudioEngine }, { createProjectFromTemplate }] = await Promise.all([
        import(audioEngineModulePath),
        import(templatesModulePath),
      ]);
      const sampleRate = 44100;
      const renderPath = async (bypassed: boolean) => {
        const context = new OfflineAudioContext(2, sampleRate, sampleRate);
        const engine = new AudioEngine();
        const doc = createProjectFromTemplate("empty");
        doc.master = {
          ...doc.master,
          effects: [],
          glueEnabled: false,
          limiterEnabled: false,
          clipperEnabled: false,
          tapeEnabled: false,
          msEnabled: false,
          bassMonoEnabled: false,
          masterGain: 1,
        };
        engine.useContext(context);
        engine.setProject(doc);
        if (bypassed) engine.setMasterBypassed(true, true);

        const input = (engine as unknown as { masterChain: { input: AudioNode } }).masterChain.input;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 1000;
        gain.gain.value = 0.25;
        oscillator.connect(gain).connect(input);
        oscillator.start(0.02);
        oscillator.stop(0.8);

        const rendered = await context.startRendering();
        let peak = 0;
        let sumSquares = 0;
        let count = 0;
        for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
          const samples = rendered.getChannelData(channel);
          for (const sample of samples) {
            peak = Math.max(peak, Math.abs(sample));
            sumSquares += sample * sample;
            count++;
          }
        }
        return { peak, rms: Math.sqrt(sumSquares / count) };
      };
      return { processed: await renderPath(false), bypassed: await renderPath(true) };
    });
    expect(facts.bypassed.peak, "the dry monitor path must carry a connected source").toBeGreaterThan(0.1);
    expect(facts.processed.peak, "the master output path must not mute a connected source").toBeGreaterThan(0.1);
  });

  test("master worklet fallbacks, delayed latency, disposal, and live/offline parity survive", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "This acceptance uses realtime and offline AudioWorklet audio.");
    test.setTimeout(150_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });

    const facts = await page.evaluate(async () => {
      const audioEngineModulePath = ["/src", "audio-engine", "AudioEngine.ts"].join("/");
      const templatesModulePath = ["/src", "project-model", "templates.ts"].join("/");
      const workletLoaderPath = ["/src", "audio-worklets", "loader.ts"].join("/");
      const [{ AudioEngine }, { createProjectFromTemplate }, { loadCoreWorklets }] = await Promise.all([
        import(audioEngineModulePath),
        import(templatesModulePath),
        import(workletLoaderPath),
      ]);
      const sampleRate = 44100;
      const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 8000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for " + label + ".");
      };
      const gateEffect = {
        id: "master-latency-gate",
        type: "gate" as const,
        bypassed: false,
        params: {
          threshold: -36,
          hysteresis: 0.15,
          attack: 0.002,
          hold: 0.02,
          release: 0.08,
          range: -48,
          lookahead: 1,
          mix: 1,
        },
      };
      const doc = createProjectFromTemplate("empty");
      doc.master = {
        ...doc.master,
        effects: [gateEffect],
        tapeEnabled: true,
        glueEnabled: true,
        limiterEnabled: true,
        clipperEnabled: false,
        msEnabled: false,
        bassMonoEnabled: false,
        masterGain: 1,
        ceilingDb: -1,
      };
      type EngineInternals = {
        projectPromise: Promise<void> | null;
        masterFx: { runtimes: Map<string, { getLatencySec?: () => number }> };
        masterChain: { input: AudioNode; masterBypassDelay: DelayNode };
      };
      const makeEngineInternals = (engine: InstanceType<typeof AudioEngine>) => engine as unknown as EngineInternals;
      const settleProject = async (engine: InstanceType<typeof AudioEngine>) => {
        const pending = makeEngineInternals(engine).projectPromise;
        if (pending) await pending;
      };

      const liveContext = new AudioContext({ sampleRate });
      if (liveContext.state === "suspended") await liveContext.resume();
      const nativeNodeConstructor = window.AudioWorkletNode;
      const trackedGateNodes: { node: AudioWorkletNode; disconnectCalls: number }[] = [];
      window.AudioWorkletNode = new Proxy(nativeNodeConstructor, {
        construct(target, args) {
          const node = Reflect.construct(target, args) as AudioWorkletNode;
          if (args[1] === "gate-processor") {
            const tracked = { node, disconnectCalls: 0 };
            const originalDisconnect = node.disconnect.bind(node);
            Object.defineProperty(node, "disconnect", {
              configurable: true,
              value: (...disconnectArgs: unknown[]) => {
                tracked.disconnectCalls++;
                return Reflect.apply(originalDisconnect, node, disconnectArgs);
              },
            });
            trackedGateNodes.push(tracked);
          }
          return node;
        },
      }) as typeof AudioWorkletNode;

      const liveWorklet = liveContext.audioWorklet;
      const originalAddModule = liveWorklet.addModule.bind(liveWorklet);
      const pendingModules: { url: string; release: () => void }[] = [];
      Object.defineProperty(liveWorklet, "addModule", {
        configurable: true,
        writable: true,
        value: (url: string) =>
          new Promise<void>((resolve) => {
            pendingModules.push({ url, release: resolve });
          }),
      });

      const engine = new AudioEngine();
      engine.useContext(liveContext);
      engine.setProject(doc);
      await settleProject(engine);
      await waitFor(() => pendingModules.length >= 2, "the live core worklet load to be held");
      const fallback = {
        gate: engine.getDegradedFx().some((item: { fxId: string }) => item.fxId === gateEffect.id),
        stages: engine.getDegradedMasterStages().map((item: { stageId: string }) => item.stageId),
      };

      const internals = makeEngineInternals(engine);
      const latencyWrites: number[] = [];
      const bypassDelayTime = internals.masterChain.masterBypassDelay.delayTime;
      const originalSetTarget = bypassDelayTime.setTargetAtTime.bind(bypassDelayTime);
      Object.defineProperty(bypassDelayTime, "setTargetAtTime", {
        configurable: true,
        writable: true,
        value: (target: number, startTime: number, timeConstant: number) => {
          latencyWrites.push(target);
          return originalSetTarget(target, startTime, timeConstant);
        },
      });

      await Promise.all(
        pendingModules.map(async (module) => {
          await originalAddModule(module.url);
          module.release();
        }),
      );
      Object.defineProperty(liveWorklet, "addModule", {
        configurable: true,
        writable: true,
        value: originalAddModule,
      });
      await waitFor(() => {
        const gateRuntime = makeEngineInternals(engine).masterFx.runtimes.get(gateEffect.id);
        return (
          !engine.getDegradedFx().some((item: { fxId: string }) => item.fxId === gateEffect.id) &&
          engine.getDegradedMasterStages().length === 0 &&
          (gateRuntime?.getLatencySec?.() ?? 0) > 0
        );
      }, "the worklet processors and delayed gate latency report");

      const gateLatencySec = internals.masterFx.runtimes.get(gateEffect.id)?.getLatencySec?.() ?? 0;
      const bypassLatencyTargetSec = Math.max(...latencyWrites);
      const liveGateNode = trackedGateNodes.findLast((entry) => entry.node.context === liveContext);
      if (!liveGateNode) throw new Error("The live master gate did not create an AudioWorkletNode.");
      const liveHandlerWasInstalled = liveGateNode.node.port.onmessage !== null;

      // Exercise the full hot-swap above, then park optional color/dynamics
      // stages so this null comparison isolates the same gate + master route
      // in both contexts instead of comparing different realtime warm-up.
      doc.master = { ...doc.master, tapeEnabled: false, glueEnabled: false, limiterEnabled: false };
      engine.setProject(doc);
      await settleProject(engine);
      const activeBypassLatencyTargetSec = latencyWrites.at(-1) ?? Number.NaN;

      const captureModuleUrl = new URL("/parity-capture-worklet.js", location.href).href;
      await originalAddModule(captureModuleUrl);
      const liveBuffer = liveContext.createBuffer(1, sampleRate, sampleRate);
      const liveInput = liveBuffer.getChannelData(0);
      for (let index = 0; index < liveInput.length; index++) {
        const time = index / sampleRate;
        liveInput[index] = 0.22 * Math.sin(2 * Math.PI * 997 * time) + 0.09 * Math.sin(2 * Math.PI * 3701 * time);
      }
      const liveSource = liveContext.createBufferSource();
      liveSource.buffer = liveBuffer;
      liveSource.loop = true;
      liveSource.connect(internals.masterChain.input);
      const sourceStartTime = liveContext.currentTime + 0.05;
      liveSource.start(sourceStartTime);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const liveCaptureNode = new AudioWorkletNode(liveContext, "capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelInterpretation: "speakers",
      });
      const liveMasterTap = engine.getMasterTapNode();
      if (!liveMasterTap) throw new Error("The live master tap is unavailable.");
      liveMasterTap.connect(liveCaptureNode);
      const liveCapture = await new Promise<{ originTime: number; samples: Float32Array }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out capturing the live master output.")), 8000);
        let originTime = Number.NaN;
        liveCaptureNode.port.onmessage = (event: MessageEvent) => {
          const data = event.data as { type?: string; time?: number; left?: Float32Array } | null;
          if (data?.type === "capture-start" && typeof data.time === "number") originTime = data.time;
          if (data?.type === "chunk" && data.left instanceof Float32Array && !Number.isNaN(originTime)) {
            clearTimeout(timeout);
            resolve({ originTime, samples: data.left });
          }
        };
        liveCaptureNode.port.postMessage({ type: "arm", chunkFrames: 8192 });
      });
      liveCaptureNode.port.postMessage({ type: "stop" });
      liveCaptureNode.port.onmessage = null;
      liveMasterTap.disconnect(liveCaptureNode);
      liveCaptureNode.disconnect();
      liveSource.stop();
      liveSource.disconnect();

      // Capture the live output while toggling monitor bypass in both directions.
      // A deliberately closed gate makes the aligned dry leg carry real signal,
      // so a discontinuous switch is visible as an isolated sample jump.
      gateEffect.params.threshold = -6;
      engine.setProject(doc);
      await settleProject(engine);
      engine.setMasterBypassed(false, true);
      const clickBuffer = liveContext.createBuffer(1, sampleRate, sampleRate);
      const clickInput = clickBuffer.getChannelData(0);
      for (let index = 0; index < clickInput.length; index++) {
        const time = index / sampleRate;
        clickInput[index] = 0.22 * Math.sin(2 * Math.PI * 997 * time) + 0.09 * Math.sin(2 * Math.PI * 3701 * time);
      }
      const clickSource = liveContext.createBufferSource();
      clickSource.buffer = clickBuffer;
      clickSource.loop = true;
      clickSource.connect(internals.masterChain.input);
      clickSource.start(liveContext.currentTime + 0.05);
      const clickCaptureNode = new AudioWorkletNode(liveContext, "capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelInterpretation: "speakers",
        processorOptions: { chunkFrames: 32768 },
      });
      liveMasterTap.connect(clickCaptureNode);
      const clickCapture = await new Promise<{ originTime: number; samples: Float32Array; transitions: number[] }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out measuring live monitor bypass transitions.")),
            8000,
          );
          let originTime = Number.NaN;
          const transitions: number[] = [];
          clickCaptureNode.port.onmessage = (event: MessageEvent) => {
            const data = event.data as { type?: string; time?: number; left?: Float32Array } | null;
            if (data?.type === "capture-start" && typeof data.time === "number") {
              originTime = data.time;
              setTimeout(() => {
                transitions.push(liveContext.currentTime);
                engine.setMasterBypassed(true);
                setTimeout(() => {
                  transitions.push(liveContext.currentTime);
                  engine.setMasterBypassed(false);
                }, 120);
              }, 60);
            }
            if (data?.type === "chunk" && data.left instanceof Float32Array && transitions.length === 2) {
              clearTimeout(timeout);
              resolve({ originTime, samples: data.left, transitions });
            }
          };
          clickCaptureNode.port.postMessage({ type: "arm", chunkFrames: 32768 });
        },
      );
      clickCaptureNode.port.postMessage({ type: "stop" });
      clickCaptureNode.port.onmessage = null;
      liveMasterTap.disconnect(clickCaptureNode);
      clickCaptureNode.disconnect();
      clickSource.stop();
      clickSource.disconnect();
      engine.setMasterBypassed(false, true);
      gateEffect.params.threshold = -36;
      engine.setProject(doc);
      await settleProject(engine);
      const transitionFrames = clickCapture.transitions.map((time) =>
        Math.round((time - clickCapture.originTime) * sampleRate),
      );
      const maxDelta = (start: number, end: number) => {
        let peak = 0;
        let peakFrame = start;
        for (let index = Math.max(1, start); index < Math.min(clickCapture.samples.length, end); index++) {
          const delta = Math.abs(clickCapture.samples[index] - clickCapture.samples[index - 1]);
          if (delta > peak) {
            peak = delta;
            peakFrame = index;
          }
        }
        return { peak, peakFrame };
      };
      const transitionRadius = Math.round(sampleRate * 0.025);
      const transitionDeltas = transitionFrames.map((frame) =>
        maxDelta(frame - transitionRadius, frame + transitionRadius),
      );
      const steadyDeltas = [
        maxDelta(0, transitionFrames[0] - transitionRadius),
        maxDelta(transitionFrames[0] + transitionRadius, transitionFrames[1] - transitionRadius),
        maxDelta(transitionFrames[1] + transitionRadius, clickCapture.samples.length),
      ];
      const transitionPeakDelta = Math.max(...transitionDeltas.map((delta) => delta.peak));
      const steadyPeakDelta = Math.max(...steadyDeltas.map((delta) => delta.peak));
      const dryMonitorPeak = Math.max(
        ...clickCapture.samples
          .slice(transitionFrames[0] + transitionRadius, transitionFrames[1] - transitionRadius)
          .map((sample) => Math.abs(sample)),
      );
      const liveMonitorClickRatio = transitionPeakDelta / Math.max(steadyPeakDelta, 1e-9);
      const maxCurvature = (start: number, end: number) => {
        let peak = 0;
        for (let index = Math.max(2, start); index < Math.min(clickCapture.samples.length, end); index++) {
          peak = Math.max(
            peak,
            Math.abs(
              clickCapture.samples[index] - 2 * clickCapture.samples[index - 1] + clickCapture.samples[index - 2],
            ),
          );
        }
        return peak;
      };
      const transitionPeakCurvature = Math.max(
        ...transitionFrames.map((frame) => maxCurvature(frame - transitionRadius, frame + transitionRadius)),
      );
      const steadyPeakCurvature = Math.max(
        maxCurvature(0, transitionFrames[0] - transitionRadius),
        maxCurvature(transitionFrames[0] + transitionRadius, transitionFrames[1] - transitionRadius),
        maxCurvature(transitionFrames[1] + transitionRadius, clickCapture.samples.length),
      );
      const liveMonitorTransientRatio = transitionPeakCurvature / Math.max(steadyPeakCurvature, 1e-9);

      const offlineContext = new OfflineAudioContext(2, sampleRate, sampleRate);
      await loadCoreWorklets(offlineContext);
      engine.useContext(offlineContext);
      engine.setProject(doc);
      await settleProject(engine);
      const oldGateDisposed =
        liveGateNode.disconnectCalls > 0 && liveGateNode.node.port.onmessage === null && liveHandlerWasInstalled;

      const offlineBuffer = offlineContext.createBuffer(1, sampleRate, sampleRate);
      const offlineInput = offlineBuffer.getChannelData(0);
      for (let index = 0; index < offlineInput.length; index++) {
        const time = index / sampleRate;
        offlineInput[index] = 0.22 * Math.sin(2 * Math.PI * 997 * time) + 0.09 * Math.sin(2 * Math.PI * 3701 * time);
      }
      const offlineSource = offlineContext.createBufferSource();
      offlineSource.buffer = offlineBuffer;
      offlineSource.loop = true;
      offlineSource.connect(makeEngineInternals(engine).masterChain.input);
      offlineSource.start(0);
      await engine.prepareOfflineRender();
      const offlineRendered = await offlineContext.startRendering();
      const offlineSamples = offlineRendered.getChannelData(0);
      const expectedOffset = Math.max(0, Math.round((liveCapture.originTime - sourceStartTime) * sampleRate));
      const compareFrames = 4096;
      let best = { offset: 0, correlation: -1, nullDb: Number.POSITIVE_INFINITY };
      for (let adjustment = -256; adjustment <= 256; adjustment++) {
        const start = expectedOffset + adjustment;
        if (start < 0 || start + compareFrames > offlineSamples.length) continue;
        let dot = 0;
        let liveEnergy = 0;
        let offlineEnergy = 0;
        let errorEnergy = 0;
        for (let index = 0; index < compareFrames; index++) {
          const liveSample = liveCapture.samples[index];
          const offlineSample = offlineSamples[start + index];
          dot += liveSample * offlineSample;
          liveEnergy += liveSample * liveSample;
          offlineEnergy += offlineSample * offlineSample;
          const error = liveSample - offlineSample;
          errorEnergy += error * error;
        }
        const correlation = dot / Math.sqrt(Math.max(1e-30, liveEnergy * offlineEnergy));
        if (correlation > best.correlation) {
          best = {
            offset: adjustment,
            correlation,
            nullDb: 10 * Math.log10((errorEnergy + 1e-30) / Math.max(1e-30, liveEnergy)),
          };
        }
      }

      await liveContext.close();
      window.AudioWorkletNode = nativeNodeConstructor;
      return {
        fallback,
        gateLatencySec,
        bypassLatencyTargetSec,
        activeBypassLatencyTargetSec,
        liveGateHandlerInstalled: liveHandlerWasInstalled,
        oldGateDisposed,
        dryMonitorPeak,
        transitionPeakDelta,
        steadyPeakDelta,
        liveMonitorClickRatio,
        transitionPeakCurvature,
        steadyPeakCurvature,
        liveMonitorTransientRatio,
        transitionDeltas,
        steadyDeltas,
        transitionFrames,
        liveOfflineCorrelation: best.correlation,
        liveOfflineNullDb: best.nullDb,
        liveOfflineAlignmentSamples: best.offset,
      };
    });

    expect(facts.fallback.gate, "master insert should begin with its explicit fallback").toBe(true);
    expect(facts.fallback.stages).toEqual(expect.arrayContaining(["tape", "glue", "limiter"]));
    expect(facts.gateLatencySec).toBeGreaterThan(0.0024);
    expect(facts.gateLatencySec).toBeLessThan(0.0026);
    expect(facts.bypassLatencyTargetSec).toBeGreaterThan(facts.gateLatencySec);
    expect(facts.bypassLatencyTargetSec).toBeLessThan(facts.gateLatencySec + 0.0003);
    expect(Math.abs(facts.activeBypassLatencyTargetSec - facts.gateLatencySec) * 44100).toBeLessThanOrEqual(1);
    expect(facts.liveGateHandlerInstalled).toBe(true);
    expect(
      facts.oldGateDisposed,
      "context replacement should disconnect the old insert and clear its port handler",
    ).toBe(true);
    expect(facts.dryMonitorPeak, "live monitor bypass should deliver aligned dry audio").toBeGreaterThan(0.1);
    expect(facts.liveMonitorTransientRatio, JSON.stringify(facts)).toBeLessThan(1.6);
    expect(facts.liveOfflineCorrelation, JSON.stringify(facts)).toBeGreaterThan(0.99);
    expect(facts.liveOfflineNullDb).toBeLessThan(-40);
    expect(Math.abs(facts.liveOfflineAlignmentSamples)).toBeLessThanOrEqual(256);
  });

  test("opens the simple view and follows signal-flow keyboard focus into advanced controls", async ({ page }) => {
    test.setTimeout(150_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const workspace = page.getByRole("region", { name: "Mastering workspace" });
    await expect(workspace).toBeVisible();
    await expect(page.getByRole("group", { name: "Master controls view" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Simple" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("slider", { name: "IN", exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: "CEIL", exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: "TRIM", exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: "TILT", exact: true })).toHaveCount(0);

    await page.getByRole("slider", { name: "CEIL", exact: true }).focus();
    const statusHint = page.getByRole("status");
    await expect(statusHint).toHaveAttribute("aria-live", "polite");
    await expect(statusHint).toHaveAttribute("aria-atomic", "true");
    await expect(statusHint).toContainText("CEIL — Physical limiter ceiling in dBFS.");
    await expect(statusHint).toContainText("-1.0 dB");

    await page.getByRole("button", { name: "Focus TILT controls" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("slider", { name: "TILT", exact: true })).toBeFocused();

    await page.getByRole("button", { name: "Simple" }).click();
    await expect(page.getByRole("slider", { name: "TILT", exact: true })).toHaveCount(0);
    await expect(page.getByText(/other enabled processors keep their saved state/i)).toBeVisible();

    const mixerTab = page.locator('.dock-tabs button[aria-label="Toggle mixer panel"]');
    const devicesTab = page.locator('.dock-tabs button[aria-label="Toggle track device chain"]');
    const exportTab = page.locator('.dock-tabs button[aria-label="Toggle export panel"]');
    const masterTab = page.locator('.dock-tabs button[aria-label="Toggle mastering panel"]');
    await expect(mixerTab).toBeVisible();
    await expect(mixerTab).toHaveAttribute("title", /Alt\+1/);
    await expect(devicesTab).toBeVisible();
    await expect(devicesTab).toHaveAttribute("title", /Alt\+2/);
    await expect(exportTab).toBeVisible();
    await expect(exportTab).toHaveAttribute("title", /Alt\+5/);

    await page.keyboard.press("Alt+1");
    await expect(mixerTab).toHaveAttribute("aria-selected", "true");
    await mixerTab.focus();
    await page.keyboard.press("Alt+9");
    await expect(workspace).toBeVisible();
    await masterTab.focus();
    await page.keyboard.press("Alt+9");
    await expect(workspace).toHaveCount(0);
    await expect(page.locator(".dock-tabs")).toBeVisible();
  });

  test("keeps mastering controls within a narrow dock viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const workspace = page.locator(".mastering-panel");
    await expect(workspace).toBeVisible();
    const overflow = await workspace.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    expect(overflow, "mastering workspace should scroll vertically without horizontal overflow").toBe(false);
    await expect(page.getByRole("button", { name: "ANALYZE FULL SONG" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Render A/B" })).toBeVisible();
  });

  test("round-trips a local mastering reference through browser IndexedDB", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const facts = await page.evaluate(async () => {
      const repositoryModulePath = ["/src", "mastering", "referenceRepository.ts"].join("/");
      const { MASTERING_REFERENCE_DB, MasteringReferenceRepository } = await import(repositoryModulePath);
      const repository = new MasteringReferenceRepository();
      const projectId = `mastering-reference-e2e-${crypto.randomUUID()}`;
      const bytes = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4];
      const source = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
      await repository.put({
        projectId,
        fileName: "reference.wav",
        mimeType: "audio/wav",
        byteLength: source.size,
        importedAt: new Date().toISOString(),
        source,
      });

      const loaded = await repository.get(projectId);
      const loadedBytes = loaded ? [...new Uint8Array(await loaded.source.arrayBuffer())] : [];
      await repository.delete(projectId);
      return {
        database: MASTERING_REFERENCE_DB,
        fileName: loaded?.fileName ?? null,
        byteLength: loaded?.byteLength ?? null,
        bytes: loadedBytes,
        removed: (await repository.get(projectId)) === null,
      };
    });

    expect(facts.database).toBe("kyx-mastering-reference");
    expect(facts.fileName).toBe("reference.wav");
    expect(facts.byteLength).toBe(8);
    expect(facts.bytes).toEqual([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    expect(facts.removed).toBe(true);
  });

  test("cancels a mastering render without leaving a report or download", async ({ page }) => {
    test.setTimeout(150_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const exportPanel = page.locator(".mastering-render-section");
    const status = page.locator(".export-status");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    await expect(page.getByRole("button", { name: "Cancel export" })).toBeVisible({ timeout: 15_000 });
    const unexpectedDownload = page
      .waitForEvent("download", { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.getByRole("button", { name: "Cancel export" }).click();

    await expect(status).toHaveClass(/export-cancelled/, { timeout: 30_000 });
    await expect(status).toContainText("Cancelled by user.");
    await expect(page.getByRole("note", { name: "Master render report details" })).toHaveCount(0);
    expect(await unexpectedDownload).toBe(false);
  });

  test("cancels a master export during WAV encoding without a report or download", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");
    await page.getByLabel("Analysis scope").selectOption("pattern");
    await page.evaluate(() => {
      const marker = window as Window & {
        __masteringEncodeStarted?: boolean;
        __masteringEncodeYieldDelayed?: boolean;
      };
      marker.__masteringEncodeStarted = false;
      marker.__masteringEncodeYieldDelayed = false;
      const originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (marker.__masteringEncodeStarted && timeout === 0 && !marker.__masteringEncodeYieldDelayed) {
          marker.__masteringEncodeYieldDelayed = true;
          return originalSetTimeout(handler, 10_000, ...args);
        }
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;

      const checkStatus = () => {
        if (document.querySelector(".export-status")?.textContent?.includes("Encoding WAV")) {
          marker.__masteringEncodeStarted = true;
        }
      };
      new MutationObserver(checkStatus).observe(document.body, { childList: true, subtree: true, characterData: true });
      checkStatus();
    });

    const exportPanel = page.locator(".mastering-render-section");
    const status = page.locator(".export-status");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    await expect(status).toContainText("Encoding WAV", { timeout: 150_000 });
    await page.waitForFunction(
      () => (window as Window & { __masteringEncodeYieldDelayed?: boolean }).__masteringEncodeYieldDelayed === true,
      undefined,
      { timeout: 150_000 },
    );

    const unexpectedDownload = page
      .waitForEvent("download", { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.getByRole("button", { name: "Cancel export" }).click();
    await expect(status).toHaveClass(/export-cancelled/, { timeout: 30_000 });
    await expect(status).toContainText("Cancelled by user.");
    await expect(page.getByRole("note", { name: "Master render report details" })).toHaveCount(0);
    expect(await unexpectedDownload).toBe(false);
  });

  test("cancels a master export during post-encode decode without a report or download", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");
    await page.getByLabel("Analysis scope").selectOption("pattern");
    await page.evaluate(() => {
      const marker = window as Window & { __masteringWavDecodePending?: boolean };
      marker.__masteringWavDecodePending = false;
      const prototype = OfflineAudioContext.prototype;
      const originalDecode = prototype.decodeAudioData;
      Object.defineProperty(prototype, "decodeAudioData", {
        configurable: true,
        writable: true,
        value: function (this: OfflineAudioContext, encodedBytes: ArrayBuffer): Promise<AudioBuffer> {
          const bytes = new Uint8Array(encodedBytes);
          const isBwfMaster =
            bytes.length > 700 &&
            bytes[0] === 0x52 &&
            bytes[1] === 0x49 &&
            bytes[2] === 0x46 &&
            bytes[3] === 0x46 &&
            bytes[8] === 0x57 &&
            bytes[9] === 0x41 &&
            bytes[10] === 0x56 &&
            bytes[11] === 0x45 &&
            bytes[36] === 0x62 &&
            bytes[37] === 0x65 &&
            bytes[38] === 0x78 &&
            bytes[39] === 0x74;
          const decoded = originalDecode.call(this, encodedBytes);
          if (!isBwfMaster) return decoded;
          marker.__masteringWavDecodePending = true;
          return decoded.then(
            (audio) => new Promise<AudioBuffer>((resolve) => setTimeout(() => resolve(audio), 15_000)),
          );
        },
      });
    });

    const exportPanel = page.locator(".mastering-render-section");
    const status = page.locator(".export-status");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    await page.waitForFunction(
      () => (window as Window & { __masteringWavDecodePending?: boolean }).__masteringWavDecodePending === true,
      undefined,
      { timeout: 150_000 },
    );
    await expect(status).toContainText("Checking encoded WAV");

    const unexpectedDownload = page
      .waitForEvent("download", { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.getByRole("button", { name: "Cancel export" }).click();
    await expect(status).toHaveClass(/export-cancelled/, { timeout: 30_000 });
    await expect(status).toContainText("Cancelled by user.");
    await expect(page.getByRole("note", { name: "Master render report details" })).toHaveCount(0);
    expect(await unexpectedDownload).toBe(false);
  });

  test("analyzes the full song, invalidates the report after a master edit, and remeasures", async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");
    await page.getByLabel("Master delivery profile").selectOption("streaming");

    const overviewStatus = page.locator(".mastering-overview-status");
    const exportPanel = page.locator(".mastering-render-section");
    const screenReaderStatus = exportPanel.locator(".sr-only");
    await page.getByRole("button", { name: "ANALYZE FULL SONG" }).click();
    await expect(overviewStatus).toHaveAttribute("data-state", "busy");
    await expect(screenReaderStatus).toHaveAttribute("role", "status");
    await expect(screenReaderStatus).toHaveAttribute("aria-live", "polite");
    await expect(screenReaderStatus).toHaveAttribute("aria-atomic", "true");
    await expect(screenReaderStatus).toContainText("Analyzing master");
    const report = page.getByRole("note", { name: "Master render report details" });
    await expect(report).toBeVisible({ timeout: 120_000 });
    await expect(report).toContainText("FULL SONG");
    await expect(report).toContainText("REPORT V");
    await expect(overviewStatus).not.toHaveText("ANALYZING");

    await page.getByRole("slider", { name: "IN", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(overviewStatus).toHaveText("STALE · ANALYZE AGAIN");
    await expect(page.locator(".export-status .export-policy-warning")).toContainText("STALE REPORT");
    await expect(screenReaderStatus).toContainText("Master report is stale. Analyze again before delivery.");

    await page.getByRole("button", { name: "ANALYZE FULL SONG" }).click();
    await expect(report).toBeVisible({ timeout: 120_000 });
    await expect(overviewStatus).not.toHaveText("STALE · ANALYZE AGAIN");
    await expect(page.locator(".export-status .export-policy-warning")).toHaveCount(0);

    await page.getByLabel("DEPTH").selectOption("16");
    const downloadPromise = page.waitForEvent("download");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.wav$/i);
    const encodedCheck = page.getByRole("region", { name: "Encoded master file check" });
    await expect(encodedCheck).toBeVisible({ timeout: 120_000 });
    await expect(encodedCheck).toContainText("WAV · 16-bit PCM");
    await expect(encodedCheck).toContainText("BWF v2");
    await expect(encodedCheck).toContainText("BWF v2 source PCM");
    await expect(encodedCheck).toContainText("FINAL FILE · DECODED + MEASURED");
    await expect(encodedCheck.getByRole("list", { name: "File check warnings" })).toHaveCount(0);
    const profileFileCheck = encodedCheck.getByRole("group", { name: "Profile file delivery check" });
    await expect(profileFileCheck).toHaveAttribute("data-state", "warn");
    await expect(profileFileCheck).toContainText("16-bit only when no higher-bit-depth master exists");

    const firstPath = await download.path();
    expect(firstPath).toBeTruthy();
    const firstFacts = readMasterWavFacts(await readFile(firstPath!));
    expect(firstFacts).toMatchObject({ formatCode: 1, channels: 2, sampleRate: 44100, bitDepth: 16, bextVersion: 2 });
    expect(firstFacts.peak, "the delivered master must contain audible signal").toBeGreaterThan(0.001);
    expect(firstFacts.rms, "the delivered master must contain sustained audio energy").toBeGreaterThan(0.0001);

    const verifyDepth = async (depth: 24 | 32) => {
      await page.getByLabel("DEPTH").selectOption(String(depth));
      const nextDownload = page.waitForEvent("download");
      await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
      const delivered = await nextDownload;
      expect(delivered.suggestedFilename()).toMatch(/\.wav$/i);

      const expectedLabel = depth === 24 ? "WAV · 24-bit PCM" : "WAV · 32-bit float";
      await expect(encodedCheck).toContainText(expectedLabel, { timeout: 120_000 });
      await expect(encodedCheck).toContainText("BWF v2 source PCM");
      await expect(encodedCheck).toContainText("FINAL FILE · DECODED + MEASURED");
      await expect(encodedCheck.getByRole("list", { name: "File check warnings" })).toHaveCount(0);
      await expect(profileFileCheck).toHaveAttribute("data-state", depth === 32 ? "fail" : "pass");

      const deliveredPath = await delivered.path();
      expect(deliveredPath).toBeTruthy();
      const deliveredBytes = await readFile(deliveredPath!);
      const facts = readMasterWavFacts(deliveredBytes);
      expect(facts).toMatchObject({
        formatCode: depth === 32 ? 3 : 1,
        channels: 2,
        sampleRate: 44100,
        bitDepth: depth,
        bextVersion: 2,
        frames: firstFacts.frames,
      });
      expect(facts.peak, `${depth}-bit master must contain audible signal`).toBeGreaterThan(0.001);
      expect(facts.rms, `${depth}-bit master must contain sustained audio energy`).toBeGreaterThan(0.0001);

      const reportText = await report.innerText();
      const sampleCount = reportText.match(/([\d\s,\.\u00a0\u202f]+)\s+samples/i);
      expect(sampleCount, "the report should expose the exact rendered sample range").toBeTruthy();
      expect(facts.frames).toBe(Number(sampleCount![1].replace(/\D/g, "")));
      return deliveredBytes;
    };

    await verifyDepth(24);
    const finalWavBytes = await verifyDepth(32);
    const reportDownloadPromise = page.waitForEvent("download");
    await report.getByRole("button", { name: "Download mastering report JSON" }).click();
    const reportDownload = await reportDownloadPromise;
    const reportPath = testInfo.outputPath("project-master-delivery-report.json");
    await reportDownload.saveAs(reportPath);
    const deliveryReport = JSON.parse(await readFile(reportPath, "utf8"));
    expect(deliveryReport.schemaVersion).toBe(11);
    expect(deliveryReport.report.version).toBe(11);
    expect(deliveryReport.report.encodedDelivery.fileDelivery).toMatchObject({
      profileId: "streaming",
      status: "fail",
    });
    expect(
      deliveryReport.report.encodedDelivery.fileDelivery.checks.some((check: { line: string }) =>
        check.line.includes("requires WAVE_FORMAT_PCM"),
      ),
    ).toBe(true);
    expect(deliveryReport.report.encodedDelivery.fingerprint).toMatchObject({
      algorithm: "SHA-256",
      status: "computed",
      hex: createHash("sha256").update(finalWavBytes).digest("hex"),
    });
  });

  test("checks Apple file rules in a project master export", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "Apple Music project delivery acceptance runs in Chromium and focused Firefox.",
    );
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");
    await page.getByLabel("Master delivery profile").selectOption("apple");
    await expect(page.getByRole("link", { name: "Apple Music · Video and Audio Asset Guide" }).first()).toBeVisible();
    await expect(page.locator(".mastering-profile-note")).toContainText(
      "Apple's Music Audio Source Profile defines file delivery, not this loudness target.",
    );

    const exportPanel = page.locator(".mastering-render-section");
    await page.getByRole("button", { name: "ANALYZE FULL SONG" }).click();
    const report = page.getByRole("note", { name: "Master render report details" });
    await expect(report).toBeVisible({ timeout: 120_000 });

    const downloadPromise = page.waitForEvent("download");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.wav$/i);
    const filePath = testInfo.outputPath("apple-project-master.wav");
    await download.saveAs(filePath);
    expect(readMasterWavFacts(await readFile(filePath))).toMatchObject({
      formatCode: 1,
      channels: 2,
      sampleRate: 44_100,
      bitDepth: 24,
      bextVersion: 2,
    });

    const encodedCheck = page.getByRole("region", { name: "Encoded master file check" });
    await expect(encodedCheck).toContainText("FINAL FILE · DECODED + MEASURED", { timeout: 120_000 });
    const fileCheck = encodedCheck.getByRole("group", { name: "Profile file delivery check" });
    await expect(fileCheck).toHaveAttribute("data-state", "not-measured");
    await expect(fileCheck).toContainText("WAV is accepted by the checked source profile");
    await expect(fileCheck).toContainText("44,100 Hz is accepted by the checked source profile");
    await expect(fileCheck).toContainText("24-bit is accepted by the checked source profile");
    await expect(fileCheck).toContainText("qualified encoder");

    const reportDownloadPromise = page.waitForEvent("download");
    await report.getByRole("button", { name: "Download mastering report JSON" }).click();
    const reportDownload = await reportDownloadPromise;
    const reportPath = testInfo.outputPath("apple-project-master-report.json");
    await reportDownload.saveAs(reportPath);
    const deliveryReport = JSON.parse(await readFile(reportPath, "utf8"));
    expect(deliveryReport.report.encodedDelivery.fileDelivery).toMatchObject({
      profileId: "apple",
      status: "not-measured",
    });
    expect(deliveryReport.profileProvenance.fileSettingsSource.url).toContain(
      "help.apple.com/itc/videoaudioassetguide",
    );
    expect(deliveryReport.profileProvenance.fileSettingsReview).toBe("current");
    expect(deliveryReport.profileProvenance.fileSettingsSource.checkedAt).toBe("2026-10-08");

    await exportPanel.getByRole("combobox", { name: "FORMAT" }).selectOption("flac");
    await page.getByLabel("DEPTH").selectOption("16");
    const flacDownloadPromise = page.waitForEvent("download");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER (FLAC)" }).click();
    const flacDownload = await flacDownloadPromise;
    expect(flacDownload.suggestedFilename()).toMatch(/\.flac$/i);
    const flacPath = testInfo.outputPath("apple-project-master-16bit.flac");
    await flacDownload.saveAs(flacPath);
    expect(readFlacFacts(await readFile(flacPath))).toMatchObject({
      sampleRate: 44_100,
      channels: 2,
      bitDepth: 16,
    });
    await expect(encodedCheck).toContainText("FLAC · 16-bit", { timeout: 120_000 });
    await expect(encodedCheck).toContainText("FINAL FILE · DECODED + MEASURED");
    await expect(fileCheck).toHaveAttribute("data-state", "not-measured");
    await expect(fileCheck).toContainText("FLAC is accepted by the checked source profile");
    await expect(fileCheck).toContainText("16-bit is accepted by the checked source profile");
    const exportAnnouncement = exportPanel.locator(".sr-only");
    await expect(exportAnnouncement).toHaveAttribute("role", "status");
    await expect(exportAnnouncement).toContainText("Profile file delivery check: not measured.");
    await expect(exportAnnouncement).toContainText("Apple-qualified encoder");

    const flacReportDownloadPromise = page.waitForEvent("download");
    await report.getByRole("button", { name: "Download mastering report JSON" }).click();
    const flacReportDownload = await flacReportDownloadPromise;
    const flacReportPath = testInfo.outputPath("apple-project-master-16bit-report.json");
    await flacReportDownload.saveAs(flacReportPath);
    const flacDeliveryReport = JSON.parse(await readFile(flacReportPath, "utf8"));
    expect(flacDeliveryReport.report.encodedDelivery.fileDelivery).toMatchObject({
      profileId: "apple",
      status: "not-measured",
    });
  });

  test("inspects a large MP3 in a real worker or reports unsupported browser decoding", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const inspection = await page.evaluate(async () => {
      const mp3ModulePath = ["/src", "export", "mp3.ts"].join("/");
      const inspectionModulePath = ["/src", "mastering", "encodedInspection.ts"].join("/");
      const profilesModulePath = ["/src", "mastering", "profiles.ts"].join("/");
      const analysisModulePath = ["/src", "mastering", "analysis.ts"].join("/");
      const [mp3Module, inspectionModule, profilesModule, analysisModule] = await Promise.all([
        import(mp3ModulePath),
        import(inspectionModulePath),
        import(profilesModulePath),
        import(analysisModulePath),
      ]);
      const sampleRate = 44100;
      const frameCount = sampleRate * 4;
      const buffer = new AudioBuffer({ length: frameCount, numberOfChannels: 2, sampleRate });
      const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
      for (let frame = 0; frame < frameCount; frame++) {
        channels[0][frame] = 0.24 * Math.sin((2 * Math.PI * 221 * frame) / sampleRate);
        channels[1][frame] = 0.19 * Math.sin((2 * Math.PI * 223 * frame) / sampleRate);
      }
      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      const sourceAnalysis = analysisModule.analyzeMasterPcm(channels, sampleRate, profile);
      const encoded = await mp3Module.encodeMp3(buffer, { kbps: 320 });

      // A valid ID3v2 padding tag takes the file over the 12 MiB inspection
      // threshold while leaving only the real MP3 frames for the decoder worker.
      const paddingBytes = 12 * 1024 * 1024 + 1;
      const header = new Uint8Array(10);
      header.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
      header[6] = (paddingBytes >>> 21) & 0x7f;
      header[7] = (paddingBytes >>> 14) & 0x7f;
      header[8] = (paddingBytes >>> 7) & 0x7f;
      header[9] = paddingBytes & 0x7f;
      const padding = new Uint8Array(paddingBytes);
      const largeFile = new Blob([header, padding, encoded], { type: "audio/mpeg" });
      let firstDecodeProgress: number | null = null;
      const result = await inspectionModule.inspectEncodedMaster({
        format: "mp3",
        bytes: largeFile,
        expectedDurationSeconds: buffer.duration,
        sourceMeasurements: sourceAnalysis.measurements,
        profile,
        onProgress: ({ progress, stage }: { progress: number; stage: string }) => {
          if (stage.startsWith("Decoding and analyzing MP3 frames") && firstDecodeProgress === null) {
            firstDecodeProgress = progress;
          }
        },
      });
      let cancellationRequested = false;
      const controller = new AbortController();
      const cancellationErrorName = await inspectionModule
        .inspectEncodedMaster({
          format: "mp3",
          bytes: largeFile,
          expectedDurationSeconds: buffer.duration,
          sourceMeasurements: sourceAnalysis.measurements,
          profile,
          signal: controller.signal,
          onProgress: ({ stage }: { progress: number; stage: string }) => {
            if (stage.startsWith("Decoding and analyzing MP3 frames")) {
              cancellationRequested = true;
              controller.abort();
            }
          },
        })
        .then(() => null)
        .catch((error: unknown) => (error instanceof Error ? error.name : "unknown"));
      return {
        fileSize: result.byteLength,
        fileDurationAccuracy: result.file.durationAccuracy,
        status: result.decode.status,
        decoder: result.decode.decoder,
        reason: result.decode.reason ?? null,
        sampleRate: result.decode.sampleRate ?? null,
        channels: result.decode.channels ?? null,
        durationSeconds: result.decode.durationSeconds ?? null,
        rmsDb: result.decode.measurements?.rmsDb ?? null,
        truePeakDb: result.decode.measurements?.truePeakDb ?? null,
        firstDecodeProgress,
        cancellationRequested,
        cancellationErrorName,
      };
    });

    expect(inspection.fileSize).toBeGreaterThan(12 * 1024 * 1024);
    if (inspection.status === "measured") {
      expect(inspection.decoder).toBe("WebCodecs MP3 worker");
      expect(inspection.fileDurationAccuracy).toBe("exact");
      expect(inspection.sampleRate).toBe(44100);
      expect(inspection.channels).toBe(2);
      expect(inspection.durationSeconds).toBeGreaterThan(3.5);
      expect(inspection.durationSeconds).toBeLessThan(4.5);
      expect(Number.isFinite(inspection.rmsDb)).toBe(true);
      expect(Number.isFinite(inspection.truePeakDb)).toBe(true);
      expect(inspection.firstDecodeProgress).toBeGreaterThan(0);
      expect(inspection.firstDecodeProgress).toBeLessThan(0.75);
      expect(inspection.cancellationRequested).toBe(true);
      expect(inspection.cancellationErrorName).toBe("AbortError");
    } else {
      expect(inspection.status).toBe("not-measured");
      expect(inspection.decoder).toBe("WebCodecs MP3 worker");
      expect(inspection.fileDurationAccuracy).toBe("estimated");
      expect(inspection.reason).toMatch(
        /does not expose|does not support MP3|capability check failed|cannot run a background|could not start the background MP3 worker|could not configure its MP3 decoder/i,
      );
      expect(inspection.cancellationRequested).toBe(false);
      expect(inspection.cancellationErrorName).toBeNull();
    }
  });

  test("rejects a corrupted MP3 instead of presenting measurements", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const errorMessage = await page.evaluate(async () => {
      const inspectionModulePath = ["/src", "mastering", "encodedInspection.ts"].join("/");
      const profilesModulePath = ["/src", "mastering", "profiles.ts"].join("/");
      const [inspectionModule, profilesModule] = await Promise.all([
        import(inspectionModulePath),
        import(profilesModulePath),
      ]);
      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      try {
        await inspectionModule.inspectEncodedMaster({
          format: "mp3",
          bytes: new Blob([Uint8Array.of(0x00, 0x13, 0x7f, 0x2a)], { type: "audio/mpeg" }),
          expectedDurationSeconds: 1,
          sourceMeasurements: {},
          profile,
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "unknown error";
      }
    });
    expect(errorMessage).toMatch(/No valid MPEG Layer III frame/);
  });

  test("streams a WAV larger than 96 MiB through the real analyzer worker and aborts during chunking", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const inspection = await page.evaluate(async () => {
      const inspectionModulePath = ["/src", "mastering", "encodedInspection.ts"].join("/");
      const profilesModulePath = ["/src", "mastering", "profiles.ts"].join("/");
      const [inspectionModule, profilesModule] = await Promise.all([
        import(inspectionModulePath),
        import(profilesModulePath),
      ]);

      const sampleRate = 44_100;
      const thresholdBytes = 96 * 1024 * 1024;
      const dataBytes = thresholdBytes + 4;
      const frameCount = dataBytes / 4;
      const wav = new ArrayBuffer(44 + dataBytes);
      const view = new DataView(wav);
      const writeText = (offset: number, value: string) => {
        for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
      };
      writeText(0, "RIFF");
      view.setUint32(4, wav.byteLength - 8, true);
      writeText(8, "WAVE");
      writeText(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 2, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 4, true);
      view.setUint16(32, 4, true);
      view.setUint16(34, 16, true);
      writeText(36, "data");
      view.setUint32(40, dataBytes, true);

      const patternFrames = 441;
      const pattern = new Int16Array(patternFrames * 2);
      for (let frame = 0; frame < patternFrames; frame++) {
        pattern[frame * 2] = Math.round(9_000 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate));
        pattern[frame * 2 + 1] = Math.round(7_500 * Math.sin((2 * Math.PI * 223 * frame) / sampleRate));
      }
      const pcm = new Int16Array(wav, 44, dataBytes / 2);
      for (let sample = 0; sample < pcm.length; sample++) pcm[sample] = pattern[sample % pattern.length]!;

      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      const prototype = OfflineAudioContext.prototype;
      const originalDecode = prototype.decodeAudioData;
      let oversizedBrowserDecodeCalls = 0;
      Object.defineProperty(prototype, "decodeAudioData", {
        configurable: true,
        writable: true,
        value: function (this: OfflineAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
          if (bytes.byteLength > thresholdBytes) oversizedBrowserDecodeCalls++;
          return originalDecode.call(this, bytes);
        },
      });

      try {
        let progressEvents = 0;
        let lastProgress = 0;
        const result = await inspectionModule.inspectEncodedMaster({
          format: "wav",
          bytes: wav,
          expectedDurationSeconds: frameCount / sampleRate,
          sourceMeasurements: {},
          profile,
          onProgress: ({ progress }: { progress: number; stage: string }) => {
            progressEvents++;
            lastProgress = progress;
          },
        });
        const controller = new AbortController();
        let abortedAtProgress: number | null = null;
        const cancelErrorName = await inspectionModule
          .inspectEncodedMaster({
            format: "wav",
            bytes: wav,
            expectedDurationSeconds: frameCount / sampleRate,
            sourceMeasurements: {},
            profile,
            signal: controller.signal,
            onProgress: ({ progress, stage }: { progress: number; stage: string }) => {
              if (stage === "Analyzing audio in bounded worker chunks" && progress > 0) {
                abortedAtProgress = progress;
                controller.abort();
              }
            },
          })
          .then(() => null)
          .catch((error: unknown) => (error instanceof Error ? error.name : "unknown"));

        return {
          byteLength: result.byteLength,
          sourceDurationSeconds: result.file.durationSeconds,
          sourceDurationAccuracy: result.file.durationAccuracy,
          status: result.decode.status,
          decoder: result.decode.decoder,
          reason: result.decode.reason ?? null,
          sampleRate: result.decode.sampleRate ?? null,
          channels: result.decode.channels ?? null,
          durationSeconds: result.decode.durationSeconds ?? null,
          rmsDb: result.decode.measurements?.rmsDb ?? null,
          truePeakDb: result.decode.measurements?.truePeakDb ?? null,
          progressEvents,
          lastProgress,
          oversizedBrowserDecodeCalls,
          abortedAtProgress,
          cancelErrorName,
        };
      } finally {
        Object.defineProperty(prototype, "decodeAudioData", {
          configurable: true,
          writable: true,
          value: originalDecode,
        });
      }
    });

    expect(inspection.byteLength).toBeGreaterThan(96 * 1024 * 1024);
    expect(inspection.sourceDurationAccuracy).toBe("exact");
    expect(inspection.sourceDurationSeconds).toBeGreaterThan(570);
    expect(inspection.status, JSON.stringify({ reason: inspection.reason })).toBe("measured");
    expect(inspection.decoder).toBe("KYX WAV PCM reader");
    expect(inspection.sampleRate).toBe(44_100);
    expect(inspection.channels).toBe(2);
    expect(inspection.durationSeconds).toBeCloseTo(inspection.sourceDurationSeconds, 6);
    expect(Number.isFinite(inspection.rmsDb)).toBe(true);
    expect(Number.isFinite(inspection.truePeakDb)).toBe(true);
    expect(inspection.progressEvents).toBeGreaterThan(100);
    expect(inspection.lastProgress).toBeGreaterThan(0.8);
    expect(inspection.oversizedBrowserDecodeCalls).toBe(0);
    expect(inspection.abortedAtProgress).toBeGreaterThan(0);
    // The initial 15% covers file fingerprinting; first chunk acknowledgement is about 19.6% overall.
    expect(inspection.abortedAtProgress).toBeLessThan(0.25);
    expect(inspection.cancelErrorName).toBe("AbortError");
  });

  test("streams a two-hour PCM programme through the real analysis worker", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "The Windows WebKit build has no Web Audio support.");
    test.setTimeout(120_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const result = await page.evaluate(async () => {
      const analysisClientPath = ["/src", "mastering", "analysisClient.ts"].join("/");
      const profilesPath = ["/src", "mastering", "profiles.ts"].join("/");
      const [analysisClient, profilesModule] = await Promise.all([import(analysisClientPath), import(profilesPath)]);
      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");

      const sampleRate = 8_000;
      const durationSeconds = 2 * 60 * 60;
      const frameCount = sampleRate * durationSeconds;
      const cycle = Float32Array.from(
        { length: 8 },
        (_, index) => 10 ** (-23 / 20) * Math.sin((2 * Math.PI * index) / 8),
      );
      const chunkLengths: number[] = [];
      let lastProgress = 0;
      const analysis = await analysisClient.analyzeMasterPcmStreamAsync(
        {
          sampleRate,
          channelCount: 1,
          frameCount,
          readChunk(offset: number, length: number) {
            const channel = new Float32Array(length);
            for (let index = 0; index < length; index++) channel[index] = cycle[(offset + index) % cycle.length]!;
            chunkLengths.push(length);
            return [channel];
          },
        },
        profile,
        { onProgress: ({ progress }: { progress: number }) => (lastProgress = progress) },
      );
      return {
        durationSeconds: analysis.mixHealth.durationSec,
        channelCount: analysis.measurements.channelCount,
        chunkCount: chunkLengths.length,
        minChunkFrames: Math.min(...chunkLengths),
        maxChunkFrames: Math.max(...chunkLengths),
        finalChunkFrames: chunkLengths.at(-1) ?? 0,
        sourceWindowCount: analysis.loudnessTimeline?.sourceWindowCount ?? null,
        timelinePoints: analysis.loudnessTimeline?.points.length ?? 0,
        integratedLufs: analysis.measurements.lufsIntegrated,
        loudnessRangeLu: analysis.measurements.loudnessRangeLu,
        truePeakDb: analysis.measurements.truePeakDb,
        progress: lastProgress,
      };
    });

    const frameCount = 8_000 * 2 * 60 * 60;
    expect(result.durationSeconds).toBe(2 * 60 * 60);
    expect(result.channelCount).toBe(1);
    expect(result.chunkCount).toBe(Math.ceil(frameCount / 131_072));
    expect(result.maxChunkFrames).toBe(131_072);
    expect(result.minChunkFrames).toBeGreaterThan(0);
    expect(result.finalChunkFrames).toBeLessThanOrEqual(131_072);
    expect(result.sourceWindowCount).toBe(72_000 - 29);
    expect(result.timelinePoints).toBeLessThanOrEqual(1_200);
    expect(Number.isFinite(result.integratedLufs)).toBe(true);
    expect(Number.isFinite(result.loudnessRangeLu)).toBe(true);
    expect(Number.isFinite(result.truePeakDb)).toBe(true);
    expect(result.progress).toBe(1);
  });

  test("terminates a silent mastering analysis worker at its idle watchdog", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "The Windows WebKit build has no Web Audio support.");
    test.setTimeout(120_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const result = await page.evaluate(async () => {
      const analysisClientPath = ["/src", "mastering", "analysisClient.ts"].join("/");
      const profilesPath = ["/src", "mastering", "profiles.ts"].join("/");
      const [analysisClient, profilesModule] = await Promise.all([import(analysisClientPath), import(profilesPath)]);
      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");

      const watchdogDelayRequests: number[] = [];
      const originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 3 * 60 * 1000) {
          watchdogDelayRequests.push(timeout);
          timeout = 20;
        }
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;

      class SilentAnalysisWorker extends EventTarget {
        readonly messageTypes: string[] = [];
        terminatedCount = 0;

        postMessage(message: unknown): void {
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message) ||
            typeof message.type !== "string"
          )
            return;
          this.messageTypes.push(message.type);
          if (message.type === "MASTER_ANALYSIS_START" && "jobId" in message) {
            this.dispatchEvent(
              new MessageEvent("message", { data: { type: "MASTER_ANALYSIS_READY", jobId: message.jobId } }),
            );
          }
          // Deliberately do not acknowledge PCM chunks: the client must time out and terminate this worker.
        }

        terminate(): void {
          this.terminatedCount++;
        }
      }

      const workers: SilentAnalysisWorker[] = [];
      Object.defineProperty(window, "Worker", {
        configurable: true,
        writable: true,
        value: class extends SilentAnalysisWorker {
          constructor() {
            super();
            workers.push(this);
          }
        },
      });

      const error = await analysisClient
        .analyzeMasterPcmStreamAsync(
          {
            sampleRate: 48_000,
            channelCount: 1,
            frameCount: 48_000,
            readChunk: (_offset: number, length: number) => [new Float32Array(length)],
          },
          profile,
        )
        .then(
          () => null,
          (value: unknown) => (value instanceof Error ? value.message : String(value)),
        );
      const worker = workers[0];
      return {
        error,
        messageTypes: worker?.messageTypes ?? [],
        terminatedCount: worker?.terminatedCount ?? 0,
        watchdogDelayRequests,
      };
    });

    expect(result.error).toBe("Master analysis worker stopped responding for 3 minutes.");
    expect(result.messageTypes).toContain("MASTER_ANALYSIS_START");
    expect(result.messageTypes).toContain("MASTER_ANALYSIS_CHUNK");
    expect(result.terminatedCount).toBe(1);
    expect(result.watchdogDelayRequests.length).toBeGreaterThan(0);
    expect(result.watchdogDelayRequests.every((delay) => delay === 3 * 60 * 1000)).toBe(true);
  });

  test("renders an external source through an isolated copy of the project master chain", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const result = await page.evaluate(async () => {
      const sessionRenderPath = ["/src", "mastering", "sessionRender.ts"].join("/");
      const sampleBankPath = ["/src", "sample-library", "factory.ts"].join("/");
      const schemaPath = ["/src", "project-model", "schema.ts"].join("/");
      const [sessionRenderModule, sampleBankModule, schemaModule] = await Promise.all([
        import(sessionRenderPath),
        import(sampleBankPath),
        import(schemaPath),
      ]);
      const source = new AudioBuffer({ length: 44_100, numberOfChannels: 2, sampleRate: 44_100 });
      const left = source.getChannelData(0);
      const right = source.getChannelData(1);
      for (let frame = 0; frame < source.length; frame++) {
        left[frame] = 0.2 * Math.sin((2 * Math.PI * 440 * frame) / source.sampleRate);
        right[frame] = 0.15 * Math.sin((2 * Math.PI * 443 * frame) / source.sampleRate);
      }
      const originalSample = left[1_000];
      const master = schemaModule.defaultMasterConfig();
      master.masterGain = 0;
      master.loudnessTrimDb = 0;
      const bank = new sampleBankModule.SampleBank();
      const revisionBeforeRender = bank.revision;
      const output = await sessionRenderModule.renderMasteringSessionSource(source, master, bank, {
        sampleRate: 44_100,
        quality: "live",
      });
      let peak = 0;
      for (let channel = 0; channel < output.numberOfChannels; channel++) {
        const samples = output.getChannelData(channel);
        for (let frame = 0; frame < samples.length; frame++) peak = Math.max(peak, Math.abs(samples[frame]));
      }
      return {
        outputDurationSeconds: output.duration,
        outputSampleRate: output.sampleRate,
        outputChannels: output.numberOfChannels,
        peak,
        sourceSampleAfterRender: left[1_000],
        originalSample,
        masterGainAfterRender: master.masterGain,
        bankSizeAfterRender: bank.size,
        revisionAfterRender: bank.revision,
        revisionBeforeRender,
      };
    });

    expect(result.outputDurationSeconds).toBeCloseTo(3, 4);
    expect(result.outputSampleRate).toBe(44_100);
    expect(result.outputChannels).toBe(2);
    expect(result.peak).toBeLessThan(1e-6);
    expect(result.sourceSampleAfterRender).toBe(result.originalSample);
    expect(result.masterGainAfterRender).toBe(0);
    expect(result.bankSizeAfterRender).toBe(0);
    expect(result.revisionAfterRender).toBe(result.revisionBeforeRender);
  });

  test("renders, analyzes, and exports a 12-minute master through the final feedback-delay echo", async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "The long offline mastering render and delivery soak require browser Web Audio APIs.",
    );
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const cdpSession = testInfo.project.name === "chromium" ? await page.context().newCDPSession(page) : null;
    let cdpMemoryStage: "inactive" | "encode" | "inspection" = "inactive";
    let cdpMemoryBaselineBytes: number | null = null;
    let cdpMemoryEncodePeakBytes = 0;
    let cdpMemoryInspectionBaselineBytes: number | null = null;
    let cdpMemoryInspectionPeakBytes = 0;
    let cdpMemorySampleCount = 0;
    let cdpMemorySampleInFlight = false;
    const readCdpJsHeapBytes = async (): Promise<number | null> => {
      if (!cdpSession) return null;
      const { metrics } = await cdpSession.send("Performance.getMetrics");
      const usedHeap = metrics.find(({ name }) => name === "JSHeapUsedSize")?.value;
      return typeof usedHeap === "number" && Number.isFinite(usedHeap) ? usedHeap : null;
    };
    const sampleCdpJsHeap = async (stage: "encode" | "inspection"): Promise<number | null> => {
      if (!cdpSession || cdpMemorySampleInFlight) return null;
      cdpMemorySampleInFlight = true;
      try {
        const usedBytes = await readCdpJsHeapBytes();
        if (usedBytes === null) return null;
        cdpMemorySampleCount++;
        if (stage === "encode") cdpMemoryEncodePeakBytes = Math.max(cdpMemoryEncodePeakBytes, usedBytes);
        if (stage === "inspection") cdpMemoryInspectionPeakBytes = Math.max(cdpMemoryInspectionPeakBytes, usedBytes);
        return usedBytes;
      } catch {
        return null;
      } finally {
        cdpMemorySampleInFlight = false;
      }
    };
    if (cdpSession) await cdpSession.send("Performance.enable");
    const cdpMemorySampler = cdpSession
      ? setInterval(() => {
          if (cdpMemoryStage !== "inactive") void sampleCdpJsHeap(cdpMemoryStage);
        }, 250)
      : null;
    const stopCdpMemorySampler = () => {
      if (cdpMemorySampler !== null) clearInterval(cdpMemorySampler);
    };
    page.on("close", () => {
      stopCdpMemorySampler();
      if (cdpSession) void cdpSession.detach().catch(() => undefined);
    });
    await page.exposeFunction("__kyxMarkMasteringMemoryStage", async (stage: string) => {
      if (stage === "encode-start") {
        cdpMemoryBaselineBytes = await readCdpJsHeapBytes();
        cdpMemoryEncodePeakBytes = cdpMemoryBaselineBytes ?? 0;
        cdpMemoryStage = "encode";
      } else if (stage === "inspection-start") {
        await sampleCdpJsHeap("encode");
        cdpMemoryInspectionBaselineBytes = await readCdpJsHeapBytes();
        cdpMemoryInspectionPeakBytes = cdpMemoryInspectionBaselineBytes ?? 0;
        cdpMemoryStage = "inspection";
      }
      await markMasteringMemoryStage(stage);
    });
    const downloadPromise = page.waitForEvent("download");
    const resultPromise = page.evaluate(async () => {
      const durationSeconds = 12 * 60;
      const sampleRate = 44_100;
      const sampleRateBytes = 2 * Float32Array.BYTES_PER_ELEMENT;
      const source = new AudioBuffer({
        length: sampleRate,
        numberOfChannels: 2,
        sampleRate,
      });
      const left = source.getChannelData(0);
      const right = source.getChannelData(1);
      const cycle = Float32Array.from(
        { length: 48 },
        (_, index) => 10 ** (-23 / 20) * Math.sin((2 * Math.PI * index) / 48),
      );
      for (let frame = 0; frame < source.length; frame++) {
        const value = cycle[frame % cycle.length]!;
        left[frame] = value;
        right[frame] = value;
      }
      left[source.length - 1] = 0.75;
      right[source.length - 1] = 0.75;

      const paths = {
        sessionRender: ["/src", "mastering", "sessionRender.ts"].join("/"),
        sampleBank: ["/src", "sample-library", "factory.ts"].join("/"),
        schema: ["/src", "project-model", "schema.ts"].join("/"),
        renderer: ["/src", "rendering", "renderer.ts"].join("/"),
        analysis: ["/src", "mastering", "analysisClient.ts"].join("/"),
        profiles: ["/src", "mastering", "profiles.ts"].join("/"),
        wav: ["/src", "rendering", "wav.ts"].join("/"),
        wavLimits: ["/src", "export", "wav-limits.ts"].join("/"),
        inspection: ["/src", "mastering", "encodedInspection.ts"].join("/"),
        download: ["/src", "export", "download.ts"].join("/"),
      };
      const [sessionRender, sampleBank, schema, renderer, analysis, profiles, wav, wavLimits, inspection, download] =
        await Promise.all([
          import(paths.sessionRender),
          import(paths.sampleBank),
          import(paths.schema),
          import(paths.renderer),
          import(paths.analysis),
          import(paths.profiles),
          import(paths.wav),
          import(paths.wavLimits),
          import(paths.inspection),
          import(paths.download),
        ]);
      const master = schema.defaultMasterConfig();
      master.effects = [
        {
          id: "12-minute-tail-delay",
          type: "delay",
          bypassed: false,
          params: { time: 500, sync: 0, feedback: 0.4, mix: 0.5, tone: 6_000 },
        },
      ] as typeof master.effects;
      const sourceId = "12-minute-mastering-soak-source";
      const document = sessionRender.createMasteringSessionRenderDocument(durationSeconds, master, sourceId);
      const sourceClip = document.arrangement.audioClips?.[0];
      if (!sourceClip) throw new Error("The long mastering render source clip is missing.");
      sourceClip.loop = true;
      document.arrangement.audioClips!.push({
        ...sourceClip,
        id: "12-minute-mastering-tail-impulse",
        startBar: 359.5,
        lengthBars: 0.5,
        loop: false,
      });
      const tailSeconds = renderer.resolveRenderTailSeconds(document);
      const expectedPcmBytes = renderer.estimateRenderPcmBytes(document, { mode: "song", sampleRate });
      const sourcePcmBytes = source.length * source.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      const combinedPcmBytes = sourcePcmBytes + expectedPcmBytes;
      const bank = new sampleBank.SampleBank();
      bank.add(sourceId, source);
      const rendered = await renderer.renderProject(document, bank, { mode: "song", sampleRate, quality: "live" });

      let nonFiniteSamples = 0;
      let peak = 0;
      let lateEchoPeak = 0;
      const programEndFrame = durationSeconds * sampleRate;
      const lateEchoStart = programEndFrame + Math.floor(5.45 * sampleRate);
      const lateEchoEnd = Math.min(rendered.length, programEndFrame + Math.floor(5.9 * sampleRate));
      for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
        const samples = rendered.getChannelData(channel);
        for (let frame = 0; frame < samples.length; frame++) {
          const value = samples[frame]!;
          if (!Number.isFinite(value)) nonFiniteSamples++;
          const magnitude = Math.abs(Number.isFinite(value) ? value : 0);
          peak = Math.max(peak, magnitude);
          if (frame >= lateEchoStart && frame < lateEchoEnd) lateEchoPeak = Math.max(lateEchoPeak, magnitude);
        }
      }

      const profile = profiles.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      const report = await analysis.analyzeMasterBufferAsync(rendered, profile);
      const timeline = report.loudnessTimeline;
      const renderedPcmBytes = rendered.length * rendered.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      const encodedCopies = 1;
      const additionalWavBytes = wavLimits.estimateWavExportAdditionalWorkingSetBytes(
        renderedPcmBytes,
        24,
        encodedCopies,
      );
      wavLimits.assertWavExportWorkingSetBudget(renderedPcmBytes, additionalWavBytes);
      const markStage = (
        window as unknown as Window & { __kyxMarkMasteringMemoryStage: (stage: string) => Promise<void> }
      ).__kyxMarkMasteringMemoryStage;
      if (typeof markStage !== "function") throw new Error("The mastering memory marker bridge is unavailable.");
      const readUsedJsHeapBytes = (): number | null => {
        const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
        return memory && Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize! : null;
      };
      const jsHeapBaselineBytes = readUsedJsHeapBytes();
      let memoryStage: "inactive" | "encode" | "inspection" = "inactive";
      let encodeHeapPeakBytes = jsHeapBaselineBytes ?? 0;
      let inspectionHeapPeakBytes = jsHeapBaselineBytes ?? 0;
      let jsHeapSampleCount = 0;
      const jsHeapSampler = window.setInterval(() => {
        const usedBytes = readUsedJsHeapBytes();
        if (usedBytes === null) return;
        jsHeapSampleCount++;
        if (memoryStage === "encode") encodeHeapPeakBytes = Math.max(encodeHeapPeakBytes, usedBytes);
        if (memoryStage === "inspection") inspectionHeapPeakBytes = Math.max(inspectionHeapPeakBytes, usedBytes);
      }, 100);
      await markStage("encode-start");
      memoryStage = "encode";
      const deliveryBlob = await wav.encodeWavBlobAsync(rendered, 24, {
        integerOverflowPolicy: "reject",
        bext: wav.createBextMetadata({
          description: "KYX 12-minute mastering acceptance",
          loudness: {
            integratedLufs: report.measurements.lufsIntegrated,
            rangeLu: report.measurements.loudnessRangeLu,
            truePeakDbtp: report.measurements.truePeakDb,
            momentaryLufs: report.measurements.lufsMomentary,
            shortTermLufs: report.measurements.lufsShortTerm,
          },
          codingHistory: `A=PCM,F=${sampleRate},W=24,M=stereo,T=KYX offline render`,
        }),
      });
      await markStage("inspection-start");
      memoryStage = "inspection";
      inspectionHeapPeakBytes = Math.max(inspectionHeapPeakBytes, readUsedJsHeapBytes() ?? 0);
      const inspected = await inspection.inspectEncodedMaster({
        format: "wav",
        bytes: deliveryBlob,
        fingerprintBlob: deliveryBlob,
        expectedDurationSeconds: rendered.duration,
        sourceMeasurements: report.measurements,
        profile,
      });
      download.downloadBlob(deliveryBlob, "kyx-12-minute-master-24bit.wav");
      memoryStage = "inactive";
      window.clearInterval(jsHeapSampler);
      const finalJsHeapBytes = readUsedJsHeapBytes();
      return {
        sourceFrames: source.length,
        sourcePcmBytes,
        renderFrames: rendered.length,
        expectedRenderFrames: expectedPcmBytes / sampleRateBytes,
        sourceDurationSeconds: durationSeconds,
        renderDurationSeconds: rendered.duration,
        estimatedTailSeconds: tailSeconds,
        combinedPcmBytes,
        estimatedDeliveryWorkingSetBytes: renderedPcmBytes + additionalWavBytes,
        deliveryByteLength: deliveryBlob.size,
        deliveryFormat: inspected.file.bitDepth,
        deliveryDecodeStatus: inspected.decode.status,
        deliveryDecoder: inspected.decode.decoder,
        deliveryDurationSeconds: inspected.decode.durationSeconds,
        deliveryFingerprintStatus: inspected.fingerprint.status,
        deliveryBextVersion: inspected.file.bext?.version ?? null,
        nonFiniteSamples,
        peak,
        lateEchoPeak,
        integratedLufs: report.measurements.lufsIntegrated,
        truePeakDb: report.measurements.truePeakDb,
        analysisDurationSeconds: report.mixHealth.durationSec,
        analysisHasNonFiniteFlag: report.mixHealth.flags.some((flag: { check: string }) => flag.check === "non-finite"),
        timelineDurationSeconds: timeline?.durationSeconds ?? null,
        timelineWindowCount: timeline?.sourceWindowCount ?? 0,
        timelinePointCount: timeline?.points.length ?? 0,
        javascriptHeap: {
          apiAvailable: jsHeapBaselineBytes !== null,
          baselineBytes: jsHeapBaselineBytes,
          encodePeakBytes: jsHeapBaselineBytes === null ? null : encodeHeapPeakBytes,
          inspectionPeakBytes: jsHeapBaselineBytes === null ? null : inspectionHeapPeakBytes,
          finalBytes: finalJsHeapBytes,
          sampleCount: jsHeapSampleCount,
        },
      };
    });
    const [result, download] = await Promise.all([resultPromise, downloadPromise]);
    console.log("12-minute WAV mastering JavaScript heap samples:", result.javascriptHeap);
    if (cdpSession) {
      await sampleCdpJsHeap("inspection");
      cdpMemoryStage = "inactive";
      stopCdpMemorySampler();
      console.log("12-minute WAV mastering Chromium CDP JS heap samples:", {
        baselineBytes: cdpMemoryBaselineBytes,
        encodePeakBytes: cdpMemoryEncodePeakBytes,
        inspectionBaselineBytes: cdpMemoryInspectionBaselineBytes,
        inspectionPeakBytes: cdpMemoryInspectionPeakBytes,
        sampleCount: cdpMemorySampleCount,
      });
      await cdpSession.detach();
    }
    const outputPath = testInfo.outputPath("kyx-12-minute-master-24bit.wav");
    await download.saveAs(outputPath);
    const outputStats = await stat(outputPath);
    const outputHandle = await open(outputPath, "r");
    let outputHeader = Buffer.alloc(0);
    try {
      outputHeader = Buffer.alloc(4096);
      const { bytesRead } = await outputHandle.read(outputHeader, 0, outputHeader.byteLength, 0);
      expect(bytesRead).toBeGreaterThan(700);
    } finally {
      await outputHandle.close();
    }
    expect(result.sourceFrames).toBe(44_100);
    expect(result.sourcePcmBytes).toBe(44_100 * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(result.renderFrames).toBe(result.expectedRenderFrames);
    expect(result.sourceDurationSeconds).toBe(12 * 60);
    expect(result.estimatedTailSeconds).toBe(6);
    expect(result.renderDurationSeconds).toBe(12 * 60 + 6);
    expect(result.combinedPcmBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(result.estimatedDeliveryWorkingSetBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(result.deliveryByteLength).toBe(outputStats.size);
    expect(result.deliveryFormat).toBe(24);
    expect(result.deliveryDecodeStatus).toBe("measured");
    expect(result.deliveryDecoder).toBe("KYX WAV PCM reader");
    expect(result.deliveryDurationSeconds).toBeCloseTo(12 * 60 + 6, 6);
    if (cdpSession) {
      expect(cdpMemoryBaselineBytes).not.toBeNull();
      expect(cdpMemorySampleCount).toBeGreaterThan(0);
    }
    expect(result.deliveryFingerprintStatus).toBe("computed");
    expect(result.deliveryBextVersion).toBeGreaterThanOrEqual(2);
    expect(outputStats.size).toBeGreaterThan(180_000_000);
    expect(outputStats.size).toBeLessThan(200_000_000);
    expect(outputHeader.toString("ascii", 0, 4)).toBe("RIFF");
    expect(outputHeader.toString("ascii", 8, 12)).toBe("WAVE");
    expect(outputHeader.readUInt32LE(4) + 8).toBe(outputStats.size);
    const formatOffset = outputHeader.indexOf("fmt ", 12, "ascii");
    expect(outputHeader.readUInt16LE(formatOffset + 8)).toBe(1);
    expect(outputHeader.readUInt16LE(formatOffset + 10)).toBe(2);
    expect(outputHeader.readUInt32LE(formatOffset + 12)).toBe(44_100);
    expect(outputHeader.readUInt16LE(formatOffset + 22)).toBe(24);
    const bextOffset = outputHeader.indexOf("bext", formatOffset + 24, "ascii");
    expect(bextOffset).toBeGreaterThan(0);
    expect(outputHeader.readUInt16LE(bextOffset + 8 + 346)).toBeGreaterThanOrEqual(2);
    const bextSize = outputHeader.readUInt32LE(bextOffset + 4);
    const dataOffset = outputHeader.indexOf("data", bextOffset + 8 + bextSize + (bextSize % 2), "ascii");
    expect(dataOffset).toBeGreaterThan(0);
    expect(outputHeader.readUInt32LE(dataOffset + 4)).toBe(result.renderFrames * 6);
    expect(result.nonFiniteSamples).toBe(0);
    expect(result.peak).toBeGreaterThan(0);
    expect(result.lateEchoPeak).toBeGreaterThan(1e-7);
    expect(Number.isFinite(result.integratedLufs)).toBe(true);
    expect(Number.isFinite(result.truePeakDb)).toBe(true);
    expect(result.analysisHasNonFiniteFlag).toBe(false);
    expect(result.analysisDurationSeconds).toBe(12 * 60 + 6);
    expect(result.timelineDurationSeconds).toBe(12 * 60 + 6);
    expect(result.timelineWindowCount).toBeGreaterThan(7_000);
    expect(result.timelinePointCount).toBeLessThanOrEqual(1_200);
  });

  test("cancels an external source import while browser decoding is pending", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringDecodeGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const decodeStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __masteringDecodeGate?: { arm: (byteLength: number) => void; waitForStart: () => Promise<void> };
        }
      ).__masteringDecodeGate;
      if (!gate) throw new Error("Mastering decode gate was not installed.");
      gate.arm(44 + 44_100 * 4);
      return gate.waitForStart();
    });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "cancelled-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await decodeStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Decoding source audio…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText(/Source import cancelled\. The selected session was left unchanged\./),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringDecodeGate?: { release: () => void } }).__masteringDecodeGate?.release();
    });
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("cancels session restore during decoding and allows a successful retry", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringDecodeGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "restore-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    const decodeStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __masteringDecodeGate?: { arm: (byteLength: number) => void; waitForStart: () => Promise<void> };
        }
      ).__masteringDecodeGate;
      if (!gate) throw new Error("Mastering decode gate was not installed.");
      gate.arm(44 + 44_100 * 4);
      return gate.waitForStart();
    });
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await decodeStarted;
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("Session load cancelled.", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringDecodeGate?: { release: () => void } }).__masteringDecodeGate?.release();
    });

    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText(/Loaded restore-cancel-source\.wav/)).toBeVisible({ timeout: 30_000 });
    await expect(session.getByLabel("External master input gain")).toBeVisible();
  });

  test("cancels an external source import while reading the original Blob", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringFileReadGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const sourceFile = makeStereoTestWav();
    const readStarted = page.evaluate((byteLength) => {
      const gate = (
        window as Window & {
          __masteringFileReadGate?: {
            arm: (size: number) => void;
            waitForStart: () => Promise<void>;
          };
        }
      ).__masteringFileReadGate;
      if (!gate) throw new Error("Mastering file-read gate was not installed.");
      gate.arm(byteLength);
      return gate.waitForStart();
    }, sourceFile.length);
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "read-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: sourceFile,
    });
    await readStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Reading source file…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText(/Source import cancelled\. The selected session was left unchanged\./),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringFileReadGate?: { release: () => void } }).__masteringFileReadGate?.release();
    });
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("cancels an external source import while hashing its original file", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringHashGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const sourceFile = makeStereoTestWav();
    const digestStarted = page.evaluate((byteLength) => {
      const gate = (
        window as Window & {
          __masteringHashGate?: {
            arm: (size: number) => void;
            waitForStart: () => Promise<void>;
          };
        }
      ).__masteringHashGate;
      if (!gate) throw new Error("Mastering hash gate was not installed.");
      gate.arm(byteLength);
      return gate.waitForStart();
    }, sourceFile.length);
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "hash-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: sourceFile,
    });
    await digestStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Fingerprinting source file…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText(/Source import cancelled\. The selected session was left unchanged\./),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringHashGate?: { release: () => void } }).__masteringHashGate?.release();
    });
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("cancels an external source import during cooperative decoded-audio inspection", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await page.addInitScript(() => {
      const marker = window as Window & { __holdMasteringAudit?: boolean };
      const originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (marker.__holdMasteringAudit && timeout === 0) return originalSetTimeout(handler, 250, ...args);
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await page.evaluate(() => {
      (window as Window & { __holdMasteringAudit?: boolean }).__holdMasteringAudit = true;
    });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "inspection-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(12),
    });
    await expect(session.locator(".mastering-file-session-status")).toContainText("Inspecting decoded source audio…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText(/Source import cancelled\. The selected session was left unchanged\./),
    ).toBeVisible();
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("cancels a comparison reference import before it is saved", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringDecodeGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "reference-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    const decodeStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __masteringDecodeGate?: { arm: (byteLength: number) => void; waitForStart: () => Promise<void> };
        }
      ).__masteringDecodeGate;
      if (!gate) throw new Error("Mastering decode gate was not installed.");
      gate.arm(44 + 44_100 * 4);
      return gate.waitForStart();
    });
    await session.getByLabel("Import external mastering reference WAV, MP3 or FLAC").setInputFiles({
      name: "cancelled-reference.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await decodeStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Decoding comparison reference…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("Reference import cancelled.", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringDecodeGate?: { release: () => void } }).__masteringDecodeGate?.release();
    });

    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText(/Loaded reference-cancel-source\.wav/)).toBeVisible({ timeout: 30_000 });
    await expect(session.getByRole("button", { name: "Listen to reference" })).toHaveCount(0);
    await expect(session.getByText("cancelled-reference.wav", { exact: true })).toHaveCount(0);
  });

  test("cancels a comparison reference import while hashing its original file", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringHashGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "reference-hash-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });

    const referenceFile = makeStereoTestWav();
    const digestStarted = page.evaluate((byteLength) => {
      const gate = (
        window as Window & {
          __masteringHashGate?: {
            arm: (size: number) => void;
            waitForStart: () => Promise<void>;
          };
        }
      ).__masteringHashGate;
      if (!gate) throw new Error("Mastering hash gate was not installed.");
      gate.arm(byteLength);
      return gate.waitForStart();
    }, referenceFile.length);
    await session.getByLabel("Import external mastering reference WAV, MP3 or FLAC").setInputFiles({
      name: "hash-cancel-reference.wav",
      mimeType: "audio/wav",
      buffer: referenceFile,
    });
    await digestStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText(
      "Fingerprinting comparison reference…",
    );
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("Reference import cancelled.", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringHashGate?: { release: () => void } }).__masteringHashGate?.release();
    });

    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText(/Loaded reference-hash-source\.wav/)).toBeVisible({ timeout: 30_000 });
    await expect(session.getByRole("button", { name: "Listen to reference" })).toHaveCount(0);
    await expect(session.getByText("hash-cancel-reference.wav", { exact: true })).toHaveCount(0);
  });

  test("cancels a comparison reference import while reading its original Blob", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringFileReadGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "reference-read-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    const referenceFile = makeStereoTestWav();
    const readStarted = page.evaluate((byteLength) => {
      const gate = (
        window as Window & {
          __masteringFileReadGate?: { arm: (size: number) => void; waitForStart: () => Promise<void> };
        }
      ).__masteringFileReadGate;
      if (!gate) throw new Error("Mastering file-read gate was not installed.");
      gate.arm(byteLength);
      return gate.waitForStart();
    }, referenceFile.length);
    await session.getByLabel("Import external mastering reference WAV, MP3 or FLAC").setInputFiles({
      name: "read-cancel-reference.wav",
      mimeType: "audio/wav",
      buffer: referenceFile,
    });
    await readStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Validating comparison reference…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("Reference import cancelled.", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringFileReadGate?: { release: () => void } }).__masteringFileReadGate?.release();
    });

    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText(/Loaded reference-read-source\.wav/)).toBeVisible({ timeout: 30_000 });
    await expect(session.getByRole("button", { name: "Listen to reference" })).toHaveCount(0);
    await expect(session.getByText("read-cancel-reference.wav", { exact: true })).toHaveCount(0);
  });

  test("cancels reference analysis before its worker receives PCM", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringAnalysisGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "analysis-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    const analysisStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __masteringAnalysisGate?: { arm: () => void; waitForStart: () => Promise<void> };
        }
      ).__masteringAnalysisGate;
      if (!gate) throw new Error("Mastering analysis gate was not installed.");
      gate.arm();
      return gate.waitForStart();
    });
    await session.getByLabel("Import external mastering reference WAV, MP3 or FLAC").setInputFiles({
      name: "analysis-cancel-reference.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await analysisStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Measuring comparison reference…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("Reference import cancelled.", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringAnalysisGate?: { release: () => void } }).__masteringAnalysisGate?.release();
    });

    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText(/Loaded analysis-cancel-source\.wav/)).toBeVisible({ timeout: 30_000 });
    await expect(session.getByRole("button", { name: "Listen to reference" })).toHaveCount(0);
    await expect(session.getByText("analysis-cancel-reference.wav", { exact: true })).toHaveCount(0);
  });

  test("shows a clear message when browser storage quota blocks a source import", async ({ page }, testInfo) => {
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "External mastering import requires an audio-capable browser.",
    );
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put;
      Object.defineProperty(IDBObjectStore.prototype, "put", {
        configurable: true,
        writable: true,
        value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
          if (this.transaction.db.name === "kyx-mastering-sessions" && this.name === "sources") {
            throw new DOMException("Simulated browser quota reached", "QuotaExceededError");
          }
          if (arguments.length > 1) return originalPut.call(this, value, key);
          return originalPut.call(this, value);
        },
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "quota-limited.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByRole("alert")).toContainText("Browser storage is full", { timeout: 30_000 });
    await expect(session.getByText(/Original saved locally/)).toHaveCount(0);
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("shows a clear message when browser storage quota blocks a comparison reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "External mastering import requires an audio-capable browser.",
    );
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put;
      Object.defineProperty(IDBObjectStore.prototype, "put", {
        configurable: true,
        writable: true,
        value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
          if (this.transaction.db.name === "kyx-mastering-sessions" && this.name === "references") {
            throw new DOMException("Simulated browser quota reached", "QuotaExceededError");
          }
          if (arguments.length > 1) return originalPut.call(this, value, key);
          return originalPut.call(this, value);
        },
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "reference-quota-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    await session.getByLabel("Import external mastering reference WAV, MP3 or FLAC").setInputFiles({
      name: "reference-quota-fail.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByRole("alert")).toContainText("Browser storage is full", { timeout: 30_000 });
    await expect(session.getByText("reference-quota-fail.wav", { exact: true })).toHaveCount(0);
    await expect(session.getByRole("button", { name: "Listen to reference" })).toHaveCount(0);
  });

  test("explains when browser permissions block the local mastering database", async ({ page }, testInfo) => {
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "Storage permission workflow is tested on audio-capable browsers.",
    );
    await page.addInitScript(() => {
      const originalOpen = IDBFactory.prototype.open;
      Object.defineProperty(IDBFactory.prototype, "open", {
        configurable: true,
        writable: true,
        value: function (this: IDBFactory, name: string, version?: number): IDBOpenDBRequest {
          if (name === "kyx-mastering-sessions") {
            throw new DOMException("Simulated local storage permission denied", "SecurityError");
          }
          if (version !== undefined) return originalOpen.call(this, name, version);
          return originalOpen.call(this, name);
        },
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await expect(session.getByRole("alert")).toContainText("Browser storage is unavailable for this page");
    await expect(session.getByRole("alert")).toContainText("Check the site storage permission");
  });

  test("rejects a malformed external WAV header without creating a session", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const corruptedWav = makeStereoTestWav();
    corruptedWav.write("NOPE", 0, "ascii");
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "damaged-source.wav",
      mimeType: "audio/wav",
      buffer: corruptedWav,
    });
    await expect(session.getByRole("alert")).toContainText("RIFF/WAVE header");
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("rejects malformed FLAC STREAMINFO edges before starting the decoder worker", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "Malformed FLAC header acceptance runs in Chromium and the focused Firefox project.",
    );
    await page.addInitScript(() => {
      const originalWorker = globalThis.Worker;
      let flacDecoderStarts = 0;
      Object.defineProperty(window, "__flacDecoderStarts", {
        configurable: true,
        get: () => flacDecoderStarts,
      });
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: new Proxy(originalWorker, {
          construct(target, argumentsList, newTarget) {
            const options = argumentsList[1] as WorkerOptions | undefined;
            if (options?.name === "flac-decoder") flacDecoderStarts++;
            return Reflect.construct(target, argumentsList, newTarget);
          },
        }),
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const valid = makeMinimalFlac();
    const invalidMarker = Buffer.from(valid);
    invalidMarker.write("NOPE", 0, "ascii");
    const nonFirstStreamInfo = Buffer.from(valid);
    nonFirstStreamInfo[4] = 0x84;
    const truncatedMetadata = Buffer.from(valid);
    truncatedMetadata.set([0, 1, 0], 5);
    const duplicateStreamInfo = Buffer.alloc(valid.length + 38);
    duplicateStreamInfo.set(valid.subarray(0, 4), 0);
    duplicateStreamInfo.set([0, 0, 0, 34], 4);
    duplicateStreamInfo.set(valid.subarray(8, 42), 8);
    duplicateStreamInfo.set([0x80, 0, 0, 34], 42);
    duplicateStreamInfo.set(valid.subarray(8, 42), 46);
    duplicateStreamInfo.set(valid.subarray(42), 80);
    const zeroSampleRate = Buffer.from(valid);
    zeroSampleRate[18] = 0;
    zeroSampleRate[19] = 0;
    zeroSampleRate[20] &= 0x0f;
    const unknownFrameCount = Buffer.from(valid);
    unknownFrameCount[21] &= 0xf0;
    unknownFrameCount.fill(0, 22, 26);

    const malformedFiles = [
      { name: "damaged-marker.flac", bytes: invalidMarker, error: "missing its marker or STREAMINFO" },
      { name: "non-first-streaminfo.flac", bytes: nonFirstStreamInfo, error: "must begin with a 34-byte STREAMINFO" },
      { name: "truncated-metadata.flac", bytes: truncatedMetadata, error: "extends beyond the file" },
      { name: "duplicate-streaminfo.flac", bytes: duplicateStreamInfo, error: "invalid or duplicated" },
      { name: "zero-rate.flac", bytes: zeroSampleRate, error: "audio fields are invalid" },
      { name: "unknown-frame-count.flac", bytes: unknownFrameCount, error: "do not include a known duration" },
      { name: "missing-frame.flac", bytes: valid.subarray(0, 42), error: "not followed by an audio frame" },
    ];

    for (const file of malformedFiles) {
      await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
        name: file.name,
        mimeType: "audio/flac",
        buffer: file.bytes,
      });
      await expect(session.getByRole("alert")).toContainText(file.error, { timeout: 30_000 });
      await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
    }

    const flacDecoderStarts = await page.evaluate(
      () => (window as Window & { __flacDecoderStarts?: number }).__flacDecoderStarts ?? -1,
    );
    expect(flacDecoderStarts).toBe(0);
  });

  test("fails a FLAC source import clearly when the browser cannot start its decoder worker", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "FLAC worker failure acceptance currently runs in Chromium.");
    const flacSource = await makeBrowserFlacSource(page);
    await page.addInitScript(() => {
      const originalWorker = globalThis.Worker;
      const gatedWorker = new Proxy(originalWorker, {
        construct(target, argumentsList) {
          const options = argumentsList[1] as WorkerOptions | undefined;
          if (options?.name === "flac-decoder") throw new Error("Test blocked the FLAC decoder worker.");
          return Reflect.construct(target, argumentsList);
        },
      });
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: gatedWorker,
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "flac-worker-unavailable.flac",
      mimeType: "audio/flac",
      buffer: flacSource,
    });
    await expect(session.getByRole("alert")).toContainText("could not start KYX's FLAC decoder worker", {
      timeout: 30_000,
    });
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
    await expect(session.locator(".mastering-file-session-source")).not.toContainText("flac-worker-unavailable.flac");
  });

  test("cancels a FLAC source decode and terminates the real browser worker", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      testInfo.project.name !== "chromium",
      "FLAC decoder worker lifecycle acceptance currently runs in Chromium.",
    );
    const flacSource = await makeBrowserFlacSource(page);
    await page.addInitScript(() => {
      type FlacDecodeGate = {
        arm: () => void;
        waitForStart: () => Promise<void>;
        release: () => void;
        terminationCount: () => number;
      };
      let armed = false;
      let startedResolve: (() => void) | null = null;
      let started = Promise.resolve();
      let releaseHeld: (() => void) | null = null;
      let flacWorkerTerminations = 0;
      const gate: FlacDecodeGate = {
        arm: () => {
          started = new Promise<void>((resolve) => {
            startedResolve = resolve;
          });
          armed = true;
        },
        waitForStart: () => started,
        release: () => {
          try {
            releaseHeld?.();
          } catch {
            // Cancellation should have terminated the worker before release.
          }
          releaseHeld = null;
        },
        terminationCount: () => flacWorkerTerminations,
      };
      Object.defineProperty(window, "__flacDecodeGate", { configurable: true, value: gate });

      const originalWorker = globalThis.Worker;
      const originalPostMessage = Worker.prototype.postMessage;
      const originalTerminate = Worker.prototype.terminate;
      const flacWorkers = new WeakSet<Worker>();
      Object.defineProperty(originalWorker.prototype, "postMessage", {
        configurable: true,
        writable: true,
        value: function (this: Worker, message: unknown, ...transfer: unknown[]) {
          if (
            flacWorkers.has(this) &&
            armed &&
            typeof message === "object" &&
            message !== null &&
            "command" in message &&
            message.command === "decodeFrames"
          ) {
            armed = false;
            releaseHeld = () => {
              Reflect.apply(originalPostMessage, this, [message, ...transfer]);
            };
            startedResolve?.();
            startedResolve = null;
            return;
          }
          return Reflect.apply(originalPostMessage, this, [message, ...transfer]);
        },
      });
      Object.defineProperty(originalWorker.prototype, "terminate", {
        configurable: true,
        writable: true,
        value: function (this: Worker) {
          if (flacWorkers.has(this)) flacWorkerTerminations++;
          return Reflect.apply(originalTerminate, this, []);
        },
      });
      const gatedWorker = new Proxy(originalWorker, {
        construct(target, argumentsList, newTarget) {
          const options = argumentsList[1] as WorkerOptions | undefined;
          const worker = Reflect.construct(target, argumentsList, newTarget);
          if (options?.name === "flac-decoder") flacWorkers.add(worker);
          return worker;
        },
      });
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: gatedWorker,
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const decodeStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __flacDecodeGate?: { arm: () => void; waitForStart: () => Promise<void> };
        }
      ).__flacDecodeGate;
      if (!gate) throw new Error("The FLAC decoder gate was not installed.");
      gate.arm();
      return gate.waitForStart();
    });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "flac-decode-cancel.flac",
      mimeType: "audio/flac",
      buffer: flacSource,
    });
    await decodeStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Decoding source audio…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText("Source import cancelled. The selected session was left unchanged.", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __flacDecodeGate?: { release: () => void } }).__flacDecodeGate?.release();
    });

    const terminationCount = await page.evaluate(() =>
      (
        window as Window & { __flacDecodeGate?: { terminationCount: () => number } }
      ).__flacDecodeGate?.terminationCount(),
    );
    expect(terminationCount).toBe(1);
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
    await expect(session.locator(".mastering-file-session-source")).not.toContainText("flac-decode-cancel.flac");
  });

  test("measures the original source as a separate baseline without changing its master draft", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "External mastering source analysis uses browser audio workers.",
    );
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "source-baseline.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(4),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });

    const inputGain = session.getByLabel("External master input gain");
    await expect(inputGain).toHaveValue("1");
    await session.getByRole("button", { name: "Analyze original external mastering input" }).click();

    const baseline = session.locator('[aria-label="Original input baseline measurements"]');
    await expect(baseline).toBeVisible({ timeout: 90_000 });
    await expect(baseline).toContainText("INPUT BASELINE · DECODED PCM · PRE-MASTER CHAIN");
    await expect(baseline).toContainText("LUFS-I");
    await expect(baseline).toContainText("dBTP");
    await expect(baseline).toContainText("Original file 44.1 kHz");
    await expect(session.getByRole("status")).toContainText(
      "Input baseline measured from decoded source PCM. No session processing setting changed.",
    );
    await expect(inputGain).toHaveValue("1");
    await expect(session.locator('[aria-label="Rendered master measurements"]')).toHaveCount(0);

    await inputGain.focus();
    await inputGain.press("ArrowLeft");
    await expect(inputGain).toHaveValue("0.99");
    await expect(baseline).toBeVisible();
    await expect(session.getByRole("button", { name: "Analyze original external mastering input" })).toBeVisible();
  });

  test("cancels external source baseline analysis without saving a partial report", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "External mastering source analysis uses browser audio workers.",
    );
    await installMasteringAnalysisGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "source-baseline-cancel.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(4),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });

    const analysisStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __masteringAnalysisGate?: { arm: () => void; waitForStart: () => Promise<void> };
        }
      ).__masteringAnalysisGate;
      if (!gate) throw new Error("Mastering analysis gate was not installed.");
      gate.arm();
      return gate.waitForStart();
    });
    await session.getByRole("button", { name: "Analyze original external mastering input" }).click();
    await analysisStarted;
    await expect(session.getByRole("status")).toContainText("Analyzing original input");
    const savedSessions = session.getByLabel("Saved mastering sessions");
    await expect(savedSessions).toBeDisabled();
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText("Input analysis cancelled. No session processing setting changed.", { exact: true }),
    ).toBeVisible();
    await expect(savedSessions).toBeEnabled();
    await page.evaluate(() => {
      (window as Window & { __masteringAnalysisGate?: { release: () => void } }).__masteringAnalysisGate?.release();
    });

    await expect(session.locator('[aria-label="Original input baseline measurements"]')).toHaveCount(0);
    await expect(session.getByLabel("External master input gain")).toHaveValue("1");
  });

  test("keeps advanced external master controls isolated and supports apply, undo, and redo", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    test.skip(testInfo.project.name !== "chromium", "External master control acceptance currently runs in Chromium.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const projectView = page.getByRole("group", { name: "Master controls view" });
    await projectView.getByRole("button", { name: "Advanced" }).click();
    const projectControls = page.getByRole("group", { name: "Built-in master processing controls" });
    await expect(projectControls.getByRole("button", { name: "Master tape" })).toHaveAttribute("aria-pressed", "false");
    await expect(projectControls.getByRole("button", { name: "Master mid side" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(projectControls.getByRole("button", { name: "Master bass mono" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "advanced-control-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(2),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.locator('[aria-label="Rendered master measurements"]')).toBeVisible({ timeout: 90_000 });

    const advanced = session.locator("details.mastering-file-session-advanced-processing");
    await advanced.locator("summary").click();
    const externalControls = session.getByRole("group", { name: "Isolated master processing controls" });
    const tape = externalControls.getByRole("button", { name: "Master tape" });
    const midSide = externalControls.getByRole("button", { name: "Master mid side" });
    const bassMono = externalControls.getByRole("button", { name: "Master bass mono" });
    await expect(tape).toHaveAttribute("aria-pressed", "false");
    await expect(midSide).toHaveAttribute("aria-pressed", "false");
    await expect(bassMono).toHaveAttribute("aria-pressed", "false");

    await tape.click();
    const tapeDrive = externalControls.getByRole("slider", { name: "TAPE DRIVE" });
    await tapeDrive.focus();
    await tapeDrive.press("ArrowRight");
    await midSide.click();
    const midGain = externalControls.getByRole("slider", { name: "MID" });
    await midGain.focus();
    await midGain.press("ArrowRight");
    await bassMono.click();
    const bassMonoFrequency = externalControls.getByRole("slider", { name: "B-MONO" });
    await bassMonoFrequency.focus();
    await bassMonoFrequency.press("ArrowRight");

    await expect(tape).toHaveAttribute("aria-pressed", "true");
    await expect(midSide).toHaveAttribute("aria-pressed", "true");
    await expect(bassMono).toHaveAttribute("aria-pressed", "true");
    await expect(tapeDrive).not.toHaveAttribute("aria-valuenow", "0.35");
    await expect(midGain).not.toHaveAttribute("aria-valuenow", "0");
    await expect(bassMonoFrequency).not.toHaveAttribute("aria-valuenow", "120");
    await expect(session.locator('[aria-label="Rendered master measurements"]')).toHaveCount(0);
    await expect(session.getByRole("button", { name: "Render & analyze" })).toBeDisabled();
    await expect(projectControls.getByRole("button", { name: "Master tape" })).toHaveAttribute("aria-pressed", "false");
    await expect(projectControls.getByRole("button", { name: "Master mid side" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(projectControls.getByRole("button", { name: "Master bass mono" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await session.getByRole("button", { name: "Apply settings" }).click();
    await expect(session.getByRole("button", { name: "Undo" })).toBeEnabled({ timeout: 30_000 });
    await expect(session.getByRole("button", { name: "Render & analyze" })).toBeEnabled();
    const sessionSelector = session.getByLabel("Saved mastering sessions");
    const savedOption = sessionSelector.locator("option").filter({ hasText: "advanced-control-source.wav" });
    const savedSessionId = await savedOption.getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await sessionSelector.selectOption("");
    await sessionSelector.selectOption(savedSessionId!);
    await expect(session.locator(".mastering-file-session-source")).toContainText("advanced-control-source.wav", {
      timeout: 30_000,
    });

    await advanced.locator("summary").click();
    const restoredControls = session.getByRole("group", { name: "Isolated master processing controls" });
    await expect(restoredControls.getByRole("button", { name: "Master tape" })).toHaveAttribute("aria-pressed", "true");
    await expect(restoredControls.getByRole("button", { name: "Master mid side" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(restoredControls.getByRole("button", { name: "Master bass mono" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(restoredControls.getByRole("slider", { name: "TAPE DRIVE" })).not.toHaveAttribute(
      "aria-valuenow",
      "0.35",
    );
    await expect(session.getByRole("button", { name: "Undo" })).toBeEnabled();

    await session.getByRole("button", { name: "Undo" }).click();
    await expect(restoredControls.getByRole("button", { name: "Master tape" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(restoredControls.getByRole("button", { name: "Master mid side" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(restoredControls.getByRole("button", { name: "Master bass mono" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(session.getByRole("button", { name: "Redo" })).toBeEnabled();
    await session.getByRole("button", { name: "Redo" }).click();
    await expect(restoredControls.getByRole("button", { name: "Master tape" })).toHaveAttribute("aria-pressed", "true");
    await expect(restoredControls.getByRole("button", { name: "Master mid side" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(restoredControls.getByRole("button", { name: "Master bass mono" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(projectControls.getByRole("button", { name: "Master tape" })).toHaveAttribute("aria-pressed", "false");
  });

  test("cancels external master and A/B renders without leaving partial results", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "External mastering render cancellation gate uses OfflineAudioContext.",
    );
    await installMasteringSessionRenderGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "cancel-render-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });

    await armMasteringSessionRenderGate(page);
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await waitForMasteringSessionRenderStart(page);
    await expect(session.getByRole("status")).toContainText("Rendering source through the master chain");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("Render or analysis cancelled.", { exact: true })).toBeVisible();
    await expect(session.locator(".mastering-file-session-report")).toHaveCount(0);
    await expect(session.getByRole("button", { name: "Encode & export WAV" })).toBeDisabled();

    await session.getByLabel("Name for version A").fill("Cancel A");
    await session.getByRole("button", { name: "Save current to A" }).click();
    await session.getByLabel("Name for version B").fill("Cancel B");
    await session.getByRole("button", { name: "Save current to B" }).click();
    await armMasteringSessionRenderGate(page);
    await session.getByRole("button", { name: "Render A/B versions" }).click();
    await waitForMasteringSessionRenderStart(page);
    await expect(session.getByRole("status")).toContainText("Rendering version A");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("A/B render cancelled.", { exact: true })).toBeVisible();
    await expect(session.getByRole("button", { name: "Listen to A" })).toBeDisabled();
    await expect(session.getByRole("button", { name: "Listen to B" })).toBeDisabled();
  });

  test("cancels external WAV encoding and final inspection without downloading an unchecked file", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering export cancellation gates use Web Audio APIs.");
    await installMasteringSessionExportGates(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "cancel-export-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Encode & export WAV" })).toBeEnabled({ timeout: 90_000 });

    await armMasteringSessionExportGate(page, "encode");
    await session.getByRole("button", { name: "Encode & export WAV" }).click();
    await waitForMasteringSessionExportGate(page, "encode");
    await expect(session.getByText(/Encoding WAV ·/)).toBeVisible();
    const encodeDownload = page.waitForEvent("download", { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("WAV export cancelled.", { exact: true })).toBeVisible();
    expect(await encodeDownload).toBe(false);
    await expect(session.getByText(/Exported .*encoded file parsed/)).toHaveCount(0);

    await armMasteringSessionExportGate(page, "inspection");
    await session.getByRole("button", { name: "Encode & export WAV" }).click();
    await waitForMasteringSessionExportGate(page, "inspection");
    await expect(session.getByRole("status")).toContainText("Checking encoded WAV delivery");
    const inspectionDownload = page.waitForEvent("download", { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("WAV export cancelled.", { exact: true })).toBeVisible();
    expect(await inspectionDownload).toBe(false);
    await expect(session.getByText(/Exported .*encoded file parsed/)).toHaveCount(0);
  });

  test("cancels external MP3 encoding and post-encode inspection without report or download", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External MP3 cancellation gates use browser audio APIs.");
    await installMasteringSessionExportGates(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "cancel-mp3-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(10),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    await session.getByLabel("External mastering render sample rate").selectOption("44100");
    await session.getByLabel("External mastering delivery format").selectOption("mp3");
    await session.getByLabel("External mastering MP3 bitrate").selectOption("192");
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Encode & export MP3" })).toBeEnabled({ timeout: 90_000 });

    await armMasteringSessionExportGate(page, "encode");
    const encodeDownload = page.waitForEvent("download", { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    await session.getByRole("button", { name: "Encode & export MP3" }).click();
    await waitForMasteringSessionExportGate(page, "encode");
    await expect(session.getByRole("status").filter({ hasText: /Encoding delivery MP3/ })).toBeVisible();
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("MP3 export cancelled.", { exact: true })).toBeVisible();
    expect(await encodeDownload).toBe(false);
    await expect(session.getByRole("group", { name: "Recent exported delivery report downloads" })).toHaveCount(0);

    await expect(session.getByRole("button", { name: "Encode & export MP3" })).toBeEnabled({ timeout: 30_000 });
    await armMasteringSessionExportGate(page, "inspection");
    const inspectionDownload = page.waitForEvent("download", { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    await session.getByRole("button", { name: "Encode & export MP3" }).click();
    await waitForMasteringSessionExportGate(page, "inspection");
    await expect(session.getByRole("status").filter({ hasText: /Checking encoded MP3 delivery/ })).toBeVisible();
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("MP3 export cancelled.", { exact: true })).toBeVisible();
    expect(await inspectionDownload).toBe(false);
    await expect(session.getByRole("group", { name: "Recent exported delivery report downloads" })).toHaveCount(0);
  });

  test("external file inserts are editable, undoable, and isolated from the open project", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const workspace = page.getByRole("region", { name: "Mastering workspace" });
    const projectMaster = workspace.locator("#master-insert-controls");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    const projectRack = projectMaster.getByRole("region", { name: "Master effects" });
    await expect(projectRack.locator(".device-chain-item")).toHaveCount(0);

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "isolated-session.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    const sessionRack = session.getByRole("region", { name: "Master effects" });
    await expect(session.getByRole("group", { name: "MASTER INSERT CHAIN" })).toBeVisible();
    await sessionRack.getByRole("combobox", { name: "Add effect to the track" }).selectOption("eq");
    await expect(sessionRack.locator("button.device-chain-item")).toHaveCount(1);
    await expect(session.getByRole("button", { name: "Apply settings" })).toBeEnabled();

    await session.getByRole("button", { name: "Apply settings" }).click();
    await expect(session.getByRole("button", { name: "Undo" })).toBeEnabled();
    await session.getByRole("button", { name: "Undo" }).click();
    await expect(sessionRack.locator(".device-chain-item")).toHaveCount(0);
    await expect(session.getByRole("button", { name: "Redo" })).toBeEnabled();
    await session.getByRole("button", { name: "Redo" }).click();
    await expect(sessionRack.locator("button.device-chain-item")).toHaveCount(1);

    await expect(projectRack.locator(".device-chain-item")).toHaveCount(0);

    await session.getByLabel("Import external mastering reference WAV, MP3 or FLAC").setInputFiles({
      name: "reference.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Reference saved locally · reference\.wav/)).toBeVisible({ timeout: 30_000 });
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Listen to session master" })).toBeEnabled({ timeout: 90_000 });
    await session.getByRole("button", { name: "Listen to session master" }).click();
    await expect(session.getByRole("button", { name: "Stop audition" })).toBeVisible();
    await session.getByRole("button", { name: "Stop audition" }).click();
    await session.getByRole("button", { name: "Listen to reference" }).click();
    await expect(session.getByRole("button", { name: "Stop audition" })).toBeVisible();
    await session.getByRole("button", { name: "Stop audition" }).click();
    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText("reference.wav", { exact: true })).toBeVisible({ timeout: 30_000 });

    await session.getByLabel("Name for version A").fill("EQ draft");
    await session.getByRole("button", { name: "Save current to A" }).click();
    await expect(session.getByRole("button", { name: "Load A into session" })).toBeVisible();
    await sessionRack.locator("select.devices-add-effect").selectOption("compressor");
    await session.getByRole("button", { name: "Apply settings" }).click();
    await session.getByLabel("Name for version B").fill("EQ + compressor");
    await session.getByRole("button", { name: "Save current to B" }).click();

    await session.getByRole("button", { name: "Render A/B versions" }).click();
    await expect(session.getByText(/A\/B render · 44\.1 kHz · Studio HQ/)).toBeVisible({ timeout: 90_000 });
    await expect(session.getByRole("button", { name: "Listen to A" })).toBeEnabled();
    await expect(session.getByRole("button", { name: "Listen to B" })).toBeEnabled();
    await session.getByRole("button", { name: "Listen to A" }).click();
    await expect(session.getByRole("button", { name: "Stop audition" })).toBeVisible();
  });

  test("renders, encodes, checks, and re-imports a mastering-session WAV", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "External mastering delivery round trip runs in Chromium and the focused Firefox project.",
    );
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const source = makeStereoTestWav();
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "pre-master.wav",
      mimeType: "audio/wav",
      buffer: source,
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });

    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Encode & export WAV" })).toBeEnabled({ timeout: 90_000 });
    await expect(session.locator(".mastering-file-session-report")).toBeVisible();

    const deliveries: Array<{ bitDepth: number; bytes: Buffer }> = [];
    for (const bitDepth of [16, 24, 32]) {
      await session.getByLabel("External mastering WAV bit depth").selectOption(String(bitDepth));
      const downloadPromise = page.waitForEvent("download");
      await session.getByRole("button", { name: "Encode & export WAV" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toContain(`${bitDepth}bit.wav`);
      const downloadPath = testInfo.outputPath(`pre-master-mastered-${bitDepth}bit.wav`);
      await download.saveAs(downloadPath);
      const delivered = await readFile(downloadPath);
      const facts = readMasterWavFacts(delivered);
      expect(facts.formatCode).toBe(bitDepth === 32 ? 3 : 1);
      expect(facts.channels).toBe(2);
      expect(facts.sampleRate).toBe(44_100);
      expect(facts.bitDepth).toBe(bitDepth);
      expect(facts.bextVersion).toBeGreaterThanOrEqual(2);
      expect(facts.frames).toBeGreaterThan(44_100);
      expect(facts.peak).toBeGreaterThan(0.01);
      await expect(session.getByText(/decoded audio measured/)).toBeVisible({ timeout: 30_000 });
      deliveries.push({ bitDepth, bytes: delivered });
    }

    for (const delivery of deliveries) {
      const filename = `re-imported-master-${delivery.bitDepth}bit.wav`;
      await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
        name: filename,
        mimeType: "audio/wav",
        buffer: delivery.bytes,
      });
      await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
      await expect(session.locator(".mastering-file-session-source")).toContainText(filename);
    }
  });

  test("round-trips project and external-session FLAC at 96 kHz", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "FLAC encoder and WASM decode acceptance runs in Chromium and the focused Firefox project.",
    );
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const workspace = page.getByRole("region", { name: "Mastering workspace" });
    await workspace.getByLabel("Analysis sample rate").selectOption("96000");
    await workspace.getByRole("combobox", { name: "FORMAT" }).selectOption("flac");
    await workspace.getByRole("combobox", { name: "DEPTH" }).selectOption("24");

    const projectDownloadPromise = page.waitForEvent("download");
    await workspace.getByRole("button", { name: "EXPORT MASTER (FLAC)" }).click();
    const projectDownload = await projectDownloadPromise;
    const projectPath = testInfo.outputPath("project-96k-master.flac");
    await projectDownload.saveAs(projectPath);
    const projectFile = await readFile(projectPath);
    expect(readFlacFacts(projectFile)).toMatchObject({ sampleRate: 96_000, channels: 2, bitDepth: 24 });
    expect(readFlacFacts(projectFile).frames).toBeGreaterThan(96_000);
    await expect(
      workspace.getByRole("status").filter({ hasText: /FLAC exported .* decoded file measured/ }),
    ).toBeVisible({ timeout: 120_000 });

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "project-96k-master.flac",
      mimeType: "audio/flac",
      buffer: projectFile,
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 60_000 });
    const savedSessions = session.getByLabel("Saved mastering sessions");
    const importedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(importedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(importedSessionId!);
    await expect(session.getByText(/Loaded project-96k-master\.flac/)).toBeVisible({ timeout: 60_000 });

    await session.getByLabel("Import external mastering reference WAV, MP3 or FLAC").setInputFiles({
      name: "flac-session-reference.flac",
      mimeType: "audio/flac",
      buffer: projectFile,
    });
    await expect(session.getByText(/Reference saved locally · flac-session-reference\.flac/)).toBeVisible({
      timeout: 60_000,
    });
    await savedSessions.selectOption("");
    await savedSessions.selectOption(importedSessionId!);
    await expect(session.getByText(/Loaded project-96k-master\.flac/)).toBeVisible({ timeout: 60_000 });
    await expect(session.getByText("flac-session-reference.flac", { exact: true })).toBeVisible({ timeout: 60_000 });

    const importedSourceRate = await page.evaluate(async (fileName) => {
      const sessionStorePath = ["/src", "mastering", "sessionStore.ts"].join("/");
      const { MasteringSessionRepository } = await import(sessionStorePath);
      const repository = new MasteringSessionRepository();
      const summary = (await repository.list()).find(
        (item: { fileName: string; id: string }) => item.fileName === fileName,
      );
      if (!summary) throw new Error("The imported FLAC session was not saved.");
      const record = await repository.get(summary.id);
      return record?.sourceSampleRate ?? null;
    }, "project-96k-master.flac");
    expect(importedSourceRate).toBe(96_000);

    await session.getByLabel("External mastering render sample rate").selectOption("96000");
    await session.getByLabel("External mastering delivery profile").selectOption("streaming");
    await session.getByLabel("External mastering delivery format").selectOption("flac");
    await session.getByLabel("External mastering FLAC bit depth").selectOption("24");
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByText(/2 ch · 96 kHz/)).toBeVisible({ timeout: 120_000 });
    await expect(session.getByRole("button", { name: "Encode & export FLAC" })).toBeEnabled({ timeout: 120_000 });

    const sessionDownloadPromise = page.waitForEvent("download");
    await session.getByRole("button", { name: "Encode & export FLAC" }).click();
    const sessionDownload = await sessionDownloadPromise;
    expect(sessionDownload.suggestedFilename()).toMatch(/mastered-96000Hz-24bit\.flac$/);
    const sessionPath = testInfo.outputPath("external-session-96k-master.flac");
    await sessionDownload.saveAs(sessionPath);
    const sessionFile = await readFile(sessionPath);
    expect(readFlacFacts(sessionFile)).toMatchObject({ sampleRate: 96_000, channels: 2, bitDepth: 24 });
    expect(readFlacFacts(sessionFile).frames).toBeGreaterThan(96_000);
    await expect(
      session.getByRole("status").filter({ hasText: /Encoded FLAC parsed and decoded audio measured/ }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(session.getByText("DECODED FLAC · POST-ENCODE", { exact: true })).toBeVisible();
    await expect(session.getByRole("group", { name: "Profile file delivery check" })).toContainText(
      "preserves the source's 96,000 Hz sample rate",
    );
    await expect(session.getByRole("group", { name: "Profile file delivery check" })).toContainText(
      "24-bit output preserves the imported source's native PCM depth",
    );
    const sessionReportPromise = page.waitForEvent("download");
    await session
      .getByRole("group", { name: "Recent exported delivery report downloads" })
      .getByRole("button", { name: `Download delivery report JSON for ${sessionDownload.suggestedFilename()}` })
      .click();
    const sessionReportDownload = await sessionReportPromise;
    const sessionReportPath = testInfo.outputPath("external-session-96k-master-report.json");
    await sessionReportDownload.saveAs(sessionReportPath);
    const sessionReport = JSON.parse(await readFile(sessionReportPath, "utf8"));
    expect(sessionReport.delivery.fileDelivery.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pass",
          line: "24-bit output preserves the imported source's native PCM depth.",
        }),
      ]),
    );

    await session.getByLabel("External mastering FLAC bit depth").selectOption("16");
    const first16BitDownloadPromise = page.waitForEvent("download");
    await session.getByRole("button", { name: "Encode & export FLAC" }).click();
    const first16BitDownload = await first16BitDownloadPromise;
    const first16BitPath = testInfo.outputPath("external-session-96k-master-16bit-first.flac");
    await first16BitDownload.saveAs(first16BitPath);
    const first16BitFile = await readFile(first16BitPath);
    expect(readFlacFacts(first16BitFile)).toMatchObject({ sampleRate: 96_000, channels: 2, bitDepth: 16 });
    await expect(
      session.getByRole("status").filter({ hasText: /Encoded FLAC parsed and decoded audio measured/ }),
    ).toBeVisible({ timeout: 120_000 });

    const second16BitDownloadPromise = page.waitForEvent("download");
    await session.getByRole("button", { name: "Encode & export FLAC" }).click();
    const second16BitDownload = await second16BitDownloadPromise;
    const second16BitPath = testInfo.outputPath("external-session-96k-master-16bit-second.flac");
    await second16BitDownload.saveAs(second16BitPath);
    expect(await readFile(second16BitPath)).toEqual(first16BitFile);

    const damagedFlac = Buffer.from(projectFile);
    damagedFlac[damagedFlac.length - 20] = damagedFlac[damagedFlac.length - 20]! ^ 1;
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "damaged-project-master.flac",
      mimeType: "audio/flac",
      buffer: damagedFlac,
    });
    await expect(session.getByRole("alert")).toContainText("does not match STREAMINFO", { timeout: 60_000 });
    await expect(session.locator(".mastering-file-session-source")).toContainText("project-96k-master.flac");
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(2);
  });

  test("round-trips known FLAC PCM vectors across rates and bit depths and enforces export limits", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    test.skip(testInfo.project.name !== "chromium", "FLAC encode/decode vectors use the browser WASM codec.");
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const result = await page.evaluate(async () => {
      const encoderPath = ["/src", "export", "flac.ts"].join("/");
      const decoderPath = ["/src", "mastering", "flacDecode.ts"].join("/");
      const [encoder, decoder] = await Promise.all([import(encoderPath), import(decoderPath)]);
      const vectors: Array<{
        sampleRate: number;
        bitDepth: 16 | 24;
        frames: number;
        maxErrorLsb: number;
      }> = [];
      for (const sampleRate of [44_100, 48_000, 96_000]) {
        for (const bitDepth of [16, 24] as const) {
          const source = new AudioBuffer({ length: 4096, numberOfChannels: 2, sampleRate });
          for (let channel = 0; channel < source.numberOfChannels; channel++) {
            const samples = source.getChannelData(channel);
            for (let frame = 0; frame < samples.length; frame++) {
              const offset = channel * 0.19;
              samples[frame] =
                0.61 * Math.sin((2 * Math.PI * 997 * frame) / sampleRate + offset) +
                0.17 * Math.sin((2 * Math.PI * 83 * frame) / sampleRate - offset);
            }
          }

          const encoded = await encoder.encodeFlac(source, { bitDepth });
          const decoded = await decoder.decodeFlacAudioBuffer(
            await encoded.arrayBuffer(),
            { sampleRate, channels: 2, durationSeconds: source.duration, bitDepth },
            { maxPcmBytes: source.length * source.numberOfChannels * Float32Array.BYTES_PER_ELEMENT * 2 },
          );
          let maxErrorLsb = 0;
          const fullScale = 2 ** (bitDepth - 1);
          for (let channel = 0; channel < source.numberOfChannels; channel++) {
            const input = source.getChannelData(channel);
            const output = decoded.getChannelData(channel);
            if (output.length !== input.length) throw new Error("FLAC round-trip changed the vector frame count.");
            for (let frame = 0; frame < input.length; frame++) {
              maxErrorLsb = Math.max(maxErrorLsb, Math.abs(input[frame]! - output[frame]!) * fullScale);
            }
          }
          vectors.push({ sampleRate, bitDepth, frames: decoded.length, maxErrorLsb });
        }
      }

      const overRangeFailures: Array<{ bitDepth: number; name: string; message: string }> = [];
      for (const bitDepth of [16, 24] as const) {
        const overRange = new AudioBuffer({ length: 16, numberOfChannels: 1, sampleRate: 48_000 });
        overRange.getChannelData(0)[0] = 1.01;
        const failure = await encoder.encodeFlac(overRange, { bitDepth }).then(
          () => null,
          (error: unknown) => ({
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        if (!failure) throw new Error(`${bitDepth}-bit FLAC accepted an over-range sample.`);
        overRangeFailures.push({ bitDepth, ...failure });
      }

      const cancelSource = new AudioBuffer({ length: 131_072, numberOfChannels: 2, sampleRate: 44_100 });
      const controller = new AbortController();
      let progressEvents = 0;
      const cancelError = await encoder
        .encodeFlac(cancelSource, {
          bitDepth: 16,
          signal: controller.signal,
          onProgress: () => {
            progressEvents++;
            controller.abort();
          },
        })
        .then(
          () => null,
          (error: unknown) => ({
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      return { vectors, overRangeFailures, progressEvents, cancelError };
    });

    expect(result.vectors.map(({ sampleRate, bitDepth }) => [sampleRate, bitDepth])).toEqual([
      [44_100, 16],
      [44_100, 24],
      [48_000, 16],
      [48_000, 24],
      [96_000, 16],
      [96_000, 24],
    ]);
    for (const vector of result.vectors) {
      expect(vector.frames).toBe(4096);
      expect(vector.maxErrorLsb, JSON.stringify(vector)).toBeLessThanOrEqual(2.25);
    }
    expect(result.overRangeFailures).toHaveLength(2);
    for (const failure of result.overRangeFailures) {
      expect(failure.name).toBe("IntegerPcmDeliveryError");
      expect(failure.message).toContain("No soft clipping was applied.");
    }
    expect(result.progressEvents).toBe(1);
    expect(result.cancelError?.name).toBe("AbortError");
  });

  test("rejects a high-entropy FLAC that crosses the real 96 MiB output cap", async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    test.skip(
      testInfo.project.name !== "chromium",
      "The large FLAC encoder limit runs against Chromium's browser worker.",
    );
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const sourceStats = await page.evaluate(() => {
      const sampleRate = 44_100;
      const frames = 7 * 60 * sampleRate;
      const source = new AudioBuffer({ length: frames, numberOfChannels: 2, sampleRate });
      for (let channel = 0; channel < source.numberOfChannels; channel++) {
        const samples = source.getChannelData(channel);
        let state = channel === 0 ? 0x6d2b79f5 : 0x1b873593;
        for (let frame = 0; frame < samples.length; frame++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          samples[frame] = ((state >>> 0) / 0xffff_ffff) * 1.6 - 0.8;
        }
      }

      (window as Window & { __masteringFlacHighEntropySource?: AudioBuffer }).__masteringFlacHighEntropySource = source;
      return {
        sourceFrames: source.length,
        sourcePcmBytes: source.length * source.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
        expectedUncompressedFlacPcmBytes: source.length * source.numberOfChannels * 3,
      };
    });

    await markMasteringMemoryStage("encode-start");
    let result: {
      failure: { name: string; message: string };
      progressEvents: number;
      lastProgress: number;
      elapsedMs: number;
    };
    try {
      result = await page.evaluate(async () => {
        const encoderPath = ["/src", "export", "flac.ts"].join("/");
        const { encodeFlac } = await import(encoderPath);
        const source = (window as Window & { __masteringFlacHighEntropySource?: AudioBuffer })
          .__masteringFlacHighEntropySource;
        if (!source) throw new Error("The high-entropy FLAC source buffer is missing.");

        let progressEvents = 0;
        let lastProgress = 0;
        const startedAt = performance.now();
        const failure = await encodeFlac(source, {
          bitDepth: 24,
          onProgress: (progress: number) => {
            progressEvents++;
            lastProgress = progress;
          },
        }).then(
          (blob: Blob) => ({ name: "UnexpectedSuccess", message: `Unexpectedly returned ${blob.size} bytes.` }),
          (error: unknown) => ({
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return { failure, progressEvents, lastProgress, elapsedMs: performance.now() - startedAt };
      });
    } finally {
      await markMasteringMemoryStage("encode-end");
    }

    const recoveryBytes = await page.evaluate(async () => {
      const encoderPath = ["/src", "export", "flac.ts"].join("/");
      const { encodeFlac } = await import(encoderPath);
      const recovery = await encodeFlac(new AudioBuffer({ length: 4096, numberOfChannels: 2, sampleRate: 44_100 }), {
        bitDepth: 24,
      });
      return recovery.size;
    });

    expect(sourceStats.sourceFrames).toBe(7 * 60 * 44_100);
    expect(sourceStats.sourcePcmBytes).toBeLessThan(160 * 1024 * 1024);
    expect(sourceStats.expectedUncompressedFlacPcmBytes).toBeGreaterThan(96 * 1024 * 1024);
    expect(result.failure.name).not.toBe("UnexpectedSuccess");
    expect(result.failure.message).toMatch(/exceeded KYX's 96 MiB in-memory export limit/);
    expect(result.progressEvents).toBeGreaterThan(0);
    expect(recoveryBytes).toBeGreaterThan(42);
  });

  test("skips oversized FLAC read-back without materializing or starting another decoder worker", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "FLAC read-back memory limits use the browser WASM worker.");
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const result = await page.evaluate(async () => {
      const encoderPath = ["/src", "export", "flac.ts"].join("/");
      const inspectionPath = ["/src", "mastering", "encodedInspection.ts"].join("/");
      const profilesPath = ["/src", "mastering", "profiles.ts"].join("/");
      const [encoder, inspection, profiles] = await Promise.all([
        import(encoderPath),
        import(inspectionPath),
        import(profilesPath),
      ]);
      const profile = profiles.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      const source = new AudioBuffer({ length: 4096, numberOfChannels: 2, sampleRate: 44_100 });
      const encoded: Blob = await encoder.encodeFlac(source, { bitDepth: 24 });

      const originalWorker = globalThis.Worker;
      let flacWorkerStarts = 0;
      const observedWorker = new Proxy(originalWorker, {
        construct(target, argumentsList, newTarget) {
          const options = argumentsList[1] as WorkerOptions | undefined;
          if (options?.name === "flac-decoder") flacWorkerStarts++;
          return Reflect.construct(target, argumentsList, newTarget);
        },
      });
      const originalArrayBuffer = Blob.prototype.arrayBuffer;
      let largestMaterializedBlobBytes = 0;
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: observedWorker,
      });
      Object.defineProperty(Blob.prototype, "arrayBuffer", {
        configurable: true,
        writable: true,
        value: function (this: Blob): Promise<ArrayBuffer> {
          largestMaterializedBlobBytes = Math.max(largestMaterializedBlobBytes, this.size);
          return Reflect.apply(originalArrayBuffer, this, []);
        },
      });

      try {
        const baseline = await inspection.inspectEncodedMaster({
          format: "flac",
          bytes: encoded,
          expectedDurationSeconds: source.duration,
          sourceMeasurements: {},
          profile,
        });
        const targetBytes = 96 * 1024 * 1024 + 1;
        const padding = new Blob([new Uint8Array(4 * 1024 * 1024)]);
        const parts: BlobPart[] = [encoded];
        let remainingBytes = targetBytes - encoded.size;
        while (remainingBytes > 0) {
          const partLength = Math.min(remainingBytes, padding.size);
          parts.push(padding.slice(0, partLength));
          remainingBytes -= partLength;
        }
        const largeFile = new Blob(parts, { type: "audio/flac" });
        const largeFileResult = await inspection.inspectEncodedMaster({
          format: "flac",
          bytes: largeFile,
          expectedDurationSeconds: source.duration,
          sourceMeasurements: {},
          profile,
        });
        const startsAfterLargeFile = flacWorkerStarts;
        const residentMemoryResult = await inspection.inspectEncodedMaster({
          format: "flac",
          bytes: encoded,
          expectedDurationSeconds: source.duration,
          sourceMeasurements: {},
          profile,
          additionalWorkingSetBytes: 512 * 1024 * 1024,
        });

        return {
          encodedBytes: encoded.size,
          baselineStatus: baseline.decode.status,
          baselineDecoder: baseline.decode.decoder,
          largeBytes: largeFile.size,
          largeStatus: largeFileResult.decode.status,
          largeDecoder: largeFileResult.decode.decoder,
          largeReason: largeFileResult.decode.reason ?? "",
          memoryStatus: residentMemoryResult.decode.status,
          memoryReason: residentMemoryResult.decode.reason ?? "",
          flacWorkerStarts,
          startsAfterLargeFile,
          largestMaterializedBlobBytes,
        };
      } finally {
        Object.defineProperty(globalThis, "Worker", {
          configurable: true,
          writable: true,
          value: originalWorker,
        });
        Object.defineProperty(Blob.prototype, "arrayBuffer", {
          configurable: true,
          writable: true,
          value: originalArrayBuffer,
        });
      }
    });

    expect(result.encodedBytes).toBeGreaterThan(42);
    expect(result.baselineStatus).toBe("measured");
    expect(result.baselineDecoder).toBe("KYX FLAC WebAssembly worker");
    expect(result.largeBytes).toBe(96 * 1024 * 1024 + 1);
    expect(result.largeStatus).toBe("not-measured");
    expect(result.largeDecoder).toBe("not invoked");
    expect(result.largeReason).toMatch(/header was checked, but post-encode decoding was skipped/);
    expect(result.memoryStatus).toBe("not-measured");
    expect(result.memoryReason).toMatch(/combined decoder memory exceeds KYX's 512 MiB/);
    expect(result.startsAfterLargeFile).toBe(1);
    expect(result.flacWorkerStarts).toBe(1);
    expect(result.largestMaterializedBlobBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  test("exports measured external MP3 deliveries at 192 and 320 kbps", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    test.skip(testInfo.project.name !== "chromium", "MP3 delivery decode acceptance currently runs in Chromium.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "mp3-delivery-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(2),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 60_000 });
    await session.getByLabel("External mastering delivery profile").selectOption("streaming");
    await session.getByRole("button", { name: "Analyze original external mastering input" }).click();
    await expect(session.locator('[aria-label="Original input baseline measurements"]')).toBeVisible({
      timeout: 90_000,
    });
    await session.getByLabel("External mastering render sample rate").selectOption("44100");
    await session.getByLabel("External mastering delivery format").selectOption("mp3");
    await session.getByLabel("External mastering MP3 bitrate").selectOption("192");
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByText(/2 ch · 44.1 kHz/)).toBeVisible({ timeout: 120_000 });

    const downloadMp3 = async (bitrate: 192 | 320, outputName: string) => {
      await session.getByLabel("External mastering MP3 bitrate").selectOption(String(bitrate));
      const downloadPromise = page.waitForEvent("download");
      await session.getByRole("button", { name: "Encode & export MP3" }).click();
      const download = await downloadPromise;
      const outputPath = testInfo.outputPath(outputName);
      await download.saveAs(outputPath);
      const output = await readFile(outputPath);
      expect(readMp3Facts(output)).toMatchObject({ sampleRate: 44_100, channels: 2, bitrateKbps: bitrate });
      const profileFileCheck = session.getByRole("group", { name: "Profile file delivery check" });
      await expect(profileFileCheck).toHaveAttribute("data-state", "warn");
      await expect(profileFileCheck).toContainText("MP3 is not listed");
      await expect(profileFileCheck).toContainText("preserves the source's 44,100 Hz sample rate");
      await expect(
        session.getByRole("status").filter({ hasText: /Encoded MP3 parsed and decoded audio measured/ }),
      ).toBeVisible({ timeout: 120_000 });
      await expect(session.getByText("DECODED MP3 · POST-ENCODE", { exact: true })).toBeVisible();
      return { output, fileName: download.suggestedFilename(), bitrateKbps: bitrate };
    };

    const mp3_192 = await downloadMp3(192, "external-master-192kbps.mp3");
    const mp3_320 = await downloadMp3(320, "external-master-320kbps.mp3");
    expect(mp3_320.output.byteLength).toBeGreaterThan(mp3_192.output.byteLength);

    await session.getByLabel("External mastering delivery format").selectOption("wav");
    const sessionInputGain = session.getByLabel("External master input gain");
    const exportedMasterGain = Number(await sessionInputGain.inputValue());
    await sessionInputGain.focus();
    await sessionInputGain.press("ArrowLeft");
    await expect(sessionInputGain).not.toHaveValue(String(exportedMasterGain));
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "mp3-other-session.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(2),
    });
    await expect(session.locator(".mastering-file-session-source")).toContainText("mp3-other-session.wav", {
      timeout: 60_000,
    });
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(3);
    const recentReports = session.getByRole("group", { name: "Recent exported delivery report downloads" });
    await expect(recentReports.getByRole("button")).toHaveCount(2);

    for (const [index, delivery] of [mp3_192, mp3_320].entries()) {
      const reportPromise = page.waitForEvent("download");
      await recentReports
        .getByRole("button", { name: `Download delivery report JSON for ${delivery.fileName}` })
        .click();
      const reportDownload = await reportPromise;
      expect(reportDownload.suggestedFilename()).toBe(delivery.fileName.replace(/\.mp3$/i, "-report.json"));
      const reportPath = testInfo.outputPath(`external-master-${index + 1}-delivery-report.json`);
      await reportDownload.saveAs(reportPath);
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report).toMatchObject({
        schema: "kyx.external-mastering-report",
        schemaVersion: 6,
        inputBaseline: {
          status: "measured",
          decodedSampleRate: 44_100,
          measurements: { channelCount: 2 },
        },
        source: { fileName: "mp3-delivery-source.wav" },
        mastering: { config: { masterGain: exportedMasterGain } },
        delivery: {
          fileName: delivery.fileName,
          format: "mp3",
          byteLength: delivery.output.byteLength,
          fileDelivery: { profileId: "streaming", status: "warn" },
          fingerprint: {
            algorithm: "SHA-256",
            status: "computed",
            hex: createHash("sha256").update(delivery.output).digest("hex"),
          },
          file: { averageBitrateKbps: delivery.bitrateKbps },
          measurementBasis: "decoded-exported-file",
          postEncode: { status: "measured" },
        },
      });
      expect(report.inputBaseline.sessionId).toBe(report.session.id);
      expect(report.inputBaseline.sourceSha256).toBe(report.source.sha256);
    }
  });

  test("checks Apple Music file rules and reports the encoder limit", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "Apple Music external delivery acceptance runs in Chromium and focused Firefox.",
    );
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "apple-delivery-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(1),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 60_000 });
    await session.getByLabel("External mastering delivery profile").selectOption("apple");
    await session.getByLabel("External mastering render sample rate").selectOption("44100");
    await session.getByLabel("External mastering delivery format").selectOption("flac");
    await session.getByLabel("External mastering FLAC bit depth").selectOption("16");
    await session.getByRole("button", { name: "Apply settings" }).click();
    await expect(session.getByRole("button", { name: "Render & analyze" })).toBeEnabled();
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByText(/2 ch · 44.1 kHz/)).toBeVisible({ timeout: 90_000 });

    const downloadPromise = page.waitForEvent("download");
    await session.getByRole("button", { name: "Encode & export FLAC" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/mastered-44100Hz-16bit\.flac$/);
    const outputPath = testInfo.outputPath("apple-external-master-16bit.flac");
    await download.saveAs(outputPath);
    expect(readFlacFacts(await readFile(outputPath))).toMatchObject({ sampleRate: 44_100, channels: 2, bitDepth: 16 });

    const fileCheck = session.getByRole("group", { name: "Profile file delivery check" });
    await expect(fileCheck).toHaveAttribute("data-state", "not-measured");
    await expect(fileCheck).toContainText("PROFILE FILE DELIVERY CHECK · NOT-MEASURED");
    await expect(fileCheck).toContainText("44,100 Hz is accepted by the checked source profile");
    await expect(fileCheck).toContainText("16-bit is accepted by the checked source profile");
    await expect(fileCheck).toContainText("qualified encoder");

    const reportPromise = page.waitForEvent("download");
    await session
      .getByRole("group", { name: "Recent exported delivery report downloads" })
      .getByRole("button", { name: `Download delivery report JSON for ${download.suggestedFilename()}` })
      .click();
    const reportDownload = await reportPromise;
    const reportPath = testInfo.outputPath("apple-external-master-delivery-report.json");
    await reportDownload.saveAs(reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.delivery.fileDelivery).toMatchObject({ profileId: "apple", status: "not-measured" });
    expect(report.delivery.fileDelivery.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "pass", line: "16-bit is accepted by the checked source profile." }),
        expect.objectContaining({ status: "not-measured", line: expect.stringContaining("qualified encoder") }),
      ]),
    );
    expect(report.mastering.profileProvenance.fileSettingsSource.url).toContain(
      "help.apple.com/itc/videoaudioassetguide",
    );
  });

  test("external-MP3-memory-soak completes a four-minute external MP3 delivery under the memory preflight", async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    test.skip(testInfo.project.name !== "chromium", "The full-duration MP3 memory soak runs in Chromium only.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "mp3-memory-soak-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(4 * 60),
    });
    await expect(session.locator(".mastering-file-session-source")).toContainText("mp3-memory-soak-source.wav", {
      timeout: 120_000,
    });
    await session.getByLabel("External mastering render sample rate").selectOption("44100");
    await session.getByLabel("External mastering delivery format").selectOption("mp3");
    await session.getByLabel("External mastering MP3 bitrate").selectOption("320");
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByText(/2 ch · 44.1 kHz/)).toBeVisible({ timeout: 240_000 });
    await expect(session.locator(".mastering-file-session-budget")).toContainText("DELIVERY MEMORY");
    console.log(`MP3 delivery preflight: ${await session.locator(".mastering-file-session-budget").innerText()}`);
    const exportButton = session.getByRole("button", { name: "Encode & export MP3" });
    await expect(exportButton).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await markMasteringMemoryStage("encode-start");
    try {
      await exportButton.click();
      await expect(session.getByRole("status").filter({ hasText: "Checking encoded MP3 delivery" })).toBeVisible({
        timeout: 240_000,
      });
      await markMasteringMemoryStage("inspection-start");
      const download = await downloadPromise;
      const outputPath = testInfo.outputPath("external-master-memory-soak-320kbps.mp3");
      await download.saveAs(outputPath);
      const output = await readFile(outputPath);
      expect(readMp3Facts(output)).toMatchObject({ sampleRate: 44_100, channels: 2, bitrateKbps: 320 });
      await expect(
        session.getByRole("status").filter({ hasText: /Encoded MP3 parsed and decoded audio measured/ }),
      ).toBeVisible({ timeout: 240_000 });
      expect(output.byteLength).toBeGreaterThan(9_000_000);
      expect(output.byteLength).toBeLessThan(12 * 1024 * 1024);
    } finally {
      await markMasteringMemoryStage("encode-end");
    }
  });

  test("external-WAV-memory-soak completes WAV delivery and preflights oversized five-minute FLAC and MP3", async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    test.skip(
      !["chromium", "firefox-mastering-session"].includes(testInfo.project.name),
      "The full-duration WAV memory soak requires a supported Web Audio browser.",
    );
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const sourcePath = testInfo.outputPath("wav-memory-soak-source.wav");
    await writeFile(sourcePath, makeStereoTestWav(5 * 60));
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles(sourcePath);
    await expect(session.locator(".mastering-file-session-source")).toContainText("wav-memory-soak-source.wav", {
      timeout: 120_000,
    });
    await session.getByLabel("External mastering render sample rate").selectOption("44100");
    await session.getByLabel("External mastering delivery format").selectOption("wav");
    await session.getByLabel("External mastering WAV bit depth").selectOption("24");
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByText(/2 ch · 44.1 kHz/)).toBeVisible({ timeout: 240_000 });
    await expect(session.locator(".mastering-file-session-budget")).toContainText("DELIVERY MEMORY");
    console.log(`WAV delivery preflight: ${await session.locator(".mastering-file-session-budget").innerText()}`);
    const exportButton = session.getByRole("button", { name: "Encode & export WAV" });
    await expect(exportButton).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await markMasteringMemoryStage("encode-start");
    try {
      await exportButton.click();
      await expect(session.getByRole("status").filter({ hasText: "Checking encoded WAV delivery" })).toBeVisible({
        timeout: 240_000,
      });
      await markMasteringMemoryStage("inspection-start");
      const download = await downloadPromise;
      const outputPath = testInfo.outputPath("external-master-memory-soak-24bit.wav");
      await download.saveAs(outputPath);
      const outputStats = await stat(outputPath);
      const handle = await open(outputPath, "r");
      try {
        const header = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
        expect(bytesRead).toBeGreaterThan(64);
        expect(header.toString("ascii", 0, 4)).toBe("RIFF");
        expect(header.toString("ascii", 8, 12)).toBe("WAVE");
        const formatOffset = header.indexOf("fmt ", 12, "ascii");
        expect(formatOffset).toBeGreaterThan(0);
        expect(header.readUInt16LE(formatOffset + 22)).toBe(24);
        expect(header.readUInt32LE(formatOffset + 12)).toBe(44_100);
      } finally {
        await handle.close();
      }
      await expect(
        session.getByRole("status").filter({ hasText: /Encoded WAV parsed and decoded audio measured/ }),
      ).toBeVisible({ timeout: 240_000 });
      await expect(session.getByText(/Decoded WAV.*KYX WAV PCM reader/)).toBeVisible();
      expect(outputStats.size).toBeGreaterThan(70_000_000);
      expect(outputStats.size).toBeLessThan(96 * 1024 * 1024);
    } finally {
      await markMasteringMemoryStage("encode-end");
    }

    await session.getByLabel("External mastering delivery format").selectOption("flac");
    await session.getByLabel("External mastering FLAC bit depth").selectOption("24");
    await expect(session.getByRole("button", { name: "Encode & export FLAC" })).toBeDisabled();
    await expect(
      session.getByRole("status").filter({ hasText: "This FLAC delivery exceeds KYX's 512 MiB" }),
    ).toBeVisible();
    await expect(session.locator(".mastering-file-session-budget")).toContainText("DELIVERY MEMORY");

    await session.getByLabel("External mastering delivery format").selectOption("mp3");
    await session.getByLabel("External mastering MP3 bitrate").selectOption("320");
    await expect(session.getByRole("button", { name: "Encode & export MP3" })).toBeDisabled();
    await expect(
      session.getByRole("status").filter({ hasText: "This MP3 delivery exceeds KYX's 512 MiB" }),
    ).toBeVisible();
    await expect(session.locator(".mastering-file-session-budget")).toContainText("DELIVERY MEMORY");
  });

  test("exports an external WAV with an honest report when the SHA-256 worker cannot start", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      testInfo.project.name !== "chromium",
      "Fingerprint-worker startup fallback acceptance currently runs in Chromium.",
    );
    await page.addInitScript(() => {
      const originalWorker = globalThis.Worker;
      const gatedWorker = new Proxy(originalWorker, {
        construct(target, argumentsList) {
          if (String(argumentsList[0]).includes("fingerprintWorker")) {
            throw new Error("Test blocked the SHA-256 worker.");
          }
          return Reflect.construct(target, argumentsList);
        },
      });
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: gatedWorker,
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "fingerprint-worker-unavailable-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(2),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 60_000 });
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Encode & export WAV" })).toBeEnabled({ timeout: 90_000 });

    const deliveryPromise = page.waitForEvent("download");
    await session.getByRole("button", { name: "Encode & export WAV" }).click();
    const delivery = await deliveryPromise;
    const deliveryPath = testInfo.outputPath("external-master-fingerprint-not-computed.wav");
    await delivery.saveAs(deliveryPath);
    const deliveryBytes = await readFile(deliveryPath);
    expect(readMasterWavFacts(deliveryBytes)).toMatchObject({ formatCode: 1, channels: 2, sampleRate: 44_100 });
    await expect(
      session.getByRole("status").filter({ hasText: "Encoded WAV parsed and decoded audio measured" }),
    ).toBeVisible({ timeout: 90_000 });

    const reportGroup = session.getByRole("group", { name: "Recent exported delivery report downloads" });
    const reportPromise = page.waitForEvent("download");
    await reportGroup
      .getByRole("button", { name: `Download delivery report JSON for ${delivery.suggestedFilename()}` })
      .click();
    const reportDownload = await reportPromise;
    const reportPath = testInfo.outputPath("external-master-fingerprint-not-computed-report.json");
    await reportDownload.saveAs(reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      schema: "kyx.external-mastering-report",
      schemaVersion: 6,
      inputBaseline: {
        status: "not-measured",
        reason: "Input baseline analysis was not run before this delivery export.",
      },
      delivery: {
        fileName: delivery.suggestedFilename(),
        byteLength: deliveryBytes.byteLength,
        fingerprint: {
          algorithm: "SHA-256",
          status: "not-computed",
          hex: null,
          reason: expect.stringContaining("Could not start the SHA-256 worker: Test blocked the SHA-256 worker."),
        },
        postEncode: { status: "measured" },
      },
    });
  });

  test("keeps an external MP3 delivery honest when browser decoding is unavailable", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      testInfo.project.name === "webkit",
      "The Windows Playwright WebKit build does not include the Web Audio media stack.",
    );
    await page.addInitScript(() => {
      const prototype = OfflineAudioContext.prototype;
      const originalDecode = prototype.decodeAudioData;
      Object.defineProperty(prototype, "decodeAudioData", {
        configurable: true,
        writable: true,
        value: function (
          this: OfflineAudioContext,
          encodedBytes: ArrayBuffer,
          successCallback?: DecodeSuccessCallback,
          errorCallback?: DecodeErrorCallback,
        ): Promise<AudioBuffer> {
          const bytes = new Uint8Array(encodedBytes);
          let mp3Offset = 0;
          if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10) {
            const tagSize =
              ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
            mp3Offset = 10 + tagSize + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
          }
          const hasMpegLayer3Frame =
            mp3Offset + 4 <= bytes.length &&
            (() => {
              const header = new DataView(bytes.buffer, bytes.byteOffset + mp3Offset, 4).getUint32(0, false);
              const versionBits = (header >>> 19) & 0b11;
              const layerBits = (header >>> 17) & 0b11;
              const bitrateIndex = (header >>> 12) & 0b1111;
              const sampleRateIndex = (header >>> 10) & 0b11;
              return (
                header >>> 21 === 0x7ff &&
                versionBits !== 1 &&
                layerBits === 1 &&
                bitrateIndex !== 0 &&
                bitrateIndex !== 15 &&
                sampleRateIndex !== 3
              );
            })();
          if (hasMpegLayer3Frame) {
            const error = new DOMException("MP3 decoding is unavailable in this browser.", "NotSupportedError");
            errorCallback?.(error);
            return Promise.reject(error);
          }
          return originalDecode.call(this, encodedBytes, successCallback, errorCallback);
        },
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV, MP3 or FLAC mixdown").setInputFiles({
      name: "mp3-no-decoder-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(2),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 60_000 });
    await session.getByLabel("External mastering render sample rate").selectOption("44100");
    await session.getByLabel("External mastering delivery format").selectOption("mp3");
    await session.getByLabel("External mastering MP3 bitrate").selectOption("192");
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Encode & export MP3" })).toBeEnabled({ timeout: 90_000 });

    const deliveryPromise = page.waitForEvent("download");
    await session.getByRole("button", { name: "Encode & export MP3" }).click();
    const delivery = await deliveryPromise;
    const deliveryPath = testInfo.outputPath("external-master-mp3-not-measured.mp3");
    await delivery.saveAs(deliveryPath);
    const deliveryBytes = await readFile(deliveryPath);
    expect(readMp3Facts(deliveryBytes)).toMatchObject({ sampleRate: 44_100, channels: 2, bitrateKbps: 192 });
    await expect(session.getByRole("status")).toContainText(/MP3 headers checked; post-decode audio was not measured/);
    await expect(session.getByText(/post-decode measurement unavailable:/)).toBeVisible();

    const reportGroup = session.getByRole("group", { name: "Recent exported delivery report downloads" });
    const reportPromise = page.waitForEvent("download");
    await reportGroup
      .getByRole("button", { name: `Download delivery report JSON for ${delivery.suggestedFilename()}` })
      .click();
    const reportDownload = await reportPromise;
    const reportPath = testInfo.outputPath("external-master-mp3-not-measured-report.json");
    await reportDownload.saveAs(reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      schema: "kyx.external-mastering-report",
      schemaVersion: 6,
      delivery: {
        fileName: delivery.suggestedFilename(),
        format: "mp3",
        byteLength: deliveryBytes.byteLength,
        fingerprint: {
          algorithm: "SHA-256",
          status: "computed",
          hex: createHash("sha256").update(deliveryBytes).digest("hex"),
        },
        measurementBasis: "pre-encode-render-pcm-only",
        postEncode: {
          status: "not-measured",
          decoder: "Web Audio",
          reason: expect.stringContaining("MP3 decoding is unavailable in this browser."),
        },
      },
    });
  });
});
