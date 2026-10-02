import { useEffect, useState, useSyncExternalStore } from "react";
import { useServices } from "./context";
import {
  getSessionRecordingState,
  isSessionStateActive,
  subscribeSessionRecordingState,
  type SessionRecordingState,
} from "./sessionStateSurface";

/**
 * SESSION STATE INDICATOR — one always-visible footer chip group that says
 * what is armed/hot right now, regardless of which panel the user is looking
 * at. The axes are otherwise scattered (arming lives in the arrangement REC
 * strip, metronome/count-in in the transport) — a user with the mixer open
 * could not see that a vocal track is armed with a punch range waiting.
 *
 * Clicking anywhere on the group opens the arrangement REC strip — the place
 * every published axis is controlled from.
 *
 * Hidden entirely when nothing is active: no traffic, no clutter.
 */

const POLL_MS = 250;

interface TransportFlags {
  metronome: boolean;
  countInBars: number;
}

function useTransportFlags(): TransportFlags {
  const services = useServices();
  const [flags, setFlags] = useState<TransportFlags>({ metronome: false, countInBars: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      setFlags((prev) => {
        const metronome = services.transport.metronome;
        const countInBars = services.transport.countInBars;
        if (prev.metronome === metronome && prev.countInBars === countInBars) return prev;
        return { metronome, countInBars };
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [services]);
  return flags;
}

export function SessionStateIndicator({ onOpenArrangement }: { onOpenArrangement: () => void }) {
  const recording: SessionRecordingState = useSyncExternalStore(
    subscribeSessionRecordingState,
    getSessionRecordingState,
    getSessionRecordingState,
  );
  const { metronome, countInBars } = useTransportFlags();

  if (!isSessionStateActive(recording) && !metronome && countInBars <= 0) return null;

  const recordingLive = recording.recState === "recording" || recording.recState === "starting";
  const armedCount = recording.armedTrackNames.length;

  return (
    <div className="session-state" role="status" aria-label="Active session modes">
      <button
        type="button"
        className="session-state-group"
        title="Active session modes — click to open the arrangement REC strip"
        onClick={onOpenArrangement}
      >
        {recordingLive && (
          <span
            className={`session-state-chip session-state-rec${recording.recState === "starting" ? " starting" : ""}`}
          >
            {recording.recState === "starting" ? "◌ REC" : "● REC"}
          </span>
        )}
        {recording.recState === "saving" && <span className="session-state-chip">SAVING…</span>}
        {armedCount > 0 && (
          <span className="session-state-chip">
            ARMED: {recording.armedTrackNames[0]}
            {armedCount > 1 ? ` +${armedCount - 1}` : ""}
          </span>
        )}
        {recording.punchRange && <span className="session-state-chip">PUNCH {recording.punchRange}</span>}
        {recording.loopTakes && <span className="session-state-chip">LOOP TAKES</span>}
        {recording.takeModeLabel && <span className="session-state-chip">{recording.takeModeLabel}</span>}
        {metronome && <span className="session-state-chip">METRO</span>}
        {countInBars > 0 && <span className="session-state-chip">COUNT-IN {countInBars}</span>}
      </button>
    </div>
  );
}
