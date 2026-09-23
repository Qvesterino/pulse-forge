import { useState } from "react";
import type { FormEvent } from "react";
import { applyFxIdea } from "./fxAddAssistant";
import { useServices } from "./context";

type Note = { tone: "ok" | "warn"; text: string };

/**
 * FX INTENT BAR — the persistent idea input in the rack header. One line,
 * always visible (no popover detour): type what the track should sound like,
 * Enter applies the best interpretation through the SAME pipelines as the
 * ✚ ADD FX assistant rows (assistant plan → production concepts) in ONE
 * undoable step.
 */
export function FxIntentBar({ trackId }: { trackId: string }) {
  const services = useServices();
  const [text, setText] = useState("");
  const [note, setNote] = useState<Note | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const outcome = applyFxIdea(services.store.getDoc(), trackId, text);
    if (outcome.kind === "unparsed") {
      setNote({ tone: "warn", text: outcome.message });
      return;
    }
    try {
      services.store.execute(outcome.command);
      setNote({ tone: "ok", text: outcome.summary });
      setText("");
    } catch (error) {
      setNote({ tone: "warn", text: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <form className="fx-intent-bar" onSubmit={submit}>
      <div className="fx-intent-row">
        <span className="fx-intent-glyph" aria-hidden="true">
          ◈
        </span>
        <input
          data-allow-focus=""
          className="fx-intent-input"
          type="text"
          value={text}
          maxLength={500}
          autoComplete="off"
          aria-label="FX idea — popíš zvuk slovami"
          placeholder="čo má tento track spraviť? — teplejšie, more space, wobbly bass…"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="btn btn-small fx-intent-apply" disabled={!text.trim()}>
          Aplikovať
        </button>
      </div>
      {note && (
        <p
          className={`fx-intent-note${note.tone === "warn" ? " fx-intent-note-warn" : ""}`}
          role="status"
          aria-live="polite"
        >
          {note.text}
        </p>
      )}
    </form>
  );
}
