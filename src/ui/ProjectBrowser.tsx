import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { CoreServices } from "../services";
import type { IncompatibleProjectMeta, SavedProjectMeta } from "../persistence/ProjectRepository";
import type { CrashJournalReport } from "../persistence/crashJournal";
import type { ProjectDocument } from "../project-model/types";
import { ticksPerBar } from "../project-model/schema";
import { TEMPLATES, createProjectFromTemplate } from "../project-model/templates";
import type { TemplateId } from "../project-model/templates";
import { stashIntentPrefill, stashSongStarter } from "../landing/handoff";
import {
  clearRecoveryBuffer,
  isBufferWorthOffering,
  readRecoveryBuffer,
  type RecoveryBuffer,
} from "../persistence/recoveryBuffer";
import { uid } from "../shared/ids";
import { appUrl } from "../shared/mountBase";
import { addAudioClip, fittedLoopPlacement } from "../commands/commands";
import { UserSampleRepository } from "../persistence/UserSampleRepository";
import { installKyxStarterLoops } from "../sample-library/kyx-starter-loops";

const TransferImportDialog = lazy(() =>
  import("./TransferImportDialog").then((module) => ({ default: module.TransferImportDialog })),
);
const TransferCapabilityCard = lazy(() =>
  import("./TransferCapabilityCard").then((module) => ({ default: module.TransferCapabilityCard })),
);

/** One row of the library: openable, or written by a newer app version. */
type ProjectRow = { kind: "ok"; meta: SavedProjectMeta } | { kind: "newer"; meta: IncompatibleProjectMeta };

const STARTER_LOOP_GENRES = new Set<TemplateId>(["house", "techno", "ukg", "trap"]);
const SONG_STARTER_TEMPLATES = TEMPLATES.filter((template) => STARTER_LOOP_GENRES.has(template.id));
const SONG_STARTER_MOODS: Partial<Record<TemplateId, string[]>> = {
  house: ["deep", "warm"],
  techno: ["aggressive", "dark"],
  ukg: ["bright", "warm"],
  trap: ["dark", "deep"],
};

const LOOP_DEMOS = {
  house: {
    template: "house" as const,
    name: "KYX Demo — Afterhours House",
    bpm: 124,
    instrumentTrack: "Chords",
    loops: ["kyx.loop.v1.house.midnight-drums", "kyx.loop.v1.house.afterhours-keys"],
  },
  trap: {
    template: "trap" as const,
    name: "KYX Demo — Half-Time Trap",
    bpm: 140,
    instrumentTrack: "808 Sub",
    loops: ["kyx.loop.v1.trap.half-time-drums", "kyx.loop.v1.trap.soft-808"],
  },
} as const;

const mergeRows = (openable: SavedProjectMeta[], newer: IncompatibleProjectMeta[]): ProjectRow[] =>
  [
    ...openable.map((meta): ProjectRow => ({ kind: "ok", meta })),
    ...newer.map((meta): ProjectRow => ({ kind: "newer", meta })),
  ].sort((a, b) => (a.meta.updatedAt < b.meta.updatedAt ? 1 : -1));

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}

function formatTransferSource(source: NonNullable<SavedProjectMeta["transferOrigin"]>["sourceDaw"]): string {
  switch (source) {
    case "fl-studio":
      return "FL Studio";
    case "cubase":
      return "Cubase";
    case "pro-tools":
      return "Pro Tools";
    case "other":
      return "WAV + MIDI";
  }
}

export function ProjectBrowser({ core, onOpen }: { core: CoreServices; onOpen: (doc: ProjectDocument) => void }) {
  const [projects, setProjects] = useState<SavedProjectMeta[] | null>(null);
  const [newerProjects, setNewerProjects] = useState<IncompatibleProjectMeta[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [crashReport, setCrashReport] = useState<CrashJournalReport | null>(null);
  const [crashDismissed, setCrashDismissed] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryBuffer | null>(null);
  const [transferImportOpen, setTransferImportOpen] = useState(false);
  const [songStarterGenre, setSongStarterGenre] = useState<TemplateId>("house");
  const [songStarterMood, setSongStarterMood] = useState("all");
  const [songStarterBpm, setSongStarterBpm] = useState("124");
  const [demoProgress, setDemoProgress] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const applyLists = useCallback((list: SavedProjectMeta[], newer: IncompatibleProjectMeta[]) => {
    setListError(null);
    setProjects(list);
    setNewerProjects(newer);
  }, []);

  const fetchLists = useCallback(async (): Promise<void> => {
    // Newer-version rows are additive — if that probe fails, still show the
    // openable library rather than blocking on it.
    const newer = await core.repo.listIncompatible().catch((err) => {
      console.warn("[ProjectBrowser] incompatible project list failed:", err);
      return [] as IncompatibleProjectMeta[];
    });
    applyLists(await core.repo.listAll(), newer);
  }, [core, applyLists]);

  const refresh = useCallback(() => {
    fetchLists().catch((err) => {
      // A blocked/corrupted/unavailable DB must not masquerade as a
      // first-run machine — the user would believe their projects are
      // gone and start over. Show the storage failure instead.
      console.error("[ProjectBrowser] project list failed:", err);
      setListError(err instanceof Error ? err.message : "Storage is unavailable");
      setProjects([]);
      setNewerProjects([]);
    });
  }, [fetchLists]);

  useEffect(() => {
    let cancelled = false;
    fetchLists()
      .then(() => {
        if (cancelled) return;
        setListError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // A blocked/corrupted/unavailable DB must not masquerade as a
        // first-run machine - the user would believe their projects are
        // gone and start over. Show the storage failure instead.
        console.error("[ProjectBrowser] project list failed:", err);
        setListError(err instanceof Error ? err.message : "Storage is unavailable");
        setProjects([]);
        setNewerProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchLists]);

  // IndexedDB failures (quota, private browsing, corrupted record) would
  // otherwise surface only as unhandled rejections while the UI sits dead.
  const guard = (action: () => Promise<void>): Promise<void> =>
    action().catch((err) => {
      console.error("[ProjectBrowser] action failed:", err);
      setActionError(err instanceof Error ? err.message : "Storage operation failed");
    });

  /** Blur any focused element before the studio mounts — otherwise the
   *  browser activates the focused button on Space instead of play. */
  const enterStudio = (doc: ProjectDocument) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    onOpen(doc);
  };

  const openById = (id: string) => {
    if (busy) return;
    setBusy(true);
    void guard(async () => {
      try {
        const doc = await core.repo.load(id);
        if (doc) enterStudio(doc);
        else setActionError("This project could not be opened — its data may be from a newer app version.");
      } finally {
        setBusy(false);
      }
    });
  };

  const openMostRecent = () => {
    if (busy) return;
    setBusy(true);
    void guard(async () => {
      try {
        const doc = await core.repo.loadMostRecent();
        if (doc) enterStudio(doc);
      } finally {
        setBusy(false);
      }
    });
  };

  const createFromTemplate = (id: TemplateId) => {
    if (busy) return;
    setBusy(true);
    void guard(async () => {
      try {
        const doc = createProjectFromTemplate(id);
        await core.repo.save(doc);
        enterStudio(doc);
      } finally {
        setBusy(false);
      }
    });
  };

  const createSongStarter = () => {
    if (busy) return;
    const template = SONG_STARTER_TEMPLATES.find((candidate) => candidate.id === songStarterGenre);
    const parsedBpm = Number(songStarterBpm);
    if (!template || !Number.isFinite(parsedBpm) || parsedBpm < 40 || parsedBpm > 240) {
      setActionError("Choose a genre and a tempo from 40 to 240 BPM.");
      return;
    }

    setBusy(true);
    setActionError(null);
    void guard(async () => {
      try {
        const bpm = Math.round(parsedBpm * 10) / 10;
        const mood = songStarterMood === "all" ? null : songStarterMood;
        const doc = createProjectFromTemplate(template.id);
        doc.name = `${template.name} Song Starter`;
        doc.bpm = bpm;
        await core.repo.save(doc);
        stashIntentPrefill(
          `Create a full ${template.name} song${mood ? ` with a ${mood} mood` : ""} at ${bpm} BPM. Include an intro, build, drop, break, final drop, and outro.`,
        );
        stashSongStarter({ genre: template.name, mood, bpm });
        enterStudio(doc);
      } finally {
        setBusy(false);
      }
    });
  };

  const createLoopDemo = (kind: keyof typeof LOOP_DEMOS) => {
    if (busy) return;
    const demo = LOOP_DEMOS[kind];
    setBusy(true);
    setActionError(null);
    setDemoProgress("Preparing original KYX loop pack…");
    void guard(async () => {
      try {
        await core.initialSampleBankHydration;
        const userSamples = new UserSampleRepository();
        await installKyxStarterLoops(core.bank, userSamples, {
          onProgress: ({ completed, total, name }) => setDemoProgress(`Installing ${completed}/${total} · ${name}`),
        });
        const assets = await userSamples.list();
        let doc = createProjectFromTemplate(demo.template);
        doc.name = demo.name;
        doc.bpm = demo.bpm;
        // The templates keep their editable patterns and scenes, while the
        // arrangement starts with the two ready-to-play pack clips.
        doc.arrangement = { ...doc.arrangement, clips: [], audioClips: [] };
        const drumTrack = doc.tracks.find((track) => track.kind === "drum");
        const instrumentTrack = doc.tracks.find(
          (track) => track.kind === "instrument" && track.name === demo.instrumentTrack,
        );
        if (!drumTrack || !instrumentTrack) throw new Error(`The ${kind} demo template is missing a required track.`);
        const targetTracks = [drumTrack, instrumentTrack];
        for (const [index, bufferId] of demo.loops.entries()) {
          const asset = assets.find((candidate) => candidate.id === bufferId);
          const track = targetTracks[index];
          if (!asset || !track) throw new Error(`A loop for the ${kind} demo could not be installed.`);
          const placement = fittedLoopPlacement(asset.duration, asset.bpm, demo.bpm, ticksPerBar(doc));
          if (!placement) throw new Error(`${asset.name} does not contain valid loop timing information.`);
          doc = addAudioClip(doc, track.id, asset.id, 0, placement.lengthBars, {
            stretchMode: "stretch",
            stretchRate: placement.rate,
          }).execute(doc);
        }
        await core.repo.save(doc);
        enterStudio(doc);
      } finally {
        setBusy(false);
        setDemoProgress(null);
      }
    });
  };

  const handleImportFile = async (file: File) => {
    if (busy) return;
    setBusy(true);
    setImportError(null);
    try {
      const [{ importPortableProjectFile, installPortableProjectAssets }, { FrozenBufferRepository }] =
        await Promise.all([import("../export/portable-project"), import("../persistence/FrozenBufferRepository")]);
      const bundle = await importPortableProjectFile(file);
      const installedAssets = await installPortableProjectAssets(
        bundle,
        core.bank,
        new UserSampleRepository(),
        new FrozenBufferRepository(),
      );
      // Save under a FRESH id: the file embeds its original id, and saving
      // with it would silently overwrite an existing library project with
      // the same id (matching the comment's intent — and repo.save is a
      // keyPath put).
      const imported: ProjectDocument = { ...installedAssets.doc, id: uid("project") };
      let saved = false;
      try {
        await core.repo.save(imported);
        saved = true;
        onOpen(imported);
      } catch (error) {
        if (!saved) await installedAssets.rollback();
        throw error;
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const duplicate = (id: string) =>
    guard(async () => {
      await core.repo.duplicate(id);
      refresh();
    });

  const startRename = (meta: SavedProjectMeta) => {
    setRenamingId(meta.id);
    setRenameValue(meta.name);
    setConfirmDeleteId(null);
  };

  const commitRename = (id: string) =>
    guard(async () => {
      await core.repo.rename(id, renameValue);
      setRenamingId(null);
      refresh();
    });

  const remove = (id: string) =>
    guard(async () => {
      await core.repo.delete(id);
      setConfirmDeleteId(null);
      refresh();
    });

  // Crash journal probe: did the PREVIOUS session end unexpectedly? The
  // journal is best-effort telemetry — a failed read just means no banner.
  useEffect(() => {
    let cancelled = false;
    core.crashJournal
      .read()
      .then((report) => {
        if (!cancelled) setCrashReport(report);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [core]);

  // D20 recovery buffer: the unload save flush does not commit, so a session
  // closed with uncommitted edits left them only in a synchronous localStorage
  // buffer. Offer them back — but ONLY while the buffer is newer than the saved
  // project, so this can never downgrade work that has since been saved.
  useEffect(() => {
    if (projects === null) return;
    const buffer = readRecoveryBuffer();
    if (!buffer) {
      setRecovery(null);
      return;
    }
    const saved = projects.find((meta) => meta.id === buffer.projectId) ?? null;
    if (!isBufferWorthOffering(buffer, saved?.updatedAt ?? null)) {
      clearRecoveryBuffer();
      setRecovery(null);
      return;
    }
    setRecovery(buffer);
  }, [projects]);

  const recover = (buffer: RecoveryBuffer) =>
    guard(async () => {
      const doc = buffer.doc as ProjectDocument;
      // Commit the recovered document under its own id so "Recover" is a real
      // save, not a one-shot view: a second crash keeps the work.
      await core.repo.save(doc);
      clearRecoveryBuffer();
      setRecovery(null);
      refresh();
      enterStudio(doc);
    });

  const dismissRecovery = () => {
    clearRecoveryBuffer();
    setRecovery(null);
  };

  const firstRun = !listError && projects !== null && projects.length === 0 && newerProjects.length === 0;
  const rows = projects === null ? null : mergeRows(projects, newerProjects);
  const latest = projects !== null && projects.length > 0 ? projects[0] : null;
  const songStarterMoods = SONG_STARTER_MOODS[songStarterGenre] ?? [];

  return (
    <div className="project-browser">
      <header className="pb-header">
        {/* DAW convention: the logo always leads home — /?landing shows the
            KYX landing page even for returning users (main.tsx Entry). */}
        <a
          className="brand"
          href={appUrl("/?landing")}
          title="KYX — landing page"
          aria-label="KYX — go to landing page"
        >
          <span className="brand-mark">KX</span>
          <span className="brand-name">KYX</span>
        </a>
        <span className="pb-tagline">beat &amp; scene-score workstation</span>
      </header>

      <div className="pb-body">
        {recovery !== null && (
          <div className="pb-crash-banner" role="alert">
            <span className="pb-crash-text">
              Uncommitted changes were found from your last session ({formatRelative(recovery.savedAt)}). The tab closed
              before KYX could save them — recover them?
            </span>
            <button type="button" className="pb-crash-dismiss" onClick={() => recover(recovery)}>
              Recover
            </button>
            <button type="button" className="pb-crash-dismiss" onClick={dismissRecovery}>
              Discard
            </button>
          </div>
        )}
        {crashReport !== null && !crashReport.lastSessionClean && !crashDismissed && (
          <div className="pb-crash-banner" role="alert">
            <span className="pb-crash-text">
              {/* "crash or force-quit" was a claim the app cannot support. `session-close`
                  is only written by the in-app back button, and an IndexedDB
                  write dispatched from `pagehide` never commits (editor audit
                  D20) — so this banner fires on every ordinary tab close, link
                  and refresh. Telling those users their work may be missing
                  trains them to ignore the one warning that would matter.
                  Say what is actually known: the session did not end cleanly. */}
              The last session did not end through KYX{"'"}s normal shutdown — you may have closed the tab or followed a
              link, or the app may have been interrupted.
              {crashReport.lastSaveOk
                ? ` Last completed save: ${formatRelative(crashReport.lastSaveOk.t)} — check the project for missing edits.`
                : " No completed save was recorded."}
            </span>
            <button
              type="button"
              className="pb-crash-dismiss"
              onClick={() => setCrashDismissed(true)}
              aria-label="Dismiss crash notice"
            >
              Dismiss
            </button>
          </div>
        )}
        {actionError && (
          <p className="pb-import-error" role="alert">
            {actionError}
          </p>
        )}
        {latest && (
          <section className="pb-continue">
            <button type="button" className="pb-continue-card" onClick={() => void openMostRecent()} disabled={busy}>
              <span className="pb-continue-label">CONTINUE LAST PROJECT</span>
              <span className="pb-continue-name">{latest.name}</span>
              <span className="pb-continue-meta">
                {latest.bpm} BPM · {latest.trackCount} tracks
                {latest.transferOrigin && ` · imported from ${formatTransferSource(latest.transferOrigin.sourceDaw)}`} ·
                saved {formatRelative(latest.updatedAt)}
              </span>
            </button>
          </section>
        )}

        <details className="pb-secondary-disclosure pb-import-disclosure" open={!firstRun}>
          <summary className="pb-title">
            {firstRun ? "ALREADY HAVE A PROJECT? IMPORT OR TRANSFER IT" : "IMPORT PROJECT"}
          </summary>
          {firstRun && (
            <Suspense fallback={<div className="panel-loading">Loading transfer guide…</div>}>
              <TransferCapabilityCard onStartTransfer={() => setTransferImportOpen(true)} />
            </Suspense>
          )}
          <section className="pb-section pb-import-contents">
            <input
              ref={fileInputRef}
              type="file"
              // No accept filter — the importer is shape-based and accepts
              // legacy sessions regardless of extension; the literal legacy
              // brand token must not ship in the bundle (release preflight).
              accept=".kyxpack,.kyx,.json,application/zip,application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              IMPORT FROM FILE
            </button>
            {!firstRun && (
              <button
                type="button"
                className="btn btn-small btn-primary pb-bring-song"
                disabled={busy}
                onClick={() => setTransferImportOpen(true)}
              >
                BRING A SONG FROM ANOTHER DAW
              </button>
            )}
            <p className="pb-import-hint">
              Portable .kyxpack files include their audio. Legacy .kyx and .json files contain project data only. Use
              Bring a Song for aligned audio track-outs and MIDI from another DAW.
            </p>
            {importError && <span className="pb-import-error">{importError}</span>}
          </section>
        </details>

        <section className="pb-section">
          <h2 className="pb-title">NEW PROJECT</h2>
          {firstRun && (
            <p className="pb-first-run">Choose a style and KYX will prepare matching loops in your new song.</p>
          )}
          <div className="pb-song-starter" aria-label="Guided song starter">
            <div className="pb-song-starter-copy">
              <strong>START A SONG</strong>
              <span>Choose a style with matching loops. KYX prepares them and filters the library for your song.</span>
            </div>
            <div className="pb-song-starter-fields">
              <label>
                <span>GENRE</span>
                <select
                  aria-label="Song starter genre"
                  value={songStarterGenre}
                  disabled={busy}
                  onChange={(event) => {
                    const next = SONG_STARTER_TEMPLATES.find((template) => template.id === event.target.value);
                    if (!next) return;
                    setSongStarterGenre(next.id);
                    setSongStarterBpm(String(next.bpm));
                    if (songStarterMood !== "all" && !(SONG_STARTER_MOODS[next.id] ?? []).includes(songStarterMood)) {
                      setSongStarterMood("all");
                    }
                  }}
                >
                  {SONG_STARTER_TEMPLATES.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>MOOD</span>
                <select
                  aria-label="Song starter mood"
                  value={songStarterMood}
                  disabled={busy}
                  onChange={(event) => setSongStarterMood(event.target.value)}
                >
                  <option value="all">Any mood</option>
                  {songStarterMoods.map((mood) => (
                    <option key={mood} value={mood}>
                      {mood}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>TEMPO · BPM</span>
                <input
                  type="number"
                  aria-label="Song starter tempo BPM"
                  min={40}
                  max={240}
                  step={0.1}
                  value={songStarterBpm}
                  disabled={busy}
                  onChange={(event) => setSongStarterBpm(event.target.value)}
                />
              </label>
            </div>
            <div className="pb-song-starter-actions">
              <span>First use downloads 4.9 MB once; the original loops stay available offline on this device.</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy ||
                  !Number.isFinite(Number(songStarterBpm)) ||
                  Number(songStarterBpm) < 40 ||
                  Number(songStarterBpm) > 240
                }
                onClick={createSongStarter}
              >
                {busy ? "OPENING…" : "CREATE SONG STARTER"}
              </button>
            </div>
          </div>
          <details className="pb-secondary-disclosure" open={!firstRun}>
            <summary className="pb-title">{firstRun ? "EXPLORE ALL PROJECT TEMPLATES" : "PROJECT TEMPLATES"}</summary>
            <div className="pb-templates">
              {TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="pb-template"
                  onClick={() => void createFromTemplate(template.id)}
                  disabled={busy}
                >
                  <span className="pb-template-top">
                    <span className="pb-template-name">{template.name.toUpperCase()}</span>
                    <span className="pb-template-bpm">{template.bpm} BPM</span>
                  </span>
                  <span className="pb-template-desc">{template.description}</span>
                  <span className="pb-template-tags">{template.tags.join(" · ")}</span>
                </button>
              ))}
            </div>
          </details>
        </section>

        <details className="pb-secondary-disclosure" open={!firstRun}>
          <summary className="pb-title">{firstRun ? "OPEN A READY-MADE LOOP DEMO" : "PLAY A LOOP DEMO"}</summary>
          <p className="pb-import-hint">
            Install the 4.9 MB original KYX loop pack and open a saved, editable example.
          </p>
          <div className="pb-loop-demos">
            <button type="button" className="pb-template" disabled={busy} onClick={() => createLoopDemo("house")}>
              <span className="pb-template-top">
                <span className="pb-template-name">AFTERHOURS HOUSE</span>
                <span className="pb-template-bpm">124 BPM</span>
              </span>
              <span className="pb-template-desc">Deep four-on-the-floor drums with warm C minor keys.</span>
              <span className="pb-template-tags">4 bars · House · C minor</span>
            </button>
            <button type="button" className="pb-template" disabled={busy} onClick={() => createLoopDemo("trap")}>
              <span className="pb-template-top">
                <span className="pb-template-name">HALF-TIME TRAP</span>
                <span className="pb-template-bpm">140 BPM</span>
              </span>
              <span className="pb-template-desc">Half-time drums with a tuned C minor 808 phrase.</span>
              <span className="pb-template-tags">4 bars · Trap · C minor</span>
            </button>
          </div>
          {demoProgress && (
            <p className="pb-import-hint" role="status">
              {demoProgress}
            </p>
          )}
        </details>

        <section className="pb-section">
          <h2 className="pb-title">PROJECTS</h2>
          {actionError && (
            <p className="pb-import-error" role="alert">
              {actionError}
            </p>
          )}
          {projects === null && <p className="pb-empty">Loading…</p>}
          {listError && projects !== null && projects.length === 0 && (
            <p className="pb-import-error" role="alert">
              Saved projects could not be read: {listError}. Your data is most likely intact — close other KYX tabs or
              check storage permissions, then reopen this page.
            </p>
          )}
          {firstRun && !listError && (
            <p className="pb-empty">No projects yet — everything you create is saved automatically.</p>
          )}
          {projects !== null && rows !== null && rows.length > 0 && (
            <div className="pb-list">
              {rows.map((row) => {
                if (row.kind === "newer") {
                  const project = row.meta;
                  return (
                    <div key={project.id} className="pb-row pb-row-newer">
                      <span
                        className="pb-row-name pb-row-name-static"
                        title="This project was made in a newer app version. Update KYX to open it."
                      >
                        {project.name}
                      </span>
                      <span className="pb-row-meta">
                        <span className="pb-badge-newer">NEWER VERSION</span> · saved{" "}
                        {formatRelative(project.updatedAt)}
                      </span>
                      <div className="pb-row-actions">
                        {confirmDeleteId === project.id ? (
                          <>
                            <button type="button" className="btn btn-danger" onClick={() => void remove(project.id)}>
                              DELETE?
                            </button>
                            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDeleteId(null)}>
                              NO
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => setConfirmDeleteId(project.id)}
                            title="Delete project"
                          >
                            DEL
                          </button>
                        )}
                      </div>
                    </div>
                  );
                }
                const project = row.meta;
                return (
                  <div key={project.id} className="pb-row">
                    {renamingId === project.id ? (
                      <input
                        className="pb-rename-input"
                        value={renameValue}
                        autoFocus
                        aria-label="Project name"
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={() => void commitRename(project.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            setRenamingId(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="pb-row-name"
                        onClick={() => void openById(project.id)}
                        disabled={busy}
                      >
                        {project.name}
                      </button>
                    )}
                    <span className="pb-row-meta">
                      {project.bpm} BPM · {project.trackCount} tracks
                      {project.transferOrigin &&
                        ` · imported from ${formatTransferSource(project.transferOrigin.sourceDaw)}`}{" "}
                      · saved {formatRelative(project.updatedAt)}
                    </span>
                    <div className="pb-row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void openById(project.id)}
                        disabled={busy}
                      >
                        OPEN
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void duplicate(project.id)}
                        title="Duplicate project"
                      >
                        DUP
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => startRename(project)}
                        title="Rename project"
                      >
                        REN
                      </button>
                      {confirmDeleteId === project.id ? (
                        <>
                          <button type="button" className="btn btn-danger" onClick={() => void remove(project.id)}>
                            DELETE?
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => setConfirmDeleteId(null)}>
                            NO
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setConfirmDeleteId(project.id)}
                          title="Delete project"
                        >
                          DEL
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {transferImportOpen && (
        <Suspense fallback={<div className="panel-loading">Loading transfer tools…</div>}>
          <TransferImportDialog
            core={core}
            onCancel={() => setTransferImportOpen(false)}
            onImported={(doc) => {
              setTransferImportOpen(false);
              enterStudio(doc);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
