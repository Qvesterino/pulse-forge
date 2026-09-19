import { useState } from "react";
import { useServices } from "./context";
import { freezeTrack, unfreezeTrack } from "../commands/commands";
import { renderTrack } from "../rendering/track-renderer";
import type { Track } from "../project-model/types";
import { downloadWav, encodeWav } from "../rendering/wav";

/**
 * Freeze/Unfreeze button for a track. Renders the track to an AudioBuffer,
 * stores it in the bank, and sets the frozen flag. Also supports bounce-to-file.
 */
export function FreezeButton({ track }: { track: Track }) {
  const services = useServices();
  const doc = services.store.getDoc();
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFrozen = "frozen" in track && track.frozen != null;

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
      // Store in bank + persist to IndexedDB so the freeze survives reloads.
      services.bank.add(bufferId, buffer);
      await services.frozenAudio.save(bufferId, encodeWav(buffer, 16));
      if (prevBufferId && prevBufferId !== bufferId) {
        services.bank.remove(prevBufferId);
        await services.frozenAudio.remove(prevBufferId);
      }
      // Set frozen flag
      services.store.execute(freezeTrack(doc, track.id, bufferId, buffer.duration, buffer.sampleRate));
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
      {track.kind === "group" ? null : isFrozen ? (
        <button
          type="button"
          className="btn btn-small"
          title="Unfreeze track — restore real-time processing"
          onClick={handleUnfreeze}
        >
          UNFREEZE
        </button>
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
