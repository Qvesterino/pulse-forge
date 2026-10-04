import { useCallback, useEffect, useState } from "react";
import { EmbedApp } from "../embed/EmbedApp";
import {
  fetchBattleLeaderboard,
  fetchBattlePair,
  submitBattleVote,
  type BattleLeaderRow,
  type BattleSidePair,
  type BattleVoteResult,
  type BattleWinner,
} from "./galleryApi";

type BattlePhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "battling"; pair: BattleSidePair }
  | { kind: "voted"; result: BattleVoteResult; winner: BattleWinner }
  | { kind: "error"; message: string };

/**
 * Gallery battles — the blind A/B taste tournament.
 *
 * Two published beats face off with no titles, no authors, no provenance:
 * the pair endpoint carries only ids and codes, so blindness holds even
 * against a curious console. The listener plays both (one at a time — the
 * embeds share an exclusive group), votes, and only then sees the reveal
 * plus the Elo movement the vote caused. Every vote lands in the server's
 * append-only training log — the taste-data flywheel in its collection
 * phase; the leaderboard is the live product surface.
 */
export function BattlePanel() {
  const [phase, setPhase] = useState<BattlePhase>({ kind: "idle" });
  const [leaders, setLeaders] = useState<BattleLeaderRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const reloadLeaders = useCallback(() => {
    fetchBattleLeaderboard().then(
      (rows) => setLeaders(rows),
      () => setLeaders([]), // battles are optional garnish — a dead endpoint never blocks the feed
    );
  }, []);

  useEffect(reloadLeaders, [reloadLeaders]);

  const findBattle = useCallback(() => {
    setStatus(null);
    setPhase({ kind: "loading" });
    fetchBattlePair().then(
      (pair) => {
        if (!pair) {
          setPhase({ kind: "error", message: "Not enough published beats for a battle yet — publish one first." });
          return;
        }
        setPhase({ kind: "battling", pair });
      },
      (error) => setPhase({ kind: "error", message: String(error) }),
    );
  }, []);

  const vote = useCallback(
    (current: BattleSidePair, winner: BattleWinner) => {
      setPhase({ kind: "loading" });
      submitBattleVote(current, winner).then(
        (result) => {
          setPhase({ kind: "voted", result, winner });
          reloadLeaders();
        },
        (error: Error & { duplicate?: boolean }) => {
          if (error.duplicate) {
            // One vote per pair per browser — silently find a fresh battle.
            // findBattle clears the status first; the message must land after.
            findBattle();
            setStatus("You already voted on this battle — here's a new one.");
            return;
          }
          setPhase({ kind: "error", message: String(error) });
        },
      );
    },
    [findBattle, reloadLeaders],
  );

  const eloArrow = (side: "a" | "b", winner: BattleWinner): string => {
    if (winner === "both_bad") return "";
    if (winner === "tie") return "·";
    return winner === side ? "▲" : "▼";
  };

  return (
    <section className="battle-panel" aria-label="Blind beat battles">
      <div className="battle-head">
        <span className="battle-title">⚔ BATTLES</span>
        <span className="battle-hint">two blind beats — pick the better one, feed the taste model</span>
        {phase.kind !== "loading" && (
          <button type="button" className="btn btn-export battle-find" onClick={findBattle}>
            {phase.kind === "battling" ? "SKIP" : phase.kind === "voted" ? "NEXT BATTLE" : "FIND A BATTLE"}
          </button>
        )}
      </div>

      {status && <div className="battle-status">{status}</div>}
      {phase.kind === "error" && (
        <div className="battle-status" role="alert">
          {phase.message}
        </div>
      )}

      {phase.kind === "loading" && <div className="battle-status">finding two beats…</div>}

      {phase.kind === "battling" && (
        <div className="battle-arena">
          {(["a", "b"] as const).map((side) => (
            <div className="battle-side" key={side}>
              <span className="battle-side-label">{side.toUpperCase()}</span>
              <EmbedApp code={phase.pair[side].code} inline hideBrand exclusiveGroup="gallery-battle" />
              <button type="button" className="btn btn-export battle-vote" onClick={() => vote(phase.pair, side)}>
                {side.toUpperCase()} WINS
              </button>
            </div>
          ))}
        </div>
      )}
      {phase.kind === "battling" && (
        <div className="battle-voterow">
          <button type="button" className="gallery-tag" onClick={() => vote(phase.pair, "tie")}>
            TIE
          </button>
          <button type="button" className="gallery-tag" onClick={() => vote(phase.pair, "both_bad")}>
            BOTH WEAK
          </button>
        </div>
      )}

      {phase.kind === "voted" && (
        <div className="battle-arena battle-arena-reveal">
          {(["a", "b"] as const).map((side) => {
            const reveal = phase.result.reveal[side];
            const rating = phase.result.ratings[side];
            return (
              <div className="battle-side" key={side}>
                <span className="battle-side-label">
                  {side.toUpperCase()} {eloArrow(side, phase.winner)}
                </span>
                <span className="battle-reveal-title">
                  {reveal.title}
                  {reveal.origin === "agent" && <span title={reveal.agent ?? "agent-made"}> 🤖</span>}
                </span>
                <span className="battle-reveal-meta">
                  by {reveal.author}
                  {reveal.genre ? ` · ${reveal.genre}` : ""}
                  {reveal.bpm ? ` · ${Math.round(reveal.bpm)} BPM` : ""}
                </span>
                {phase.winner !== "both_bad" && (
                  <span className="battle-elo">
                    elo {Math.round(rating.elo)} · {rating.wins}W {rating.losses}L {rating.ties}T
                  </span>
                )}
                {phase.winner === "both_bad" && <span className="battle-elo">logged as weak — no rating change</span>}
              </div>
            );
          })}
        </div>
      )}

      {leaders.length > 0 && (
        <div className="battle-leaders">
          <span className="battle-leaders-label">TOP BY BATTLES</span>
          {leaders.slice(0, 5).map((row, index) => (
            <span className="battle-leader" key={row.id}>
              #{index + 1} {row.title}
              {row.origin === "agent" && " 🤖"} · {row.author} · {row.elo}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
