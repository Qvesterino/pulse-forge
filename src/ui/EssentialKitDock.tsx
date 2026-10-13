import { useState } from "react";
import type { EffectType, Track } from "../project-model/types";
import {
  ESSENTIAL_KIT_DEFAULT_VARIANT,
  ESSENTIAL_KIT_SLOTS,
  type EssentialKitSlot,
  type EssentialKitSlotId,
} from "../effects/essentialKit";
import { KitMultiview } from "./KitMultiview";

type EssentialKitDockProps = {
  track: Track;
  /** Which device types already sit on this track, for the ON TRACK marks. */
  installedTypes: readonly EffectType[];
  onLoadKit: (selection: Readonly<Record<EssentialKitSlotId, string>>) => void;
  /** Commit one parameter of an inserted kit device through the command path. */
  onParamChange: (fxId: string, paramId: string, value: number) => void;
};

/**
 * Module-first companion to the SOURCE dock: pick a character for each of the
 * five fundamental devices, then load them all in one click. Below the slots,
 * every device that is actually on the track shows its own controls — the
 * selection answers "which one", the multiview answers "what is it doing now".
 *
 * The dock holds only the CHOICE and renders document values; every insert and
 * every drag goes through a command, so nothing here owns audio or project
 * state.
 */
export function EssentialKitDock({ track, installedTypes, onLoadKit, onParamChange }: EssentialKitDockProps) {
  const [selection, setSelection] = useState<Readonly<Record<EssentialKitSlotId, string>>>(() => ({
    ...ESSENTIAL_KIT_DEFAULT_VARIANT,
  }));

  const choose = (slot: EssentialKitSlot, label: string) => setSelection((prev) => ({ ...prev, [slot.id]: label }));

  return (
    <section className="essential-kit-dock" aria-label="Essential kit">
      <div className="essential-kit-head">
        <div>
          <span className="essential-kit-kicker">ESSENTIAL</span>
          <span className="essential-kit-title">KIT</span>
          <span className="essential-kit-description">EQ, dynamics, saturation, delay and reverb on {track.name}</span>
        </div>
        <button
          type="button"
          className="btn btn-small essential-kit-load"
          onClick={() => onLoadKit(selection)}
          title={`Insert the five essential devices on ${track.name} in one undo step`}
        >
          LOAD KIT
        </button>
      </div>
      <div className="essential-kit-slots">
        {ESSENTIAL_KIT_SLOTS.map((slot) => {
          const installed = installedTypes.includes(slot.type);
          return (
            <div key={slot.id} className="essential-kit-slot">
              <div className="essential-kit-slot-head">
                <span className="essential-kit-slot-label">{slot.label}</span>
                {installed && (
                  <span className="essential-kit-installed" title={`${slot.label} is already on this track`}>
                    ON TRACK
                  </span>
                )}
              </div>
              <div className="essential-kit-variants" role="group" aria-label={`${slot.label} variant`}>
                {slot.variants.map((variant) => (
                  <button
                    key={variant.presetId}
                    type="button"
                    className={`essential-kit-variant${selection[slot.id] === variant.label ? " is-active" : ""}`}
                    aria-pressed={selection[slot.id] === variant.label}
                    onClick={() => choose(slot, variant.label)}
                  >
                    {variant.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <KitMultiview track={track} onChange={onParamChange} />
      <span className="essential-kit-hint">FIVE DEVICES · ONE UNDO STEP · STACKS IN SIGNAL ORDER</span>
    </section>
  );
}
