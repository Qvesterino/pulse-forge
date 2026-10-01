import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * McpAgentSessionVertical — 9:16 cut of the agent-session replay for
 * TikTok / Reels / Shorts. Same REAL demo transcript as McpAgentSession
 * (scripts/mcp-agent-demo.mts read-backs), re-laid out for the phone:
 * bigger type, shorter lines, punchy title cards, hook in the first
 * second. ~29 s @ 30 fps, 1080×1920.
 */

export const VAGENT_FPS = 30;
export const VAGENT_WIDTH = 1080;
export const VAGENT_HEIGHT = 1920;
export const VAGENT_DURATION_FRAMES = 870; // 29 s

const ACCENT = "#f59e0b";
const BLUE = "#60a5fa";
const GREEN = "#34d399";
const BG = "#05070c";
const INK = (a: number) => `rgba(235,240,250,${a})`;
const MONO = '"JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, monospace';
const SANS = '"Inter", "Segoe UI", system-ui, sans-serif';

const E = {
  out: (k: number) => 1 - Math.pow(1 - k, 3),
};

type Line = {
  at: number;
  who: "AGENT" | "KYX";
  text: string;
  verified?: boolean;
};

// Real read-backs, split for the narrow frame.
const LINES: Line[] = [
  { at: 118, who: "AGENT", text: "initialize — kyx-mcp ✓" },
  { at: 158, who: "AGENT", text: "read kyx://playbook ✓" },
  { at: 198, who: "KYX", text: "124 BPM · 3 tracks" },
  { at: 240, who: "AGENT", text: "kyx_generate { drill · 142 }" },
  { at: 258, who: "KYX", text: "“drill - UK Drill” · 32 steps ✓" },
  { at: 304, who: "AGENT", text: "ghost snares · swing 58%" },
  { at: 322, who: "KYX", text: "snare 2 → 6 steps ✓" },
  { at: 368, who: "AGENT", text: "kyx_mix { drill }" },
  { at: 384, who: "KYX", text: "8 mix decisions ✓" },
  { at: 428, who: "AGENT", text: "arrange { drill, 32 bars }" },
  { at: 444, who: "KYX", text: "intro → verse → chorus → outro ✓" },
  { at: 496, who: "AGENT", text: "drums → reverb · play ▶" },
  { at: 514, who: "KYX", text: "send 0.35 · playing ✓" },
  { at: 566, who: "AGENT", text: "experiment: tempo 90 …" },
  { at: 600, who: "KYX", text: "90 BPM · nope" },
  { at: 636, who: "AGENT", text: "checkpoint restore" },
  { at: 654, who: "KYX", text: "124 BPM · verified ✓" },
];

const Backdrop: React.FC = () => {
  const f = useCurrentFrame();
  const glow = 0.1 + 0.05 * Math.sin(f / 16);
  return (
    <AbsoluteFill style={{ background: BG }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(760px 640px at 50% 34%, rgba(245,158,11,${glow}), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)`,
          backgroundSize: "72px 72px",
          opacity: 0.5,
        }}
      />
    </AbsoluteFill>
  );
};

/** Big hook — on screen before the scroll, gone by the console. */
const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const k = interpolate(f, [4, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = interpolate(f, [92, 116], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const e = E.out(k);
  return (
    <AbsoluteFill style={{ opacity: out, justifyContent: "center", alignItems: "center", padding: "0 70px" }}>
      <div style={{ textAlign: "center", transform: `translateY(${(1 - e) * 36}px)` }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 26,
            letterSpacing: "0.3em",
            color: ACCENT,
            marginBottom: 34,
            opacity: interpolate(f, [12, 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          WATCH THIS
        </div>
        <div style={{ fontFamily: SANS, fontSize: 96, fontWeight: 800, color: INK(0.97), lineHeight: 1.06 }}>
          An AI agent
          <br />
          produces a beat
          <br />
          in a real DAW.
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 38,
            color: INK(0.6),
            marginTop: 32,
            opacity: interpolate(f, [30, 48], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          and it can't break the track.
        </div>
      </div>
    </AbsoluteFill>
  );
};

const TypedLine: React.FC<{ line: Line }> = ({ line }) => {
  const f = useCurrentFrame();
  const local = f - line.at;
  if (local < 0) return null;
  const isAgent = line.who === "AGENT";
  const color = isAgent ? BLUE : ACCENT;
  const chars = Math.floor(E.out(Math.min(1, local / 12)) * line.text.length);
  const shown = line.text.slice(0, chars);
  const done = chars >= line.text.length;
  const slide = (1 - E.out(Math.min(1, local / 10))) * 22;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 20,
        fontFamily: MONO,
        fontSize: 34,
        lineHeight: 1.45,
        opacity: Math.min(1, local / 5),
        transform: `translateX(${slide}px)`,
        marginBottom: 22,
      }}
    >
      <span style={{ color, fontWeight: 700, width: 172, flexShrink: 0, fontSize: 30 }}>{line.who} ▸</span>
      <span style={{ color: INK(0.93) }}>
        {shown}
        {!done && <span style={{ color: ACCENT }}>▌</span>}
        {done && line.verified && <span style={{ color: GREEN }}> ✓</span>}
      </span>
    </div>
  );
};

const Console: React.FC = () => {
  const f = useCurrentFrame();
  const k = interpolate(f, [104, 128], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const e = E.out(k);
  const cursorOn = Math.floor(f / 16) % 2 === 0;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", opacity: e, paddingBottom: 210 }}>
      <div
        style={{
          width: 960,
          transform: `translateY(${(1 - e) * 44}px)`,
          borderRadius: 28,
          border: `1px solid ${INK(0.14)}`,
          background: "rgba(8,11,18,0.88)",
          boxShadow: "0 40px 120px rgba(0,0,0,0.65)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "22px 28px",
            borderBottom: `1px solid ${INK(0.1)}`,
            fontFamily: MONO,
            fontSize: 25,
            color: INK(0.55),
          }}
        >
          <span style={{ width: 17, height: 17, borderRadius: 999, background: "#f87171", display: "inline-block" }} />
          <span style={{ width: 17, height: 17, borderRadius: 999, background: "#fbbf24", display: "inline-block" }} />
          <span style={{ width: 17, height: 17, borderRadius: 999, background: GREEN, display: "inline-block" }} />
          <span style={{ marginLeft: 12, fontSize: 22 }}>kyx — agent session</span>
          <span
            style={{
              marginLeft: "auto",
              border: `1px solid rgba(245,158,11,0.4)`,
              borderRadius: 999,
              padding: "5px 16px",
              color: ACCENT,
              fontSize: 20,
              letterSpacing: "0.14em",
            }}
          >
            MCP LIVE
          </span>
        </div>
        <div style={{ padding: "34px 36px 30px", minHeight: 700 }}>
          {LINES.map((line) => (
            <TypedLine key={`${line.at}-${line.text}`} line={line} />
          ))}
          {f > 700 && (
            <div style={{ fontFamily: MONO, fontSize: 34, color: ACCENT, marginTop: 8 }}>{cursorOn ? "▌" : " "}</div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Persistent progress wordmark top — brand while the story plays. */
const Wordmark: React.FC = () => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [104, 122], [0, 0.9], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        top: 96,
        width: "100%",
        textAlign: "center",
        fontFamily: SANS,
        fontSize: 34,
        fontWeight: 800,
        letterSpacing: "0.26em",
        color: INK(opacity * 0.85),
      }}
    >
      KYX <span style={{ color: ACCENT }}>·</span> AI AGENT
    </div>
  );
};

const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const AT = 740;
  if (f < AT) return null;
  const k = interpolate(f, [AT, AT + 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const e = E.out(k);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: `rgba(5,7,12,${0.88 * e})`, padding: "0 80px" }}>
      <div style={{ textAlign: "center", transform: `translateY(${(1 - e) * 30}px)` }}>
        <div style={{ fontFamily: SANS, fontSize: 92, fontWeight: 800, color: INK(0.97), lineHeight: 1.08 }}>
          AI agents
          <br />
          produce inside
          <br />
          <span style={{ color: ACCENT }}>KYX.</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 30, color: INK(0.62), marginTop: 36, lineHeight: 1.5 }}>
          verified · undoable
          <br />
          open protocol (MCP)
        </div>
        <div
          style={{
            display: "inline-block",
            marginTop: 44,
            fontFamily: MONO,
            fontSize: 26,
            letterSpacing: "0.2em",
            color: BG,
            background: ACCENT,
            borderRadius: 999,
            padding: "16px 40px",
            fontWeight: 700,
          }}
        >
          kyx.studio
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const McpAgentSessionVertical: React.FC = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeOut = interpolate(f, [durationInFrames - 12, durationInFrames - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ opacity: fadeOut, background: BG }}>
      <Backdrop />
      <Hook />
      <Wordmark />
      <Console />
      <EndCard />
    </AbsoluteFill>
  );
};
