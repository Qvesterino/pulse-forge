import { useEffect, useMemo, useState } from "react";
import {
  addAudioClip,
  assignLivePad,
  createLiveSet,
  deleteLiveSet,
  duplicateLiveSet,
  fittedLoopPlacement,
  renameLiveSet,
  selectLiveSet,
  setLiveSetOptions,
} from "../commands/commands";
import { BAR_TICKS } from "../project-model/types";
import { sceneSecondsToBars, tempoAtTick } from "../project-model/scene-time";
import type { LiveSet, LiveSetPad } from "../project-model/types";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import { KYX_SAMPLE_MIME } from "./SampleBrowser";
import { useArrangementCapture, useDoc, useServices } from "./context";
import { usePlayheadBar } from "./playhead";

const EMPTY_USER_ASSETS: UserSampleAsset[] = [];
const EMPTY_LIVE_SETS: LiveSet[] = [];
const factoryAssetsById = new Map(FACTORY_ASSETS.map((asset) => [asset.id, asset]));
const LOOP_LENGTHS = [1, 2, 4, 8, 16] as const;

function sampleIdFromDrop(data: DataTransfer): string | null {
  const custom = data.getData(KYX_SAMPLE_MIME).trim();
  if (custom) return custom;
  const plain = data.getData("text/plain").trim();
  return plain && /^[a-z0-9._-]{1,512}$/i.test(plain) ? plain : null;
}

function padFromAsset(id: string, userAssets: readonly UserSampleAsset[]): LiveSetPad {
  const userAsset = userAssets.find((asset) => asset.id === id);
  if (userAsset) {
    const isLoop =
      userAsset.loopMetadata?.isLoop === false
        ? false
        : userAsset.loopMetadata?.isLoop === true || (Number.isFinite(userAsset.bpm) && (userAsset.bpm ?? 0) >= 40);
    return {
      slot: 0,
      bufferId: userAsset.id,
      name: userAsset.name,
      ...(Number.isFinite(userAsset.bpm) && (userAsset.bpm ?? 0) >= 40 && (userAsset.bpm ?? 0) <= 240
        ? { bpm: userAsset.bpm }
        : {}),
      ...(isLoop ? { loop: true } : {}),
    };
  }
  return { slot: 0, bufferId: id, name: factoryAssetsById.get(id)?.name ?? id };
}

export function LivePadsPanel() {
  const services = useServices();
  const doc = useDoc();
  const capture = useArrangementCapture();
  const playheadBar = usePlayheadBar(services.transport);
  const [userAssets, setUserAssets] = useState<UserSampleAsset[]>(EMPTY_USER_ASSETS);
  const [nameDraft, setNameDraft] = useState("");
  const [message, setMessage] = useState("");
  const [busyPad, setBusyPad] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void services.userSamples.list().then((assets) => {
      if (active) setUserAssets(assets);
    });
    return () => {
      active = false;
    };
  }, [services.userSamples]);

  const sets = doc.liveSets ?? EMPTY_LIVE_SETS;
  const liveSet = sets.find((set) => set.id === doc.activeLiveSetId) ?? sets[0];
  const tracks = useMemo(() => doc.tracks.filter((track) => track.kind !== "generative"), [doc.tracks]);
  const trackId =
    liveSet?.trackId && tracks.some((track) => track.id === liveSet.trackId) ? liveSet.trackId : tracks[0]?.id;
  const clips = doc.arrangement.audioClips ?? [];

  useEffect(() => {
    setNameDraft(liveSet?.name ?? "");
  }, [liveSet?.id, liveSet?.name]);

  useEffect(() => {
    if (capture.message) setMessage(capture.message);
  }, [capture.message]);

  const assetName = (id: string): string =>
    userAssets.find((asset) => asset.id === id)?.name ?? factoryAssetsById.get(id)?.name ?? id;

  const assign = (slot: number, bufferId: string) => {
    if (!liveSet) return;
    const asset = padFromAsset(bufferId, userAssets);
    asset.slot = slot;
    services.store.execute(assignLivePad(doc, liveSet.id, asset));
    setMessage(`${asset.name} assigned to pad ${slot + 1}.`);
  };

  const launch = async (pad: LiveSetPad) => {
    if (!liveSet) return;
    const destinationId =
      liveSet.trackId && tracks.some((track) => track.id === liveSet.trackId) ? liveSet.trackId : trackId;
    if (!destinationId) {
      setMessage("Add an audio-capable track before launching a pad.");
      return;
    }
    setBusyPad(pad.slot);
    setMessage("");
    try {
      await services.core.initialSampleBankHydration;
      const source = services.bank.get(pad.bufferId);
      if (!source) throw new Error("This loop is still loading or its audio could not be restored.");

      const currentDoc = services.store.getDoc();
      if (capture.capturing) {
        const captureMessage = services.capture.toggleLivePad(liveSet.id, pad.slot, destinationId, source.duration);
        setMessage(captureMessage);
        return;
      }
      const barTick = Math.max(0, services.transport.position);
      const startBar = services.transport.playing
        ? Math.floor(barTick / BAR_TICKS) + 1
        : Math.max(0, Math.ceil((barTick - 1e-6) / BAR_TICKS));
      const startTick = startBar * BAR_TICKS;
      const targetBpm = tempoAtTick(currentDoc.arrangement.clips, currentDoc.scenes, startTick, currentDoc.bpm);
      const fit = pad.bpm
        ? fittedLoopPlacement(source.duration, pad.bpm, targetBpm, currentDoc.timeSignature.numerator)
        : null;
      const lengthBars = pad.loop
        ? Math.max(liveSet.loopBars, fit?.lengthBars ?? 0)
        : Math.max(0.25, sceneSecondsToBars(source.duration, targetBpm));
      const patch = {
        ...(pad.loop ? { loop: true } : {}),
        ...(fit ? { stretchMode: "stretch" as const, stretchRate: fit.rate } : {}),
        liveSetId: liveSet.id,
        livePadSlot: pad.slot,
      };

      if (!services.transport.playing) services.playback.seek(startTick);
      services.playback.setMode("song");
      services.store.execute(addAudioClip(currentDoc, destinationId, pad.bufferId, startBar, lengthBars, patch));
      if (!services.transport.playing) services.playback.playPause();
      const loopNotice =
        pad.loop && fit && fit.lengthBars > liveSet.loopBars
          ? ` Source loop needs ${fit.lengthBars} bars, so the clip keeps its full length.`
          : "";
      setMessage(
        `Queued ${pad.name} for bar ${startBar + 1}. The audio clip is editable in the arrangement.${loopNotice}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not launch this Live Pad.");
    } finally {
      setBusyPad(null);
    }
  };

  const liveCaptureState = (slot: number) => {
    const tick = Math.max(0, services.transport.position);
    return capture.livePads.find(
      (voice) =>
        voice.setId === liveSet?.id &&
        voice.slot === slot &&
        (voice.endTick === null || tick < voice.endTick) &&
        (voice.stopTick === null || tick < voice.stopTick),
    );
  };

  const setPlaying = (slot: number): boolean => {
    if (!services.transport.playing || !liveSet) return false;
    const tick = Math.max(0, services.transport.position);
    const liveState = liveCaptureState(slot);
    const capturedVoicePlaying =
      liveState !== undefined &&
      tick >= liveState.startTick &&
      (liveState.endTick === null || tick < liveState.endTick) &&
      (liveState.stopTick === null || tick < liveState.stopTick);
    return (
      capturedVoicePlaying ||
      clips.some(
        (clip) =>
          clip.liveSetId === liveSet.id &&
          clip.livePadSlot === slot &&
          playheadBar >= clip.startBar &&
          playheadBar < clip.startBar + clip.lengthBars,
      )
    );
  };

  return (
    <section className="live-pads-panel" aria-label="Live Pads">
      <header className="live-pads-header">
        <div>
          <span className="panel-kicker">PERFORMANCE</span>
          <h2 className="panel-title">LIVE PADS</h2>
        </div>
        <div className="live-pads-set-actions">
          {sets.length > 0 && (
            <select
              aria-label="Live Set"
              value={liveSet?.id ?? ""}
              onChange={(event) => services.store.execute(selectLiveSet(doc, event.target.value))}
            >
              {sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => services.store.execute(createLiveSet(doc, `Live Set ${sets.length + 1}`))}
            disabled={sets.length >= 32}
            title="Create a project-local 4×4 pad set"
          >
            + SET
          </button>
          {liveSet && (
            <>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => services.store.execute(duplicateLiveSet(doc, liveSet.id))}
              >
                DUPLICATE
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => services.store.execute(deleteLiveSet(doc, liveSet.id))}
              >
                DELETE
              </button>
            </>
          )}
        </div>
      </header>

      {liveSet ? (
        <>
          <div className="live-pads-options">
            <label>
              SET NAME
              <input
                aria-label="Live Set name"
                value={nameDraft}
                maxLength={64}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => {
                  if (liveSet && nameDraft.trim() && nameDraft.trim() !== liveSet.name) {
                    services.store.execute(renameLiveSet(doc, liveSet.id, nameDraft));
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </label>
            <label>
              ROUTE
              <select
                aria-label="Live Set destination track"
                value={trackId ?? ""}
                onChange={(event) =>
                  services.store.execute(setLiveSetOptions(doc, liveSet.id, { trackId: event.target.value || null }))
                }
                disabled={tracks.length === 0}
              >
                {tracks.length === 0 ? (
                  <option value="">No audio track</option>
                ) : (
                  tracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              LOOP LENGTH
              <select
                aria-label="Live Pad loop length"
                value={liveSet.loopBars}
                onChange={(event) =>
                  services.store.execute(
                    setLiveSetOptions(doc, liveSet.id, { loopBars: Number(event.target.value) as LiveSet["loopBars"] }),
                  )
                }
              >
                {LOOP_LENGTHS.map((bars) => (
                  <option key={bars} value={bars}>
                    {bars} BARS
                  </option>
                ))}
              </select>
            </label>
            <span className="live-pads-mode-hint">
              {capture.capturing
                ? "CAPTURE: LOOP PADS TOGGLE ON BAR LINES · ONE-SHOTS STAY FINITE"
                : "LOOPS LAUNCH ON THE NEXT BAR · AUDIO CLIPS APPEAR IN SONG ARRANGEMENT"}
            </span>
          </div>

          <div className="live-pads-grid" role="grid" aria-label={`${liveSet.name} pads`}>
            {Array.from({ length: 16 }, (_, slot) => {
              const pad = liveSet.pads.find((candidate) => candidate.slot === slot);
              const active = setPlaying(slot);
              const captureState = liveCaptureState(slot);
              const queuedStart = captureState !== undefined && services.transport.position < captureState.startTick;
              const queuedStop = captureState?.stopTick !== null && captureState?.stopTick !== undefined;
              const buttonStatus = queuedStart
                ? "queued to start"
                : queuedStop
                  ? "stop queued"
                  : active
                    ? "playing"
                    : "";
              return (
                <div
                  className={`live-pad-cell${pad ? " assigned" : " empty"}${active ? " playing" : ""}${queuedStart || queuedStop ? " queued" : ""}`}
                  key={slot}
                  role="gridcell"
                  onDragOver={(event) => {
                    if (
                      event.dataTransfer.types.includes(KYX_SAMPLE_MIME) ||
                      event.dataTransfer.types.includes("text/plain")
                    ) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                    }
                  }}
                  onDrop={(event) => {
                    const bufferId = sampleIdFromDrop(event.dataTransfer);
                    if (!bufferId) return;
                    event.preventDefault();
                    assign(slot, bufferId);
                  }}
                >
                  <button
                    type="button"
                    className="live-pad"
                    disabled={!pad || busyPad !== null}
                    onClick={() => pad && void launch(pad)}
                    aria-label={
                      pad
                        ? `${capture.capturing && pad.loop ? "Toggle" : "Launch"} pad ${slot + 1}, ${pad.name}${buttonStatus ? `, ${buttonStatus}` : ""}`
                        : `Empty pad ${slot + 1}, drop a sample loop here`
                    }
                    title={
                      !pad
                        ? "Drag a loop or sample here"
                        : queuedStart && capture.capturing
                          ? "Press again to cancel the queued start"
                          : queuedStop && capture.capturing
                            ? "Press again to cancel the queued stop"
                            : active && capture.capturing && pad.loop
                              ? `Queue ${pad.name} to stop at the next bar`
                              : `Launch ${pad.name} at the next bar`
                    }
                  >
                    <span className="live-pad-number">{String(slot + 1).padStart(2, "0")}</span>
                    <span className="live-pad-name">{pad ? assetName(pad.bufferId) : "DROP LOOP"}</span>
                    {pad?.bpm && (
                      <span className="live-pad-meta">
                        {Math.round(pad.bpm)} BPM{pad.loop ? " · LOOP" : ""}
                      </span>
                    )}
                    {busyPad === slot && <span className="live-pad-meta">LOADING…</span>}
                    {capture.capturing && captureState && (
                      <span className="live-pad-meta">
                        {queuedStart ? "QUEUED" : queuedStop ? "STOP QUEUED" : active ? "CAPTURING" : ""}
                      </span>
                    )}
                  </button>
                  {pad && (
                    <button
                      type="button"
                      className="live-pad-clear"
                      aria-label={`Clear pad ${slot + 1}`}
                      title="Clear pad assignment"
                      onClick={() => {
                        services.store.execute(assignLivePad(doc, liveSet.id, null, slot));
                        setMessage(`Pad ${slot + 1} cleared.`);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="live-pads-empty">
          <p>Create a Live Set, then drag loops from the Sounds browser onto the pads.</p>
          <button type="button" className="btn" onClick={() => services.store.execute(createLiveSet(doc))}>
            CREATE LIVE SET
          </button>
        </div>
      )}
      <div className="live-pads-status" aria-live="polite">
        {message}
      </div>
    </section>
  );
}
