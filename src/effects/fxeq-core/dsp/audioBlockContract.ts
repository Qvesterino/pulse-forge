/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// FXEQ — shared audio-block contract
//
// Every prepared DSP object owns scratch state sized for maxBlockSize. The
// contract has two deliberately different entry points:
//
//   assertAudioBlock(...)  — for a DSP object that can only process one
//                            prepared block. Invalid and oversized input is
//                            rejected before any state or audio is touched.
//   processAudioChunks(...) — for a host-facing processor. A larger host
//                             block is split into bounded views while state
//                             remains continuous across chunks.
//
// Keeping these rules here prevents individual modules from silently
// truncating a block (which used to leave an unprocessed tail in the buffer).

export type AudioBlock = Float32Array[];

function assertFrameCount(frameCount: number, context: string): void {
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new RangeError(`${context}: frameCount must be a non-negative integer (received ${String(frameCount)})`);
  }
}

function assertMaxBlockSize(maxBlockSize: number, context: string): void {
  if (!Number.isInteger(maxBlockSize) || maxBlockSize < 1) {
    throw new RangeError(`${context}: maxBlockSize must be a positive integer (received ${String(maxBlockSize)})`);
  }
}

/** Validate channel shape without imposing a prepared block-size limit. */
export function assertAudioBlockShape(
  channels: AudioBlock,
  frameCount: number,
  context: string,
  expectedChannelCount?: number,
): void {
  assertFrameCount(frameCount, context);

  if (!Array.isArray(channels)) {
    throw new TypeError(`${context}: channels must be an array of Float32Array values`);
  }
  if (expectedChannelCount !== undefined && channels.length !== expectedChannelCount) {
    throw new RangeError(`${context}: expected ${expectedChannelCount} channel(s), received ${channels.length}`);
  }
  if (channels.length === 0 && frameCount > 0) {
    throw new RangeError(`${context}: at least one channel is required for a non-empty block`);
  }

  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c];
    if (!(channel instanceof Float32Array)) {
      throw new TypeError(`${context}: channel ${c} must be a Float32Array`);
    }
    if (channel.length < frameCount) {
      throw new RangeError(`${context}: channel ${c} has ${channel.length} samples, but frameCount is ${frameCount}`);
    }
  }
}

/** Validate a block passed directly to a prepared DSP object. */
export function assertAudioBlock(
  channels: AudioBlock,
  frameCount: number,
  maxBlockSize: number,
  context: string,
  expectedChannelCount?: number,
): void {
  assertMaxBlockSize(maxBlockSize, context);
  assertAudioBlockShape(channels, frameCount, context, expectedChannelCount);
  if (frameCount > maxBlockSize) {
    throw new RangeError(
      `${context}: frameCount ${frameCount} exceeds prepared maxBlockSize ${maxBlockSize}; ` +
        "the host must chunk the block before calling this DSP object",
    );
  }
}

/**
 * Process a host block in bounded views. The callback receives views into the
 * original channel arrays, so in-place processing and state continuity are
 * preserved without copying the audio. `relatedChannels` is useful for a
 * sidechain: it is chunked at the same offsets and validated against the
 * same frame count.
 */
export function processAudioChunks(
  channels: AudioBlock,
  frameCount: number,
  maxBlockSize: number,
  processChunk: (channels: AudioBlock, frameCount: number, offset: number, relatedChannels: AudioBlock | null) => void,
  relatedChannels?: AudioBlock | null,
): void {
  assertMaxBlockSize(maxBlockSize, "audio block contract");
  assertAudioBlockShape(channels, frameCount, "audio block contract");
  if (relatedChannels) {
    assertAudioBlockShape(relatedChannels, frameCount, "audio block related channels");
  }
  if (frameCount === 0) return;

  const channelViews: AudioBlock = new Array(channels.length);
  const relatedViews: AudioBlock | null = relatedChannels ? new Array(relatedChannels.length) : null;

  for (let offset = 0; offset < frameCount; offset += maxBlockSize) {
    const count = Math.min(maxBlockSize, frameCount - offset);
    const end = offset + count;
    for (let c = 0; c < channels.length; c++) {
      channelViews[c] = channels[c].subarray(offset, end);
    }
    if (relatedChannels && relatedViews) {
      for (let c = 0; c < relatedChannels.length; c++) {
        relatedViews[c] = relatedChannels[c].subarray(offset, end);
      }
    }
    processChunk(channelViews, count, offset, relatedViews);
  }
}

/** Build offset-aligned views for a related block inside a chunk callback. */
export function viewAudioChunk(
  channels: AudioBlock | null | undefined,
  offset: number,
  frameCount: number,
): AudioBlock | null {
  if (!channels) return null;
  const views: AudioBlock = new Array(channels.length);
  for (let c = 0; c < channels.length; c++) {
    views[c] = channels[c].subarray(offset, offset + frameCount);
  }
  return views;
}
