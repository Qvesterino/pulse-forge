import { useEffect, useState } from "react";
import { useServices } from "./context";
import { pitchName } from "../project-model/types";

/**
 * MPE discoverability strip: a badge that lights up once per-note pressure
 * or CC74 timbre arrives from a controller, plus live per-note bars for the
 * held notes (top row = pressure, bottom = timbre). Makes the expressive
 * engine visible instead of living under the hood.
 */
export function MpeIndicator() {
  const services = useServices();
  const midi = services.midi;
  const [, setTick] = useState(0);

  useEffect(() => midi.subscribeMpe(() => setTick((t) => t + 1)), [midi]);

  const connected = midi.isMpeConnected();
  const notes = midi.getMpeNotes();

  return (
    <div className="mpe-indicator" role="status" aria-label="MPE controller activity">
      <span
        className={`mpe-badge${connected ? " active" : ""}`}
        title={
          connected
            ? "MPE controller connected — per-note pressure + CC74 timbre are live"
            : "No MPE controller detected — send per-note pressure or CC74 from a controller to light this up"
        }
      >
        MPE
      </span>
      {notes.length === 0 ? (
        <span className="mpe-hint">{connected ? "touch a note" : "no MPE notes held"}</span>
      ) : (
        notes.slice(0, 8).map((n) => (
          <span key={n.pitch} className="mpe-note" title={`${pitchName(n.pitch)} — pressure ${(n.pressure * 100).toFixed(0)}%, timbre ${(n.timbre * 100).toFixed(0)}%`}>
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
