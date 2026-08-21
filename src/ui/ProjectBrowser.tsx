import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreServices } from "../services";
import type { SavedProjectMeta } from "../persistence/ProjectRepository";
import type { ProjectDocument } from "../project-model/types";
import { TEMPLATES, createProjectFromTemplate } from "../project-model/templates";
import type { TemplateId } from "../project-model/templates";
import { importProject } from "../export/project-io";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    core.repo
      .listAll()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [core]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openById = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const doc = await core.repo.load(id);
      if (doc) onOpen(doc);
    } finally {
      setBusy(false);
    }
  };

  const openMostRecent = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const doc = await core.repo.loadMostRecent();
      if (doc) onOpen(doc);
    } finally {
      setBusy(false);
    }
  };

  const createFromTemplate = async (id: TemplateId) => {
    if (busy) return;
    setBusy(true);
    try {
      const doc = createProjectFromTemplate(id);
      await core.repo.save(doc);
      onOpen(doc);
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (file: File) => {
    if (busy) return;
    setBusy(true);
    setImportError(null);
    try {
      const doc = await importProject(file);
      // Save with new ID to avoid overwriting existing projects
      await core.repo.save(doc);
      onOpen(doc);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (id: string) => {
    await core.repo.duplicate(id);
    refresh();
  };

  const startRename = (meta: SavedProjectMeta) => {
    setRenamingId(meta.id);
    setRenameValue(meta.name);
    setConfirmDeleteId(null);
  };

  const commitRename = async (id: string) => {
    await core.repo.rename(id, renameValue);
    setRenamingId(null);
    refresh();
  };

  const remove = async (id: string) => {
    await core.repo.delete(id);
    setConfirmDeleteId(null);
    refresh();
  };

  const firstRun = projects !== null && projects.length === 0;
  const latest = projects !== null && projects.length > 0 ? projects[0] : null;

  return (
    <div className="project-browser">
      <header className="pb-header">
        <div className="brand">
          <span className="brand-mark">PF</span>
          <span className="brand-name">PULSE FORGE</span>
        </div>
        <span className="pb-tagline">beat &amp; scene-score workstation</span>
      </header>

      <div className="pb-body">
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
            accept=".json,.pulseforge.json"
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
          {projects === null && <p className="pb-empty">Loading…</p>}
          {firstRun && <p className="pb-empty">No projects yet — everything you create is saved automatically.</p>}
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
                    <button type="button" className="pb-row-name" onClick={() => void openById(project.id)} disabled={busy}>
                      {project.name}
                    </button>
                  )}
                  <span className="pb-row-meta">
                    {project.bpm} BPM · {project.trackCount} tracks · saved {formatRelative(project.updatedAt)}
                  </span>
                  <div className="pb-row-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => void openById(project.id)} disabled={busy}>
                      OPEN
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => void duplicate(project.id)} title="Duplicate project">
                      DUP
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => startRename(project)} title="Rename project">
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
                      <button type="button" className="btn btn-ghost" onClick={() => setConfirmDeleteId(project.id)} title="Delete project">
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
