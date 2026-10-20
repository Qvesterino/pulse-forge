import { useEffect, useState } from "react";
import type { ProjectTransferSourceDaw } from "../project-model/types";
import { useServices } from "./context";
import { DAW_ACTION_MAPPINGS, DAW_PROFILE_OPTIONS, readDawProfile, writeDawProfile } from "./dawProfile";
import type { SongStarterHandoff } from "../landing/handoff";

const TOUR_KEY = "pf-tour-v1";
const TRANSFER_TOUR_KEY = "pf-transfer-tour-v1";
const SONG_STARTER_TOUR_KEY = "pf-song-starter-tour-v1";

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
    title: "3/4 — ARRANGE & MIX",
    body: "Switch between PATTERN and SONG in the top bar: build a loop in Pattern, then arrange it on the Song timeline. Ctrl+K searches panels and actions; Ctrl+Z undoes an edit.",
    hint: "Watch the top bar for save status",
  },
  {
    title: "4/4 — SAVE & EXPORT",
    body: "Press Ctrl+S to save now. Open EXPORT for WAV, MP3, video, or a share link.",
    hint: "Your next session starts here",
  },
];

const TRANSFER_STEPS: TourStep[] = [
  {
    title: "1/4 — CHECK THE ARRANGEMENT",
    body: "Your audio lanes start together at bar 1. Play through once and check their alignment before you continue editing.",
    hint: "Your source project stays in its original DAW",
  },
  {
    title: "2/4 — CONTINUE WITH MIDI",
    body: "Imported MIDI becomes editable song clips in the arrangement; use the drum grid to build new patterns. CC7 and CC11 become track-volume automation, CC10 becomes pan, and CC64 sustain extends note lengths.",
    hint: "Other unsupported MIDI data was listed before import",
  },
  {
    title: "3/4 — FIND YOUR NEXT ACTION",
    body: "Open the command palette with Ctrl+K to search for actions such as Mixer, Arrangement, or Export. Use Ctrl+Z to undo an edit.",
    hint: "Your imported audio and MIDI stay in one project",
  },
  {
    title: "4/4 — SAVE AND EXPORT",
    body: "Save this KYX project with Ctrl+S, then open Export to make a WAV, MP3, or stems for your next step.",
    hint: "Continue from your new KYX copy",
  },
];

const SONG_STARTER_STEPS: TourStep[] = [
  {
    title: "1/4 — YOUR LOOPS ARE READY",
    body: "Your selected style and tempo are already applied in Sounds. Narrow the list by mood, instrument, or key.",
    hint: "Choose a loop and preview it",
  },
  {
    title: "2/4 — PREVIEW AND ADD",
    body: "Preview a loop in Sounds, select its destination track above the sequencer, then add it to the arrangement as an editable clip.",
    hint: "Ctrl+Z undoes the last edit",
  },
  {
    title: "3/4 — SAVE AND REOPEN",
    body: "KYX saves as you work. Open Projects to leave the studio, then reopen your song to continue where you left off.",
    hint: "Use Ctrl+S to save now",
  },
  {
    title: "4/4 — EXPORT YOUR SONG",
    body: "Open Export, choose WAV or MP3, and render a file you can play or share outside KYX.",
    hint: "The project stays in your KYX library",
  },
];

const TRANSFER_SOURCE_LABELS: Record<ProjectTransferSourceDaw, string> = {
  "fl-studio": "FL STUDIO TO KYX",
  cubase: "CUBASE TO KYX",
  "pro-tools": "PRO TOOLS TO KYX",
  other: "ANOTHER DAW TO KYX",
};

function tourDone(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return true; // storage blocked — don't nag
  }
}

/** StrictMode double-mounts effects — the tour must be a strict singleton. */
let tourActive = false;

/**
 * First-run onboarding: four steps over the real UI. Transferred projects
 * and guided song starters get a one-time tour for their specific workflow.
 */
export function OnboardingTour({
  sourceDaw,
  songStarter,
}: {
  sourceDaw?: ProjectTransferSourceDaw;
  songStarter?: SongStarterHandoff | null;
}) {
  const services = useServices();
  const [step, setStep] = useState(-1);
  const [preferredSourceDaw, setPreferredSourceDaw] = useState<ProjectTransferSourceDaw | null>(readDawProfile);
  const isTransferProject = sourceDaw !== undefined;
  const isSongStarterProject = !isTransferProject && songStarter != null;
  const profile = sourceDaw ?? preferredSourceDaw;
  const tourKey = isTransferProject ? TRANSFER_TOUR_KEY : isSongStarterProject ? SONG_STARTER_TOUR_KEY : TOUR_KEY;
  const steps = isTransferProject ? TRANSFER_STEPS : isSongStarterProject ? SONG_STARTER_STEPS : STEPS;

  useEffect(() => {
    setStep(-1);
    if (isSongStarterProject) {
      try {
        localStorage.setItem(TOUR_KEY, "1");
      } catch {
        /* the guided starter still has its focused tour for this session */
      }
    }
    if (tourDone(tourKey) || tourActive) return;
    tourActive = true;
    // Wait one beat so the studio chrome settles before the card appears.
    const id = setTimeout(() => setStep(0), 600);
    return () => {
      clearTimeout(id);
      tourActive = false;
    };
  }, [isSongStarterProject, tourKey]);

  const finish = () => {
    try {
      localStorage.setItem(tourKey, "1");
    } catch {
      // storage blocked — hide for this session only
    }
    void services.flushSave();
    setStep(-1);
  };

  if (step < 0) return null;
  const current = steps[step];
  if (!current) return null;
  const profileHint =
    !isTransferProject && profile && step === 2
      ? `Your ${DAW_PROFILE_OPTIONS.find(({ id }) => id === profile)?.label} equivalent is ${DAW_ACTION_MAPPINGS[1]!.familiarTerm[profile]}.`
      : !isTransferProject && profile && step === 3
        ? `You may know this as ${DAW_ACTION_MAPPINGS[2]!.familiarTerm[profile]}.`
        : null;
  const tourTitle =
    isTransferProject && step === 0
      ? `1/4 — ${TRANSFER_SOURCE_LABELS[sourceDaw]}`
      : isSongStarterProject && step === 0
        ? `1/4 — YOUR ${songStarter.genre.toUpperCase()} STARTER`
        : current.title;
  const tourBody =
    isSongStarterProject && step === 0
      ? `Your ${songStarter.genre}${songStarter.mood ? ` · ${songStarter.mood}` : ""} style and ${songStarter.bpm} BPM are already applied. KYX prepares matching loops automatically; watch the pack status, then preview one in Sounds.`
      : current.body;

  return (
    <div className="tour-card" role="dialog" aria-label="Onboarding tour" aria-live="polite">
      <div className="tour-head">
        <span className="tour-brand">KYX</span>
        <button type="button" className="btn btn-small" onClick={finish} aria-label="Skip tour">
          SKIP
        </button>
      </div>
      <h3 className="tour-title">{tourTitle}</h3>
      <p className="tour-body">{tourBody}</p>
      {profileHint && <p className="tour-profile-hint">{profileHint}</p>}
      {!isTransferProject && !isSongStarterProject && step === 0 && (
        <label className="tour-profile-picker">
          Coming from another DAW? <span>Optional</span>
          <select
            aria-label="Previous DAW profile"
            value={preferredSourceDaw ?? ""}
            onChange={(event) => {
              const next = DAW_PROFILE_OPTIONS.some(({ id }) => id === event.currentTarget.value)
                ? (event.currentTarget.value as ProjectTransferSourceDaw)
                : null;
              setPreferredSourceDaw(next);
              writeDawProfile(next);
            }}
          >
            <option value="">Choose later</option>
            {DAW_PROFILE_OPTIONS.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="tour-foot">
        <span className="tour-hint">{current.hint}</span>
        <div className="tour-dots" aria-hidden>
          {steps.map((_, i) => (
            <span key={i} className={`tour-dot${i === step ? " active" : ""}${i < step ? " done" : ""}`} />
          ))}
        </div>
        {step < steps.length - 1 ? (
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
