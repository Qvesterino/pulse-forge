import { useEffect, useRef } from "react";
import { useServices } from "./context";
import { setPadColor } from "../commands/commands";
import type { DrumTrack } from "../project-model/types";
import type { RepeatRate } from "../audio-engine/NoteRepeat";
import { PINNABLE_RATES, setPinnedRates, usePinnedRates } from "./padChannelState";

const PAD_COLOR_SWATCHES = [
  "#f59e0b",
  "#f87171",
  "#fb7185",
  "#f472b6",
  "#a78bfa",
  "#60a5fa",
  "#22d3ee",
  "#4ade80",
  "#a3e635",
  "#e8e8e8",
];

/**
 * The pad repeat-rate menu — ONE component, two hosts.
 *
 * This menu used to live inline in RackStrip, which made "the same menu" a
 * promise rather than a fact: the sequencer row labels need the identical menu
 * (right-click AND touch long-press), and a second hand-written copy would be a
 * third behaviour to keep in sync. Extracting it keeps the DOM identical for
 * the rack while making the agreement structural.
 *
 * All state writes go through padChannelState, so a rate picked from either
 * host is immediately visible in the other one.
 */
export function PadRateMenu({
  padId,
  track,
  x,
  y,
  globalRate,
  onClose,
  onStatus,
}: {
  padId: string;
  track: DrumTrack;
  x: number;
  y: number;
  /** The header's global division, shown on the "inherit" row. */
  globalRate: RepeatRate;
  onClose: () => void;
  /** Colour-change failures surface here (the rack shows its kit status). */
  onStatus?: (message: string) => void;
}) {
  const services = useServices();
  const pinnedRates = usePinnedRates();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const padColor = track.pads.find((p) => p.id === padId)?.color;

  // Close on any outside press (same contract as the arrangement context menus).
  useEffect(() => {
    const close = () => onCloseRef.current();
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div
      className="context-menu"
      role="menu"
      aria-label="Pad repeat rate"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - 260),
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="context-menu-header">PAD REPEAT RATE</div>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setPinnedRates((prev) => {
            const next = { ...prev };
            delete next[padId];
            return next;
          });
          onCloseRef.current();
        }}
      >
        Inherit global ({globalRate})
      </button>
      {PINNABLE_RATES.map((rate) => (
        <button
          key={rate}
          type="button"
          role="menuitem"
          onClick={() => {
            setPinnedRates((prev) => ({ ...prev, [padId]: rate }));
            onCloseRef.current();
          }}
        >
          {rate}
          {pinnedRates[padId] === rate ? " ✓" : ""}
        </button>
      ))}
      <div className="context-menu-header">COLOR</div>
      <div className="pad-color-row">
        {PAD_COLOR_SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            role="menuitemradio"
            aria-checked={padColor === swatch}
            className="pad-color-swatch"
            style={{ background: swatch }}
            title={swatch}
            onClick={() => {
              try {
                services.store.execute(setPadColor(services.store.doc, track.id, padId, swatch));
              } catch {
                onStatusRef.current?.("Colour change failed");
              }
              onCloseRef.current();
            }}
          />
        ))}
        <button
          type="button"
          role="menuitem"
          className="pad-color-auto"
          title="Back to the category colour"
          onClick={() => {
            try {
              services.store.execute(setPadColor(services.store.doc, track.id, padId, null));
            } catch {
              onStatusRef.current?.("Clear failed");
            }
            onCloseRef.current();
          }}
        >
          AUTO
        </button>
      </div>
    </div>
  );
}
