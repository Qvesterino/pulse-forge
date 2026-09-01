import { useEffect, useState } from "react";
import { useServices } from "./context";

const TOUR_KEY = "pf-tour-v1";

interface TourStep {
  title: string;
  body: string;
  hint: string;
}

const STEPS: TourStep[] = [
  {
    title: "1/4 — MAKE SOUND",
    body: "Click any pad in the rack on the left. Each pad is one drum sound — kick, snare, hats.",
    hint: "Try it, then click NEXT",
  },
  {
    title: "2/4 — PROGRAM THE BEAT",
    body: "The grid on the right is your sequencer. Click steps to toggle them, drag vertically for velocity.",
    hint: "16 steps = 1 bar",
  },
  {
    title: "3/4 — SHAPE THE MIX",
    body: "ASSIST proposes patterns and mix moves. SLICE LAB chops any MP3 onto pads. Every action is undoable.",
    hint: "Ctrl+Z always works",
  },
  {
    title: "4/4 — FORGE & SHARE",
    body: "EXPORT gives you MP3, WAV, video or a share link that opens the whole project anywhere.",
    hint: "Welcome to the forge",
  },
];

function tourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === "1";
  } catch {
    return true; // storage blocked — don't nag
  }
}

/** StrictMode double-mounts effects — the tour must be a strict singleton. */
let tourActive = false;

/**
 * First-run onboarding: four steps over the real UI. Shows once per
 * browser (pf-tour-v1), skippable at any point.
 */
export function OnboardingTour() {
  const services = useServices();
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (tourDone() || tourActive) return;
    tourActive = true;
    // Wait one beat so the studio chrome settles before the card appears.
    const id = setTimeout(() => setStep(0), 600);
    return () => {
      clearTimeout(id);
      tourActive = false;
    };
  }, []);

  const finish = () => {
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch {
      // storage blocked — hide for this session only
    }
    void services.flushSave();
    setStep(-1);
  };

  if (step < 0) return null;
  const current = STEPS[step];

  return (
    <div className="tour-card" role="dialog" aria-label="Onboarding tour" aria-live="polite">
      <div className="tour-head">
        <span className="tour-brand">PF</span>
        <button type="button" className="btn btn-small" onClick={finish} aria-label="Skip tour">
          SKIP
        </button>
      </div>
      <h3 className="tour-title">{current.title}</h3>
      <p className="tour-body">{current.body}</p>
      <div className="tour-foot">
        <span className="tour-hint">{current.hint}</span>
        <div className="tour-dots" aria-hidden>
          {STEPS.map((_, i) => (
            <span key={i} className={`tour-dot${i === step ? " active" : ""}${i < step ? " done" : ""}`} />
          ))}
        </div>
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn btn-small btn-export" onClick={() => setStep((s) => s + 1)}>
            NEXT
          </button>
        ) : (
          <button type="button" className="btn btn-small btn-export" onClick={finish}>
            LET'S FORGE
          </button>
        )}
      </div>
    </div>
  );
}
