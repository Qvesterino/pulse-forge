import { useSyncExternalStore, useState } from "react";
import { openProject, type Services } from "../services";
import { defaultServerUrl, randomRoomId, shareUrl } from "../collab/collabShared";
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

  // Reactive session snapshot: any status/participant change re-renders.
  useSyncExternalStore(
    (cb) => services.collab?.subscribe(cb) ?? (() => {}),
    () => (services.collab ? `${services.collab.status}|${services.collab.participants.length}` : ""),
    () => "",
  );
  const session = services.collab;

  const startOrJoin = async () => {
    const roomId = (roomDraft.trim() || randomRoomId()).toLowerCase();
    await services.closeProject();
    void openProject(services.core, doc, { collab: { roomId, serverUrl: serverUrl.trim() } }).then(onReplaceServices);
  };

  const leave = async () => {
    // Drop ?collab= from the URL so the next project open does not re-join.
    if (typeof history !== "undefined" && typeof location !== "undefined") {
      history.replaceState(null, "", location.pathname);
    }
    await services.closeProject();
    void openProject(services.core, doc).then(onReplaceServices);
  };

  const copyLink = async () => {
    if (!session) return;
    const url = shareUrl(
      session.roomId,
      session.serverUrl,
      typeof location !== "undefined" ? location.origin : "https://pulse-forge.app",
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
        <button type="button" className="btn btn-export" onClick={() => void startOrJoin()}>
          START / JOIN SESSION
        </button>
      </div>
    );
  }

  const statusClass = session.status === "connected" ? "ok" : session.status === "connecting" ? "wait" : "bad";
  return (
    <div className="collab-panel" role="dialog" aria-label="Collaboration session">
      <div className="collab-title">
        JAM SESSION <span className={`collab-status collab-status-${statusClass}`}>{session.status.toUpperCase()}</span>
      </div>
      <div className="collab-room">
        <span className="collab-room-code" title="Room code">
          {session.roomId}
        </span>
        <button type="button" className="btn btn-small" onClick={() => void copyLink()}>
          {copied ? "COPIED!" : "COPY LINK"}
        </button>
      </div>
      <div className="collab-people">
        <span className="collab-chip" style={{ borderColor: session.localUser.color }}>
          {session.localUser.name} (you)
        </span>
        {session.participants.map((p) => (
          <span key={p.id} className="collab-chip" style={{ borderColor: p.color }}>
            {p.name}
          </span>
        ))}
        {session.participants.length === 0 && <span className="collab-hint">waiting for others — share the link…</span>}
      </div>
      <button type="button" className="btn btn-export" onClick={() => void leave()}>
        LEAVE SESSION
      </button>
    </div>
  );
}
