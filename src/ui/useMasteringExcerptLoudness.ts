import { useEffect, useState } from "react";
import type { BufferSummary } from "../audio-engine/metering";
import { measureMasterBufferRangeLufsAsync } from "../mastering/analysisClient";

export interface MasteringExcerptLoudnessMatch {
  status: "measuring" | "ready" | "unavailable";
  projectBuffer: AudioBuffer;
  referenceBuffer: AudioBuffer;
  projectOffset: number;
  referenceOffset: number;
  durationSeconds: number;
  projectLufs: number | null;
  referenceLufs: number | null;
  reason?: string;
}

export function useMasteringExcerptLoudness({
  enabled,
  projectBuffer,
  projectSummary,
  referenceBuffer,
  referenceSummary,
  projectOffset,
  referenceOffset,
  durationSeconds,
}: {
  enabled: boolean;
  projectBuffer: AudioBuffer | null;
  projectSummary: BufferSummary | null;
  referenceBuffer: AudioBuffer | null;
  referenceSummary: BufferSummary | null;
  projectOffset: number;
  referenceOffset: number;
  durationSeconds: number;
}): {
  current: MasteringExcerptLoudnessMatch | null;
  pending: boolean;
  targetLufs: number | null;
} {
  const [match, setMatch] = useState<MasteringExcerptLoudnessMatch | null>(null);
  const pairReady = Boolean(
    enabled && projectBuffer && projectSummary && referenceBuffer && referenceSummary && durationSeconds > 0,
  );
  const isCurrent = Boolean(
    pairReady &&
    match &&
    match.projectBuffer === projectBuffer &&
    match.referenceBuffer === referenceBuffer &&
    match.projectOffset === projectOffset &&
    match.referenceOffset === referenceOffset &&
    match.durationSeconds === durationSeconds,
  );
  const current = isCurrent ? match : null;
  const pending = Boolean(enabled && pairReady && (!current || current.status === "measuring"));
  const targetLufs =
    current?.status === "ready" && current.projectLufs !== null && current.referenceLufs !== null
      ? Math.min(current.projectLufs, current.referenceLufs)
      : null;

  useEffect(() => {
    if (!pairReady || !projectBuffer || !projectSummary || !referenceBuffer || !referenceSummary) {
      setMatch(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setMatch({
      status: "measuring",
      projectBuffer,
      referenceBuffer,
      projectOffset,
      referenceOffset,
      durationSeconds,
      projectLufs: null,
      referenceLufs: null,
    });

    const timer = window.setTimeout(() => {
      const measureSide = (
        buffer: AudioBuffer,
        fullSummary: BufferSummary,
        startSeconds: number,
      ): Promise<number | null> => {
        const selectedFrames = Math.round(durationSeconds * buffer.sampleRate);
        if (startSeconds <= 0 && selectedFrames >= buffer.length - 1) {
          return Promise.resolve(fullSummary.lufsIntegrated > -119 ? fullSummary.lufsIntegrated : null);
        }
        return measureMasterBufferRangeLufsAsync(buffer, startSeconds, durationSeconds, controller.signal);
      };

      void Promise.all([
        measureSide(projectBuffer, projectSummary, projectOffset),
        measureSide(referenceBuffer, referenceSummary, referenceOffset),
      ])
        .then(([projectLufs, referenceLufs]) => {
          if (!active || controller.signal.aborted) return;
          setMatch({
            status: "ready",
            projectBuffer,
            referenceBuffer,
            projectOffset,
            referenceOffset,
            durationSeconds,
            projectLufs,
            referenceLufs,
          });
        })
        .catch((reason: unknown) => {
          if (!active || controller.signal.aborted) return;
          controller.abort();
          setMatch({
            status: "unavailable",
            projectBuffer,
            referenceBuffer,
            projectOffset,
            referenceOffset,
            durationSeconds,
            projectLufs: null,
            referenceLufs: null,
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    durationSeconds,
    pairReady,
    projectBuffer,
    projectOffset,
    projectSummary,
    referenceBuffer,
    referenceOffset,
    referenceSummary,
  ]);

  return { current, pending, targetLufs };
}
