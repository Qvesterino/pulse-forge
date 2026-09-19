import { useEffect, useMemo, useState } from "react";
import { useMacros, useMaster, useReturns, useSelection, useSelectionStore, useServices, useTracks } from "./context";
import {
  addEffectToTracks,
  addMacroMapping,
  addToGroup,
  clearAllMutes,
  clearAllSolos,
  createReturnTrack,
  deleteTrack,
  duplicateTrack,
  removeEffectFromTracks,
  removeFromGroup,
  setEffectBypassOnTracks,
  setGroupCollapsed,
  setGroupMute,
  setGroupSolo,
  setMasterConfig,
  setReturnGain,
  setTrackColor,
  setTrackParams,
  setTrackSend,
} from "../commands/commands";
import type { EffectType, Track } from "../project-model/types";
import { EFFECT_DEFS } from "../effects/registry";
import { Slider } from "./controls";
import { Meter } from "./Meter";
import { MasterMeter, MasterStereoMeters } from "./MasterMeter";
import { trackBadge } from "./TrackTabs";
import { FreezeButton } from "./FreezeButton";
import { MacroPerformanceBar } from "./MacroPerformanceBar";

export function Mixer({ onOpenFxPanel }: { onOpenFxPanel?: () => void } = {}) {
  const services = useServices();
  // Fine-grained selectors (GOAL 04): Mixer only ever reads `tracks`
  // and `doc.returns`. Subscribing to those slices individually instead of
  // the whole document via `useDoc()` means a track-mute change no longer
  // re-renders this component if the tracks array identity is preserved by
  // structural sharing in `normalizeProject` (schema.ts:1841).
  // The full `doc` is still needed for `setMasterConfig` / `setTrackSend`
  // command arguments — `services.store.getDoc()` is a plain getter
  // (not a React subscription), so it does not affect re-renders.
  const tracks = useTracks();
  const returns = useReturns();
  const doc = services.store.getDoc();
  const selection = useSelection();
  const selectedIds = selection.trackIds;
  // Mixer re-renders on every doc mutation (it is a `useDoc` subscriber).
  // Five separate `tracks.filter(...)` calls per render is wasteful for
  // large sessions — memoize each derived value so the chain collapses to
  // a single pass when `tracks` / `selectedIds` are unchanged.
  const selectedTracks = useMemo(() => tracks.filter((t) => selectedIds.includes(t.id)), [tracks, selectedIds]);
  const batchCount = selectedTracks.length > 0 ? selectedTracks.length : tracks.length;
  const [batchType, setBatchType] = useState<EffectType>("eq");
  const soloCount = useMemo(() => tracks.filter((t) => t.solo).length, [tracks]);
  const muteCount = useMemo(() => tracks.filter((t) => t.mute).length, [tracks]);
  const collapsedGroups = useMemo(
    () =>
      new Set(
        tracks
          .filter((t) => t.kind === "group" && (t as import("../project-model/types").GroupTrack).collapsed)
          .map((t) => t.id),
      ),
    [tracks],
  );
  const visibleTracks = useMemo(
    () =>
      tracks.filter((t) => {
        if (
          t.kind !== "group" &&
          (t as unknown as { groupId?: string }).groupId &&
          collapsedGroups.has((t as unknown as { groupId?: string }).groupId!)
        )
          return false;
        return true;
      }),
    [tracks, collapsedGroups],
  );
  return (
    <section className="mixer" aria-label="Mixer">
      <div className="mixer-batch-bar" role="toolbar" aria-label="Batch FX">
        <span className="mixer-batch-label">BATCH FX → {batchCount} TRACKS</span>
        <select
          value={batchType}
          onChange={(e) => setBatchType(e.target.value as EffectType)}
          aria-label="Batch effect type"
        >
          {Object.keys(EFFECT_DEFS)
            .sort()
            .map((k) => (
              <option key={k} value={k}>
                {EFFECT_DEFS[k as EffectType].name}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="btn btn-small"
          title="Add effect to selected tracks (or all if none selected) — 1 click on 5 tracks"
          onClick={() => {
            const ids = selectedTracks.length > 0 ? selectedTracks.map((t) => t.id) : tracks.map((t) => t.id);
            try {
              services.store.execute(addEffectToTracks(doc, ids.slice(0, 5), batchType));
              // The rack (device knobs / flagship panel) lives in the FX
              // dock panel — reveal it, otherwise adding from the Mixer
              // gives zero visible feedback.
              onOpenFxPanel?.();
            } catch (e) {
              /* toast via error */ void e;
            }
          }}
        >
          ADD TO {Math.min(5, batchCount)}
        </button>
        <button
          type="button"
          className="btn btn-small"
          title={`Bypass ${EFFECT_DEFS[batchType].name} on the selected tracks (or all) — one undo step`}
          onClick={() => {
            const ids = selectedTracks.length > 0 ? selectedTracks.map((t) => t.id) : tracks.map((t) => t.id);
            try {
              services.store.execute(setEffectBypassOnTracks(doc, ids, batchType, true));
            } catch (e) {
              void e;
            }
          }}
        >
          BYPASS
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          title={`Remove every ${EFFECT_DEFS[batchType].name} from the selected tracks (or all) — one undo step`}
          onClick={() => {
            const ids = selectedTracks.length > 0 ? selectedTracks.map((t) => t.id) : tracks.map((t) => t.id);
            try {
              services.store.execute(removeEffectFromTracks(doc, ids, batchType));
            } catch (e) {
              void e;
            }
          }}
        >
          REMOVE
        </button>
        <span className="mixer-batch-label" aria-hidden="true">
          ·
        </span>
        <button
          type="button"
          className="btn btn-small"
          title="Clear SOLO on every track — one undo step"
          disabled={soloCount === 0}
          onClick={() => {
            try {
              services.store.execute(clearAllSolos(doc));
            } catch (e) {
              void e;
            }
          }}
        >
          CLEAR SOLO{soloCount > 0 ? ` (${soloCount})` : ""}
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Clear MUTE on every track — one undo step"
          disabled={muteCount === 0}
          onClick={() => {
            try {
              services.store.execute(clearAllMutes(doc));
            } catch (e) {
              void e;
            }
          }}
        >
          CLEAR MUTE{muteCount > 0 ? ` (${muteCount})` : ""}
        </button>
        <MacroPerformanceBar />
      </div>
      <div className="mixer-strips">
        {visibleTracks.map((track) => (
          <ChannelStrip key={track.id} track={track} canDelete={tracks.length > 1} />
        ))}
        {collapsedGroups.size > 0 && (
          <div className="mixer-fold-hint" style={{ fontSize: 10, color: "var(--muted)", padding: "4px 6px" }}>
            {[...collapsedGroups].map((gid) => {
              const g = tracks.find((t) => t.id === gid) as import("../project-model/types").GroupTrack | undefined;
              const count = tracks.filter(
                (t) => t.kind !== "group" && (t as unknown as { groupId?: string }).groupId === gid,
              ).length;
              return (
                <span key={gid} style={{ marginRight: 8 }}>
                  {g?.name ?? gid}: {count} hidden ▶
                </span>
              );
            })}
          </div>
        )}
        {returns.map((ret) => (
          <div key={ret.id} className="channel-strip return-strip" aria-label={`Return ${ret.name}`}>
            <div className="channel-name">
              <span className="track-tab-badge">RTN</span>
              <span className="channel-name-label">{ret.name}</span>
            </div>
            <div className="channel-body">
              <div className="channel-controls">
                <Slider
                  compact
                  label="GAIN"
                  value={ret.gain}
                  min={0}
                  max={1.5}
                  defaultValue={0.9}
                  format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)}`}
                  onCommit={(gain) => services.store.execute(setReturnGain(doc, ret.id, gain))}
                />
                <div className="return-fx-names">
                  {ret.effects.map((fx) => (
                    <span key={fx.id} className="return-fx-name">
                      {fx.type}
                    </span>
                  ))}
                </div>
              </div>
              <Meter engine={services.engine} kind="return" id={ret.id} />
            </div>
          </div>
        ))}
        <MasterStrip />
      </div>
    </section>
  );
}

function MasterStrip() {
  const services = useServices();
  // Fine-grained selector (GOAL 04): MasterStrip only ever reads `master`.
  // Subscribing to the whole document via `useDoc()` would re-render this
  // strip on every track-mute change. `useMaster()` re-renders only when
  // the master slice identity changes. `setMasterConfig` and friends still
  // need the full `doc`, but `services.store.getDoc()` is a plain getter
  // (not a React subscription) so it does not affect re-renders.
  const master = useMaster();
  const doc = services.store.getDoc();
  const limiterTitle =
    "Master limiter — transparent brick-wall ceiling that prevents clipping above the ceiling (default −1 dBFS). " +
    "Always safe to leave on.";
  const clipperTitle =
    "Master soft clipper — sat­urating curve above the ceiling, adds character and perceived loudness. " +
    "Engage it for a coloured master, leave it off for a clean mastered feel.";
  return (
    <div className="channel-strip master-strip" aria-label="Master channel">
      <div className="channel-name">
        <span className="channel-name-label">MASTER</span>
      </div>
      <div className="channel-body">
        <div className="channel-controls">
          <Slider
            compact
            label="IN"
            value={master.masterGain}
            min={0}
            max={1.5}
            defaultValue={1}
            format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)} dB`}
            onCommit={(masterGain) => services.store.execute(setMasterConfig(doc, { masterGain }))}
          />
          <Slider
            compact
            label="CEIL"
            value={master.ceilingDb}
            min={-12}
            max={0}
            defaultValue={-1}
            format={(v) => `${v.toFixed(1)} dB`}
            onCommit={(ceilingDb) => services.store.execute(setMasterConfig(doc, { ceilingDb }))}
          />
          <div className="master-toggles">
            <button
              type="button"
              className={`btn btn-small${master.limiterEnabled ? " active-solo" : ""}`}
              title={limiterTitle}
              aria-label="Master limiter"
              aria-pressed={master.limiterEnabled}
              onClick={() => services.store.execute(setMasterConfig(doc, { limiterEnabled: !master.limiterEnabled }))}
            >
              LIMIT
            </button>
            <button
              type="button"
              className={`btn btn-small${master.clipperEnabled ? " active-solo" : ""}`}
              title={clipperTitle}
              aria-label="Master soft clipper"
              aria-pressed={master.clipperEnabled}
              onClick={() => services.store.execute(setMasterConfig(doc, { clipperEnabled: !master.clipperEnabled }))}
            >
              CLIP
            </button>
            <button
              type="button"
              className={`btn btn-small${(master.glueEnabled ?? true) ? " active-solo" : ""}`}
              title="Buss glue on master (post-M/S, pre-clipper) — gentle 2:1 RMS leveling before the limiter"
              aria-label="Master glue"
              aria-pressed={master.glueEnabled ?? true}
              onClick={() =>
                services.store.execute(setMasterConfig(doc, { glueEnabled: !(master.glueEnabled ?? true) }))
              }
            >
              GLUE
            </button>
            <button
              type="button"
              className={`btn btn-small${master.tapeEnabled ? " active-solo" : ""}`}
              title="Tape saturation on master (post-gain, pre-limiter) — adds warmth, 1-knob drive"
              aria-label="Master tape"
              aria-pressed={!!master.tapeEnabled}
              onClick={() => services.store.execute(setMasterConfig(doc, { tapeEnabled: !master.tapeEnabled }))}
            >
              TAPE
            </button>
            <button
              type="button"
              className={`btn btn-small${master.bassMonoEnabled ? " active-solo" : ""}`}
              title="Bass Mono — below the corner frequency the master collapses to mono (club/low-end focus)"
              aria-label="Master bass mono"
              aria-pressed={!!master.bassMonoEnabled}
              onClick={() => services.store.execute(setMasterConfig(doc, { bassMonoEnabled: !master.bassMonoEnabled }))}
            >
              B-MONO
            </button>
          </div>
          {!!master.bassMonoEnabled && (
            <Slider
              compact
              label="B-MONO"
              value={master.bassMonoFreq ?? 120}
              min={60}
              max={400}
              defaultValue={120}
              format={(v) => `${Math.round(v)} Hz`}
              onCommit={(bassMonoFreq) => services.store.execute(setMasterConfig(doc, { bassMonoFreq }))}
            />
          )}
          {master.tapeEnabled && (
            <Slider
              compact
              label="TAPE DRIVE"
              value={master.tapeDrive ?? 0.35}
              min={0}
              max={1}
              defaultValue={0.35}
              format={(v) => `${Math.round(v * 100)}%`}
              onCommit={(tapeDrive) => services.store.execute(setMasterConfig(doc, { tapeDrive }))}
            />
          )}
          {master.msEnabled && (
            <>
              <Slider
                compact
                label="MID"
                value={master.msMidGain ?? 0}
                min={-6}
                max={6}
                defaultValue={0}
                format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`}
                onCommit={(msMidGain) => services.store.execute(setMasterConfig(doc, { msMidGain }))}
              />
              <Slider
                compact
                label="SIDE"
                value={master.msSideGain ?? 0}
                min={-6}
                max={6}
                defaultValue={0}
                format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`}
                onCommit={(msSideGain) => services.store.execute(setMasterConfig(doc, { msSideGain }))}
              />
            </>
          )}
          {/* Stereo indicators fill the strip's dead space under the controls. */}
          <MasterStereoMeters />
        </div>
        <MasterMeter />
      </div>
    </div>
  );
}

function ChannelStrip({ track, canDelete }: { track: Track; canDelete: boolean }) {
  const services = useServices();
  // Fine-grained selectors (GOAL 04): ChannelStrip needs `tracks` to
  // detect bus groups (the BUS dropdown is only meaningful when at
  // least one GroupTrack exists), `returns` for the send row in the
  // strip body, and `macros` for the "Link to macro" items in the
  // fader context menu. Subscribing to the whole document via `useDoc()`
  // would re-render every strip on every unrelated mutation; with
  // structural sharing in normalizeProject, none of these slices
  // changes identity for most edits.
  const tracks = useTracks();
  const returns = useReturns();
  const macros = useMacros();
  const doc = services.store.getDoc();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [faderMenu, setFaderMenu] = useState<null | {
    x: number;
    y: number;
    param: "gain" | "pan" | string;
    defaultValue: number;
    trackId: string;
  }>(null);
  const isGroup = track.kind === "group";
  // The BUS dropdown is only meaningful once bus groups exist — before that
  // every strip just repeats a dead "UNGROUPED" select.
  const hasBusGroups = tracks.some((candidate) => candidate.kind === "group");
  const selectionStore = useSelectionStore();
  const selection = useSelection();

  useEffect(() => {
    if (!faderMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".fader-menu")) return;
      setFaderMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [faderMenu]);

  return (
    <div
      className={`channel-strip${isGroup ? " group-strip" : ""}${dragOver ? " drag-over" : ""}${selection.trackIds.includes(track.id) ? " selected-strip" : ""}`}
      draggable={!isGroup}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input, select, a, .channel-color")) return;
        const ids = isGroup
          ? [
              track.id,
              ...tracks
                .filter((t) => t.kind !== "group" && (t as unknown as { groupId?: string }).groupId === track.id)
                .map((t) => t.id),
            ]
          : [track.id];
        const mode =
          e.ctrlKey || (e as unknown as { metaKey?: boolean }).metaKey
            ? "add"
            : (e as unknown as { shiftKey?: boolean }).shiftKey
              ? "range"
              : "replace";
        selectionStore.setTracks(
          ids,
          mode as "replace" | "add" | "range",
          tracks.map((t) => t.id),
        );
      }}
      onDragStart={(e) => {
        if (isGroup) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("text/plain", track.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!isGroup) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!isGroup) return;
        e.preventDefault();
        setDragOver(false);
        const draggedId = e.dataTransfer.getData("text/plain");
        if (!draggedId || draggedId === track.id) return;
        try {
          services.store.execute(addToGroup(doc, draggedId, track.id));
        } catch {
          /* ignore */
        }
      }}
      data-colored={track.color || undefined}
      style={
        track.color
          ? ({
              borderTopColor: track.color,
              borderTopWidth: 3,
              "--strip-color": track.color,
            } as React.CSSProperties)
          : undefined
      }
    >
      <div className="channel-name">
        {isGroup && (
          <button
            type="button"
            className="btn btn-small"
            title={track.collapsed ? "Unfold group (show members)" : "Fold group (hide members)"}
            onClick={() =>
              services.store.execute(
                setGroupCollapsed(doc, track.id, !(track as import("../project-model/types").GroupTrack).collapsed),
              )
            }
            style={{ minWidth: 22, padding: "2px 4px" }}
          >
            {(track as import("../project-model/types").GroupTrack).collapsed ? "▶" : "▼"}
          </button>
        )}
        <span className="track-tab-badge">{trackBadge(track)}</span>
        <input
          className="channel-name-input"
          value={nameDraft ?? track.name}
          aria-label={`Track ${track.id} name`}
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={() => {
            if (nameDraft !== null && nameDraft.trim() !== "" && nameDraft !== track.name) {
              services.store.execute(setTrackParams(doc, track.id, { name: nameDraft.trim() }));
            }
            setNameDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <input
          type="color"
          className="channel-color"
          value={track.color ?? "#6366f1"}
          title="Track color (tag)"
          aria-label={`Color for ${track.name}`}
          onChange={(e) => services.store.execute(setTrackColor(doc, track.id, e.target.value))}
          onDoubleClick={() => services.store.execute(setTrackColor(doc, track.id, null))}
        />
        {isGroup && (track as import("../project-model/types").GroupTrack).collapsed && (
          <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 4 }}>
            {
              tracks.filter((t) => t.kind !== "group" && (t as unknown as { groupId?: string }).groupId === track.id)
                .length
            }{" "}
            hidden
          </span>
        )}
      </div>
      <div className="channel-body">
        <div className="channel-controls">
          {track.kind !== "group" && hasBusGroups && (
            <label className="channel-bus-select">
              <span className="slider-label">BUS</span>
              <select
                value={track.groupId ?? ""}
                aria-label={`Bus for ${track.name}`}
                title="Route this channel through a bus group"
                onChange={(event) => {
                  if (event.target.value) services.store.execute(addToGroup(doc, track.id, event.target.value));
                  else services.store.execute(removeFromGroup(doc, track.id));
                }}
              >
                <option value="">UNGROUPED</option>
                {tracks
                  .filter((candidate) => candidate.kind === "group")
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <Slider
            label="VOL"
            value={track.gain}
            min={0}
            max={1.5}
            defaultValue={0.9}
            format={(v) => (20 * Math.log10(Math.max(v, 0.001))).toFixed(1)}
            onCommit={(gain) => services.store.execute(setTrackParams(doc, track.id, { gain }))}
            onMenu={(x, y) => setFaderMenu({ x, y, param: "gain", defaultValue: 0.9, trackId: track.id })}
          />
          <Slider
            label="PAN"
            value={track.pan}
            min={-1}
            max={1}
            defaultValue={0}
            format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)}
            onCommit={(pan) => services.store.execute(setTrackParams(doc, track.id, { pan }))}
            onMenu={(x, y) => setFaderMenu({ x, y, param: "pan", defaultValue: 0, trackId: track.id })}
          />
          {returns.map((ret) => (
            <div
              key={ret.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setFaderMenu({
                  x: e.clientX,
                  y: e.clientY,
                  param: `send:${ret.id}`,
                  defaultValue: 0,
                  trackId: track.id,
                });
              }}
              title="Send level — drag the slider, or open the menu for exact values"
            >
              <Slider
                compact
                label={`→ ${ret.name.toUpperCase()}`}
                value={track.sends[ret.id] ?? 0}
                min={0}
                max={1.5}
                defaultValue={0}
                format={(v) => (v < 0.005 ? "OFF" : `${Math.round((v / 1.5) * 100)}%`)}
                onCommit={(level) => services.store.execute(setTrackSend(doc, track.id, ret.id, level))}
                onMenu={(x, y) => setFaderMenu({ x, y, param: `send:${ret.id}`, defaultValue: 0, trackId: track.id })}
              />
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small send-create"
            title="Create a new return track (FX bus fed by the sends above)"
            aria-label="Create return track"
            onClick={() => {
              try {
                services.store.execute(createReturnTrack(doc));
              } catch {
                /* ignore */
              }
            }}
          >
            + RETURN
          </button>
        </div>
        <Meter engine={services.engine} kind="track" id={track.id} />
      </div>
      <div className="channel-buttons">
        <button
          type="button"
          className={`btn btn-small${track.mute ? " active-mute" : ""}`}
          title={isGroup ? "Mute group (+ members) — one gesture for all" : "Mute track"}
          onClick={() => {
            if (isGroup) services.store.execute(setGroupMute(doc, track.id, !track.mute));
            else services.store.execute(setTrackParams(doc, track.id, { mute: !track.mute }));
          }}
        >
          M
        </button>
        <button
          type="button"
          className={`btn btn-small${track.solo ? " active-solo" : ""}`}
          title={isGroup ? "Solo group (+ members)" : "Solo track"}
          onClick={() => {
            if (isGroup) services.store.execute(setGroupSolo(doc, track.id, !track.solo));
            else services.store.execute(setTrackParams(doc, track.id, { solo: !track.solo }));
          }}
        >
          S
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Duplicate track with FX (copies pads/effects/sends/color)"
          onClick={() => services.store.execute(duplicateTrack(doc, track.id))}
        >
          DUP
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          title="Delete track"
          disabled={!canDelete}
          onClick={() => services.store.execute(deleteTrack(doc, track.id))}
        >
          ×
        </button>
        <FreezeButton track={track} />
      </div>
      {faderMenu && faderMenu.trackId === track.id && (
        <div
          className="fader-menu"
          role="menu"
          style={{ left: faderMenu.x, top: faderMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-header">FADER</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (faderMenu.param === "gain")
                services.store.execute(setTrackParams(doc, track.id, { gain: faderMenu.defaultValue }));
              else if (faderMenu.param === "pan")
                services.store.execute(setTrackParams(doc, track.id, { pan: faderMenu.defaultValue }));
              else if (faderMenu.param.startsWith("send:")) {
                const rid = faderMenu.param.slice(5);
                services.store.execute(setTrackSend(doc, track.id, rid, 0));
              }
              setFaderMenu(null);
            }}
          >
            Reset to default ({faderMenu.defaultValue})
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const cur =
                faderMenu.param === "gain"
                  ? track.gain
                  : faderMenu.param === "pan"
                    ? track.pan
                    : (track.sends[faderMenu.param.slice(5)] ?? 0);
              const raw = window.prompt(`Type value for ${faderMenu.param}:`, String(cur));
              const n = raw ? Number(raw) : NaN;
              if (Number.isFinite(n)) {
                if (faderMenu.param === "gain")
                  services.store.execute(setTrackParams(doc, track.id, { gain: Math.min(1.5, Math.max(0, n)) }));
                else if (faderMenu.param === "pan")
                  services.store.execute(setTrackParams(doc, track.id, { pan: Math.min(1, Math.max(-1, n)) }));
                else if (faderMenu.param.startsWith("send:")) {
                  const rid = faderMenu.param.slice(5);
                  services.store.execute(setTrackSend(doc, track.id, rid, Math.min(1.5, Math.max(0, n))));
                }
              }
              setFaderMenu(null);
            }}
          >
            Type value…
          </button>
          {macros.length > 0 ? (
            macros.slice(0, 4).map((macro) => (
              <button
                key={macro.id}
                type="button"
                role="menuitem"
                disabled={faderMenu.param !== "gain" && faderMenu.param !== "pan"}
                onClick={() => {
                  if (faderMenu.param === "gain" || faderMenu.param === "pan") {
                    try {
                      services.store.execute(
                        addMacroMapping(doc, macro.id, track.id, faderMenu.param as "gain" | "pan"),
                      );
                    } catch {
                      /* ignore */
                    }
                  }
                  setFaderMenu(null);
                }}
              >
                Link to macro ({macro.name})
              </button>
            ))
          ) : (
            <button type="button" role="menuitem" disabled>
              Link to macro (none)
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (faderMenu.param.startsWith("send:")) {
                try {
                  services.store.execute(createReturnTrack(doc));
                } catch {
                  /* ignore */
                }
              }
              setFaderMenu(null);
            }}
            disabled={!faderMenu.param.startsWith("send:")}
          >
            Create return
          </button>
        </div>
      )}
    </div>
  );
}
