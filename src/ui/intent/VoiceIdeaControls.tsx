import type { ReactElement } from "react";

/**
 * F4 collaborator — the 🎤 voice-idea controls: hum & harmonize, hear-yourself
 * mic monitoring, and the record button that drives MediaRecorder → analyzeVoiceIdea.
 *
 * Extracted verbatim from IntentPanel. Returns a fragment because these three
 * controls are siblings inside the shell's control row — wrapping them in an
 * element would change the DOM the stylesheet targets.
 *
 * Pure renderer: no recorder, no mic node, no analyser. The shell owns the capture
 * lifecycle; this module only reports the two toggles and forwards the record verb.
 */
export interface VoiceIdeaControlsProps {
  /** SUNO build stacks diatonic backing vocals under the hummed hook. */
  harmonize: boolean;
  onHarmonizeChange: (next: boolean) => void;
  /** Hear yourself through the app — headphones only, speakers feed back. */
  micMonitor: boolean;
  onMicMonitorChange: (next: boolean) => void;
  recording: boolean;
  onToggleRecording: () => void;
  /** Shared with the reference controls — both sit on the reference upload path. */
  disabled: boolean;
}

export function VoiceIdeaControls(props: VoiceIdeaControlsProps): ReactElement {
  const { harmonize, onHarmonizeChange, micMonitor, onMicMonitorChange, recording, onToggleRecording, disabled } =
    props;
  return (
    <>
      <label
        className="intent-monitor-toggle"
        title="Hum & harmonize: the SUNO build stacks diatonic backing vocals (third above + below) under your hummed hook on a 'Hum Harmony' track"
      >
        <input type="checkbox" checked={harmonize} onChange={(event) => onHarmonizeChange(event.target.checked)} />
        🎶
      </label>
      <label
        className="intent-monitor-toggle"
        title="Hear yourself through the app — HEADPHONES ONLY (speakers feed back into the mic)"
      >
        <input type="checkbox" checked={micMonitor} onChange={(event) => onMicMonitorChange(event.target.checked)} />
        🔊
      </label>
      <button
        type="button"
        className={`btn intent-idea-btn${recording ? " recording" : ""}`}
        disabled={disabled}
        onClick={() => onToggleRecording()}
        title="Voice idea — record yourself humming/singing the hook; the beat builds around YOUR tempo, key and melody"
      >
        {recording ? "■ STOP" : "🎤 IDEA"}
      </button>
    </>
  );
}
