/**
 * VSCO 2 CE INGEST — converts a chosen subset of the VSCO 2 Community
 * Edition orchestral library (CC0, 44.1kHz/16-bit) into KYX sample packs.
 *
 * Input : D:\sample-sources\vsco2\VSCO-2-CE-SFZ\  (SFZ + WAV tree)
 * Output: public/samples/vsco/{id}.wav + src/presets/vsco-pack.generated.ts
 *
 * The key/velocity mapping comes from the SFZ REGIONS (not filenames):
 * default_path + <region> sample/lokey/hikey/pitch_keycenter/lovel/hivel.
 * Each region becomes one SampleLayer: root = pitch_keycenter, keyzone =
 * lokey..hikey, velocity window = lovel..hivel.
 *
 * Zero dependencies. Run: node scripts/convert-vsco2.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = "D:/sample-sources/vsco2/VSCO-2-CE-SFZ";
const OUT_DIR = "public/samples/vsco";
const GENERATED = "src/presets/vsco-pack.generated.ts";
const TRIM_DB = -50;
const END_DB = -55;
const PEAK_TARGET = Math.pow(10, -1.5 / 20);

/** The v1 subset — orchestral colors the synth factory lacks. Extend the
 * list to convert more of the 75 instruments (each is one SFZ). */
const INSTRUMENTS = readdirSync(SRC)
  .filter((f) => f.endsWith(".sfz") && !f.includes("-KS"))
  .map((f) => ({ sfz: f, id: f.replace(".sfz", "") }));

function decodeWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not RIFF/WAVE");
  }
  let pos = 12;
  let dataStart = -1;
  let dataBytes = 0;
  let channels = 1;
  let bits = 16;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      // fmt body starts at pos+8: [2..3] channels, [12..13] bits.
      channels = buf.readUInt16LE(pos + 10);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === "data") {
      dataStart = pos + 8;
      dataBytes = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error("no data chunk");
  const bytesPer = bits / 8;
  const frames = Math.floor(dataBytes / (bytesPer * channels));
  const left = new Float32Array(frames);
  const right = channels > 1 ? new Float32Array(frames) : null;
  // 16 / 24 / 32-bit PCM readers (24-bit: 3-byte little-endian signed).
  const read =
    bits === 16
      ? (p) => buf.readInt16LE(p) / 32768
      : bits === 24
        ? (p) => buf.readIntLE(p, 3) / 8388608
        : (p) => buf.readInt32LE(p) / 2147483648;
  for (let i = 0; i < frames; i++) {
    left[i] = read(dataStart + i * bytesPer * channels);
    if (right) right[i] = read(dataStart + i * bytesPer * channels + bytesPer);
  }
  return { left, right, frames };
}

function encodeWav16(channels) {
  const frames = channels[0].length;
  const nch = channels.length;
  const bytes = Buffer.alloc(44 + frames * nch * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * nch * 2, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(nch, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(44100 * nch * 2, 28);
  bytes.writeUInt16LE(nch * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * nch * 2, 40);
  let pos = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, ch[i])) * 32767), pos);
      pos += 2;
    }
  }
  return bytes;
}

const dbfs = (db) => Math.pow(10, db / 20);

function trimStartOf(data, sr) {
  const threshold = dbfs(TRIM_DB);
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) return Math.max(0, i - Math.round(sr * 0.02));
  }
  return 0;
}

function trimEndOf(data, sr) {
  const threshold = dbfs(END_DB);
  let last = data.length - 1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i]) > threshold) {
      last = i;
      break;
    }
  }
  return Math.min(data.length, last + Math.round(sr * 0.12));
}

function peakOf(data, from, to) {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

/** State-machine SFZ parser: opcodes accumulate line by line (VSCO2 puts
 * each opcode on its OWN line after the <region> header) and a region
 * flushes when the next header appears. Group opcodes carry over. */
function parseSfz(text) {
  let defaultPath = "";
  const bs = String.fromCharCode(92);
  // The value may contain spaces ("Violin Section") — capture to EOL.
  for (const m of text.matchAll(/default_path\s*=\s*(.+?)\s*$/gm)) {
    defaultPath = m[1].split(bs).join("/");
  }
  const regions = [];
  let ops = {};
  let current = null;
  const flush = () => {
    if (current === "region" && ops.sample) {
      regions.push({
        sample: String(ops.sample).split(bs).join("/"),
        lokey: ops.lokey != null ? Number(ops.lokey) : 0,
        hikey: ops.hikey != null ? Number(ops.hikey) : 127,
        keycenter:
          ops.pitch_keycenter != null ? Number(ops.pitch_keycenter) : ops.lokey != null ? Number(ops.lokey) : 60,
        lovel: ops.lovel != null ? Number(ops.lovel) : 0,
        hivel: ops.hivel != null ? Number(ops.hivel) : 127,
      });
    }
    ops = {};
  };
  const readOpcodes = (line) => {
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) ops[m[1]] = m[2];
  };
  for (const raw of text.split(new RegExp("\r?\n"))) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    const header = /<\s*(control|global|group|region)\s*>\s*(.*)/.exec(line);
    if (header) {
      flush();
      current = header[1];
      readOpcodes(header[2]);
      continue;
    }
    readOpcodes(line.split("//")[0]);
  }
  flush();
  return { defaultPath, regions };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const allLayers = [];
  const report = [];
  for (const inst of INSTRUMENTS) {
    let parsed;
    try {
      parsed = parseSfz(readFileSync(path.join(SRC, inst.sfz), "utf8"));
    } catch (error) {
      console.warn(`vsco2: skip ${inst.sfz}: ${error.message}`);
      continue;
    }
    const layers = [];
    let zone = 0;
    let written = 0;
    for (const region of parsed.regions) {
      let wav;
      try {
        wav = decodeWav(readFileSync(path.join(SRC, parsed.defaultPath, region.sample)));
      } catch (error) {
        console.warn(`vsco2: ${region.sample}: ${error.message} — skipped`);
        continue;
      }
      const sr = 44100;
      const from = trimStartOf(wav.left, sr);
      const to = trimEndOf(wav.left, sr);
      const outFrames = Math.max(to - from, Math.round(sr * 0.1));
      const peak = peakOf(wav.left, from, to);
      if (peak <= 0) continue;
      const gain = Math.min(4, PEAK_TARGET / peak);
      const fadeFrom = Math.max(0, outFrames - Math.round(sr * 0.12));
      const chL = new Float32Array(outFrames);
      const chR = wav.right ? new Float32Array(outFrames) : null;
      for (let i = 0; i < outFrames; i++) {
        const src = Math.min(from + i, wav.left.length - 1);
        const fade = i >= fadeFrom ? 1 - (i - fadeFrom) / (outFrames - fadeFrom) : 1;
        chL[i] = wav.left[src] * gain * fade;
        if (chR) chR[i] = wav.right[src] * gain * fade;
      }
      zone += 1;
      const sampleId = `factory.vsco.${inst.id}.r${zone}`.toLowerCase();
      writeFileSync(path.join(OUT_DIR, `${sampleId}.wav`), encodeWav16(chR ? [chL, chR] : [chL]));
      written += 1;
      layers.push({
        id: `layer.vsco.${inst.id}.r${zone}`.toLowerCase(),
        sampleId,
        min: region.lovel / 127,
        max: region.hivel >= 127 ? 1 : (region.hivel + 1) / 127,
        minPitch: region.lokey,
        maxPitch: region.hikey,
        root: region.keycenter,
      });
    }
    if (layers.length === 0) {
      console.warn(`vsco2: ${inst.id}: no convertible regions — skipped`);
      continue;
    }
    allLayers.push(...layers);
    report.push(`${inst.name}: ${layers.length} layers / ${written} wavs`);
    console.log(`vsco2: ${inst.name} — ${layers.length} layers, ${written} wavs`);
  }

  const instrumentGroups = [];
  const packedLayerValues = [];
  for (const layer of allLayers) {
    const match = /^layer\.vsco\.(.+)\.r(\d+)$/.exec(layer.id);
    if (!match) throw new Error(`invalid generated VSCO layer id: ${layer.id}`);
    const instrument = match[1];
    const zone = Number(match[2]);
    let group = instrumentGroups[instrumentGroups.length - 1];
    if (!group || group[0] !== instrument) {
      group = [instrument, 0];
      instrumentGroups.push(group);
    }
    if (zone !== group[1] + 1) throw new Error(`non-sequential VSCO zone: ${layer.id}`);
    group[1] = zone;
    const maxVelocity = layer.max >= 1 ? 127 : Math.round(layer.max * 127) - 1;
    const values = [
      Math.round(layer.min * 127),
      maxVelocity,
      layer.minPitch,
      layer.maxPitch,
      layer.root,
    ];
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 127)) {
      throw new Error(`VSCO layer values must fit in one byte: ${layer.id}`);
    }
    packedLayerValues.push(...values);
  }
  const packedBytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const value of packedLayerValues) {
    bitBuffer |= value << bitCount;
    bitCount += 7;
    while (bitCount >= 8) {
      packedBytes.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) packedBytes.push(bitBuffer & 0xff);
  const packedLayerData = Buffer.from(packedBytes).toString("base64");

  // The full object form repeated both long IDs and seven property names for
  // every velocity/key zone. Store the five bounded numeric fields as base64
  // bytes, with instrument names/counts shared once, then rebuild the exact
  // SampleLayer objects at module load while keeping every preset.
  const generated = [
    "/**",
    " * GENERATED by scripts/convert-vsco2.mjs — do not edit by hand.",
    " * Source: VSCO 2 Community Edition (CC0) — see src/sample-library/licenses.ts PACK_CREDITS.",
    " */",
    'import type { SampleLayer } from "../project-model/types";',
    "",
    `const VSCO_INSTRUMENT_GROUPS = ${JSON.stringify(instrumentGroups)} as const;`,
    `const VSCO_LAYER_DATA_BASE64 = "${packedLayerData}";`,
    "",
    "const decodeVscoLayers = (): SampleLayer[] => {",
    "  const bytes = Uint8Array.from(atob(VSCO_LAYER_DATA_BASE64), (char) => char.charCodeAt(0));",
    "  const layers: SampleLayer[] = [];",
    "  let bitOffset = 0;",
    "  const read7 = (): number => {",
    "    const byteOffset = bitOffset >>> 3;",
    "    const shift = bitOffset & 7;",
    "    const low = bytes[byteOffset]!;",
    "    const high = bytes[byteOffset + 1] ?? 0;",
    "    bitOffset += 7;",
    "    return ((low | (high << 8)) >>> shift) & 0x7f;",
    "  };",
    "  for (const [instrument, count] of VSCO_INSTRUMENT_GROUPS) {",
    "    for (let zone = 1; zone <= count; zone += 1) {",
    "      const minVelocity = read7();",
    "      const maxVelocity = read7();",
    "      const minPitch = read7();",
    "      const maxPitch = read7();",
    "      const root = read7();",
    "      const suffix = `.r${zone}`;",
    "      layers.push({",
    "        id: `layer.vsco.${instrument}${suffix}`,",
    "        sampleId: `factory.vsco.${instrument}${suffix}`,",
    "        min: minVelocity / 127,",
    "        max: maxVelocity >= 127 ? 1 : (maxVelocity + 1) / 127,",
    "        minPitch,",
    "        maxPitch,",
    "        root,",
    "      });",
    "    }",
    "  }",
    "  if (Math.ceil(bitOffset / 8) !== bytes.length) throw new Error(\"VSCO layer metadata length mismatch\");",
    "  return layers;",
    "};",
    "",
    "export const VSCO_PACK_LAYERS: SampleLayer[] = decodeVscoLayers();",
    "",
  ].join("\n");
  writeFileSync(GENERATED, generated);
  console.log(`vsco2 ingest complete: ${allLayers.length} layers → ${OUT_DIR}`);
}

main();
