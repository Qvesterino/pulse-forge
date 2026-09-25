import { describe, expect, it, vi } from "vitest";
import { audioClipChannelData, connectAudioClipSourceChannel } from "../src/audio-engine/audioClipChannels";

describe("audio clip source-channel routing", () => {
  it("routes exactly one source channel to the clip's mono input", () => {
    const splitter = { connect: vi.fn() } as unknown as ChannelSplitterNode;
    const source = {
      buffer: { numberOfChannels: 2 },
      connect: vi.fn(),
    } as unknown as AudioBufferSourceNode;
    const destination = {} as AudioNode;
    const context = { createChannelSplitter: vi.fn(() => splitter) } as unknown as BaseAudioContext;

    const created = connectAudioClipSourceChannel(context, source, destination, 1);

    expect(created).toBe(splitter);
    expect(context.createChannelSplitter).toHaveBeenCalledWith(2);
    expect(source.connect).toHaveBeenCalledWith(splitter);
    expect(splitter.connect).toHaveBeenCalledWith(destination, 1, 0);
  });

  it("keeps the original multichannel path when no valid source channel is selected", () => {
    const source = {
      buffer: { numberOfChannels: 2 },
      connect: vi.fn(),
    } as unknown as AudioBufferSourceNode;
    const destination = {} as AudioNode;
    const context = { createChannelSplitter: vi.fn() } as unknown as BaseAudioContext;

    expect(connectAudioClipSourceChannel(context, source, destination)).toBeNull();
    expect(connectAudioClipSourceChannel(context, source, destination, 2)).toBeNull();
    expect(source.connect).toHaveBeenNthCalledWith(1, destination);
    expect(source.connect).toHaveBeenNthCalledWith(2, destination);
    expect(context.createChannelSplitter).not.toHaveBeenCalled();
  });

  it("selects matching PCM for channel-specific waveforms and analysis", () => {
    const left = new Float32Array([0.1, 0.2]);
    const right = new Float32Array([-0.3, -0.4]);
    const buffer = {
      numberOfChannels: 2,
      getChannelData: vi.fn((channel: number) => (channel === 1 ? right : left)),
    } as unknown as AudioBuffer;

    expect(audioClipChannelData(buffer, 1)).toBe(right);
    expect(audioClipChannelData(buffer, 0)).toBe(left);
    expect(audioClipChannelData(buffer, 5)).toBe(left);
    expect(audioClipChannelData(buffer)).toBe(left);
  });
});
