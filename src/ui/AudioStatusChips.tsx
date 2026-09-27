import { useCallback, useEffect, useRef, useState } from "react";
import { readStoragePressure, shouldShowSuspendedChip, startDeviceMonitor } from "../services/deviceMonitor";
import { useServices } from "./context";

type Notice = { level: "warn" | "info"; message: string; id: number };

const STORAGE_WARN_AT = 0.85;

/**
 * AUDIO STATUS CHIPS — the studio's "something is off with sound" surface.
 *
 * Three passive chips next to the save status, each answering one question:
 *  - SUSPENDED (amber, actionable): the user pressed play but the
 *    AudioContext cannot run (autoplay policy, sleep wake). Click = resume.
 *  - DEVICE notice (transient, 6 s): output/mic plugged or unplugged — the
 *    browser re-routes silently, we say it out loud.
 *  - STORAGE (persistent until dismissed): IndexedDB is nearly full — the
 *    one failure mode that silently eats saved projects.
 *
 * All three are observers: no engine/DSP changes, zero cost when healthy.
 */
export function AudioStatusChips() {
  const services = useServices();
  const [suspended, setSuspended] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [storagePressure, setStoragePressure] = useState<number | null>(null);
  const [storageDismissed, setStorageDismissed] = useState(() => {
    try {
      return sessionStorage.getItem("pf-storage-warn-dismissed") === "1";
    } catch {
      return false;
    }
  });
  const noticeId = useRef(0);
  const noticeTimer = useRef<number | null>(null);

  const pushNotices = useCallback((messages: Array<{ level: "warn" | "info"; message: string }>) => {
    if (messages.length === 0) return;
    noticeId.current += 1;
    setNotice({ ...messages[0]!, id: noticeId.current });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);

  // ── Wave B: suspended-context chip (poll — the engine owns onstatechange,
  // we must not clobber it; a 1 s state read is free) ──
  useEffect(() => {
    const update = () => {
      try {
        const state = services.engine.getLiveAudioState();
        setSuspended(shouldShowSuspendedChip(state, services.transport.playing));
      } catch {
        /* engine gone mid-swap */
      }
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [services]);

  // ── Wave A: device connect/disconnect monitor ──
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = startDeviceMonitor((messages) => pushNotices(messages));
    } catch {
      /* mediaDevices unavailable */
    }
    return () => unsubscribe?.();
  }, [pushNotices]);

  // ── Wave C: storage pressure check at boot + every 10 min ──
  useEffect(() => {
    const check = () => void readStoragePressure().then((p) => setStoragePressure(p));
    check();
    const interval = window.setInterval(check, 10 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  const resumeAudio = () => {
    try {
      services.engine.ensureContext();
    } catch {
      /* guidance-level failure — the chip stays honest */
    }
  };

  return (
    <>
      {suspended && (
        <button
          type="button"
          className="save-status save-error"
          title="The audio engine is suspended — click to resume (this can happen after sleep or when the browser blocks autoplay)"
          onClick={resumeAudio}
        >
          AUDIO SUSPENDED — CLICK TO RESUME
        </button>
      )}
      {notice && (
        <span
          className={`save-status ${notice.level === "warn" ? "save-error" : "save-dirty"}`}
          role="status"
          aria-live="polite"
        >
          {notice.level === "warn" ? "⚠ " : "＋ "}
          {notice.message}
        </span>
      )}
      {storagePressure !== null && storagePressure >= STORAGE_WARN_AT && !storageDismissed && (
        <button
          type="button"
          className="save-status save-error"
          title="This browser's storage is nearly full — export your project and remove old ones (Projects → Delete), or the autosave will start failing"
          onClick={() => {
            try {
              sessionStorage.setItem("pf-storage-warn-dismissed", "1");
            } catch {
              /* private mode */
            }
            setStorageDismissed(true);
          }}
        >
          ⚠ STORAGE {Math.round(storagePressure * 100)}% FULL — EXPORT & CLEAN
        </button>
      )}
    </>
  );
}
