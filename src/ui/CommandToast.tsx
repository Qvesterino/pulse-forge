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
    let lastSeen: string | null = null;
    const unsubscribe = services.store.subscribe(() => {
      const current = services.store.lastCommandLabel;
      if (current && current !== lastSeen) {
        lastSeen = current;
        setLabel(current);
        setVisible(true);
      } else if (!current) {
        lastSeen = null;
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
