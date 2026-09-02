import { useEffect, useMemo, useState } from "react";
import { EmbedApp } from "../embed/EmbedApp";
import { shareAppUrl } from "../export/shareCode";
import type { ProjectDocument } from "../project-model/types";
import {
  encodeProjectForGallery,
  extractShareCode,
  listBeats,
  publishBeat,
  type GalleryItem,
} from "./galleryApi";

type FeedState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: GalleryItem[] };

const PUBLISH_CODE_KEY = "pf-publish-code";

/**
 * /gallery — the Beat Gallery. A feed of community beats (share codes +
 * tags) served by the collab server's JSON store. Every beat plays through
 * the embed player and opens in the full studio — the content flywheel:
 * hear it → fork it → publish yours.
 */
export function GalleryPage() {
  const [feed, setFeed] = useState<FeedState>({ kind: "loading" });
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [prefilledCode, setPrefilledCode] = useState<string | null>(null);

  const reload = () => {
    setFeed({ kind: "loading" });
    listBeats().then(
      (items) => setFeed({ kind: "ready", items }),
      (error) => setFeed({ kind: "error", message: String(error) }),
    );
  };

  useEffect(reload, []);

  // Arriving from the studio's PUBLISH button — the encoded project is
  // handed over via sessionStorage so the URL stays clean.
  useEffect(() => {
    try {
      const code = sessionStorage.getItem(PUBLISH_CODE_KEY);
      if (code) {
        sessionStorage.removeItem(PUBLISH_CODE_KEY);
        setPrefilledCode(code);
      }
    } catch {
      // storage blocked — the paste box still works
    }
  }, []);

  const allTags = useMemo(() => {
    if (feed.kind !== "ready") return [];
    const counts = new Map<string, number>();
    for (const item of feed.items) {
      for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [feed]);

  const visible = useMemo(() => {
    if (feed.kind !== "ready") return [];
    const q = query.trim().toLowerCase();
    return feed.items.filter((item) => {
      if (filter && !item.tags.includes(filter)) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.author.toLowerCase().includes(q) ||
        item.tags.some((tag) => tag.includes(q))
      );
    });
  }, [feed, filter, query]);

  return (
    <div className="gallery-root" aria-label="Beat Gallery">
      <header className="gallery-header">
        <div className="gallery-brand">
          <span className="gallery-brand-mark">PF</span>
          <div>
            <h1>BEAT GALLERY</h1>
            <p>Hear it. Fork it. Drop yours. Every beat opens in the full studio — free, no install.</p>
          </div>
        </div>
        <nav className="gallery-nav">
          <a className="btn btn-export" href="/studio">
            OPEN STUDIO
          </a>
        </nav>
      </header>

      <PublishForm prefilledCode={prefilledCode} onPublished={reload} />

      <div className="gallery-toolbar" role="search">
        <input
          className="gallery-search"
          type="search"
          placeholder="Search beats, authors, tags…"
          aria-label="Search beats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {filter && (
          <button type="button" className="gallery-tag gallery-tag-active" onClick={() => setFilter(null)}>
            #{filter} ✕
          </button>
        )}
      </div>

      {allTags.length > 0 && (
        <div className="gallery-tagrow" aria-label="Popular tags">
          {allTags.map(([tag, count]) => (
            <button
              key={tag}
              type="button"
              className={"gallery-tag" + (filter === tag ? " gallery-tag-active" : "")}
              onClick={() => setFilter(filter === tag ? null : tag)}
            >
              #{tag} <span className="gallery-tag-count">{count}</span>
            </button>
          ))}
        </div>
      )}

      {feed.kind === "loading" && <div className="gallery-state">loading beats…</div>}
      {feed.kind === "error" && (
        <div className="gallery-state gallery-state-error">
          <p>Gallery server unreachable: {feed.message}</p>
          <p className="gallery-hint">
            Run <code>npm run collab</code> to start it on port 1234.
          </p>
          <button type="button" className="btn btn-export" onClick={reload}>
            RETRY
          </button>
        </div>
      )}
      {feed.kind === "ready" && visible.length === 0 && (
        <div className="gallery-state">
          {feed.items.length === 0
            ? "No beats yet — be the first. Export a share link from the studio and drop it above."
            : "No beats match this filter."}
        </div>
      )}

      <div className="gallery-grid">
        {visible.map((item) => (
          <GalleryCard
            key={item.id}
            item={item}
            playing={playingId === item.id}
            onTogglePlay={() => setPlayingId(playingId === item.id ? null : item.id)}
            onTagClick={(tag) => setFilter(filter === tag ? null : tag)}
          />
        ))}
      </div>

      <footer className="gallery-footer">
        PULSE FORGE — a free browser studio. Beats are share links; nothing is uploaded but the project data.
      </footer>
    </div>
  );
}

function GalleryCard({
  item,
  playing,
  onTogglePlay,
  onTagClick,
}: {
  item: GalleryItem;
  playing: boolean;
  onTogglePlay: () => void;
  onTagClick: (tag: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const openUrl = shareAppUrl(item.code, location.origin);
  const date = new Date(item.createdAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(openUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the Open button still works
    }
  };

  return (
    <article className="gallery-card" aria-label={`Beat: ${item.title}`}>
      <div className="gallery-card-head">
        <button
          type="button"
          className="gallery-play"
          aria-label={playing ? "Stop preview" : "Play preview"}
          onClick={onTogglePlay}
        >
          {playing ? "✕" : "▶"}
        </button>
        <div className="gallery-card-titlebox">
          <h3 className="gallery-card-title">{item.title}</h3>
          <span className="gallery-card-meta">
            by {item.author}
            {dateLabel ? ` · ${dateLabel}` : ""}
            {item.bpm ? ` · ${item.bpm} BPM` : ""}
          </span>
        </div>
      </div>
      {item.tags.length > 0 && (
        <div className="gallery-card-tags">
          {item.tags.map((tag) => (
            <button key={tag} type="button" className="gallery-tag" onClick={() => onTagClick(tag)}>
              #{tag}
            </button>
          ))}
        </div>
      )}
      {playing && (
        <div className="gallery-embed">
          <EmbedApp code={item.code} inline />
        </div>
      )}
      <div className="gallery-card-actions">
        <a className="btn btn-export gallery-open" href={openUrl} target="_blank" rel="noreferrer">
          OPEN IN FORGE
        </a>
        <button type="button" className="gallery-copylink" onClick={() => void copyLink()}>
          {copied ? "LINK COPIED ✓" : "COPY LINK"}
        </button>
      </div>
    </article>
  );
}

function PublishForm({
  prefilledCode,
  onPublished,
}: {
  prefilledCode: string | null;
  onPublished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prefilledCode) {
      setCodeInput(prefilledCode);
      setOpen(true);
      setStatus("Project loaded from the studio — add a title and publish.");
    }
  }, [prefilledCode]);

  const parseTags = (raw: string): string[] =>
    raw
      .split(/[,\s]+/)
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 5);

  const loadFile = async (file: File) => {
    try {
      const text = await file.text();
      const doc = JSON.parse(text) as ProjectDocument;
      if (!doc || !Array.isArray((doc as ProjectDocument).tracks)) throw new Error("not a Pulse Forge project");
      setCodeInput(encodeProjectForGallery(doc));
      if (!title) setTitle(doc.name ?? "");
      setStatus(`Loaded "${doc.name}" — add a title and publish.`);
    } catch (error) {
      setStatus(`Could not read project file: ${String(error)}`);
    }
  };

  const submit = async () => {
    const code = extractShareCode(codeInput);
    if (!code) {
      setStatus("Paste a valid share link or share code (from the studio's COPY SHARE LINK).");
      return;
    }
    if (!title.trim()) {
      setStatus("Give the beat a title.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await publishBeat({ title: title.trim(), author: author.trim(), tags: parseTags(tags), code });
      setStatus("Published! Your beat is live in the feed. 🔥");
      setTitle("");
      setTags("");
      setCodeInput("");
      onPublished();
    } catch (error) {
      setStatus(`Publish failed: ${String(error instanceof Error ? error.message : error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gallery-publish" aria-label="Publish a beat">
      {!open ? (
        <button type="button" className="gallery-publish-toggle" onClick={() => setOpen(true)}>
          + DROP YOUR BEAT
        </button>
      ) : (
        <div className="gallery-publish-form">
          <div className="gallery-publish-head">
            <span>DROP YOUR BEAT</span>
            <button
              type="button"
              className="gallery-publish-close"
              aria-label="Close publish form"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="gallery-publish-row">
            <input
              aria-label="Beat title"
              placeholder="Title — e.g. Midnight 808 Jam"
              value={title}
              maxLength={64}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              aria-label="Your name"
              placeholder="Your name (optional)"
              value={author}
              maxLength={32}
              onChange={(e) => setAuthor(e.target.value)}
            />
            <input
              aria-label="Tags"
              placeholder="Tags: phonk, 808, dark (max 5)"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <textarea
            aria-label="Share link or code"
            placeholder="Paste your share link (COPY SHARE LINK in the studio) — or a project .json file below"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            rows={3}
          />
          <div className="gallery-publish-actions">
            <label className="gallery-filelabel btn btn-export">
              LOAD .JSON FILE
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadFile(file);
                }}
              />
            </label>
            <button type="button" className="btn btn-export" disabled={busy} onClick={() => void submit()}>
              {busy ? "PUBLISHING…" : "PUBLISH TO GALLERY"}
            </button>
          </div>
          {status && <div className="gallery-publish-status">{status}</div>}
        </div>
      )}
    </section>
  );
}
