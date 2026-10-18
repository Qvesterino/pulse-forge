import { useEffect, useMemo, useState } from "react";
import {
  addMasteringAlbumTrack,
  createMasteringAlbum,
  estimateMasteringAlbumDuration,
  MASTERING_ALBUM_GAP_MAX_SECONDS,
  MASTERING_ALBUM_TRACK_LIMIT,
  MasteringAlbumRepository,
  moveMasteringAlbumTrack,
  removeMasteringAlbumTrack,
  setMasteringAlbumGap,
  summarizeMasteringAlbumDelivery,
  type MasteringAlbumRecord,
  type MasteringAlbumTrack,
  type MasteringAlbumTrackDeliveryAudit,
} from "../mastering/albumStore";
import type { MasteringSessionSummary } from "../mastering/sessionStore";
import type { MasteringRenderSampleRate } from "../mastering/sampleRates";
import { NumericDraftInput } from "./NumericDraftInput";

export interface MasteringAlbumBatchExportOptions {
  format: "wav" | "flac" | "mp3";
  sampleRate: MasteringRenderSampleRate;
  bitDepth: 16 | 24 | 32;
  mp3Bitrate: 192 | 320;
  normalizeToLufs: number | null;
  truePeakCeilingDbtp: number;
  maximumGainDb: number;
}

export interface MasteringAlbumGainNormalizationOptions {
  targetLufs: number;
  truePeakCeilingDbtp: number;
  maximumGainDb: number;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "Duration unavailable while a session is missing";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function albumWithTitle(album: MasteringAlbumRecord, title: string): MasteringAlbumRecord {
  return { ...album, title: title.trim(), updatedAt: new Date().toISOString() };
}

export function MasteringAlbumPanel({
  sessions,
  activeSessionId,
  onOpenSession,
  onAudition,
  onStopAudition,
  onBatchExport,
  auditioningAlbumId = null,
  auditionStatus = "",
  externallyBusy = false,
  deliveryRefreshToken = 0,
}: {
  sessions: MasteringSessionSummary[];
  activeSessionId: string | null;
  onOpenSession(sessionId: string): void;
  onAudition?(album: MasteringAlbumRecord, normalization?: MasteringAlbumGainNormalizationOptions): void;
  onStopAudition?(): void;
  onBatchExport?(album: MasteringAlbumRecord, options: MasteringAlbumBatchExportOptions): void;
  auditioningAlbumId?: string | null;
  auditionStatus?: string;
  externallyBusy?: boolean;
  deliveryRefreshToken?: number;
}) {
  const repository = useMemo(() => new MasteringAlbumRepository(), []);
  const [albums, setAlbums] = useState<MasteringAlbumRecord[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [sessionToAdd, setSessionToAdd] = useState("");
  const [gapDrafts, setGapDrafts] = useState<Record<string, string>>({});
  const [batchFormat, setBatchFormat] = useState<MasteringAlbumBatchExportOptions["format"]>("wav");
  const [batchSampleRate, setBatchSampleRate] = useState<MasteringRenderSampleRate>(44_100);
  const [batchBitDepth, setBatchBitDepth] = useState<16 | 24 | 32>(24);
  const [batchMp3Bitrate, setBatchMp3Bitrate] = useState<192 | 320>(320);
  const [batchNormalize, setBatchNormalize] = useState(false);
  const [batchTargetLufs, setBatchTargetLufs] = useState(-14);
  const [batchTruePeakCeiling, setBatchTruePeakCeiling] = useState(-1.5);
  const [batchMaximumGain, setBatchMaximumGain] = useState(12);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const controlsBusy = busy || externallyBusy;

  useEffect(() => {
    let active = true;
    void repository.list().then(
      (records) => {
        if (!active) return;
        setAlbums(records);
        setSelectedAlbumId((current) => current || records[0]?.id || "");
      },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load album sequences.");
      },
    );
    return () => {
      active = false;
    };
  }, [deliveryRefreshToken, repository]);

  const selectedAlbum = albums.find((album) => album.id === selectedAlbumId) ?? null;
  useEffect(() => {
    setTitleDraft(selectedAlbum?.title ?? "");
    setGapDrafts({});
  }, [selectedAlbum?.id, selectedAlbum?.title]);

  useEffect(() => {
    if (activeSessionId && sessions.some((session) => session.id === activeSessionId)) {
      setSessionToAdd((current) => current || activeSessionId);
    } else if (!sessions.some((session) => session.id === sessionToAdd)) {
      setSessionToAdd(sessions[0]?.id ?? "");
    }
  }, [activeSessionId, sessionToAdd, sessions]);

  const sessionMap = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const deliveryAudit = selectedAlbum ? summarizeMasteringAlbumDelivery(selectedAlbum, sessionMap) : null;
  const deliveryByTrackId = useMemo(
    () => new Map(deliveryAudit?.tracks.map((track) => [track.trackId, track]) ?? []),
    [deliveryAudit],
  );
  const batchTracksReady = Boolean(
    selectedAlbum &&
    selectedAlbum.tracks.length > 0 &&
    selectedAlbum.tracks.every((track) => sessionMap.has(track.sessionId)),
  );
  const batchMp3RateUnsupported = batchFormat === "mp3" && batchSampleRate === 96_000;
  const estimatedDuration = selectedAlbum
    ? estimateMasteringAlbumDuration(
        selectedAlbum,
        new Map(sessions.map((session) => [session.id, session.durationSeconds])),
      )
    : null;

  async function persist(next: MasteringAlbumRecord, success: string) {
    setBusy(true);
    setError("");
    try {
      await repository.save(next);
      setAlbums((current) =>
        [next, ...current.filter((album) => album.id !== next.id)].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
      );
      setSelectedAlbumId(next.id);
      setStatus(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the album sequence.");
    } finally {
      setBusy(false);
    }
  }

  async function createAlbum() {
    setError("");
    try {
      const album = createMasteringAlbum(titleDraft || `Album ${albums.length + 1}`);
      await persist(album, `Created album sequence “${album.title}”.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Enter a valid album title.");
    }
  }

  async function saveTitle() {
    if (!selectedAlbum) return;
    const title = titleDraft.trim();
    if (!title) {
      setError("Enter an album title first.");
      return;
    }
    await persist(albumWithTitle(selectedAlbum, title), "Album title saved.");
  }

  async function addTrack() {
    if (!selectedAlbum || !sessionToAdd) return;
    try {
      const next = addMasteringAlbumTrack(selectedAlbum, sessionToAdd);
      await persist(next, `Added ${sessionMap.get(sessionToAdd)?.fileName ?? "session"} to the sequence.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add the session to this album.");
    }
  }

  async function updateTrack(
    track: MasteringAlbumTrack,
    operation: (album: MasteringAlbumRecord) => MasteringAlbumRecord,
  ) {
    if (!selectedAlbum) return;
    try {
      await persist(
        operation(selectedAlbum),
        `Updated “${sessionMap.get(track.sessionId)?.fileName ?? "missing track"}”.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the album sequence.");
    }
  }

  async function deleteAlbum() {
    if (!selectedAlbum || !window.confirm(`Delete the album sequence “${selectedAlbum.title}”?`)) return;
    setBusy(true);
    setError("");
    try {
      await repository.delete(selectedAlbum.id);
      const remaining = albums.filter((album) => album.id !== selectedAlbum.id);
      setAlbums(remaining);
      setSelectedAlbumId(remaining[0]?.id ?? "");
      setStatus(`Deleted album sequence “${selectedAlbum.title}”. The mastering sessions and audio files were kept.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the album sequence.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mastering-album" aria-labelledby="mastering-album-title">
      <div className="mastering-album-heading">
        <div>
          <span className="mastering-panel-kicker">ALBUM SEQUENCING</span>
          <h4 id="mastering-album-title">Plan track order and gaps</h4>
          <p>
            Build a saved sequence from local mastering sessions. This plans playback order and silence between songs;
            every mastered song remains a separate delivery file.
          </p>
        </div>
        <div className="mastering-album-create">
          <label>
            <span>NEW ALBUM</span>
            <input
              aria-label="New album title"
              maxLength={120}
              placeholder="Album title"
              value={titleDraft}
              disabled={controlsBusy}
              onChange={(event) => setTitleDraft(event.currentTarget.value)}
            />
          </label>
          <button type="button" className="btn btn-small" disabled={controlsBusy} onClick={() => void createAlbum()}>
            Create album
          </button>
        </div>
      </div>

      {albums.length > 0 && (
        <div className="mastering-album-controls">
          <label>
            <span>SAVED ALBUM</span>
            <select
              aria-label="Saved album sequences"
              value={selectedAlbum?.id ?? ""}
              disabled={controlsBusy}
              onChange={(event) => setSelectedAlbumId(event.currentTarget.value)}
            >
              {albums.map((album) => (
                <option value={album.id} key={album.id}>
                  {album.title} · {album.tracks.length} tracks
                </option>
              ))}
            </select>
          </label>
          {selectedAlbum && (
            <>
              <label>
                <span>ALBUM TITLE</span>
                <input
                  aria-label="Album title"
                  maxLength={120}
                  value={titleDraft}
                  disabled={controlsBusy}
                  onChange={(event) => setTitleDraft(event.currentTarget.value)}
                />
              </label>
              <button type="button" className="btn btn-small" disabled={controlsBusy} onClick={() => void saveTitle()}>
                Save title
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={controlsBusy}
                onClick={() => void deleteAlbum()}
              >
                Delete album
              </button>
            </>
          )}
        </div>
      )}

      {selectedAlbum && (
        <>
          <div className="mastering-album-add-track">
            <label>
              <span>ADD SAVED SESSION</span>
              <select
                aria-label="Mastering session to add to album"
                value={sessionToAdd}
                disabled={controlsBusy || sessions.length === 0}
                onChange={(event) => setSessionToAdd(event.currentTarget.value)}
              >
                {sessions.length === 0 && <option value="">No saved mastering sessions</option>}
                {sessions.map((session) => (
                  <option value={session.id} key={session.id}>
                    {session.fileName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-small"
              disabled={controlsBusy || !sessionToAdd || selectedAlbum.tracks.length >= MASTERING_ALBUM_TRACK_LIMIT}
              onClick={() => void addTrack()}
            >
              Add track
            </button>
          </div>
          <div className="mastering-album-summary" aria-live="polite">
            <strong>{selectedAlbum.tracks.length} tracks</strong>
            <span>Estimated sequence duration: {formatDuration(estimatedDuration)}</span>
            {auditioningAlbumId === selectedAlbum.id ? (
              <button type="button" className="btn btn-small" onClick={onStopAudition}>
                Stop album audition
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-small"
                disabled={controlsBusy || selectedAlbum.tracks.length === 0 || !onAudition}
                onClick={() => {
                  if (batchNormalize) {
                    onAudition?.(selectedAlbum, {
                      targetLufs: batchTargetLufs,
                      truePeakCeilingDbtp: batchTruePeakCeiling,
                      maximumGainDb: batchMaximumGain,
                    });
                  } else {
                    onAudition?.(selectedAlbum);
                  }
                }}
              >
                {batchNormalize ? "Audition gain-matched sequence" : "Audition album sequence"}
              </button>
            )}
          </div>
          {selectedAlbum.tracks.length > 0 && (
            <div
              className="mastering-album-delivery mastering-album-batch-export"
              role="group"
              aria-label="Batch album delivery"
            >
              <strong>BATCH DELIVERY</strong>
              <div className="mastering-album-controls">
                <label>
                  <span>FORMAT</span>
                  <select
                    aria-label="Album batch export format"
                    value={batchFormat}
                    disabled={controlsBusy}
                    onChange={(event) => {
                      const format = event.target.value as MasteringAlbumBatchExportOptions["format"];
                      setBatchFormat(format);
                      if (format === "mp3" && batchSampleRate === 96_000) setBatchSampleRate(48_000);
                      if (format === "flac" && batchBitDepth === 32) setBatchBitDepth(24);
                    }}
                  >
                    <option value="wav">WAV</option>
                    <option value="flac">FLAC</option>
                    <option value="mp3">MP3</option>
                  </select>
                </label>
                <label>
                  <span>RENDER RATE</span>
                  <select
                    aria-label="Album batch export render rate"
                    value={batchSampleRate}
                    disabled={controlsBusy}
                    onChange={(event) => setBatchSampleRate(Number(event.target.value) as MasteringRenderSampleRate)}
                  >
                    <option value={44_100}>44.1 kHz</option>
                    <option value={48_000}>48 kHz</option>
                    {batchFormat !== "mp3" && <option value={96_000}>96 kHz</option>}
                  </select>
                </label>
                {batchFormat === "mp3" ? (
                  <label>
                    <span>BITRATE</span>
                    <select
                      aria-label="Album batch MP3 bitrate"
                      value={batchMp3Bitrate}
                      disabled={controlsBusy}
                      onChange={(event) => setBatchMp3Bitrate(Number(event.target.value) as 192 | 320)}
                    >
                      <option value={192}>192 kbps</option>
                      <option value={320}>320 kbps</option>
                    </select>
                  </label>
                ) : (
                  <label>
                    <span>BIT DEPTH</span>
                    <select
                      aria-label={`Album batch ${batchFormat.toUpperCase()} bit depth`}
                      value={batchBitDepth === 32 ? 32 : batchBitDepth}
                      disabled={controlsBusy}
                      onChange={(event) => setBatchBitDepth(Number(event.target.value) as 16 | 24 | 32)}
                    >
                      <option value={16}>16-bit</option>
                      <option value={24}>24-bit</option>
                      {batchFormat === "wav" && <option value={32}>32-bit float</option>}
                    </select>
                  </label>
                )}
                <label className="mastering-album-normalize-toggle">
                  <span>GAIN-ONLY LOUDNESS MATCH</span>
                  <input
                    type="checkbox"
                    aria-label="Match album track loudness using gain only"
                    checked={batchNormalize}
                    disabled={controlsBusy}
                    onChange={(event) => setBatchNormalize(event.currentTarget.checked)}
                  />
                </label>
                {batchNormalize && (
                  // These three drive the gain applied to the EXPORTED PCM of
                  // every album track, so an unguarded parse is an audio
                  // defect, not a display one. They used to be raw
                  // `Number(event.currentTarget.value)` onChange handlers:
                  //   empty field → Number("") === 0 → normalizeToLufs 0
                  //     (measured reaching onBatchExport), i.e. 0 LUFS-I;
                  //   "99"        → accepted unclamped (measured reaching
                  //     onAudition), far outside the declared [-24, -6];
                  //   empty TP    → truePeakCeilingDbtp 0, ceiling disabled.
                  // NumericDraftInput gives the project's documented
                  // draft/commit contract (one write per edit, empty = cancel,
                  // Escape abandons) and the parent clamps to the same range
                  // the `min`/`max` attributes advertise.
                  <>
                    <label>
                      <span>TARGET LUFS-I</span>
                      <NumericDraftInput
                        aria-label="Album batch target integrated loudness in LUFS"
                        min={-24}
                        max={-6}
                        step={0.1}
                        value={batchTargetLufs}
                        disabled={controlsBusy}
                        onCommit={(value) => setBatchTargetLufs(Math.min(-6, Math.max(-24, value)))}
                      />
                    </label>
                    <label>
                      <span>TRUE-PEAK CEILING</span>
                      <NumericDraftInput
                        aria-label="Album batch true-peak ceiling in dBTP"
                        min={-6}
                        max={0}
                        step={0.1}
                        value={batchTruePeakCeiling}
                        disabled={controlsBusy}
                        onCommit={(value) => setBatchTruePeakCeiling(Math.min(0, Math.max(-6, value)))}
                      />
                    </label>
                    <label>
                      <span>MAXIMUM BOOST</span>
                      <NumericDraftInput
                        aria-label="Album batch maximum gain boost in decibels"
                        min={0}
                        max={24}
                        step={1}
                        value={batchMaximumGain}
                        disabled={controlsBusy}
                        onCommit={(value) => setBatchMaximumGain(Math.min(24, Math.max(0, value)))}
                      />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={controlsBusy || !batchTracksReady || !onBatchExport || batchMp3RateUnsupported}
                  onClick={() =>
                    onBatchExport?.(selectedAlbum, {
                      format: batchFormat,
                      sampleRate: batchSampleRate,
                      bitDepth: batchBitDepth,
                      mp3Bitrate: batchMp3Bitrate,
                      normalizeToLufs: batchNormalize ? batchTargetLufs : null,
                      truePeakCeilingDbtp: batchTruePeakCeiling,
                      maximumGainDb: batchMaximumGain,
                    })
                  }
                >
                  Export {selectedAlbum.tracks.length} tracks
                </button>
              </div>
              <small>
                Tracks render and verify one at a time with each session&apos;s saved master settings. Outputs include a
                JSON report. Optional loudness match applies one static gain to each track, capped by maximum boost and
                the true-peak ceiling; it adds no compression and does not change saved sessions.
                {batchMp3RateUnsupported
                  ? " MP3 supports 44.1 or 48 kHz."
                  : " Your browser may ask to allow multiple downloads."}
              </small>
            </div>
          )}
          {auditionStatus && (
            <p className="mastering-album-audition-status" role="status" aria-live="polite">
              {auditionStatus}
              {auditioningAlbumId === selectedAlbum.id && " Sequence order and gaps are captured for this audition."}
            </p>
          )}
          {deliveryAudit && selectedAlbum.tracks.length > 0 && (
            <div className="mastering-album-delivery" role="group" aria-label="Album delivery consistency report">
              <strong>DELIVERY CONSISTENCY</strong>
              <span>
                {deliveryAudit.currentReportCount}/{selectedAlbum.tracks.length} current export reports ·{" "}
                {deliveryAudit.measuredTrackCount} decoded
              </span>
              {deliveryAudit.lufsSpreadDb != null && deliveryAudit.lufsMedian != null ? (
                <span>
                  LUFS-I spread {deliveryAudit.lufsSpreadDb.toFixed(1)} LU across {deliveryAudit.lufsMeasuredTrackCount}{" "}
                  tracks · median {deliveryAudit.lufsMedian.toFixed(1)} LUFS
                </span>
              ) : (
                <span>Decode at least two current track exports to compare integrated loudness.</span>
              )}
              {deliveryAudit.truePeakMaxDb != null && (
                <span>
                  Highest decoded true peak {deliveryAudit.truePeakMaxDb.toFixed(1)} dBTP across{" "}
                  {deliveryAudit.truePeakMeasuredTrackCount} tracks
                </span>
              )}
              <small>
                Report only; it does not change any session settings. Review each track against its own delivery target.
              </small>
            </div>
          )}
          {selectedAlbum.tracks.length > 0 ? (
            <ol className="mastering-album-track-list" aria-label={`${selectedAlbum.title} track order`}>
              {selectedAlbum.tracks.map((track, index) => {
                const session = sessionMap.get(track.sessionId);
                const gapValue = gapDrafts[track.id] ?? String(track.gapAfterSeconds);
                const delivery = deliveryByTrackId.get(track.id);
                return (
                  <li className="mastering-album-track" key={track.id}>
                    <span className="mastering-album-track-index" aria-label={`Track ${index + 1}`}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="mastering-album-track-info">
                      <strong>{session?.fileName ?? "Missing mastering session"}</strong>
                      <small>
                        {session
                          ? `${formatDuration(session.durationSeconds)} · ${session.channels} ch · ${session.sourceSampleRate} Hz`
                          : `Session ${track.sessionId} was deleted or is unavailable`}
                      </small>
                      {delivery && <AlbumDeliveryStatus audit={delivery} />}
                    </div>
                    {index < selectedAlbum.tracks.length - 1 && (
                      <label className="mastering-album-gap">
                        <span>Gap after track</span>
                        <input
                          aria-label={`Gap after track ${index + 1} in seconds`}
                          type="number"
                          min={0}
                          max={MASTERING_ALBUM_GAP_MAX_SECONDS}
                          step={0.1}
                          value={gapValue}
                          disabled={controlsBusy}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setGapDrafts((current) => ({ ...current, [track.id]: value }));
                          }}
                          onBlur={(event) => {
                            const rawValue = event.currentTarget.value;
                            const seconds = Number(rawValue);
                            if (!Number.isFinite(seconds) || seconds < 0 || seconds > MASTERING_ALBUM_GAP_MAX_SECONDS) {
                              setGapDrafts((current) => ({ ...current, [track.id]: String(track.gapAfterSeconds) }));
                              setError(`Track gaps must be between 0 and ${MASTERING_ALBUM_GAP_MAX_SECONDS} seconds.`);
                              return;
                            }
                            setGapDrafts((current) => ({ ...current, [track.id]: String(seconds) }));
                            void updateTrack(track, (album) => setMasteringAlbumGap(album, track.id, seconds));
                          }}
                        />
                        <span>s</span>
                      </label>
                    )}
                    <div className="mastering-album-track-actions">
                      {session && (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={controlsBusy}
                          onClick={() => onOpenSession(session.id)}
                        >
                          Open session
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`Move ${session?.fileName ?? "missing track"} up`}
                        disabled={controlsBusy || index === 0}
                        onClick={() => void updateTrack(track, (album) => moveMasteringAlbumTrack(album, track.id, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`Move ${session?.fileName ?? "missing track"} down`}
                        disabled={controlsBusy || index === selectedAlbum.tracks.length - 1}
                        onClick={() => void updateTrack(track, (album) => moveMasteringAlbumTrack(album, track.id, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`Remove ${session?.fileName ?? "missing track"} from album`}
                        disabled={controlsBusy}
                        onClick={() => void updateTrack(track, (album) => removeMasteringAlbumTrack(album, track.id))}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="mastering-album-empty">Add saved mastering sessions to begin arranging this album.</p>
          )}
        </>
      )}

      {albums.length === 0 && (
        <p className="mastering-album-empty">
          Create an album sequence to arrange the saved mastering sessions on this device.
        </p>
      )}
      {status && (
        <p className="mastering-album-status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="mastering-album-status" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function AlbumDeliveryStatus({ audit }: { audit: MasteringAlbumTrackDeliveryAudit }) {
  const summary = audit.deliverySummary;
  let text: string;
  switch (audit.state) {
    case "missing-session":
      text = "Delivery metrics unavailable · session missing";
      break;
    case "no-report":
      text = "No checked delivery export yet";
      break;
    case "stale":
      text = "Delivery report stale · render and export this revision again";
      break;
    case "not-measured":
      text = `Exported ${summary?.format.toUpperCase() ?? "file"} · decoded loudness/true peak unavailable`;
      break;
    case "measured": {
      const metrics = [
        summary?.lufsIntegrated == null ? null : `${summary.lufsIntegrated.toFixed(1)} LUFS-I`,
        summary?.truePeakDb == null ? null : `${summary.truePeakDb.toFixed(1)} dBTP`,
      ].filter(Boolean);
      const relativeLoudness =
        audit.lufsOffsetFromMedianDb == null
          ? ""
          : ` · ${audit.lufsOffsetFromMedianDb > 0 ? "+" : ""}${audit.lufsOffsetFromMedianDb.toFixed(1)} LU vs album median`;
      text = `Current ${summary?.format.toUpperCase() ?? "delivery"} · ${metrics.length ? metrics.join(" · ") : "audio decoded; no finite metrics"}${relativeLoudness}`;
      break;
    }
  }
  return (
    <small className="mastering-album-track-delivery" data-state={audit.state}>
      {text}
      {summary && audit.state !== "stale" && ` · ${summary.fileName}`}
    </small>
  );
}
