import { useEffect, useState } from "react";
import { useServices } from "./context";
import { pitchName } from "../project-model/types";

/**
 * Partial MPE input activity strip: a badge that lights up when poly pressure
 * or CC74 timbre arrives, with live bars keyed by held pitch. It does not
 * imply complete zone negotiation or per-note pitch-bend support.
 */
export function MpeIndicator() {
  const services = useServices();
  const midi = services.midi;
  const [, setTick] = useState(0);

  useEffect(() => {
    // Keep the indicator additive: older embedded/test MIDI facades may not
    // expose the MPE capability yet, but the surrounding MIDI tools must
    // remain usable instead of crashing during render.
    if (typeof midi.subscribeMpe !== "function") return undefined;
    return midi.subscribeMpe(() => setTick((t) => t + 1));
  }, [midi]);

  const connected = typeof midi.isMpeConnected === "function" && midi.isMpeConnected();
  const notes = typeof midi.getMpeNotes === "function" ? midi.getMpeNotes() : [];

  return (
    <div className="mpe-indicator" role="status" aria-label="MPE-related MIDI input activity">
      <span
        className={`mpe-badge${connected ? " active" : ""}`}
        title={
          connected
            ? "MPE-related input seen — pressure and CC74 are received; pitch bend currently applies track-wide"
            : "No MPE-related pressure or CC74 input seen; this indicator does not detect or negotiate an MPE zone"
        }
      >
        MPE
      </span>
      {notes.length === 0 ? (
        <span className="mpe-hint">{connected ? "touch a note" : "no MPE expression seen"}</span>
      ) : (
        notes.slice(0, 8).map((n) => (
          <span
            key={n.pitch}
            className="mpe-note"
            title={`${pitchName(n.pitch)} — pressure ${(n.pressure * 100).toFixed(0)}%, timbre ${(n.timbre * 100).toFixed(0)}%`}
          >
            <span className="mpe-note-name">{pitchName(n.pitch)}</span>
            <span className="mpe-bar">
              <span className="mpe-bar-fill mpe-pressure" style={{ width: `${Math.round(n.pressure * 100)}%` }} />
            </span>
            <span className="mpe-bar">
              <span className="mpe-bar-fill mpe-timbre" style={{ width: `${Math.round(n.timbre * 100)}%` }} />
            </span>
          </span>
        ))
      )}
    </div>
  );
}
