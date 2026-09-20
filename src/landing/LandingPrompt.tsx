import { useEffect, useMemo, useRef, useState } from "react";
import { EmbedApp } from "../embed/EmbedApp";
import { encodeShareCode } from "../export/shareCode";
import { createProjectFromTemplate } from "../project-model/templates";
import { generateLandingBeat } from "./landingBeat";
import { savePendingHandoff } from "./handoff";
import { funnelEvent, funnelTiming } from "../services/funnel";

const PROMPT_CHIPS = ["dark trap 140", "deep house 124", "hard techno 145", "lo-fi chill 85", "uk garage 133"];

type ForgePhase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ready"; code: string }
  | { kind: "error"; message: string };

/**
 * The landing hero prompt (viral growth plan A1): describe a beat, forge it
 * with the real intent engine in this tab, hear it through the real offline
 * renderer, carry it into the studio.
 *
 * Audio policy: NOTHING plays by itself — generation renders silently and
 * the preview player waits for the user's play click (autoplay-safe). The
 * Forge click is the user gesture that may create the AudioContext later.
 */
export function LandingPrompt({ onEnterStudio }: { onEnterStudio: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<ForgePhase>({ kind: "idle" });
  const [demoUntilForge, setDemoUntilForge] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Fáza C — TTFB measurement: the budgets (forge→sound < 5 s warm, < 10 s
  // cold) are only real if they are measured. Anchor = each Forge click.
  const forgeStartRef = useRef(0);

  useEffect(() => {
    // A superseding forge (or unmount) cancels the in-flight generation;
    // its continuation must not touch state afterwards.
    return () => abortRef.current?.abort();
  }, []);

  const forge = async (rawPrompt: string) => {
    const text = rawPrompt.trim();
    if (!text || phase.kind === "busy") return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    forgeStartRef.current = performance.now();
    setPhase({ kind: "busy" });
    try {
      const beat = await generateLandingBeat(text, controller.signal);
      if (controller.signal.aborted) return;
      funnelEvent("landing_prompt_forged");
      funnelTiming("landing_forge_generate_ms", performance.now() - forgeStartRef.current);
      setPhase({ kind: "ready", code: encodeShareCode(beat.doc) });
      setDemoUntilForge(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const openInStudio = () => {
    if (phase.kind !== "ready") return;
    // Handoff first, then enter — Boot reads sessionStorage right after.
    savePendingHandoff({ code: phase.code, prompt: prompt.trim() });
    funnelEvent("landing_forged_to_studio");
    onEnterStudio();
  };

  return (
    <div className="landing-prompt" aria-label="Describe your beat">
      <form
        className="landing-prompt-row"
        onSubmit={(event) => {
          event.preventDefault();
          void forge(prompt);
        }}
      >
        <input
          ref={inputRef}
          className="landing-prompt-input"
          type="text"
          value={prompt}
          maxLength={120}
          placeholder="Describe your beat — e.g. dark trap 140"
          aria-label="Describe the beat you want"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          type="submit"
          className="landing-btn landing-btn-primary landing-forge-btn"
          disabled={!prompt.trim() || phase.kind === "busy"}
        >
          {phase.kind === "busy" ? "Forging…" : "Forge it"}
        </button>
      </form>

      <div className="landing-prompt-chips" aria-label="Prompt ideas">
        {PROMPT_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="landing-chip"
            disabled={phase.kind === "busy"}
            onClick={() => {
              setPrompt(chip);
              inputRef.current?.focus();
            }}
          >
            {chip}
          </button>
        ))}
      </div>

      <div className="landing-prompt-result">
        {phase.kind === "idle" && demoUntilForge && (
          <>
            <p className="landing-prompt-hint">Or press play to hear a demo — then type your own and forge it.</p>
            {/* Block-level player: must NOT sit inside the <p> above (invalid
                div-in-p nesting trips React's validateDOMNesting warning). */}
            <span className="landing-hero-player landing-prompt-demo">
              <DemoPlayer />
            </span>
          </>
        )}
        {phase.kind === "busy" && <p className="landing-prompt-hint">Composing your beat…</p>}
        {phase.kind === "error" && (
          <p className="landing-prompt-error" role="alert">
            Generation failed: {phase.message} — try another prompt.
          </p>
        )}
        {phase.kind === "ready" && (
          <>
            <span className="landing-hero-player">
              <EmbedApp
                code={phase.code}
                inline
                hideBrand
                onPlayed={() => {
                  funnelEvent("landing_prompt_played");
                  // TTFB: click→sound for THIS forge, and time-to-first-sound
                  // relative to page load (the conversion budget number).
                  if (forgeStartRef.current > 0) {
                    funnelTiming("landing_forge_to_sound_ms", performance.now() - forgeStartRef.current);
                  }
                  funnelTiming("landing_first_sound_ms", performance.now());
                }}
              />
            </span>
            <div className="landing-prompt-actions">
              <button type="button" className="landing-btn landing-btn-primary" onClick={openInStudio}>
                Open in studio →
              </button>
              <button
                type="button"
                className="landing-btn landing-btn-ghost"
                onClick={() => void forge(prompt)}
              >
                Forge another
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The pre-forge demo — same house template hero player as before. */
function DemoPlayer() {
  // Sync: the template import is already in this chunk's graph (landingBeat),
  // so the demo player paints in the first commit — no late flash.
  const code = useMemo(() => encodeShareCode(createProjectFromTemplate("house")), []);
  return <EmbedApp code={code} inline hideBrand />;
}
