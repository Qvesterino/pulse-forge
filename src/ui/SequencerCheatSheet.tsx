import { useEffect } from "react";

/**
 * Sequencer gesture cheat sheet — every hidden drag/key the step sequencer
 * knows, in one dismissible panel anchored over the grid. Scoped to the
 * sequencer (the global "?" help lists app-wide shortcuts).
 */
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "STEPS",
    items: [
      ["click", "toggle step"],
      ["drag →", "paint steps"],
      ["drag ↑↓", "velocity"],
      ["Alt+drag", "microtiming (early/late)"],
      ["Ctrl+drag", "probability"],
      ["cell bottom bar", "amount 0–100% (ghost/accent)"],
      ["right-click / long-press", "p-lock editor (pitch/gain/pan/cutoff)"],
    ],
  },
  {
    title: "SELECT",
    items: [
      ["Shift+drag", "lasso multi-select"],
      ["drag a selection", "move all selected"],
      ["COPY/PASTE LOCKS", "p-lock clipboard"],
    ],
  },
  {
    title: "KEYS — drums",
    items: [
      ["QWERTYU ASDFGHJK", "pads — live play, records with ⏺"],
      ["hold pad + RATE", "note repeat"],
    ],
  },
  {
    title: "KEYS — melodic",
    items: [
      ["A–;", "semitones (C4 base)"],
      ["Z / X", "octave down / up"],
      ["⏺ armed + A–;", "records into the pattern"],
    ],
  },
  {
    title: "PIANO ROLL",
    items: [
      ["STEP", "cursor entry — ←/→ move, ↑/↓ pitch, A–; insert, Del removes"],
      ["Shift+C", "chord stamp at cursor"],
      ["SPLIT / GLUE", "chop / legato"],
      ["QUANT / DUP / DEL", "selection ops"],
    ],
  },
  {
    title: "TRANSPORT",
    items: [
      ["Space", "play / pause"],
      ["ruler click", "seek"],
      ["ruler drag", "loop region"],
      ["Ctrl+wheel", "horizontal zoom"],
      ["⏺ + OVERDUB/REPLACE", "record mode, Q grid, strength"],
      ["L", "loop on/off"],
    ],
  },
  {
    title: "GLOBAL",
    items: [
      ["Ctrl+K", "command palette"],
      ["Ctrl+Z", "undo — a record pass is ONE entry"],
      ["Alt+1–6", "panels"],
      ["?", "full shortcut help"],
    ],
  },
];

export function SequencerCheatSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="cheat-sheet" role="dialog" aria-label="Sequencer gesture cheat sheet">
      <div className="cheat-sheet-header">
        <span className="cheat-sheet-title">GESTURES</span>
        <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close cheat sheet">
          ✕
        </button>
      </div>
      <div className="cheat-sheet-groups">
        {GROUPS.map((group) => (
          <div key={group.title} className="cheat-sheet-group">
            <span className="cheat-sheet-group-title">{group.title}</span>
            {group.items.map(([keys, what]) => (
              <div key={keys} className="cheat-sheet-row">
                <kbd className="cheat-sheet-keys">{keys}</kbd>
                <span className="cheat-sheet-what">{what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
