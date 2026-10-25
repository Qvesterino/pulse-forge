import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyKitToDrumTrack } from "../commands/drumContent";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import { applyRoundRobinVariants, ensureFactorySamples } from "../sample-library/factory";
import { rankByProjectSoundFit, scoreProjectSoundFit, type ProjectSoundContext } from "../sample-library/projectFit";
import { KIT_PRESETS, type KitPreset } from "../project-model/kit-presets";
import type { DrumTrack } from "../project-model/types";
import type { UserKit } from "../persistence/KitRepository";
import { ticksPerBar } from "../project-model/schema";
import { useServices } from "./context";

type AuditionKit = KitPreset & { source: "factory" | "user" };
type AuditionState = { kitId: string; phase: "loading" | "pending" | "active" };

const FACTORY_SAMPLE_IDS = new Set(FACTORY_ASSETS.map((asset) => asset.id));

function kitSampleIds(kit: KitPreset): string[] {
  return [
    ...new Set(
      kit.pads
        .flatMap((pad) => [pad.assetId, ...(pad.layers ?? []).map((layer) => layer.sampleId)])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

function soundFitDescriptor(kit: AuditionKit) {
  return { genres: [kit.genre] };
}

export function KitAuditionBrowser({
  track,
  query,
  genre,
  mood,
  projectContext,
}: {
  track: DrumTrack;
  query: string;
  genre: string;
  mood: string;
  projectContext: ProjectSoundContext;
}) {
  const services = useServices();
  const [userKits, setUserKits] = useState<UserKit[]>([]);
  const [bars, setBars] = useState(2);
  const [transportPlaying, setTransportPlaying] = useState(services.transport.playing);
  const [audition, setAudition] = useState<AuditionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const boundaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubscribeTick = useRef<(() => void) | null>(null);
  const unsubscribeLoop = useRef<(() => void) | null>(null);
  const runtimeActive = useRef(false);

  const stopAudition = useCallback(() => {
    requestId.current += 1;
    if (boundaryTimer.current) clearTimeout(boundaryTimer.current);
    boundaryTimer.current = null;
    unsubscribeTick.current?.();
    unsubscribeTick.current = null;
    unsubscribeLoop.current?.();
    unsubscribeLoop.current = null;
    if (runtimeActive.current) services.setPlaybackProjectAudition(null);
    runtimeActive.current = false;
    setAudition(null);
  }, [services]);

  useEffect(() => {
    let cancelled = false;
    void services.userKits
      .list()
      .then((kits) => {
        if (!cancelled && kits.length > 0) setUserKits(kits);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load saved kits");
      });
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    const observedDoc = { current: services.store.getDoc() };
    const unsubscribe = services.store.subscribe(() => {
      const next = services.store.getDoc();
      if (next === observedDoc.current) return;
      observedDoc.current = next;
      stopAudition();
    });
    return unsubscribe;
  }, [services, stopAudition]);

  useEffect(() => {
    const unsubscribe = services.transport.subscribePlaying((playing) => {
      setTransportPlaying(playing);
      if (!playing) stopAudition();
    });
    return unsubscribe;
  }, [services, stopAudition]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && audition) stopAudition();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [audition, stopAudition]);

  useEffect(() => {
    return () => stopAudition();
  }, [track.id, stopAudition]);

  const kits = useMemo(() => {
    const values: AuditionKit[] = [
      ...KIT_PRESETS.map((kit) => ({ ...kit, source: "factory" as const })),
      ...userKits.map((kit) => ({ ...kit, source: "user" as const })),
    ];
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching = values.filter((kit) => {
      if (genre !== "all" && kit.genre.toLocaleLowerCase() !== genre.toLocaleLowerCase()) return false;
      const haystack = `${kit.name} ${kit.genre} ${kit.description}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    return rankByProjectSoundFit(matching, soundFitDescriptor, projectContext);
  }, [userKits, query, genre, projectContext]);

  const loadKitSamples = async (kit: KitPreset): Promise<void> => {
    await services.core.initialSampleBankHydration;
    const ids = kitSampleIds(kit);
    const factoryBases = [
      ...new Set(
        ids.flatMap((id) => {
          const baseId = id.replace(/\.rr[23]$/, "");
          return FACTORY_SAMPLE_IDS.has(baseId) ? [baseId] : [];
        }),
      ),
    ];
    await ensureFactorySamples(services.bank, factoryBases);
    for (const baseId of factoryBases) {
      if (!services.bank.has(`${baseId}.rr2`) || !services.bank.has(`${baseId}.rr3`)) {
        applyRoundRobinVariants(services.bank, baseId);
      }
    }
    const missing = ids.filter((id) => !services.bank.has(id));
    if (missing.length > 0) throw new Error(`Kit samples are unavailable: ${missing.slice(0, 3).join(", ")}`);
  };

  const schedulePreview = async (kit: AuditionKit) => {
    stopAudition();
    const request = requestId.current;
    const sourceDoc = services.store.getDoc();
    const sourceTrack = sourceDoc.tracks.find((candidate) => candidate.id === track.id && candidate.kind === "drum");
    if (!sourceTrack || sourceTrack.kind !== "drum") {
      setError("The selected drum track is no longer available");
      return;
    }
    setError(null);
    setAudition({ kitId: kit.id, phase: "loading" });

    try {
      await loadKitSamples(kit);
      if (request !== requestId.current || services.store.getDoc() !== sourceDoc) return;
      if (!services.transport.playing) throw new Error("Start playback to audition a kit in the beat");

      // Build a throwaway playback view. Only the explicit Apply button below
      // enters the command/undo path.
      const auditionDoc = applyKitToDrumTrack(sourceDoc, track.id, kit.name, kit.pads).execute(sourceDoc);
      const barTicks = ticksPerBar(sourceDoc);
      const runAt = (audioTime: number, action: () => void) => {
        const delay = Math.max(0, (audioTime - services.engine.currentTime) * 1000);
        boundaryTimer.current = setTimeout(() => {
          boundaryTimer.current = null;
          if (request === requestId.current && services.transport.playing && services.store.getDoc() === sourceDoc) {
            try {
              action();
            } catch (caught) {
              stopAudition();
              setError(caught instanceof Error ? caught.message : "Could not audition this kit");
            }
          }
        }, delay);
      };

      const listenTick = (
        tick: number,
        onBoundary: (audioTime: number, tick: number) => void,
        onCancelled: () => void,
      ) => {
        let unsubscribe: (() => void) | null = null;
        let removeAfterSubscribe = false;
        const detach = () => {
          if (unsubscribe) unsubscribe();
          else removeAfterSubscribe = true;
          if (unsubscribe && unsubscribeTick.current === unsubscribe) unsubscribeTick.current = null;
        };
        const handle = services.scheduler.subscribeTickBoundary(tick, (boundary) => {
          if (request !== requestId.current) return;
          if (boundary.cancelled) {
            detach();
            onCancelled();
            return;
          }
          detach();
          onBoundary(boundary.audioTime, boundary.tick);
        });
        unsubscribe = handle;
        if (removeAfterSubscribe) handle();
        else unsubscribeTick.current = handle;
      };

      const listenLoop = (
        onBoundary: (audioTime: number, loopStart: number, loopEnd: number) => void,
        onCancelled: () => void,
      ) => {
        let unsubscribe: (() => void) | null = null;
        let removeAfterSubscribe = false;
        const detach = () => {
          if (unsubscribe) unsubscribe();
          else removeAfterSubscribe = true;
          if (unsubscribe && unsubscribeLoop.current === unsubscribe) unsubscribeLoop.current = null;
        };
        const handle = services.scheduler.subscribeLoopBoundaries((boundary) => {
          if (request !== requestId.current) return;
          if (boundary.cancelled) {
            detach();
            onCancelled();
            return;
          }
          detach();
          onBoundary(boundary.audioTime, boundary.loopStartTick, boundary.loopEndTick);
        });
        unsubscribe = handle;
        if (removeAfterSubscribe) handle();
        else unsubscribeLoop.current = handle;
      };

      const finishAt = (audioTime: number) => runAt(audioTime, stopAudition);
      const finishAfter = (remainingTicks: number, fromTick: number, loopStart: number, loopEnd: number) => {
        if (request !== requestId.current) return;
        if (!services.transport.loopEnabled || services.transport.loopEnd <= 0) {
          const endTick = fromTick + remainingTicks;
          listenTick(
            endTick,
            (audioTime) => finishAt(audioTime),
            () => finishAfter(remainingTicks, Math.max(0, services.transport.position), loopStart, loopEnd),
          );
          return;
        }
        const currentLoopStart = services.transport.loopStart;
        const currentLoopEnd = services.transport.loopEnd;
        const distanceToWrap = Math.max(0, currentLoopEnd - fromTick);
        if (remainingTicks < distanceToWrap) {
          listenTick(
            fromTick + remainingTicks,
            (audioTime) => finishAt(audioTime),
            () =>
              finishAfter(remainingTicks, Math.max(0, services.transport.position), currentLoopStart, currentLoopEnd),
          );
          return;
        }
        listenLoop(
          (audioTime, boundaryStart, boundaryEnd) => {
            const remainingAfterWrap = remainingTicks - distanceToWrap;
            runAt(audioTime, () => {
              if (remainingAfterWrap <= 0) stopAudition();
              else finishAfter(remainingAfterWrap, boundaryStart, boundaryStart, boundaryEnd);
            });
          },
          () => finishAfter(remainingTicks, Math.max(0, services.transport.position), currentLoopStart, currentLoopEnd),
        );
      };

      const activate = (audioTime: number, startTick: number) => {
        runAt(audioTime, () => {
          services.setPlaybackProjectAudition(auditionDoc);
          runtimeActive.current = true;
          setAudition({ kitId: kit.id, phase: "active" });
          finishAfter(bars * barTicks, startTick, services.transport.loopStart, services.transport.loopEnd);
        });
      };

      const queueNextBar = () => {
        if (request !== requestId.current || !services.transport.playing) return;
        const currentTick = Math.max(0, services.transport.position);
        const nextBar = (Math.floor(currentTick / barTicks) + 1) * barTicks;
        if (services.transport.loopEnabled && services.transport.loopEnd > 0 && nextBar >= services.transport.loopEnd) {
          listenLoop((audioTime, loopStart) => activate(audioTime, loopStart), queueNextBar);
          return;
        }
        listenTick(nextBar, activate, queueNextBar);
      };

      setAudition({ kitId: kit.id, phase: "pending" });
      queueNextBar();
    } catch (caught) {
      if (request !== requestId.current) return;
      setAudition(null);
      setError(caught instanceof Error ? caught.message : "Could not preview this kit");
    }
  };

  const applyKit = async (kit: AuditionKit) => {
    stopAudition();
    const sourceDoc = services.store.getDoc();
    const currentTrack = sourceDoc.tracks.find((candidate) => candidate.id === track.id && candidate.kind === "drum");
    if (!currentTrack || currentTrack.kind !== "drum") {
      setError("The selected drum track is no longer available");
      return;
    }
    setError(null);
    setAudition({ kitId: kit.id, phase: "loading" });
    try {
      await loadKitSamples(kit);
      if (services.store.getDoc() !== sourceDoc) return;
      services.store.execute(applyKitToDrumTrack(sourceDoc, track.id, kit.name, kit.pads));
      setAudition(null);
    } catch (caught) {
      setAudition(null);
      setError(caught instanceof Error ? caught.message : "Could not apply this kit");
    }
  };

  return (
    <section className="kit-audition" aria-label="Kit audition in the current beat">
      <div className="kit-audition-heading">
        <div>
          <strong>KIT AUDITION</strong>
          <span>Try a complete kit in this beat. Apply commits one undoable change.</span>
        </div>
        <label>
          <span>Length</span>
          <select
            aria-label="Kit audition length"
            value={bars}
            disabled={audition !== null}
            onChange={(event) => setBars(Number(event.target.value))}
          >
            {[1, 2, 4].map((value) => (
              <option key={value} value={value}>
                {value} {value === 1 ? "bar" : "bars"}
              </option>
            ))}
          </select>
        </label>
        {audition && (
          <button type="button" className="btn btn-small" onClick={stopAudition}>
            STOP
          </button>
        )}
      </div>
      <p className="kit-audition-hint">
        {transportPlaying
          ? "Preview starts on the next bar. Stop or Escape cancels."
          : "Start playback to hear kits in the arrangement."}
        {mood !== "all" ? " Kit mood is not tagged, so mood stays neutral." : ""}
      </p>
      {error && (
        <div className="sample-library-error" role="alert">
          {error}
        </div>
      )}
      <div className="kit-audition-list">
        {kits.map((kit, index) => {
          const active = audition?.kitId === kit.id;
          const fit = scoreProjectSoundFit(soundFitDescriptor(kit), projectContext) > 0;
          return (
            <article className={`kit-audition-card${active ? " auditioning" : ""}`} key={`${kit.source}:${kit.id}`}>
              <div className="kit-audition-copy">
                <strong>{kit.name}</strong>
                <span>
                  {kit.genre} · {kit.source === "user" ? "Saved kit" : "KYX kit"}
                </span>
                <small>{kit.description}</small>
              </div>
              {fit && index === 0 && <span className="kit-fit-badge">PROJECT FIT</span>}
              <div className="kit-audition-actions">
                {active && audition.phase === "active" ? (
                  <span className="kit-audition-playing">PLAYING</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={!transportPlaying || audition !== null}
                    onClick={() => void schedulePreview(kit)}
                  >
                    {active
                      ? audition.phase === "loading"
                        ? "LOADING…"
                        : "QUEUED…"
                      : `PREVIEW ${bars} BAR${bars === 1 ? "" : "S"}`}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-small active"
                  disabled={audition?.phase === "loading"}
                  onClick={() => void applyKit(kit)}
                >
                  {active && audition.phase === "loading" ? "LOADING…" : "APPLY"}
                </button>
              </div>
            </article>
          );
        })}
        {kits.length === 0 && <div className="sample-empty">No kits match these search and genre filters.</div>}
      </div>
      {audition?.phase === "pending" && (
        <span className="kit-audition-live-status" role="status">
          Kit preview queued for the next bar.
        </span>
      )}
      {audition?.phase === "active" && (
        <span className="kit-audition-live-status" role="status">
          Playing {bars} bar{bars === 1 ? "" : "s"} of {kits.find((kit) => kit.id === audition.kitId)?.name}. Press Stop
          or Escape to restore the project kit.
        </span>
      )}
    </section>
  );
}
