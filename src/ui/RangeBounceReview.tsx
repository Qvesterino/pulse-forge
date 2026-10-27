import { useCallback, useEffect, useRef, useState } from "react";
import { playAuditionBuffer, stopAudition } from "../intent/audition";
import { ticksPerBar } from "../project-model/schema";
import type { ProjectDocument } from "../project-model/types";
import {
  commitRangeBouncePreview,
  prepareRangeBouncePreview,
  type PreparedRangeBouncePreview,
} from "../services/rangeConsolidation";
import { useSelectionStore, useServices } from "./context";

export interface RangeBounceReviewRequest {
  sourceDoc: ProjectDocument;
  range: { fromTick: number; toTick: number };
  trackIds: string[];
  targetTrackId: string;
  selectedTrackIds: string[];
}

export function RangeBounceReview({ request, onClose }: { request: RangeBounceReviewRequest; onClose: () => void }) {
  const services = useServices();
  const selectionStore = useSelectionStore();
  const [preview, setPreview] = useState<PreparedRangeBouncePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [playing, setPlaying] = useState<"A" | "B" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCurrent = useCallback(() => {
    const liveSelection = selectionStore.getState();
    return (
      services.store.getDoc() === request.sourceDoc &&
      liveSelection.timeRange?.fromTick === request.range.fromTick &&
      liveSelection.timeRange?.toTick === request.range.toTick &&
      liveSelection.trackIds.length === request.selectedTrackIds.length &&
      liveSelection.trackIds.every((id, index) => id === request.selectedTrackIds[index])
    );
  }, [request, selectionStore, services.store]);

  const close = useCallback(() => {
    stopAudition();
    setPlaying(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!preview) return;
    const discardIfStale = () => {
      if (busyRef.current || isCurrent()) return;
      stopAudition();
      setPlaying(null);
      setPreview(null);
      setError("Project or selection changed. This preview was discarded without adding audio.");
    };
    const unsubscribeStore = services.store.subscribe(discardIfStale);
    const unsubscribeSelection = selectionStore.subscribe(discardIfStale);
    discardIfStale();
    return () => {
      unsubscribeStore();
      unsubscribeSelection();
      stopAudition();
    };
  }, [isCurrent, preview, selectionStore, services.store]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const renderPreview = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareRangeBouncePreview(
        services,
        { range: request.range, trackIds: request.trackIds, targetTrackId: request.targetTrackId },
        isCurrent,
      );
      setPreview(prepared);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const confirmBounce = async () => {
    if (!preview || busyRef.current) return;
    stopAudition();
    setPlaying(null);
    busyRef.current = true;
    setBusy(true);
    try {
      await commitRangeBouncePreview(services, preview, isCurrent);
      setPreview(null);
      close();
    } catch (cause) {
      if (!isCurrent() || services.bank.revision !== preview.bankRevision) setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const audition = (take: "A" | "B") => {
    if (!preview) return;
    const buffer = take === "A" ? preview.before : preview.after;
    const gain = take === "A" ? preview.beforeGain : preview.afterGain;
    playAuditionBuffer(buffer, () => setPlaying(null), gain);
    setPlaying(take);
  };

  const targetTrack = request.sourceDoc.tracks.find((track) => track.id === request.targetTrackId);
  const trackNames = request.trackIds
    .map((id) => request.sourceDoc.tracks.find((track) => track.id === id)?.name)
    .filter((name): name is string => !!name);
  const barUnit = ticksPerBar(request.sourceDoc);
  const fromBar = Math.min(request.range.fromTick, request.range.toTick) / barUnit;
  const toBar = Math.max(request.range.fromTick, request.range.toTick) / barUnit;

  return (
    <div className="generate-dialog-backdrop" role="presentation" onMouseDown={(event) => event.stopPropagation()}>
      <section
        className="generate-dialog"
        style={{ width: "min(560px, calc(100vw - 32px))" }}
        role="dialog"
        aria-modal="true"
        aria-label="Selected range bounce A/B preview"
      >
        <div className="generate-dialog-header">
          <span className="generate-dialog-title">RANGE BOUNCE · A/B REVIEW</span>
          <button type="button" className="btn btn-small" disabled={busy} onClick={close}>
            ✕
          </button>
        </div>
        <div className="generate-dialog-body">
          <div className="generate-field">
            <strong>
              Bars {fromBar + 1}–{toBar} · {trackNames.join(", ") || "selected tracks"}
            </strong>
            <span>New audio clip target: {targetTrack?.name ?? request.targetTrackId}</span>
          </div>
          <div role="note">
            A is the current mix. B is the mix after adding the rendered clip alongside its source material. The
            audition is temporary; confirmation adds one undoable audio clip.
          </div>
          {error && <div role="alert">{error}</div>}
          {preview ? (
            <div className="generate-mode-row">
              <button
                type="button"
                className={`btn btn-small${playing === "A" ? " active-solo" : ""}`}
                onClick={() => audition("A")}
              >
                A · ORIGINAL MIX
              </button>
              <button
                type="button"
                className={`btn btn-small${playing === "B" ? " active-solo" : ""}`}
                onClick={() => audition("B")}
              >
                B · BOUNCE RESULT
              </button>
              {playing && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    stopAudition();
                    setPlaying(null);
                  }}
                >
                  STOP
                </button>
              )}
            </div>
          ) : (
            <div>Render both versions through the project mix and audition them at matched preview level.</div>
          )}
        </div>
        <div className="generate-dialog-footer">
          <button type="button" className="btn btn-small" disabled={busy} onClick={close}>
            CANCEL
          </button>
          {preview ? (
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={busy}
              onClick={() => void confirmBounce()}
            >
              {busy ? "ADDING BOUNCE…" : "CONFIRM BOUNCE · ONE UNDO"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={busy}
              onClick={() => void renderPreview()}
            >
              {busy ? "RENDERING A/B…" : "RENDER A/B PREVIEW"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
