import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLibrary, useServices } from "./context";
import { applyInstrumentPreset } from "../commands/commands";
import { factoryPresets, isFactoryPresetsWarm, warmFactoryPresets } from "../presets/factory-loader";
import { PRESET_ENERGIES, PRESET_USE_CASES, getPresetMetadata } from "../presets/catalog";
import type { InstrumentPreset, PresetEnergy, PresetUseCase } from "../presets/types";
import { rankSimilarPresets } from "../presets/similar";
import { ticksPerBar } from "../project-model/schema";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";
import { projectSoundContext, rankByProjectSoundFit, type ProjectSoundContext } from "../sample-library/projectFit";
import { uid } from "../shared/ids";

type UseCaseFilter = PresetUseCase | "all";
type EnergyFilter = PresetEnergy | "all";
type ScopeFilter = "all" | "fav" | "recent" | "similar";

export function PresetBrowser({
  track,
  query = "",
  genre = "all",
  mood = "all",
  projectContext,
  preloadPresetSamples,
}: {
  track: InstrumentTrack;
  query?: string;
  genre?: string;
  mood?: string;
  projectContext?: ProjectSoundContext;
  preloadPresetSamples?: (preset: InstrumentPreset) => Promise<void>;
}) {
  const services = useServices();
  const doc = services.store.getDoc();
  const fitContext = projectContext ?? projectSoundContext(doc, services.transport.bpm);
  const loadPresetSamples = preloadPresetSamples ?? (() => Promise.resolve());
  const library = useLibrary();
  const [useCase, setUseCase] = useState<UseCaseFilter>("all");
  const [energy, setEnergy] = useState<EnergyFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  // Filters live behind one toggle — search-first keeps the browser scannable;
  // the toggle shows how many filters are shaping the list when collapsed.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [userPresets, setUserPresets] = useState<InstrumentPreset[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewingPresetId, setPreviewingPresetId] = useState<string | null>(null);
  const [liveAuditionPendingId, setLiveAuditionPendingId] = useState<string | null>(null);
  const [liveAuditionActiveId, setLiveAuditionActiveId] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boundaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubscribeBoundary = useRef<(() => void) | null>(null);
  const unsubscribeLoopBoundary = useRef<(() => void) | null>(null);
  const auditionRequest = useRef(0);
  const liveAuditionMode = useRef(false);
  const liveRuntimeActive = useRef(false);
  const isolatedPreviewActive = useRef(false);

  const stopPresetAudition = useCallback(() => {
    const shouldStopAudio =
      previewTimer.current !== null ||
      boundaryTimer.current !== null ||
      unsubscribeBoundary.current !== null ||
      unsubscribeLoopBoundary.current !== null ||
      liveRuntimeActive.current ||
      isolatedPreviewActive.current;
    auditionRequest.current += 1;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (boundaryTimer.current) clearTimeout(boundaryTimer.current);
    previewTimer.current = null;
    boundaryTimer.current = null;
    unsubscribeBoundary.current?.();
    unsubscribeBoundary.current = null;
    unsubscribeLoopBoundary.current?.();
    unsubscribeLoopBoundary.current = null;
    if (shouldStopAudio) services.engine.stopPreview();
    if (liveRuntimeActive.current) services.setInstrumentPresetAuditionProject(null);
    liveRuntimeActive.current = false;
    isolatedPreviewActive.current = false;
    setPreviewingPresetId(null);
    setLiveAuditionPendingId(null);
    setLiveAuditionActiveId(null);
    liveAuditionMode.current = false;
  }, [services]);

  useEffect(() => {
    setPreviewingPresetId(null);
    return () => stopPresetAudition();
  }, [stopPresetAudition, track.id]);

  useEffect(() => {
    const unsubscribe = services.transport.subscribePlaying((playing) => {
      if (!playing && liveAuditionMode.current && (liveAuditionPendingId || liveAuditionActiveId)) {
        stopPresetAudition();
      } else if (playing && previewingPresetId) {
        services.engine.stopPreview();
        setPreviewingPresetId(null);
      }
    });
    return unsubscribe;
  }, [services, liveAuditionPendingId, liveAuditionActiveId, previewingPresetId, stopPresetAudition]);

  const observedDoc = useRef<ProjectDocument>(doc);
  useEffect(() => {
    observedDoc.current = services.store.getDoc();
    return services.store.subscribe(() => {
      const nextDoc = services.store.getDoc();
      if (nextDoc === observedDoc.current) return;
      observedDoc.current = nextDoc;
      stopPresetAudition();
    });
  }, [services, stopPresetAudition]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(previewingPresetId || liveAuditionPendingId || liveAuditionActiveId)) return;
      stopPresetAudition();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewingPresetId, liveAuditionPendingId, liveAuditionActiveId, stopPresetAudition]);

  // Quota/private-browsing failures must surface in the UI instead of dying
  // as unhandled rejections behind a `void`ed promise.
  const guard = useCallback((action: () => Promise<void>): Promise<void> => {
    setSaveError(null);
    return action().catch((err) => {
      console.error("[PresetBrowser] operation failed:", err);
      setSaveError(err instanceof Error ? err.message : "Storage operation failed");
    });
  }, []);

  const refreshUserPresets = useCallback(() => {
    services.core.presets
      .list()
      .then(setUserPresets)
      .catch(() => setUserPresets([]));
  }, [services]);

  useEffect(() => {
    refreshUserPresets();
  }, [refreshUserPresets, track.instrument]);

  // The factory bank (core + real-instrument packs) arrives through the lazy
  // loader — first open warms it once, then the read is synchronous.
  const bankWarm = isFactoryPresetsWarm();
  const [bankTick, setBankTick] = useState(0);
  useEffect(() => {
    if (bankWarm) return;
    let cancelled = false;
    void warmFactoryPresets().then(() => {
      if (!cancelled) setBankTick((tick) => tick + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [bankWarm]);

  const all = useMemo(
    () => [...(bankWarm ? factoryPresets() : []), ...userPresets].filter((p) => p.instrument === track.instrument),
    // bankTick re-runs the memo when the lazy bank finishes warming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bankWarm, bankTick, userPresets, track.instrument],
  );

  const base = all.filter((preset) => {
    const metadata = getPresetMetadata(preset);
    if (
      genre !== "all" &&
      ![preset.genre, ...preset.tags].some((value) => value && value.toLocaleLowerCase() === genre.toLocaleLowerCase())
    )
      return false;
    if (mood !== "all" && !preset.mood.some((value) => value.toLocaleLowerCase() === mood.toLocaleLowerCase()))
      return false;
    if (useCase !== "all" && metadata.useCase !== useCase) return false;
    if (energy !== "all" && metadata.energy !== energy) return false;
    if (scope === "fav" && !library.favoritePresets.includes(preset.id)) return false;
    if (scope === "recent" && !library.recentPresets.includes(preset.id)) return false;
    if (query.trim().length > 0) {
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const haystack =
        `${preset.name} ${preset.tags.join(" ")} ${preset.genre ?? ""} ${preset.mood.join(" ")} ${metadata.useCase} ${metadata.energy} ${metadata.source}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  });
  // SIMILAR: rank the remaining presets of this instrument by param distance
  // to the current patch; a similarity chip is rendered next to each row.
  const ranked = scope === "similar" ? rankSimilarPresets(base, track, 24) : null;
  const similarityOf = new Map(ranked?.map((r) => [r.preset.id, r.similarity]) ?? []);
  const fitOrdered = rankByProjectSoundFit(
    ranked ? ranked.map((result) => result.preset) : base,
    (preset) => {
      const metadata = getPresetMetadata(preset);
      return {
        genres: [preset.genre ?? "", ...preset.tags],
        moods: preset.mood,
        bpmRange: metadata.bpmRange,
      };
    },
    fitContext,
  );
  const filtered = fitOrdered;

  const current = all.find((p) => p.id === track.presetId) ?? null;
  const activeFilterCount = (useCase !== "all" ? 1 : 0) + (energy !== "all" ? 1 : 0);

  const apply = async (preset: InstrumentPreset) => {
    stopPresetAudition();
    const request = auditionRequest.current;
    const sourceDoc = services.store.getDoc();
    try {
      await loadPresetSamples(preset);
      if (request !== auditionRequest.current || sourceDoc !== services.store.getDoc()) return;
      services.store.execute(applyInstrumentPreset(sourceDoc, track.id, preset));
      void guard(async () => {
        await services.library.recordPreset(preset.id);
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not load preset samples");
    }
  };

  const activateLiveAudition = (
    preset: InstrumentPreset,
    project: ProjectDocument,
    request: number,
    audioTime: number,
  ) => {
    const delayMs = Math.max(0, (audioTime - services.engine.currentTime) * 1000);
    boundaryTimer.current = setTimeout(() => {
      boundaryTimer.current = null;
      if (request !== auditionRequest.current || !services.transport.playing) return;
      try {
        services.setInstrumentPresetAuditionProject(project);
        liveAuditionMode.current = true;
        liveRuntimeActive.current = true;
        setLiveAuditionPendingId(null);
        setLiveAuditionActiveId(preset.id);
      } catch (error) {
        stopPresetAudition();
        setSaveError(error instanceof Error ? error.message : "Could not start preset audition");
      }
    }, delayMs);
  };

  const scheduleAtNextBar = (preset: InstrumentPreset, project: ProjectDocument, request: number) => {
    const currentDoc = services.store.getDoc();
    const barTicks = ticksPerBar(currentDoc);
    const currentTick = Math.max(0, services.transport.position);
    const nextBarTick = (Math.floor(currentTick / barTicks) + 1) * barTicks;
    const scheduleLoopWrap =
      services.transport.loopEnabled && services.transport.loopEnd > 0 && nextBarTick >= services.transport.loopEnd;

    if (scheduleLoopWrap) {
      const listen = () => {
        let unsubscribe: (() => void) | null = null;
        let removeWhenSubscribed = false;
        const detach = () => {
          if (unsubscribe) unsubscribe();
          else removeWhenSubscribed = true;
          if (unsubscribe && unsubscribeLoopBoundary.current === unsubscribe) unsubscribeLoopBoundary.current = null;
        };
        const handle = services.scheduler.subscribeLoopBoundaries((boundary) => {
          if (request !== auditionRequest.current) return;
          if (boundary.cancelled) {
            detach();
            if (services.transport.playing) listen();
            return;
          }
          detach();
          activateLiveAudition(preset, project, request, boundary.audioTime);
        });
        unsubscribe = handle;
        if (removeWhenSubscribed) handle();
        else unsubscribeLoopBoundary.current = handle;
      };
      listen();
      return;
    }

    const listen = (tick: number) => {
      let unsubscribe: (() => void) | null = null;
      let removeWhenSubscribed = false;
      const detach = () => {
        if (unsubscribe) unsubscribe();
        else removeWhenSubscribed = true;
        if (unsubscribe && unsubscribeBoundary.current === unsubscribe) unsubscribeBoundary.current = null;
      };
      const handle = services.scheduler.subscribeTickBoundary(tick, (boundary) => {
        if (request !== auditionRequest.current) return;
        if (boundary.cancelled) {
          detach();
          if (services.transport.playing) {
            const now = Math.max(0, services.transport.position);
            listen((Math.floor(now / barTicks) + 1) * barTicks);
          }
          return;
        }
        detach();
        activateLiveAudition(preset, project, request, boundary.audioTime);
      });
      unsubscribe = handle;
      if (removeWhenSubscribed) handle();
      else unsubscribeBoundary.current = handle;
    };
    listen(nextBarTick);
  };

  const preview = async (preset: InstrumentPreset) => {
    stopPresetAudition();
    const request = auditionRequest.current;
    const sourceDoc = services.store.getDoc();
    setSaveError(null);
    liveAuditionMode.current = services.transport.playing;
    setLiveAuditionPendingId(preset.id);
    try {
      await loadPresetSamples(preset);
      if (request !== auditionRequest.current || sourceDoc !== services.store.getDoc()) return;
      if (services.transport.playing) {
        const project = applyInstrumentPreset(sourceDoc, track.id, preset).execute(sourceDoc);
        scheduleAtNextBar(preset, project, request);
      } else {
        setLiveAuditionPendingId(null);
        services.engine.previewInstrumentPreset(track.id, preset);
        isolatedPreviewActive.current = true;
        setPreviewingPresetId(preset.id);
        previewTimer.current = setTimeout(() => {
          previewTimer.current = null;
          isolatedPreviewActive.current = false;
          setPreviewingPresetId((active) => (active === preset.id ? null : active));
        }, 1_500);
      }
    } catch (error) {
      stopPresetAudition();
      setSaveError(error instanceof Error ? error.message : "Could not load preset samples");
    }
  };

  const saveCurrent = async () => {
    setSaveError(null);
    const name = saveName.trim();
    if (name.length === 0) return;
    const preset: InstrumentPreset = {
      id: uid("preset"),
      name,
      instrument: track.instrument,
      genre: null,
      mood: [],
      tags: ["user"],
      params: { ...track.params },
      sampleId: track.sampleId,
      user: true,
    };
    preset.metadata = getPresetMetadata(preset);
    await services.core.presets.save(preset);
    setSaveOpen(false);
    setSaveName("");
    refreshUserPresets();
  };

  const removeUserPreset = async (id: string) => {
    await services.core.presets.delete(id);
    refreshUserPresets();
  };

  return (
    <div className="preset-browser">
      <div className="preset-current">
        <span className="preset-current-label">PRESET</span>
        <span className="preset-current-name">{current ? current.name : "Custom"}</span>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            setSaveOpen((open) => !open);
            setSaveName(current ? `${current.name} ` : `${track.name} `);
          }}
          title="Save current sound as a user preset"
        >
          SAVE
        </button>
      </div>

      {saveOpen && (
        <div className="preset-save">
          <input
            className="preset-save-input"
            value={saveName}
            autoFocus
            placeholder="Preset name"
            aria-label="New preset name"
            onChange={(event) => setSaveName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void guard(saveCurrent);
              if (event.key === "Escape") setSaveOpen(false);
            }}
          />
          <button type="button" className="btn btn-small" onClick={() => void guard(saveCurrent)}>
            OK
          </button>
        </div>
      )}

      {saveError && (
        <div className="preset-save-error" role="alert" aria-live="polite">
          {saveError}
        </div>
      )}

      <div className="preset-toolbar">
        <button
          type="button"
          className={`btn btn-small preset-filter-toggle${filtersOpen || activeFilterCount > 0 ? " active" : ""}`}
          aria-expanded={filtersOpen}
          title="Filter by role and energy"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          FILTERS{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          <span aria-hidden="true">{filtersOpen ? " ▴" : " ▾"}</span>
        </button>
      </div>

      <div className="preset-chips" role="group" aria-label="Preset scope">
        {(["all", "fav", "recent", "similar"] as ScopeFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`preset-chip${scope === s ? " active" : ""}`}
            onClick={() => setScope(s)}
            title={s === "similar" ? "Presets closest to the current sound (same instrument)" : undefined}
          >
            {s === "similar" ? "SIMILAR ▸" : s.toUpperCase()}
          </button>
        ))}
      </div>

      {filtersOpen && (
        <>
          <div className="preset-chips" role="group" aria-label="Preset role filter">
            <button
              type="button"
              className={`preset-chip${useCase === "all" ? " active" : ""}`}
              aria-pressed={useCase === "all"}
              onClick={() => setUseCase("all")}
            >
              ROLE: ALL
            </button>
            {PRESET_USE_CASES.map((value) => (
              <button
                key={value}
                type="button"
                className={`preset-chip${useCase === value ? " active" : ""}`}
                aria-pressed={useCase === value}
                onClick={() => setUseCase(useCase === value ? "all" : value)}
              >
                ROLE: {value.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="preset-chips" role="group" aria-label="Preset energy filter">
            <button
              type="button"
              className={`preset-chip${energy === "all" ? " active" : ""}`}
              aria-pressed={energy === "all"}
              onClick={() => setEnergy("all")}
            >
              ENERGY: ALL
            </button>
            {PRESET_ENERGIES.map((value) => (
              <button
                key={value}
                type="button"
                className={`preset-chip${energy === value ? " active" : ""}`}
                aria-pressed={energy === value}
                onClick={() => setEnergy(energy === value ? "all" : value)}
              >
                ENERGY: {value.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="preset-list">
        {filtered.length === 0 && <div className="preset-empty">No presets match.</div>}
        {filtered.map((preset) => {
          const metadata = getPresetMetadata(preset);
          const isPreviewing = previewingPresetId === preset.id;
          const isLiveAuditioning = liveAuditionPendingId === preset.id || liveAuditionActiveId === preset.id;
          const isAuditioning = isPreviewing || isLiveAuditioning;
          return (
            <div
              key={preset.id}
              className={`preset-row${preset.id === track.presetId ? " active" : ""}`}
              title={`${metadata.source} · ${metadata.license} · ${metadata.bpmRange.min}–${metadata.bpmRange.max} BPM · key ${metadata.keySuitability}`}
            >
              <button
                type="button"
                className={`preset-preview${isAuditioning ? " active" : ""}`}
                aria-label={isAuditioning ? `Stop preview ${preset.name}` : `Preview ${preset.name}`}
                aria-pressed={isAuditioning}
                title={
                  liveAuditionPendingId === preset.id
                    ? "Loading samples and waiting for the next bar"
                    : liveAuditionActiveId === preset.id
                      ? "Auditioning through the track effects"
                      : isPreviewing
                        ? "Stop preview"
                        : "Preview preset"
                }
                onClick={() => {
                  if (isAuditioning) {
                    stopPresetAudition();
                  } else {
                    void preview(preset);
                  }
                }}
              >
                {isAuditioning ? "■" : "▶"}
              </button>
              <button
                type="button"
                className="preset-name"
                aria-label={`Apply ${preset.name}`}
                onClick={() => void apply(preset)}
                title={`Apply ${preset.name}`}
              >
                {preset.name}
              </button>
              <span className="preset-tags">
                {metadata.useCase} · {metadata.energy} · {preset.genre ? preset.genre : "user"}
              </span>
              {similarityOf.has(preset.id) && (
                <span className="preset-sim" title="Parameter similarity to the current sound">
                  ≈{Math.round((similarityOf.get(preset.id) ?? 0) * 100)}%
                </span>
              )}
              <button
                type="button"
                className={`preset-fav${library.favoritePresets.includes(preset.id) ? " active" : ""}`}
                aria-label={
                  library.favoritePresets.includes(preset.id) ? `Unfavorite ${preset.name}` : `Favorite ${preset.name}`
                }
                aria-pressed={library.favoritePresets.includes(preset.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  void guard(async () => {
                    await services.library.togglePresetFavorite(preset.id);
                  });
                }}
              >
                {library.favoritePresets.includes(preset.id) ? "♥" : "♡"}
              </button>
              {preset.user && (
                <button
                  type="button"
                  className="preset-delete"
                  aria-label={`Delete preset ${preset.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void guard(async () => removeUserPreset(preset.id));
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
