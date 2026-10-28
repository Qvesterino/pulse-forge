import type { ProjectTransferSourceDaw } from "../project-model/types";
import type { ShortcutKey } from "./shortcuts";

export const DAW_PROFILE_STORAGE_KEY = "pf-daw-profile-v1";

export const DAW_PROFILE_OPTIONS: readonly { id: ProjectTransferSourceDaw; label: string }[] = [
  { id: "fl-studio", label: "FL Studio" },
  { id: "cubase", label: "Cubase" },
  { id: "pro-tools", label: "Pro Tools" },
  { id: "other", label: "Another DAW" },
];

export interface DawActionMapping {
  id: "phrase" | "arrangement" | "export" | "track-selection" | "audition" | "pattern-record" | "audio-record" | "comp";
  action: string;
  familiarTerm: Record<ProjectTransferSourceDaw, string>;
  kyxTerm: string;
  kyxDetail?: string;
  shortcutKeys?: ShortcutKey[];
}

/** Familiar vocabulary is a bridge to KYX concepts, not a DAW-specific mode. */
export const DAW_ACTION_MAPPINGS: readonly DawActionMapping[] = [
  {
    id: "phrase",
    action: "Make a phrase or loop",
    familiarTerm: {
      "fl-studio": "Pattern / Channel Rack",
      cubase: "MIDI part / Key Editor",
      "pro-tools": "MIDI clip / MIDI Editor",
      other: "phrase or clip",
    },
    kyxTerm: "Pattern",
    shortcutKeys: ["nextPattern", "prevPattern"],
  },
  {
    id: "arrangement",
    action: "Arrange the song",
    familiarTerm: {
      "fl-studio": "Playlist",
      cubase: "Project window",
      "pro-tools": "Edit window",
      other: "song timeline",
    },
    kyxTerm: "Song → Arrangement",
    shortcutKeys: ["panelArr"],
  },
  {
    id: "export",
    action: "Export the mix",
    familiarTerm: {
      "fl-studio": "Render",
      cubase: "Export Audio Mixdown",
      "pro-tools": "Bounce Mix",
      other: "mix export",
    },
    kyxTerm: "Export panel",
    shortcutKeys: ["panelExport"],
  },
  {
    id: "track-selection",
    action: "Select or switch tracks",
    familiarTerm: {
      "fl-studio": "Channel Rack / Playlist track",
      cubase: "Track list",
      "pro-tools": "Track list",
      other: "Track list",
    },
    kyxTerm: "Tracks → Track tabs",
    kyxDetail: "Tab / Shift+Tab moves between tracks; 1–9 selects a track by position.",
    shortcutKeys: [
      "nextTrack",
      "prevTrack",
      "selectTrack1",
      "selectTrack2",
      "selectTrack3",
      "selectTrack4",
      "selectTrack5",
      "selectTrack6",
      "selectTrack7",
      "selectTrack8",
      "selectTrack9",
    ],
  },
  {
    id: "audition",
    action: "Preview a sound in the beat",
    familiarTerm: {
      "fl-studio": "Browser preview",
      cubase: "MediaBay preview",
      "pro-tools": "Workspace preview",
      other: "Sound browser preview",
    },
    kyxTerm: "Sounds → Preview",
    kyxDetail: "Previews immediately while stopped, or on the next beat over the mix during playback.",
  },
  {
    id: "pattern-record",
    action: "Record MIDI into a pattern",
    familiarTerm: {
      "fl-studio": "Step / pattern recording",
      cubase: "MIDI recording",
      "pro-tools": "MIDI track recording",
      other: "MIDI recording",
    },
    kyxTerm: "Top bar → Record MIDI",
    kyxDetail: "Choose overdub or replace; recording quantize is optional.",
  },
  {
    id: "audio-record",
    action: "Record audio on the song timeline",
    familiarTerm: {
      "fl-studio": "Playlist audio recording",
      cubase: "Audio track recording",
      "pro-tools": "Track record-enable",
      other: "Audio track recording",
    },
    kyxTerm: "Song → Arrangement → ● AUDIO REC",
    kyxDetail: "Choose the input, arm a track, then record at the playhead or set a punch range.",
  },
  {
    id: "comp",
    action: "Build a comp from alternate takes",
    familiarTerm: {
      "fl-studio": "Playlist take lanes",
      cubase: "Audio comping",
      "pro-tools": "Playlists / comping",
      other: "Take lanes / comping",
    },
    kyxTerm: "Arrangement → Take Lanes → Comp",
    kyxDetail: "Audition passes, choose a range or request Smart Comp; edits stay undoable.",
  },
];

const PROFILE_IDS = new Set(DAW_PROFILE_OPTIONS.map(({ id }) => id));

export function readDawProfile(): ProjectTransferSourceDaw | null {
  try {
    const value = localStorage.getItem(DAW_PROFILE_STORAGE_KEY);
    return value && PROFILE_IDS.has(value as ProjectTransferSourceDaw) ? (value as ProjectTransferSourceDaw) : null;
  } catch {
    return null;
  }
}

export function writeDawProfile(profile: ProjectTransferSourceDaw | null): boolean {
  try {
    if (profile === null) localStorage.removeItem(DAW_PROFILE_STORAGE_KEY);
    else if (PROFILE_IDS.has(profile)) localStorage.setItem(DAW_PROFILE_STORAGE_KEY, profile);
    else return false;
    return true;
  } catch {
    return false;
  }
}
