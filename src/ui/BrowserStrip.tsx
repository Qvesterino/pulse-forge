import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useServices } from "./context";
import { addAudioClip, fittedLoopPlacement, setInstrumentSample, setPadParams } from "../commands/commands";
import { loopPreviewPlaybackRate } from "../audio-engine/loopTempo";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import { PPQ, type Track } from "../project-model/types";
import { ticksPerBar } from "../project-model/schema";
import { sceneSecondsToBars, tempoAtTick } from "../project-model/scene-time";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import type { SongStarterHandoff } from "../landing/handoff";

const SampleBrowser = lazy(() => import("./SampleBrowser").then((m) => ({ default: m.SampleBrowser })));

const STRIP_STORAGE_KEY = "pf-browser-strip-v1";

function loadStripOpen(): boolean {
  try {
    return JSON.parse(localStorage.getItem(STRIP_STORAGE_KEY) ?? "true") !== false;
  } catch {
    return true;
  }
}

/**
 * Left sounds strip (ROADMAP-UI-2027, Vlna 4) — the FL-Studio browser
 * lesson: the library is ALWAYS one glance away, never a dialog. Clicking a
 * sound assigns it to the current target (selected drum pad, or the selected
 * instrument track's sample slot) and previews it; dragging drops onto
 * sequencer rows and track tabs.
 *
 * Lazy: the browser (and its DropZone/Freesound/intake chunk) mounts on
 * first expand — a session that never opens sounds pays nothing. The
 * collapsed state is a slim labelled rail, so reopening is one click.
 */
export function BrowserStrip({
  track,
  selectedPadId,
  songStarter = null,
  viewRequest,
}: {
  track: Track;
  selectedPadId: string;
  songStarter?: SongStarterHandoff | null;
  viewRequest?: { view: "sounds" | "loops" | "presets"; id: number };
}) {
  const services = useServices();
  const [open, setOpen] = useState(() => Boolean(songStarter) || loadStripOpen());
  const [browserView, setBrowserView] = useState<"sounds" | "loops" | "presets">(() =>
    songStarter ? "loops" : "sounds",
  );
  const handledViewRequest = useRef(0);

  useEffect(() => {
    if (!viewRequest || viewRequest.id === 0 || viewRequest.id === handledViewRequest.current) return;
    handledViewRequest.current = viewRequest.id;
    setOpen(true);
    setBrowserView(viewRequest.view);
  }, [viewRequest]);

  useEffect(() => {
    try {
      localStorage.setItem(STRIP_STORAGE_KEY, JSON.stringify(open));
    } catch {
      /* cosmetic preference — quota/private mode stays silent */
    }
  }, [open]);

  const doc = services.store.getDoc();
  const drumPad =
    track.kind === "drum" ? (track.pads.find((pad) => pad.id === selectedPadId) ?? track.pads[0] ?? null) : null;
  const instrumentTarget = track.kind === "instrument" ? track : null;
  const arrangementTarget = track.kind === "generative" ? null : track;
  const currentId = drumPad ? drumPad.assetId : instrumentTarget ? instrumentTarget.sampleId : null;

  const assign = (assetId: string | null) => {
    // The strip has no target of its own — it borrows the selection: the
    // selected drum pad first, then the selected instrument track. Preview
    // already fired inside the browser's apply(); this is just the write.
    if (drumPad) {
      services.store.execute(setPadParams(doc, drumPad.id, { assetId }));
      return;
    }
    if (instrumentTarget) {
      services.store.execute(setInstrumentSample(doc, instrumentTarget.id, assetId));
    }
  };

  const previewLoop = (asset: UserSampleAsset) => {
    const currentDoc = services.store.getDoc();
    const nextBeatTick = (Math.floor(services.transport.position / PPQ) + 1) * PPQ;
    const targetBpm = tempoAtTick(
      currentDoc.arrangement.clips,
      currentDoc.scenes,
      nextBeatTick,
      currentDoc.bpm,
      ticksPerBar(currentDoc),
    );
    const detectedBpm = Number.isFinite(asset.bpm) && asset.bpm! >= 40 && asset.bpm! <= 240 ? asset.bpm! : targetBpm;
    services.engine.previewAssetSynced(asset.id, loopPreviewPlaybackRate(detectedBpm, targetBpm), true);
  };

  const addLoopToArrangement = async (asset: UserSampleAsset) => {
    if (!arrangementTarget) throw new Error("Select a drum, instrument, or group track first.");
    await services.core.initialSampleBankHydration;
    if (!services.bank.has(asset.id)) throw new Error("This loop is still loading or its audio could not be restored.");

    const currentDoc = services.store.getDoc();
    const target = currentDoc.tracks.find((candidate) => candidate.id === arrangementTarget.id);
    if (!target || target.kind === "generative")
      throw new Error("The selected arrangement track is no longer available.");
    const playheadTick = Math.max(0, services.transport.position);
    const startBar = Math.max(0, Math.ceil((playheadTick - 1e-6) / ticksPerBar(currentDoc)));
    const targetBpm = tempoAtTick(
      currentDoc.arrangement.clips,
      currentDoc.scenes,
      startBar * ticksPerBar(currentDoc),
      currentDoc.bpm,
      ticksPerBar(currentDoc),
    );
    const fitted = fittedLoopPlacement(asset.duration, asset.bpm, targetBpm, ticksPerBar(currentDoc));
    const lengthBars =
      fitted?.lengthBars ?? Math.max(0.25, sceneSecondsToBars(asset.duration, targetBpm, ticksPerBar(currentDoc)));

    services.store.execute(
      addAudioClip(
        currentDoc,
        target.id,
        asset.id,
        startBar,
        lengthBars,
        fitted ? { stretchMode: "stretch", stretchRate: fitted.rate } : {},
      ),
    );
  };

  if (!open) {
    return (
      <aside className="browser-strip collapsed" aria-label="Sounds (collapsed)">
        <button
          type="button"
          className="browser-strip-rail"
          onClick={() => setOpen(true)}
          aria-label="Open sounds browser"
          title="Sounds — open the browser strip"
        >
          <span className="browser-strip-rail-label">SOUNDS</span>
          <span aria-hidden="true">▸</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="browser-strip" aria-label="Sounds">
      <div className="browser-strip-head">
        <span className="panel-kicker">SOUNDS</span>
        <span
          className="browser-strip-target"
          title="Sounds assign to the selected pad or instrument; loops can be added to the arrangement track"
        >
          {drumPad ? (
            <>
              <span>LOOPS → {arrangementTarget?.name ?? "none"}</span>
              <span className="browser-strip-subtarget">DRUM SOUND → {drumPad.name}</span>
            </>
          ) : instrumentTarget ? (
            <span>LOOPS → {arrangementTarget?.name ?? "none"}</span>
          ) : arrangementTarget ? (
            <span>LOOPS → {arrangementTarget.name}</span>
          ) : (
            <span>no target</span>
          )}
        </span>
        <button
          type="button"
          className="browser-strip-collapse"
          onClick={() => setOpen(false)}
          aria-label="Collapse sounds browser"
          title="Collapse the sounds strip"
        >
          ◂
        </button>
      </div>
      <div className="browser-strip-body">
        <Suspense fallback={<div className="panel-loading">Loading sounds…</div>}>
          <SampleBrowser
            assets={FACTORY_ASSETS}
            currentId={currentId}
            onSelect={assign}
            allowNone={Boolean(drumPad || instrumentTarget)}
            showDropZone
            onPreviewLoop={previewLoop}
            onAddLoop={arrangementTarget ? addLoopToArrangement : undefined}
            loopStarter={songStarter}
            view={browserView}
            onViewChange={setBrowserView}
            targetTrack={track}
          />
        </Suspense>
      </div>
    </aside>
  );
}
