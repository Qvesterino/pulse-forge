import type { Services } from "../services";
import { BAR_TICKS, getActivePattern, STEP_TICKS, type ProjectDocument } from "../project-model/types";
import { encodeWavAsync } from "../rendering/wav";

const MAX_PREVIEW_BARS = 4;
const PREVIEW_SAMPLE_RATE = 22_050;
const MAX_PREVIEW_WAV_BYTES = 3 * 1024 * 1024;

export interface McpAudioContent {
  data: string;
  mimeType: "audio/wav";
}

export interface McpAudioPreviewArtifact {
  audio: McpAudioContent;
  bars: number;
  durationSec: number;
  sampleRate: number;
  byteLength: number;
}

/**
 * Clone the project down to its opening N bars. Arrangement clips crossing
 * the boundary are shortened (not moved), later clips/transitions are left
 * out, and pattern-only projects get a bounded active pattern. The caller's
 * document is never mutated.
 */
export function createMcpPreviewDocument(doc: ProjectDocument, bars: number): ProjectDocument {
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_PREVIEW_BARS) {
    throw new Error(`preview bars must be an integer from 1 to ${MAX_PREVIEW_BARS}`);
  }

  const clips = doc.arrangement.clips.flatMap((clip) => {
    if (clip.startBar >= bars) return [];
    const lengthBars = Math.min(clip.lengthBars, bars - clip.startBar);
    return lengthBars > 0 ? [{ ...clip, lengthBars }] : [];
  });
  const audioClips = (doc.arrangement.audioClips ?? []).flatMap((clip) => {
    if (clip.startBar >= bars) return [];
    const lengthBars = Math.min(clip.lengthBars, bars - clip.startBar);
    return lengthBars > 0 ? [{ ...clip, lengthBars }] : [];
  });
  const clipIds = new Set(clips.map((clip) => clip.id));
  const transitions = (doc.arrangement.transitions ?? []).filter(
    (transition) => clipIds.has(transition.fromClipId) && clipIds.has(transition.toClipId),
  );

  const arrangement = {
    ...doc.arrangement,
    clips,
    ...(doc.arrangement.audioClips != null ? { audioClips } : {}),
    ...(doc.arrangement.transitions != null ? { transitions } : {}),
  };
  if (doc.arrangement.clips.length > 0 || (doc.arrangement.audioClips?.length ?? 0) > 0) {
    return { ...doc, arrangement };
  }

  const active = getActivePattern(doc);
  const stepsPerBar = BAR_TICKS / STEP_TICKS;
  const bounded = { ...active, stepCount: Math.min(active.stepCount, bars * stepsPerBar) };
  return {
    ...doc,
    arrangement,
    patterns: doc.patterns.map((pattern) => (pattern.id === active.id ? bounded : pattern)),
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

/** Render a bounded, playable MCP audio attachment using KYX's shared engine. */
export async function mcpRenderAudioPreview(
  services: Services,
  request: { bars: number },
): Promise<McpAudioPreviewArtifact> {
  const source = services.store.getDoc();
  const doc = createMcpPreviewDocument(source, request.bars);
  const hasArrangement = source.arrangement.clips.length > 0 || (source.arrangement.audioClips?.length ?? 0) > 0;
  const mode = hasArrangement ? "song" : "pattern";
  const { renderProject } = await import("../rendering/renderer");
  const buffer = await renderProject(doc, services.bank, {
    mode,
    sampleRate: PREVIEW_SAMPLE_RATE,
    tailSeconds: 0.35,
    ...(hasArrangement ? { arrangementOnly: true, minimumDurationTicks: request.bars * BAR_TICKS } : {}),
    quality: "live",
  });

  const expectedBytes = 44 + buffer.length * buffer.numberOfChannels * 2;
  if (expectedBytes > MAX_PREVIEW_WAV_BYTES) {
    throw new Error(
      `preview is too large (${(expectedBytes / 1024 / 1024).toFixed(1)} MiB WAV); request fewer bars (maximum ${MAX_PREVIEW_BARS})`,
    );
  }
  const wav = await encodeWavAsync(buffer, 16, {});
  return {
    audio: { data: arrayBufferToBase64(wav), mimeType: "audio/wav" },
    bars: request.bars,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    byteLength: wav.byteLength,
  };
}
