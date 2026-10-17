import { useEffect, useState } from "react";
import { useServices } from "./context";

/**
 * Audio unlock for touch devices: iOS/Android suspend the AudioContext
 * until a user gesture, and a suspended context means silent pads. This
 * component (a) attempts an unlock on the very first pointer gesture
 * anywhere, and (b) shows a TAP TO ENABLE AUDIO banner on touch devices
 * whenever the context is actually suspended, so silence is never a
 * mystery.
 */
export function AudioUnlock() {
  const services = useServices();
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const unlock = () => {
      // A refused realtime context throws synchronously; an unguarded throw in
      // a capture-phase pointerdown listener would break every first tap.
      try {
        services.engine.ensureContext();
      } catch {
        /* the TAP TO ENABLE AUDIO banner stays up and retries */
      }
    };
    window.addEventListener("pointerdown", unlock, { once: true, capture: true });

    const isCoarse = () => {
      try {
        return window.matchMedia?.("(pointer: coarse)").matches ?? false;
      } catch {
        return false;
      }
    };
    const tick = () => {
      const ctx = services.engine.context as AudioContext | null;
      setBlocked(!!ctx && ctx.state === "suspended" && isCoarse());
    };
    tick();
    const interval = window.setInterval(tick, 700);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.clearInterval(interval);
    };
  }, [services]);

  if (!blocked) return null;
  return (
    <button
      type="button"
      className="audio-unlock"
      onClick={() => {
        try {
          services.engine.ensureContext();
        } catch {
          /* guidance-level failure — the banner stays honest */
        }
      }}
    >
      🔊 TAP TO ENABLE AUDIO
    </button>
  );
}
