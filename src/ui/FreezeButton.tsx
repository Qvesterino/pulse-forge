import { useState } from "react";
import { useDoc, useServices } from "./context";
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
  const doc = useDoc();
  const [rendering, setRendering] = useState(false);

  const isFrozen = "frozen" in track && track.frozen != null;

  const handleFreeze = async () => {
    if (rendering) return;
    // Group tracks have no own audio: their frozen buffer would be silence
    // (the renderer includes only the group itself, not its children).
    if (track.kind === "group") return;
    setRendering(true);
    try {
      const prevBufferId = track.frozen?.bufferId ?? null;
      const bufferId = `frozen-${track.id}-${Date.now().toString(36)}`;
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
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="freeze-controls">
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
