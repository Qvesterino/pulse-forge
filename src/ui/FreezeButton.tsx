import { useEffect, useState } from "react";
import { useServices } from "./context";
import { freezeTrack, unfreezeTrack } from "../commands/commands";
import { renderTrack } from "../rendering/track-renderer";
import { freezeSignature, freezeStaleness, rememberFreezeSignature } from "../rendering/freezeSignature";
import type { Track } from "../project-model/types";
import { downloadWav, encodeWav } from "../rendering/wav";

/**
 * Freeze/Unfreeze button for a track. Renders the track to an AudioBuffer,
 * stores it in the bank, and sets the frozen flag. Also supports bounce-to-file.
 *
 * Wave 2/D: the buffer is stamped with a signature of the document it was
 * rendered from. When the project changes afterwards the strip shows EDITED
 * SINCE FREEZE and offers RE-FREEZE — the old behavior kept playing the
 * stale render silently while the export re-rendered the edited track, so
 * what you heard and what you exported disagreed with no visible cause.
 */
export function FreezeButton({ track }: { track: Track }) {
  const services = useServices();
  const doc = services.store.getDoc();
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const isFrozen = "frozen" in track && track.frozen != null;
  const frozenBufferId = "frozen" in track && track.frozen != null ? track.frozen.bufferId : null;

  useEffect(() => {
    if (frozenBufferId == null) {
      setStale(false);
      return;
    }
    let cancelled = false;
    void freezeStaleness(doc, frozenBufferId).then((status) => {
      if (!cancelled) setStale(status === "stale");
    });
    return () => {
      cancelled = true;
    };
  }, [doc, frozenBufferId]);

  const handleFreeze = async () => {
    if (rendering) return;
    // Group tracks have no own audio: their frozen buffer would be silence
    // (the renderer includes only the group itself, not its children).
    if (track.kind === "group") return;
    setRendering(true);
    setError(null);
    let newBufferId: string | null = null;
    try {
      const prevBufferId = track.frozen?.bufferId ?? null;
      const bufferId = `frozen-${track.id}-${Date.now().toString(36)}`;
      newBufferId = bufferId;
      const buffer = await renderTrack(doc, track.id, services.bank, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 3,
        // Freeze captures the track-local generator + FX. Group/master FX
        // remain live, so the frozen buffer is not routed through those
        // processors twice after it is inserted back into the graph.
        includeRouting: false,
      });
      // Signature of the document this render came from (Wave 2/D). Taken
      // from the same `doc` the render used, so it cannot drift.
      const signature = await freezeSignature(doc);
      // Store in bank + persist to IndexedDB so the freeze survives reloads.
      services.bank.add(bufferId, buffer);
      await services.frozenAudio.save(bufferId, encodeWav(buffer, 16), signature ?? undefined);
      if (signature != null) rememberFreezeSignature(bufferId, signature);
      if (prevBufferId && prevBufferId !== bufferId) {
        services.bank.remove(prevBufferId);
        await services.frozenAudio.remove(prevBufferId);
      }
      // Set frozen flag
      services.store.execute(freezeTrack(doc, track.id, bufferId, buffer.duration, buffer.sampleRate));
      setStale(false);
      // Align the fresh buffer to the transport when freezing mid-playback.
      if (services.transport.playing) {
        services.engine.restartFrozenSources(services.transport.position);
      }
    } catch (err) {
      console.error("[FreezeButton] freeze failed:", err);
      if (newBufferId) services.bank.remove(newBufferId);
      setError(err instanceof Error ? err.message : "Freeze failed — try again");
    } finally {
      setRendering(false);
    }
  };

  const handleUnfreeze = () => {
    if (!isFrozen) return;
    // The buffer (bank + IndexedDB) is intentionally kept: unfreeze is
    // undoable and the restored doc would reference this bufferId again.
    // Orphans are GC'd the next time the project opens.
    services.store.execute(unfreezeTrack(doc, track.id));
  };

  const handleBounce = async () => {
    if (rendering) return;
    setRendering(true);
    setError(null);
    try {
      const buffer = await renderTrack(doc, track.id, services.bank, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 3,
      });
      const wav = encodeWav(buffer, 16);
      downloadWav(wav, `${track.name}-bounce.wav`);
    } catch (err) {
      console.error("[FreezeButton] bounce failed:", err);
      setError(err instanceof Error ? err.message : "Bounce failed — try again");
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="freeze-controls">
      {error && (
        <span className="freeze-error" role="status" aria-live="polite" title={error}>
          {error}
        </span>
      )}
      {isFrozen && stale && (
        <span
          className="freeze-error"
          role="status"
          data-stale="true"
          title="Edited since the freeze: live playback uses the frozen render, while the export re-renders this track — the two no longer match. Re-freeze to sync them."
        >
          EDITED SINCE FREEZE
        </span>
      )}
      {track.kind === "group" ? null : isFrozen ? (
        <>
          <button
            type="button"
            className="btn btn-small"
            title="Unfreeze track — restore real-time processing"
            onClick={handleUnfreeze}
          >
            UNFREEZE
          </button>
          <button
            type="button"
            className={stale ? "btn btn-small btn-export" : "btn btn-small"}
            disabled={rendering}
            title={
              stale
                ? "Re-render the frozen buffer from the current edits — one undo step"
                : "Re-render the frozen buffer"
            }
            onClick={() => void handleFreeze()}
          >
            {rendering ? (stale ? "RE-FREEZING…" : "FREEZING…") : stale ? "RE-FREEZE" : "REFRESH"}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-small"
          disabled={rendering}
          title="Freeze track — render to audio buffer for CPU savings"
          onClick={() => void handleFreeze()}
        >
          {rendering ? "FREEZING…" : "FREEZE"}
        </button>
      )}
      <button
        type="button"
        className="btn btn-small"
        disabled={rendering}
        title="Bounce track to WAV file"
        onClick={() => void handleBounce()}
      >
        {rendering ? "BOUNCING…" : "BOUNCE"}
      </button>
    </div>
  );
}
