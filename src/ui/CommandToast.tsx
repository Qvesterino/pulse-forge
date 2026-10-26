import { useEffect, useState } from "react";
import { useServices } from "./context";

/**
 * Brief, transient acknowledgement of the most recent command.
 * Reads lastCommandLabel from ProjectStore. Fades after 1.4 s.
 *
 * It also carries the store's NOTICE — "you asked for something and there
 * was nothing to do". Audit S-5: after a reload the undo history starts
 * empty, and Ctrl+Z used to vanish without a word, which reads as a broken
 * app rather than as an empty history. The notice has its own dedupe key
 * (its id), because the undo stack's length does not change when an undo did
 * nothing.
 *
 * No user controls — pure visual feedback. Lives next to the status bar.
 */
export function CommandToast() {
  const services = useServices();
  const [label, setLabel] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Use the undo stack length as the dedupe key so consecutive identical
    // commands (e.g. two "+1 step" presses) still trigger the toast.
    let lastSeen = -1;
    let lastNoticeId = -1;
    const unsubscribe = services.store.subscribe(() => {
      const notice = services.store.notice;
      if (notice != null && notice.id !== lastNoticeId) {
        lastNoticeId = notice.id;
        setLabel(notice.text);
        setDetail(notice.detail);
        setVisible(true);
        return;
      }
      const current = services.store.lastCommandLabel;
      const count = services.store.undoStackLength;
      if (current && count !== lastSeen) {
        lastSeen = count;
        setLabel(current);
        setDetail(services.store.lastCommandDetail);
        setVisible(true);
      } else if (!current) {
        lastSeen = -1;
      }
    });
    return unsubscribe;
  }, [services]);

  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => setVisible(false), 1400);
    return () => clearTimeout(id);
  }, [visible, label]);

  if (!label) return null;
  return (
    <div
      className={`command-toast${visible ? " visible" : ""}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      title="Last command"
    >
      {label}
      {detail && <span className="command-toast-detail">{detail}</span>}
    </div>
  );
}
