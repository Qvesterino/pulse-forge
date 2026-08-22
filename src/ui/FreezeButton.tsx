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
    setRendering(true);
    try {
      const bufferId = `frozen-${track.id}-${Date.now().toString(36)}`;
      const buffer = await renderTrack(doc, track.id, services.bank, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 3,
      });
      // Store in bank
      services.bank.add(bufferId, buffer);
      // Set frozen flag
      services.store.execute(
        freezeTrack(doc, track.id, bufferId, buffer.duration, buffer.sampleRate),
      );
    } catch (err) {
      console.error("[FreezeButton] freeze failed:", err);
    } finally {
      setRendering(false);
    }
  };

  const handleUnfreeze = () => {
    if (!isFrozen) return;
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
      {isFrozen ? (
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
