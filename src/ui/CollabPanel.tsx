import { useSyncExternalStore, useEffect, useRef, useState } from "react";
import { openProject, type Services } from "../services";
import { defaultServerUrl, randomRoomId, shareUrl } from "../collab/collabShared";
import { encodeProjectForGallery, setRemixParent } from "../gallery/galleryApi";
import { Slider } from "./controls";
import { JAM_ROLES, normalizeJamRole, type JamRole } from "../collab/jamRoles";
import { useDoc, useServices } from "./context";

/**
 * Collab session panel: start/join a room, copy a share link, see who is
 * connected, leave. Starting a session re-opens the current project with a
 * CRDT-backed store (see services.openProject) — the swap is seamless
 * because the whole studio re-mounts against the new services object.
 */
export function CollabPanel({ onReplaceServices }: { onReplaceServices: (services: Services) => void }) {
  const services = useServices();
  const doc = useDoc();
  const [serverUrl, setServerUrl] = useState(defaultServerUrl());
  const [roomDraft, setRoomDraft] = useState("");
  const [copied, setCopied] = useState(false);
  // A project swap is an async close+reopen pair — two overlapping swaps
  // (rapid double-click, START then LEAVE mid-flight) would race the two
  // openProject() calls and orphan the loser's collab session/websocket.
  // One swap at a time; later clicks wait or are dropped.
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // The ref is the authoritative guard: two synchronous clicks both observe
  // the pre-update `switching` state, but never pass the ref check.
  const switchingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reactive session snapshot: any status/participant change re-renders.
  useSyncExternalStore(
    (cb) => services.collab?.subscribe(cb) ?? (() => {}),
    () => (services.collab ? `${services.collab.status}|${services.collab.participants.length}` : ""),
    () => "",
  );
  const session = services.collab;

  // Jam-role gate feedback: the store publishes the last refused command.
  const [blocked, setBlocked] = useState<string | null>(null);
  useEffect(() => {
    return services.store.subscribe(() => {
      const yStore = services.store as { lastRoleBlock?: { type: string; role: JamRole } | null };
      setBlocked(yStore.lastRoleBlock ? `${yStore.lastRoleBlock.role} can't run ${yStore.lastRoleBlock.type}` : null);
    });
  }, [services]);

  const swapProject = async (options: Parameters<typeof openProject>[2]) => {
    if (switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    setSwitchError(null);
    try {
      await services.closeProject();
      const next = await openProject(services.core, doc, options);
      if (mounted.current) onReplaceServices(next);
    } catch (err) {
      if (mounted.current) setSwitchError(`Project switch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      switchingRef.current = false;
      if (mounted.current) setSwitching(false);
    }
  };

  const startOrJoin = () => {
    const roomId = (roomDraft.trim() || randomRoomId()).toLowerCase();
    return swapProject({ collab: { roomId, serverUrl: serverUrl.trim() } });
  };

  const leave = () => {
    // Drop ?collab= from the URL so the next project open does not re-join.
    if (typeof history !== "undefined" && typeof location !== "undefined") {
      history.replaceState(null, "", location.pathname);
    }
    return swapProject(undefined);
  };

  /** Instant Jam loop closer: publish the jammed room state to the gallery
   *  with lineage (?remixOf= came from the JAM LIVE button). Same hand-off
   *  as the studio PUBLISH button — the gallery opens pre-filled. */
  const publishJam = () => {
    try {
      sessionStorage.setItem("pf-publish-code", encodeProjectForGallery(doc));
    } catch {
      // storage blocked — the gallery paste box still works
    }
    const remixOf = typeof location !== "undefined" ? new URLSearchParams(location.search).get("remixOf") : null;
    if (remixOf) setRemixParent({ id: remixOf, title: "your jam origin" });
    window.open("/gallery", "_blank", "noopener");
  };

  const copyLink = async () => {
    if (!session) return;
    const url =
      isJam && typeof location !== "undefined"
        ? location.href
        : shareUrl(
            session.roomId,
            session.serverUrl,
            typeof location !== "undefined" ? location.origin : "https://kyx.app",
          );
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — the link stays visible in the room code.
    }
  };

  if (!session) {
    return (
      <div className="collab-panel" role="dialog" aria-label="Collaboration session">
        <div className="collab-title">JAM SESSION</div>
        <p className="collab-hint">
          Start a room and share the link — everyone edits the same project live. Requires a running collab server (
          <code>npm run collab</code>).
        </p>
        <label className="collab-field">
          <span>SERVER</span>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} spellCheck={false} />
        </label>
        <label className="collab-field">
          <span>ROOM (blank = new)</span>
          <input
            value={roomDraft}
            onChange={(e) => setRoomDraft(e.target.value)}
            placeholder="e.g. k3x9qz"
            spellCheck={false}
          />
        </label>
        <button type="button" className="btn btn-export" disabled={switching} onClick={() => void startOrJoin()}>
          {switching ? "SWITCHING…" : "START / JOIN SESSION"}
        </button>
        {switchError && (
          <p className="collab-hint" role="alert">
            {switchError}
          </p>
        )}
      </div>
    );
  }

  const statusClass = session.status === "connected" ? "ok" : session.status === "connecting" ? "wait" : "bad";
  const bandmate = services.bandmate;
  const [bmTick, setBmTick] = useState(0);
  useEffect(() => bandmate?.subscribe(() => setBmTick((t) => t + 1)), [bandmate]);
  void bmTick;
  const bmState = bandmate?.getState();
  // A jam link (?import=<code>&collab=<room>) must be shared WHOLE — the
  // import code is what seeds the beat into the room for every joiner.
  const isJam = typeof location !== "undefined" && new URLSearchParams(location.search).has("import");
  return (
    <div className="collab-panel" role="dialog" aria-label="Collaboration session">
      <div className="collab-title">
        JAM SESSION <span className={`collab-status collab-status-${statusClass}`}>{session.status.toUpperCase()}</span>
        {isJam && (
          <span
            className="collab-jam-badge"
            title="This room was opened from a gallery beat — the invite link carries the beat"
          >
            LIVE JAM
          </span>
        )}
      </div>
      <div className="collab-room">
        <span className="collab-room-code" title="Room code">
          {session.roomId}
        </span>
        <button type="button" className="btn btn-small" onClick={() => void copyLink()}>
          {copied ? "COPIED!" : "COPY LINK"}
        </button>
        <button
          type="button"
          className="btn btn-small collab-publish"
          title="Drop the current jam state into the public Beat Gallery (with lineage to the origin beat)"
          onClick={publishJam}
        >
          PUBLISH THIS JAM ▸
        </button>
      </div>
      <div className="collab-people">
        <span className="collab-chip" style={{ borderColor: session.localUser.color }}>
          {session.localUser.name} (you)
        </span>
        {session.participants.map((p) => (
          <span key={p.id} className="collab-chip" style={{ borderColor: p.color }}>
            {p.name}
            {p.role && p.role !== "owner" ? ` · ${p.role}` : ""}
          </span>
        ))}
        {session.participants.length === 0 && <span className="collab-hint">waiting for others — share the link…</span>}
      </div>
      {bandmate && bmState && (
        <div className="collab-bandmate" role="group" aria-label="AI bandmate">
          <div className="collab-bandmate-head">
            <span className="collab-bandmate-title">
              🤖 AI BANDMATE{" "}
              <span className={bmState.enabled ? "collab-bandmate-on" : "collab-bandmate-off"}>
                {bmState.enabled ? "ONLINE" : "OFFLINE"}
              </span>
            </span>
            <button
              type="button"
              className={`btn btn-small${bmState.enabled ? " active" : ""}`}
              aria-pressed={bmState.enabled}
              onClick={() => bandmate.setEnabled(!bmState.enabled)}
            >
              {bmState.enabled ? "PULL OUT" : "GIVE IT THE DRUMS"}
            </button>
          </div>
          {bmState.enabled && (
            <>
              <Slider
                compact
                label={`ENERGY (${Math.round(bmState.energy * 100)}%)`}
                min={0}
                max={1}
                value={bmState.energy}
                defaultValue={0.6}
                format={(v: number) => `${Math.round(v * 100)}%`}
                onCommit={(v: number) => bandmate.setEnergy(v)}
              />
              <span className="collab-hint">
                plays drums on phrase boundaries while the room plays — its rows, its track, your call
              </span>
              {bmState.sceneRole && (
                <span
                  className="collab-bandmate-scene"
                  title="The bot reads the scene role and adapts (breaks held, builds filled)"
                >
                  SCENE: {bmState.sceneRole.toUpperCase()}
                </span>
              )}
            </>
          )}
        </div>
      )}
      <label className="collab-field">
        <span>YOUR ROLE</span>
        <select
          value={session.localRole}
          onChange={(e) => session.setRole(normalizeJamRole(e.target.value))}
          aria-label="Jam role"
        >
          {JAM_ROLES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} — {r.blurb}
            </option>
          ))}
        </select>
      </label>
      {blocked && (
        <p className="collab-hint" role="alert">
          ⛔ {blocked}
        </p>
      )}
      <button type="button" className="btn btn-export" disabled={switching} onClick={() => void leave()}>
        {switching ? "SWITCHING…" : "LEAVE SESSION"}
      </button>
      {switchError && (
        <p className="collab-hint" role="alert">
          {switchError}
        </p>
      )}
    </div>
  );
}
