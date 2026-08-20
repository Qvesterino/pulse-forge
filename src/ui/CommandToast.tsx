import { useEffect, useState } from "react";
import { useServices } from "./context";

/**
 * Brief, transient acknowledgement of the most recent command.
 * Reads lastCommandLabel from ProjectStore. Fades after 1.4 s.
 *
 * No user controls — pure visual feedback. Lives next to the status bar.
 */
export function CommandToast() {
  const services = useServices();
  const [label, setLabel] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Use the undo stack length as the dedupe key so consecutive identical
    // commands (e.g. two "+1 step" presses) still trigger the toast.
    let lastSeen = -1;
    const unsubscribe = services.store.subscribe(() => {
      const current = services.store.lastCommandLabel;
      const count = services.store.undoStackLength;
      if (current && count !== lastSeen) {
        lastSeen = count;
        setLabel(current);
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
    </div>
  );
}
