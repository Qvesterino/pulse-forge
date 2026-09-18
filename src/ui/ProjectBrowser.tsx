import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreServices } from "../services";
import type { SavedProjectMeta } from "../persistence/ProjectRepository";
import type { ProjectDocument } from "../project-model/types";
import { TEMPLATES, createProjectFromTemplate } from "../project-model/templates";
import type { TemplateId } from "../project-model/templates";
import { importProject } from "../export/project-io";
import { uid } from "../shared/ids";

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

export function ProjectBrowser({ core, onOpen }: { core: CoreServices; onOpen: (doc: ProjectDocument) => void }) {
  const [projects, setProjects] = useState<SavedProjectMeta[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    core.repo
      .listAll()
      .then((list) => {
        setListError(null);
        setProjects(list);
      })
      .catch((err) => {
        // A blocked/corrupted/unavailable DB must not masquerade as a
        // first-run machine — the user would believe their projects are
        // gone and start over. Show the storage failure instead.
        console.error("[ProjectBrowser] project list failed:", err);
        setListError(err instanceof Error ? err.message : "Storage is unavailable");
        setProjects([]);
      });
  }, [core]);

  useEffect(() => {
    let cancelled = false;
    core.repo
      .listAll()
      .then((list) => {
        if (cancelled) return;
        setListError(null);
        setProjects(list);
      })
      .catch((err) => {
        if (cancelled) return;
        // A blocked/corrupted/unavailable DB must not masquerade as a
        // first-run machine - the user would believe their projects are
        // gone and start over. Show the storage failure instead.
        console.error("[ProjectBrowser] project list failed:", err);
        setListError(err instanceof Error ? err.message : "Storage is unavailable");
        setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [core]);

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

  const handleImportFile = async (file: File) => {
    if (busy) return;
    setBusy(true);
    setImportError(null);
    try {
      const doc = await importProject(file);
      // Save under a FRESH id: the file embeds its original id, and saving
      // with it would silently overwrite an existing library project with
      // the same id (matching the comment's intent — and repo.save is a
      // keyPath put).
      const imported: ProjectDocument = { ...doc, id: uid("project") };
      await core.repo.save(imported);
      onOpen(imported);
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

  const firstRun = projects !== null && projects.length === 0;
  const latest = projects !== null && projects.length > 0 ? projects[0] : null;

  return (
    <div className="project-browser">
      <header className="pb-header">
        {/* DAW convention: the logo always leads home — /?landing shows the
            KYX landing page even for returning users (main.tsx Entry). */}
        <a className="brand" href="/?landing" title="KYX — landing page" aria-label="KYX — go to landing page">
          <span className="brand-mark">KX</span>
          <span className="brand-name">KYX</span>
        </a>
        <span className="pb-tagline">beat &amp; scene-score workstation</span>
      </header>

      <div className="pb-body">
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
                {latest.bpm} BPM · {latest.trackCount} tracks · saved {formatRelative(latest.updatedAt)}
              </span>
            </button>
          </section>
        )}

        <section className="pb-section">
          <h2 className="pb-title">IMPORT PROJECT</h2>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.kyx.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              e.target.value = "";
            }}
          />
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            IMPORT FROM FILE
          </button>
          {importError && <span className="pb-import-error">{importError}</span>}
        </section>

        <section className="pb-section">
          <h2 className="pb-title">NEW PROJECT</h2>
          {firstRun && (
            <p className="pb-first-run">Pick a template — you will hear your first sound in under a minute.</p>
          )}
          <div className="pb-templates">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`pb-template${firstRun && template.id === "house" ? " pb-template-start" : ""}`}
                onClick={() => void createFromTemplate(template.id)}
                disabled={busy}
              >
                <span className="pb-template-top">
                  <span className="pb-template-name">{template.name.toUpperCase()}</span>
                  <span className="pb-template-bpm">{template.bpm} BPM</span>
                </span>
                <span className="pb-template-desc">{template.description}</span>
                <span className="pb-template-tags">{template.tags.join(" · ")}</span>
                {firstRun && template.id === "house" && <span className="pb-template-start-hint">START HERE</span>}
              </button>
            ))}
          </div>
        </section>

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
          {projects !== null && projects.length > 0 && (
            <div className="pb-list">
              {projects.map((project) => (
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
                    {project.bpm} BPM · {project.trackCount} tracks · saved {formatRelative(project.updatedAt)}
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
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
