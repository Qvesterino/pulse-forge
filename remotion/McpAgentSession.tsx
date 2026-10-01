import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * McpAgentSession — an AI agent session in KYX, replayed as an animated
 * console. The transcript lines are the REAL read-backs from
 * scripts/mcp-agent-demo.mts (the live E2E harness), so the video cannot
 * drift from what the product actually does.
 *
 * Visual language matches PulseForgePromo: KYX orange on near-black,
 * JetBrains Mono, beat-aware glows. ~26 s @ 30 fps, 1920×1080.
 */

export const AGENT_FPS = 30;
export const AGENT_WIDTH = 1920;
export const AGENT_HEIGHT = 1080;
export const AGENT_DURATION_FRAMES = 780; // 26 s

const ACCENT = "#f59e0b";
const BLUE = "#60a5fa";
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

// Real read-backs from scripts/mcp-agent-demo.mts.
const LINES: Line[] = [
  { at: 100, who: "AGENT", text: "initialize — kyx-mcp · protocol 2025-03-26", verified: true },
  { at: 152, who: "AGENT", text: "read kyx://playbook — “read before acting”", verified: true },
  { at: 204, who: "KYX", text: "124 BPM · 3 tracks · 1 scenes · 1 patterns" },
  { at: 256, who: "AGENT", text: "kyx_generate { drill · seed “demo-agent-1” · 2 bars · 142 }" },
  { at: 270, who: "KYX", text: "generated “drill - UK Drill” · 32 steps", verified: true },
  { at: 322, who: "AGENT", text: "kyx_steps — ghost snares, steps [6, 14]" },
  { at: 336, who: "KYX", text: "snare 2 → 6 steps · swing 58%", verified: true },
  { at: 388, who: "AGENT", text: "kyx_mix { drill } · kyx_arrange { drill, 32 bars }" },
  { at: 400, who: "KYX", text: "8 mix decisions · intro → verse → chorus → outro", verified: true },
  { at: 452, who: "AGENT", text: "send drums → reverb bus · transport play" },
  { at: 464, who: "KYX", text: "send 0.35 · ▶ PLAY", verified: true },
  { at: 516, who: "AGENT", text: "experiment: set tempo to 90 …" },
  { at: 540, who: "KYX", text: "90 BPM · …that is not it" },
  { at: 576, who: "AGENT", text: "checkpoint restore “before-agent-session”" },
  { at: 590, who: "KYX", text: "124 BPM · verified", verified: true },
];

const Backdrop: React.FC = () => {
  const f = useCurrentFrame();
  const glow = 0.09 + 0.04 * Math.sin(f / 18);
  return (
    <AbsoluteFill style={{ background: BG }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1100px 560px at 50% 36%, rgba(245,158,11,${glow}), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
          opacity: 0.5,
        }}
      />
    </AbsoluteFill>
  );
};

const TitleCard: React.FC = () => {
  const f = useCurrentFrame();
  if (f > 120) {
    // fade out as the console takes over
  }
  const k = interpolate(f, [6, 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = interpolate(f, [96, 122], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const e = E.out(k);
  return (
    <AbsoluteFill style={{ opacity: out, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", transform: `translateY(${(1 - e) * 30}px)`, opacity: e }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 22,
            letterSpacing: "0.35em",
            color: ACCENT,
            marginBottom: 28,
            opacity: interpolate(f, [14, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          KYX · MODEL CONTEXT PROTOCOL
        </div>
        <div style={{ fontFamily: SANS, fontSize: 92, fontWeight: 800, color: INK(0.97), lineHeight: 1.05 }}>
          An AI agent walks
          <br />
          into your studio.
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 34,
            color: INK(0.62),
            marginTop: 26,
            opacity: interpolate(f, [30, 50], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          read · compose · mix · verify — every step undoable
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
  const chars = Math.floor(E.out(Math.min(1, local / 14)) * line.text.length);
  const shown = line.text.slice(0, chars);
  const done = chars >= line.text.length;
  const slide = (1 - E.out(Math.min(1, local / 12))) * 18;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 18,
        fontFamily: MONO,
        fontSize: 27,
        lineHeight: 1.5,
        opacity: Math.min(1, local / 6),
        transform: `translateX(${slide}px)`,
        marginBottom: 14,
      }}
    >
      <span style={{ color, fontWeight: 700, width: 128, flexShrink: 0 }}>{line.who} ▸</span>
      <span style={{ color: INK(0.92) }}>
        {shown}
        {!done && <span style={{ color: ACCENT }}>▌</span>}
        {done && line.verified && <span style={{ color: "#34d399" }}> ✓</span>}
      </span>
    </div>
  );
};

const Console: React.FC = () => {
  const f = useCurrentFrame();
  const k = interpolate(f, [92, 118], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const e = E.out(k);
  const cursorOn = Math.floor(f / 16) % 2 === 0;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: e }}>
      <div
        style={{
          width: 1480,
          transform: `translateY(${(1 - e) * 40}px)`,
          borderRadius: 22,
          border: `1px solid ${INK(0.14)}`,
          background: "rgba(8,11,18,0.86)",
          boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        {/* console chrome */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "18px 26px",
            borderBottom: `1px solid ${INK(0.1)}`,
            fontFamily: MONO,
            fontSize: 19,
            color: INK(0.55),
          }}
        >
          <span style={{ width: 14, height: 14, borderRadius: 999, background: "#f87171", display: "inline-block" }} />
          <span style={{ width: 14, height: 14, borderRadius: 999, background: "#fbbf24", display: "inline-block" }} />
          <span style={{ width: 14, height: 14, borderRadius: 999, background: "#34d399", display: "inline-block" }} />
          <span style={{ marginLeft: 14 }}>kyx — agent session</span>
          <span
            style={{
              marginLeft: "auto",
              border: `1px solid ${INK(0.16)}`,
              borderRadius: 999,
              padding: "4px 14px",
              color: ACCENT,
              fontSize: 16,
              letterSpacing: "0.18em",
            }}
          >
            MCP · RELAY LIVE
          </span>
        </div>
        {/* lines */}
        <div style={{ padding: "34px 40px 26px", minHeight: 620 }}>
          {LINES.map((line) => (
            <TypedLine key={`${line.at}-${line.text}`} line={line} />
          ))}
          {f > 620 && (
            <div style={{ fontFamily: MONO, fontSize: 27, color: ACCENT, marginTop: 6 }}>
              {cursorOn ? "▌" : " "}
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const AT = 668;
  if (f < AT) return null;
  const k = interpolate(f, [AT, AT + 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const e = E.out(k);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: `rgba(5,7,12,${0.82 * e})` }}>
      <div style={{ textAlign: "center", transform: `translateY(${(1 - e) * 26}px)` }}>
        <div style={{ fontFamily: SANS, fontSize: 84, fontWeight: 800, color: INK(0.97), lineHeight: 1.08 }}>
          AI agents produce
          <br />
          inside KYX.
        </div>
        <div style={{ fontFamily: MONO, fontSize: 26, color: INK(0.6), marginTop: 26, letterSpacing: "0.08em" }}>
          open protocol · every step verified · every step undoable
        </div>
        <div
          style={{
            display: "inline-block",
            marginTop: 34,
            fontFamily: MONO,
            fontSize: 20,
            letterSpacing: "0.22em",
            color: ACCENT,
            border: `1px solid rgba(245,158,11,0.4)`,
            borderRadius: 999,
            padding: "10px 26px",
          }}
        >
          MCP · KYX STUDIO
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const McpAgentSession: React.FC = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeOut = interpolate(f, [durationInFrames - 12, durationInFrames - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ opacity: fadeOut, background: BG }}>
      <Backdrop />
      <TitleCard />
      <Console />
      <EndCard />
      <AbsoluteFill
        style={{
          background: `radial-gradient(900px 420px at 50% 108%, rgba(245,158,11,${0.12 + 0.05 * Math.sin(f / 22)}), transparent 70%)`,
        }}
      />
    </AbsoluteFill>
  );
};
