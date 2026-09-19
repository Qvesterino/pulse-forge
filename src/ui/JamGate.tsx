import { useEffect, useRef, useState } from "react";
import type { Services } from "../services";

/**
 * TAP TO JAM — the autoplay-policy moment of Instant Jam.
 *
 * A joiner opening a jam link lands with a SUSPENDED AudioContext (browsers
 * only allow audio after a user gesture). Until they tap, the room is
 * silent and the whole "open link → hear music → play" chain breaks. This
 * full-screen gate is that one deliberate gesture: it resumes the context,
 * re-anchors the transport to the last received pulse (the leader's NOW),
 * and steps out of the way.
 *
 * Shows only on jam boots (?collab= in the URL) while the context is not
 * running; a running context (headless checks, already-resumed sessions)
 * never sees it.
 */
export function JamGate({ services, jamActive }: { services: Services; jamActive: boolean }) {
  const [audioLive, setAudioLive] = useState(true);
  const [tapped, setTapped] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!jamActive) return;
    const check = () => {
      const state = services.engine.context?.state;
      setAudioLive(state === "running");
    };
    check();
    const id = window.setInterval(check, 400);
    return () => window.clearInterval(id);
  }, [services, jamActive]);

  if (!jamActive || audioLive || tapped) return null;

  const tap = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      // The tap IS the user gesture: ensureContext's best-effort resume
      // succeeds now, and the pulse re-anchor drops the joiner into the
      // leader's timeline immediately.
      const ctx = services.engine.ensureContext() as AudioContext | undefined;
      if (ctx && ctx.state === "suspended") await ctx.resume().catch(() => {});
      services.sharedTransportReapply?.();
      setTapped(true);
    } catch {
      // A failed unlock (no AudioContext support, engine teardown mid-tap)
      // keeps the gate up — the user can simply tap again. Never let the
      // gesture handler produce an unhandled rejection.
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="jam-gate" role="button" aria-label="Tap to join the live jam" onPointerDown={() => void tap()}>
      <div className="jam-gate-inner">
        <span className="jam-gate-badge">LIVE JAM</span>
        <span className="jam-gate-title">TAP TO JAM</span>
        <span className="jam-gate-sub">the beat is loaded and the room is live — one tap and you're in</span>
      </div>
    </div>
  );
}
