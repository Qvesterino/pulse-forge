import { useEffect, useRef, useState } from "react";
import { useServices } from "./context";

const STORAGE_KEY = "pulse-forge.onboarding.done.v1";

const STEPS = [
  "Press SPACE — this template already makes sound.",
  "Click steps in the grid to change the beat. Drag up/down for velocity.",
  "MIX · FX · ARR · MOD · EXPORT open the bottom panels. Press ? for all shortcuts.",
  "Describe what you want in the INTENT bar and press Ctrl+Enter — the AI builds it.",
  "ARM a track in ARR and press REC — record over the beat.",
] as const;

/** Progress events: each fires when the user does the action a step asks for. */
const PROGRESS_EVENT = "kyx:onboarding-progress";

export type OnboardingProgressKey = "panel-opened" | "intent-generated" | "recorded";

/** A guided song starter replaces the generic first-project hints. */
export function markOnboardingHintComplete(): void {
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    /* private mode — onboarding is still hidden for the current starter */
  }
}

/** Fire-and-forget: the onboarding hint consumes it to advance its step. */
export function notifyOnboardingProgress(key: OnboardingProgressKey): void {
  try {
    window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail: { key } }));
  } catch {
    /* no window (test env) — onboarding just stays on this step */
  }
}

/** Step s advances to s+1 when its own progress event fires. */
const ADVANCE_KEYS: Record<number, OnboardingProgressKey> = { 2: "panel-opened", 3: "intent-generated" };

/**
 * Minimal interactive onboarding (FEATURES.md §146): short hints that advance
 * as the user actually does things. Shown once per browser profile. Steps
 * cover the core journey — transport, grid editing, panels, the AI intent
 * path and recording — and the last one auto-dismisses on a first take.
 */
export function OnboardingHint({ disabled = false }: { disabled?: boolean }) {
  const services = useServices();
  const [step, setStep] = useState<number>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ? STEPS.length : 0;
    } catch {
      return STEPS.length;
    }
  });
  const initialDoc = useRef(services.store.doc);
  const dismissRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (disabled || step !== 0) return;
    const timer = setInterval(() => {
      if (services.transport.playing) setStep(1);
    }, 250);
    return () => clearInterval(timer);
  }, [disabled, step, services]);

  useEffect(() => {
    if (disabled || step !== 1) return;
    return services.store.subscribe(() => {
      if (services.store.doc !== initialDoc.current) setStep(2);
    });
  }, [disabled, step, services]);

  // Middle steps advance on progress events fired where the action happens
  // (panel open, intent generate). Each step listens only for its own key.
  useEffect(() => {
    const advanceKey = ADVANCE_KEYS[step];
    if (disabled || !advanceKey) return;
    const advance = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === advanceKey) setStep(step + 1);
    };
    window.addEventListener(PROGRESS_EVENT, advance);
    return () => window.removeEventListener(PROGRESS_EVENT, advance);
  }, [disabled, step]);

  // Final step auto-dismisses when the user records their first take —
  // the journey is complete.
  useEffect(() => {
    if (disabled || step !== STEPS.length - 1) return;
    const onRecorded = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === "recorded") dismissRef.current();
    };
    window.addEventListener(PROGRESS_EVENT, onRecorded);
    return () => window.removeEventListener(PROGRESS_EVENT, onRecorded);
  }, [disabled, step]);

  const dismiss = () => {
    markOnboardingHintComplete();
    setStep(STEPS.length);
  };
  dismissRef.current = dismiss;

  if (disabled || step >= STEPS.length) return null;

  return (
    <div className="onboarding" role="status">
      <span className="onboarding-step">{`${step + 1}/${STEPS.length}`}</span>
      <span className="onboarding-text">{STEPS[step]}</span>
      {step === STEPS.length - 1 ? (
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
