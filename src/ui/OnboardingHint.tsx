import { useEffect, useRef, useState } from "react";
import { useServices } from "./context";

const STORAGE_KEY = "***";

const STEPS = [
  "Press SPACE — this template already makes sound.",
  "Click steps in the grid to change the beat. Drag up/down for velocity.",
  "MIX · FX · ARR · MOD · EXPORT open the bottom panels. Press ? for all shortcuts.",
] as const;

/**
 * Minimal interactive onboarding (FEATURES.md §146): three short hints that
 * advance as the user actually does things. Shown once per browser profile.
 */
export function OnboardingHint() {
  const services = useServices();
  const [step, setStep] = useState<number>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ? STEPS.length : 0;
    } catch {
      return STEPS.length;
    }
  });
  const initialDoc = useRef(services.store.doc);

  useEffect(() => {
    if (step !== 0) return;
    const timer = setInterval(() => {
      if (services.transport.playing) setStep(1);
    }, 250);
    return () => clearInterval(timer);
  }, [step, services]);

  useEffect(() => {
    if (step !== 1) return;
    return services.store.subscribe(() => {
      if (services.store.doc !== initialDoc.current) setStep(2);
    });
  }, [step, services]);

  if (step >= STEPS.length) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      /* private mode — onboarding just won't persist */
    }
    setStep(STEPS.length);
  };

  return (
    <div className="onboarding" role="status">
      <span className="onboarding-step">{`${step + 1}/${STEPS.length}`}</span>
      <span className="onboarding-text">{STEPS[step]}</span>
      {step === 2 ? (
        <button type="button" className="btn btn-ghost onboarding-done" onClick={dismiss}>
          DONE
        </button>
      ) : (
        <button type="button" className="onboarding-skip" onClick={dismiss} aria-label="Dismiss onboarding">
          ×
        </button>
      )}
    </div>
  );
}
