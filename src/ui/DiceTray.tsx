import { useEffect, useState } from "react";
import { useDoc, useServices } from "./context";
import { useDice } from "./DiceContext";
import { getStyleNamesForGenre } from "../ai/grooves/index";
import { GENRES } from "../ai/types";
import { getDrumTrack } from "../project-model/types";
import { PAD_NAMES } from "../ai/types";
import { KIT_PRESETS } from "../project-model/kit-presets";

function MiniPreview({ rows, activePads }: { rows: number[][]; activePads: number[] }) {
  if (!rows.length || activePads.length === 0) return <div className="dice-preview-empty">— no preview —</div>;
  return (
    <div className="dice-preview-grid" role="img" aria-label="Dice preview">
      <div className="dice-preview-ruler">
        {Array.from({ length: 16 }, (_, i) => (
          <div key={i} className={`dice-preview-step${i % 4 === 0 ? " beat" : ""}`}>
            {i + 1}
          </div>
        ))}
      </div>
      {activePads.slice(0, 4).map((padIdx) => {
        const row = rows[padIdx];
        if (!row) return null;
        return (
          <div key={padIdx} className="dice-preview-row">
            <span className="dice-preview-pad" title={PAD_NAMES[padIdx] ?? `Pad ${padIdx}`}>
              {(PAD_NAMES[padIdx] ?? `P${padIdx}`).slice(0, 4)}
            </span>
            {row.slice(0, 16).map((vel, step) => (
              <div
                key={step}
                className={`dice-preview-cell${vel > 0 ? " active" : ""}${step % 4 === 0 ? " beat" : ""}`}
                style={vel > 0 ? { opacity: 0.3 + vel * 0.7 } : undefined}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function DiceTray() {
  const doc = useDoc();
  const services = useServices();
  const {
    session,
    preview,
    rollFull,
    rollVary,
    jump,
    apply,
    toggleLockKey,
    toggleFav,
    setMode,
    setJitter,
    setGenre,
    setStyle,
    setSeed,
    setLength,
    setEnergy,
    setDensity,
    setComplexity,
    setVariation,
    setMood,
    setKitId,
  } = useDice();

  const styles = getStyleNamesForGenre(session.intent.genre);
  const seed = preview.seed;

  // Derive preview rows for mini grid
  let previewRows: number[][] = [];
  let previewActivePads: number[] = [];
  if (preview.mode === "full" && preview.fullPattern?.proposal?.pattern) {
    const pat = preview.fullPattern.proposal.pattern;
    const target = doc.tracks.find((t) => t.kind === "drum") ?? getDrumTrack(doc);
    previewRows = target.pads.map((pad) => pat.rows[pad.id] ?? []);
    previewActivePads = previewRows.map((row, idx) => (row.some((v) => v > 0) ? idx : -1)).filter((i) => i >= 0);
  } else if (preview.mode === "vary" && preview.varyPatch) {
    const pads = getDrumTrack(doc).pads;
    previewRows = pads.map((pad) => preview.varyPatch!.rows[pad.id] ?? []);
    // Map pads indices to previewRows indices (pads order matches rows)
    // previewRows is per padId order; show varyPatch rows directly via pads
    previewActivePads = pads.map((_, i) => (previewRows[i]?.some((v) => v > 0) ? i : -1)).filter((i) => i >= 0);
  }

  const [ghostPlaying, setGhostPlaying] = useState(false);
  useEffect(() => {
    return () => services.ghost.stop();
  }, [services.ghost]);
  useEffect(() => {
    // Stop ghost on preview change (seed/mode/locks)
    services.ghost.stop();
    setGhostPlaying(false);
  }, [seed, session.mode, session.locks, services.ghost]);
  // Stop ghost when main transport starts
  useEffect(() => {
    const unsub = services.playback.subscribe(() => {
      if (services.transport.playing && services.ghost.isPlaying) {
        services.ghost.stop();
        setGhostPlaying(false);
      }
    });
    return unsub;
  }, [services.playback, services.transport, services.ghost]);

  const handleGhostToggle = () => {
    if (ghostPlaying) {
      services.ghost.stop();
      setGhostPlaying(false);
      return;
    }
    const pat = preview.fullPattern?.proposal?.pattern;
    if (pat) {
      if (services.transport.playing) {
        services.playback.stop();
      }
      services.ghost.play(pat, { loopBars: 1, kitAssignments: preview.kitAssignments ?? undefined });
      setGhostPlaying(true);
      setTimeout(() => setGhostPlaying(services.ghost.isPlaying), 100);
    } else if (preview.varyPatch) {
      // For vary mode, build a temporary pattern from patch and preview it
      try {
        const active = doc.patterns.find((p) => p.id === doc.activePatternId);
        if (active) {
          const ghostPat = {
            ...active,
            rows: preview.varyPatch.rows,
            stepMeta: preview.varyPatch.stepMeta as unknown as typeof active.stepMeta,
          };
          services.ghost.play(ghostPat as unknown as typeof active, { loopBars: 1 });
          setGhostPlaying(true);
        }
      } catch {}
    }
  };

  const handleApply = () => {
    services.ghost.stop();
    setGhostPlaying(false);
    apply(services, doc);
  };

  const handleCopySeed = async () => {
    try {
      await navigator.clipboard.writeText(seed);
    } catch {}
  };

  return (
    <div className="dice-tray" role="region" aria-label="Dice — rapid beat generator">
      <div className="dice-tray-header">
        <span className="dice-tray-title">DICE — rapid idea generator</span>
        <span className="dice-tray-hint">
          Dva hody · Full = nový pattern · Vary = mutácia aktívneho · 100 hodov bez undo
        </span>
      </div>

      {/* Intent row */}
      <div className="dice-row dice-intent-row">
        <label className="dice-field">
          <span>GENRE</span>
          <select value={session.intent.genre} onChange={(e) => setGenre(e.target.value as (typeof GENRES)[number])}>
            {GENRES.map((g) => (
              <option key={g} value={g}>
                {g.charAt(0).toUpperCase() + g.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="dice-field">
          <span>STYLE</span>
          <select value={session.intent.style ?? ""} onChange={(e) => setStyle(e.target.value || null)}>
            <option value="">Random</option>
            {styles.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="dice-field">
          <span>KIT</span>
          <select value={session.kitId ?? ""} onChange={(e) => setKitId(e.target.value || null)}>
            <option value="">Random (dice)</option>
            {KIT_PRESETS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <label className="dice-field">
          <span>LENGTH</span>
          <select value={session.intent.length} onChange={(e) => setLength(Number(e.target.value))}>
            <option value={16}>16</option>
            <option value={32}>32</option>
            <option value={64}>64</option>
          </select>
        </label>
        <label className="dice-field dice-seed-field">
          <span>SEED</span>
          <input value={seed} onChange={(e) => setSeed(e.target.value)} maxLength={16} spellCheck={false} />
          <button type="button" className="btn btn-small" onClick={handleCopySeed} title="Copy seed" aria-label="Copy seed">
            📋
          </button>
        </label>
      </div>

      {/* Deep intent sliders */}
      <div className="dice-row dice-intent-sliders">
        <label className="dice-slider">
          <span>ENERGY {Math.round(session.intent.energy * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={session.intent.energy}
            onChange={(e) => setEnergy(Number(e.target.value))}
          />
        </label>
        <label className="dice-slider">
          <span>DENSITY {Math.round(session.intent.density * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={session.intent.density}
            onChange={(e) => setDensity(Number(e.target.value))}
          />
        </label>
        <label className="dice-slider">
          <span>COMPLEX {Math.round(session.intent.complexity * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={session.intent.complexity}
            onChange={(e) => setComplexity(Number(e.target.value))}
          />
        </label>
        <label className="dice-slider">
          <span>VARIAT {Math.round(session.intent.variation * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={session.intent.variation}
            onChange={(e) => setVariation(Number(e.target.value))}
          />
        </label>
        <label className="dice-field">
          <span>MOOD</span>
          <select value={session.intent.mood ?? ""} onChange={(e) => setMood(e.target.value || null)}>
            <option value="">—</option>
            <option value="dark">dark</option>
            <option value="aggressive">aggressive</option>
            <option value="chill">chill</option>
            <option value="energetic">energetic</option>
            <option value="bright">bright</option>
          </select>
        </label>
      </div>

      {/* Two big dice */}
      <div className="dice-row dice-roll-row">
        <button
          type="button"
          className={`btn dice-big${session.mode === "full" ? " dice-active" : ""}`}
          onClick={rollFull}
          title="Roll FULL — new pattern (dice). Hotkey: D"
        >
          🎲 FULL
        </button>
        <button
          type="button"
          className={`btn dice-big${session.mode === "vary" ? " dice-active" : ""}`}
          onClick={rollVary}
          title="Roll VARY — mutate active pattern. Hotkey: Shift+D"
        >
          🎲 VARY
        </button>
        <div className="dice-jitter">
          <label>
            <span>JITTER {Math.round(session.jitter * 100)}%</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={session.jitter}
              onChange={(e) => setJitter(Number(e.target.value))}
            />
          </label>
          <span className="dice-jitter-hint" title="0 = len seed, 1 = style + ghost/micro/temp randomizácia">
            style·ghost·micro·temp
          </span>
        </div>
        <div className="dice-mode-switch">
          <button
            type="button"
            className={`btn btn-small${session.mode === "full" ? " active-solo" : ""}`}
            onClick={() => setMode("full")}
          >
            FULL
          </button>
          <button
            type="button"
            className={`btn btn-small${session.mode === "vary" ? " active-solo" : ""}`}
            onClick={() => setMode("vary")}
          >
            VARY
          </button>
        </div>
      </div>

      {/* Locks */}
      <div className="dice-row dice-locks">
        <span className="dice-locks-label">LOCKS</span>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.drums ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("drums")}
          title="Lock all drums"
        >
          Drums {session.locks.drums ? "■" : "□"}
        </button>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.kick ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("kick")}
          disabled={session.locks.drums}
          title="Lock kicks"
        >
          Kick {session.locks.kick ? "■" : "□"}
        </button>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.snare ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("snare")}
          disabled={session.locks.drums}
          title="Lock snares"
        >
          Snare {session.locks.snare ? "■" : "□"}
        </button>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.hats ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("hats")}
          disabled={session.locks.drums}
          title="Lock hats"
        >
          Hats {session.locks.hats ? "■" : "□"}
        </button>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.bass ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("bass")}
          title="Lock bass"
        >
          Bass {session.locks.bass ? "■" : "□"}
        </button>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.chords ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("chords")}
          title="Lock chords"
        >
          Chords {session.locks.chords ? "■" : "□"}
        </button>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.lead ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("lead")}
          title="Lock lead"
        >
          Lead {session.locks.lead ? "■" : "□"}
        </button>
        <button
          type="button"
          className={`btn btn-small dice-lock${session.locks.kit ? " active-solo" : ""}`}
          onClick={() => toggleLockKey("kit")}
          title="Lock kit — don't randomize samples"
        >
          Kit {session.locks.kit ? "■" : "□"}
        </button>
      </div>

      {/* History strip */}
      <div className="dice-row dice-history">
        <span className="dice-history-label">
          HISTORY {session.cursor + 1}/{session.seedChain.length}
        </span>
        <div className="dice-history-strip" role="tablist" aria-label="Dice history">
          {session.seedChain.map((s, i) => (
            <button
              key={`${s}-${i}`}
              type="button"
              role="tab"
              aria-selected={i === session.cursor}
              className={`dice-history-dot${i === session.cursor ? " active" : ""}${session.favorites.has(i) ? " fav" : ""}`}
              onClick={() => jump(i)}
              title={`${s}${session.favorites.has(i) ? " ★" : ""} — click to jump`}
            >
              {session.favorites.has(i) ? "★" : "●"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn btn-small${session.favorites.has(session.cursor) ? " active-solo" : ""}`}
          onClick={() => toggleFav(session.cursor)}
          title="Favorite current roll"
        >
          {session.favorites.has(session.cursor) ? "★ FAV" : "☆ Fav"}
        </button>
        <span className="dice-seed-display" title={seed}>
          {seed}
        </span>
      </div>

      {/* Preview + Apply */}
      <div className="dice-preview">
        <div className="dice-preview-header">
          <span>PREVIEW</span>
          <span className="dice-preview-meta">
            {preview.mode.toUpperCase()} · {preview.beforeHits} → {preview.hitCount} hits · score{" "}
            {preview.score != null ? `${preview.score}/100` : "—"} · swing{" "}
            {preview.swing != null ? `${Math.round(preview.swing * 100)}%` : "—"} ·{" "}
            {preview.kitName
              ? `${preview.kitName} · `
              : preview.kitAssignments
                ? `${preview.kitAssignments.size} swaps · `
                : ""}
            {session.intent.length} steps · {session.intent.genre}
            {session.intent.style ? ` · ${session.intent.style}` : ""}
          </span>
          <button
            type="button"
            className={`btn btn-small${ghostPlaying ? " active-solo" : ""}`}
            onClick={handleGhostToggle}
            title={ghostPlaying ? "Stop ghost preview" : "Play ghost preview — hear without committing (loops 1 bar)"}
          >
            {ghostPlaying ? "■ STOP" : "▶ PREVIEW"}
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={handleApply}
            title="Apply current dice roll (one undo)"
          >
            APPLY
          </button>
        </div>
        <MiniPreview rows={previewRows} activePads={previewActivePads} />
      </div>

      <div className="dice-footer-hint">
        Hotkeys: <kbd>D</kbd> Full · <kbd>Shift+D</kbd> Vary · <kbd>←</kbd>
        <kbd>→</kbd> history · locks držia stem pri hode · Apply = 1 undo
      </div>
    </div>
  );
}
