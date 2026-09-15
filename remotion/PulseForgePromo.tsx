import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// ── Design system ────────────────────────────────────────────────────────────
export const PROMO_FPS = 30;
export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;
export const PROMO_DURATION_FRAMES = 1500; // 50 s

const BPM = 124;
const BEAT_F = (30 * 60) / BPM; // ≈ 14.52 frames per beat

const ACCENT = "#f59e0b";
const BLUE = "#60a5fa";
const BG = "#05070c";
const INK = (a: number) => `rgba(235,240,250,${a})`;
const MONO = '"JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, monospace';

const E = {
  out: (k: number) => 1 - Math.pow(1 - k, 3),
};

/** Phase (0..1) inside the current beat — used for pulse effects. */
const beatPhase = (f: number) => (f % BEAT_F) / BEAT_F;

const chipStyle: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 20,
  letterSpacing: "0.12em",
  color: INK(0.7),
  border: `1px solid ${INK(0.16)}`,
  borderRadius: 999,
  padding: "8px 18px",
};

// ── Primitives ───────────────────────────────────────────────────────────────

const Backdrop: React.FC = () => {
  const f = useCurrentFrame();
  const glow = 0.1 + 0.05 * Math.sin(beatPhase(f) * Math.PI * 2);
  return (
    <AbsoluteFill style={{ background: BG }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1100px 560px at 50% 38%, rgba(245,158,11,${glow}), transparent 70%)`,
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

const Word: React.FC<{
  text: string;
  at: number;
  size?: number;
  color?: string;
  weight?: number;
  mono?: boolean;
}> = ({ text, at, size = 96, color = INK(0.96), weight = 800, mono = false }) => {
  const f = useCurrentFrame();
  const k = Math.max(0, Math.min(1, (f - at) / 14));
  const e = E.out(k);
  return (
    <div
      style={{
        fontSize: size,
        fontWeight: weight,
        color,
        fontFamily: mono ? MONO : "Inter, system-ui, sans-serif",
        letterSpacing: mono ? "0.04em" : "-0.02em",
        transform: `translateY(${(1 - e) * 36}px)`,
        opacity: e,
      }}
    >
      {text}
    </div>
  );
};

const Cursor: React.FC<{ x: number; y: number; scale?: number; clickAt?: number }> = ({
  x,
  y,
  scale = 1,
  clickAt,
}) => {
  const f = useCurrentFrame();
  const clicked = clickAt !== undefined && f >= clickAt;
  const ring = clicked ? Math.max(0, (f - clickAt) / 12) : 0;
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `scale(${scale})` }}>
      <svg width="40" height="52" viewBox="0 0 40 52">
        <path d="M4 2 L4 40 L13 31 L20 48 L26 45 L19 29 L32 29 Z" fill="#fff" stroke="#0a0e16" strokeWidth="2" />
      </svg>
      {clicked && (
        <div
          style={{
            position: "absolute",
            left: -14,
            top: -8,
            width: 44,
            height: 44,
            borderRadius: "50%",
            border: `2px solid ${ACCENT}`,
            transform: `scale(${1 + ring * 1.4})`,
            opacity: 1 - ring,
          }}
        />
      )}
    </div>
  );
};

// ── S1 · Cold open ───────────────────────────────────────────────────────────
const S1ColdOpen: React.FC = () => {
  const f = useCurrentFrame();
  const out = interpolate(f, [88, 108], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cursorOn = Math.floor(f / 12) % 2 === 0;
  return (
    <AbsoluteFill style={{ opacity: out, transform: `translateY(${(1 - out) * -30}px)` }}>
      <div style={{ position: "absolute", left: 160, top: 330 }}>
        <Word text="MAKE BEATS" at={4} size={128} />
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 6 }}>
          <Word text="IN YOUR BROWSER" at={26} size={128} color={INK(0.85)} />
          <div
            style={{
              width: 64,
              height: 96,
              background: ACCENT,
              opacity: cursorOn ? 0.9 : 0,
              marginTop: 10,
            }}
          />
        </div>
        <div
          style={{
            marginTop: 48,
            opacity: interpolate(f, [64, 84], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          <span style={chipStyle}>KYX · 124 BPM · ZERO INSTALL</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── S2 · Studio (step grid) ──────────────────────────────────────────────────
const ROWS = [
  { name: "KICK", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], color: ACCENT },
  { name: "SNARE", steps: [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0.3], color: BLUE },
  { name: "HAT", steps: [0, 0, 0.6, 0, 0, 0, 0.7, 0, 0, 0, 0.5, 0.3, 0, 0, 0.8, 0], color: "#a78bfa" },
  { name: "CLAP", steps: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0], color: "#34d399" },
];

const S2Studio: React.FC = () => {
  const f = useCurrentFrame();
  const enter = spring({ frame: f, fps: 30, config: { damping: 200 } });
  const playCol = Math.floor(f / 4) % 16;
  const beatPulse = 1 - beatPhase(f);
  return (
    <AbsoluteFill style={{ opacity: enter, transform: `scale(${0.94 + enter * 0.06})` }}>
      <div style={{ position: "absolute", left: 160, top: 90, display: "flex", gap: 14, alignItems: "center" }}>
        <span style={{ ...chipStyle, color: ACCENT, borderColor: ACCENT }}>▶ PLAYING</span>
        <span style={chipStyle}>124.0 BPM</span>
        <span style={chipStyle}>LOOP · 1.1</span>
      </div>
      <div style={{ position: "absolute", left: 160, top: 170, display: "flex", gap: 10 }}>
        {["DR", "808", "AN", "KEYS"].map((t, i) => (
          <span
            key={t}
            style={{
              ...chipStyle,
              color: INK(i === 0 ? 0.95 : 0.5),
              borderColor: i === 0 ? ACCENT : INK(0.14),
            }}
          >
            {t}
          </span>
        ))}
      </div>
      <div style={{ position: "absolute", left: 160, top: 250 }}>
        {ROWS.map((row) => (
          <div key={row.name} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
            <span style={{ fontFamily: MONO, fontSize: 15, width: 90, color: INK(0.55) }}>{row.name}</span>
            {row.steps.map((v, si) => {
              const hot = si === playCol && v > 0;
              const lit = v > 0;
              const w = hot ? 1 + beatPulse * 0.25 : 1;
              return (
                <div
                  key={si}
                  style={{
                    width: 44 * w,
                    height: 44 * w,
                    borderRadius: 8,
                    border: `1px solid ${INK(lit ? 0.4 : 0.12)}`,
                    background: lit
                      ? `linear-gradient(180deg, ${row.color}${hot ? "ff" : "99"}, ${row.color}44)`
                      : `rgba(255,255,255,${si % 4 === 0 ? 0.08 : 0.04})`,
                    boxShadow: hot ? `0 0 24px ${row.color}` : "none",
                    transform: hot ? "translateY(-3px)" : "none",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          right: 170,
          top: 250,
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          height: 220,
        }}
      >
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const h = 40 + 150 * Math.abs(Math.sin(f / (7 + i * 2)) * (0.6 + 0.4 * beatPulse));
          return (
            <div
              key={i}
              style={{
                width: 22,
                height: h,
                borderRadius: 4,
                background: `linear-gradient(180deg, ${ACCENT}, ${BLUE})`,
                opacity: 0.85,
              }}
            />
          );
        })}
      </div>
      <div style={{ position: "absolute", right: 170, top: 560, textAlign: "right" }}>
        <Word text="14 INSTRUMENTS" at={40} size={54} />
        <Word text="AI PATTERNS · SCENES" at={110} size={54} />
        <Word text="MOD MATRIX · MPE" at={180} size={54} color={INK(0.7)} />
      </div>
    </AbsoluteFill>
  );
};

// ── S3 · Sound depth cards ───────────────────────────────────────────────────
const DepthCard: React.FC<{
  at: number;
  title: string;
  sub: string;
  glyph: React.ReactNode;
}> = ({ at, title, sub, glyph }) => {
  const f = useCurrentFrame();
  const k = spring({ frame: f - at, fps: 30, config: { damping: 200 } });
  if (f < at) return null;
  return (
    <div
      style={{
        width: 640,
        padding: "26px 30px",
        borderRadius: 16,
        border: `1px solid ${INK(0.14)}`,
        background: "rgba(12,16,26,0.85)",
        transform: `scale(${0.92 + k * 0.08}) translateY(${(1 - k) * 26}px)`,
        opacity: k,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ width: 64, height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {glyph}
        </div>
        <div>
          <div style={{ fontSize: 30, fontWeight: 800, color: INK(0.95), letterSpacing: "0.02em" }}>{title}</div>
          <div style={{ fontFamily: MONO, fontSize: 14, color: INK(0.5), marginTop: 4 }}>{sub}</div>
        </div>
      </div>
    </div>
  );
};

const S3SoundDepth: React.FC = () => {
  return (
    <AbsoluteFill style={{ padding: "150px 220px" }}>
      <Word text="Depth where it matters." at={4} size={64} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginTop: 60 }}>
        <DepthCard
          at={26}
          title="MOD MATRIX"
          sub="env · lfo · vel · pressure → anything"
          glyph={
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 12px)", gap: 6 }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
                const on = (n * 5 + Math.floor(n / 3)) % 4 !== 0;
                return (
                  <div
                    key={n}
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: on ? ACCENT : INK(0.18),
                      boxShadow: on ? `0 0 10px ${ACCENT}` : "none",
                    }}
                  />
                );
              })}
            </div>
          }
        />
        <DepthCard
          at={52}
          title="13 DRUM MODELS"
          sub="kick · snare · hats · rim · tom · ride…"
          glyph={
            <div style={{ fontFamily: MONO, fontSize: 13, color: INK(0.8), lineHeight: 1.5 }}>
              <div>KICK · SNARE · RIM</div>
              <div style={{ color: ACCENT }}>TOM · RIDE · ZAP</div>
            </div>
          }
        />
        <DepthCard
          at={78}
          title="LIVE GRANULAR"
          sub="drag the playhead. it listens."
          glyph={
            <div style={{ display: "flex", gap: 4, alignItems: "center", height: 40 }}>
              {[3, 10, 6, 14, 9, 18, 5, 12, 8].map((h, i) => (
                <div
                  key={i}
                  style={{
                    width: 5,
                    height: h * 1.6,
                    borderRadius: 2,
                    background: i % 2 ? BLUE : ACCENT,
                  }}
                />
              ))}
            </div>
          }
        />
        <DepthCard
          at={104}
          title="MPE"
          sub="per-note pressure + timbre, every synth"
          glyph={
            <div style={{ display: "flex", gap: 5, alignItems: "flex-end", height: 40 }}>
              {[0.3, 0.8, 0.5, 1, 0.65].map((v, i) => (
                <div
                  key={i}
                  style={{
                    width: 14,
                    height: 40 * v + 6,
                    borderRadius: 3,
                    background: i === 3 ? ACCENT : BLUE,
                    opacity: 0.9,
                  }}
                />
              ))}
            </div>
          }
        />
      </div>
    </AbsoluteFill>
  );
};

// ── S4 · Instant jam ─────────────────────────────────────────────────────────
const JamCursor: React.FC<{ x: number; y: number; clickAt: number }> = ({ x, y, clickAt }) => {
  const f = useCurrentFrame();
  return <Cursor x={x} y={y} scale={1.4} clickAt={clickAt} />;
};

const S4InstantJam: React.FC = () => {
  const f = useCurrentFrame();
  const linkChars = Math.max(0, Math.min(31, Math.floor((f - 74) / 1.6)));
  const linkFull = "kyx.app/?import=midnight&collab=k3xjam";
  const gatePulse = 0.5 + 0.5 * Math.sin(beatPhase(f) * Math.PI * 2);
  const dissolve = f < 190 ? 0 : Math.min(1, (f - 190) / 18);

  if (f < 130) {
    const cardK = spring({ frame: f, fps: 30, config: { damping: 200 } });
    const cursorTravel = E.out(Math.min(1, Math.max(0, (f - 36) / 22)));
    const cx = 1600 - (1600 - 1010) * cursorTravel;
    const cy = 300 + (560 - 300) * cursorTravel;
    return (
      <AbsoluteFill>
        <Word text="FROM THE GALLERY" at={4} size={54} color={INK(0.6)} />
        <div
          style={{
            position: "absolute",
            left: 360,
            top: 260,
            width: 1200,
            padding: "34px 40px",
            borderRadius: 18,
            border: `1px solid ${INK(0.14)}`,
            background: "rgba(12,16,26,0.9)",
            transform: `scale(${0.94 + cardK * 0.06})`,
            opacity: cardK,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <div
              style={{
                width: 76,
                height: 76,
                borderRadius: 14,
                background: ACCENT,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 34,
                color: "#0a0e16",
              }}
            >
              ▶
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 40, fontWeight: 800, color: INK(0.95) }}>Midnight Wire</div>
              <div style={{ fontFamily: MONO, fontSize: 16, color: INK(0.5), marginTop: 6 }}>
                by mira · house · 124 BPM · ▶ 1.2k · 🎸 3 remixes
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 28, alignItems: "center" }}>
            <span style={chipStyle}>OPEN IN KYX</span>
            <span style={chipStyle}>REMIX ⚡</span>
            <span style={{ ...chipStyle, color: ACCENT, borderColor: ACCENT, fontWeight: 700 }}>JAM LIVE ▸</span>
            <span style={chipStyle}>COPY LINK</span>
          </div>
        </div>
        <JamCursor x={cx} y={cy} clickAt={62} />
        {f >= 74 && (
          <div style={{ position: "absolute", left: 360, top: 700, fontFamily: MONO, fontSize: 26, color: BLUE }}>
            {linkFull.slice(0, linkChars)}
            {Math.floor(f / 8) % 2 === 0 ? "▌" : ""}
          </div>
        )}
        {f >= 100 && (
          <div
            style={{
              position: "absolute",
              left: 360,
              top: 780,
              opacity: interpolate(f, [100, 115], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            <span style={{ ...chipStyle, color: ACCENT, borderColor: ACCENT }}>
              SHARE THE LINK — EVERYONE LANDS IN THE SAME ROOM
            </span>
          </div>
        )}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - dissolve }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `radial-gradient(1200px 600px at 50% 40%, rgba(245,158,11,${0.1 + gatePulse * 0.1}), rgba(6,8,12,0.96))`,
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                display: "inline-block",
                fontFamily: MONO,
                fontSize: 22,
                letterSpacing: "0.14em",
                color: ACCENT,
                border: `2px solid ${ACCENT}`,
                borderRadius: 999,
                padding: "6px 22px",
                opacity: 0.55 + gatePulse * 0.45,
              }}
            >
              LIVE JAM
            </div>
            <div style={{ fontSize: 120, fontWeight: 800, color: "#fff", letterSpacing: "0.05em", marginTop: 24 }}>
              TAP TO JAM
            </div>
            <div style={{ fontSize: 20, color: INK(0.55), marginTop: 10 }}>
              the beat is loaded and the room is live — one tap and you're in
            </div>
          </div>
        </div>
        <Cursor x={1240} y={520} scale={1.6} clickAt={178} />
      </AbsoluteFill>
      <div style={{ opacity: dissolve, display: "flex", gap: 16, justifyContent: "center", paddingTop: 120 }}>
        {["YOU", "MIRA", "DEX", "KYX 🤖"].map((who, i) => {
          const k = spring({ frame: f - 215 - i * 6, fps: 30, config: { damping: 200 } });
          return (
            <span
              key={who}
              style={{
                ...chipStyle,
                color: INK(0.9),
                borderColor: i === 3 ? BLUE : INK(0.2),
                opacity: k,
                transform: `scale(${0.9 + k * 0.1})`,
              }}
            >
              {who}
            </span>
          );
        })}
      </div>
      <div
        style={{
          opacity: interpolate(f, [240, 262], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          textAlign: "center",
          paddingTop: 60,
        }}
      >
        <Word text="The room is live." at={240} size={76} />
        <div style={{ marginTop: 26 }}>
          <span style={{ ...chipStyle, color: ACCENT, borderColor: ACCENT }}>▶ SHARED TRANSPORT — EVERYONE IN SYNC</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── S5 · The band ────────────────────────────────────────────────────────────
const KEY_CAPS: Array<{ cap: string; note: string }> = [
  { cap: "A", note: "C4" },
  { cap: "W", note: "C#4" },
  { cap: "S", note: "D4" },
  { cap: "E", note: "D#4" },
  { cap: "D", note: "E4" },
  { cap: "F", note: "F4" },
  { cap: "T", note: "F#4" },
  { cap: "G", note: "G4" },
  { cap: "H", note: "A4" },
  { cap: "J", note: "B4" },
  { cap: "K", note: "C5" },
];

const S5Band: React.FC = () => {
  const f = useCurrentFrame();
  const step = Math.floor(f / 5) % 11;
  const beatPulse = 1 - beatPhase(f);
  return (
    <AbsoluteFill style={{ padding: "130px 170px" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <span style={{ ...chipStyle, color: "#34d399", borderColor: "#34d399" }}>▶ PLAYING</span>
        <span style={chipStyle}>124.0 BPM</span>
        <span style={{ ...chipStyle, color: ACCENT, borderColor: ACCENT }}>SYNCED — DRIFT 1 TICK</span>
        <span style={{ ...chipStyle, color: INK(0.5) }}>YOU · MIRA · KYX 🤖</span>
      </div>
      <div style={{ marginTop: 24 }}>
        <Word text="One pulse. Everyone." at={20} size={66} />
      </div>

      <div style={{ position: "absolute", left: 170, top: 420 }}>
        <div style={{ fontFamily: MONO, fontSize: 15, color: INK(0.5), marginBottom: 14 }}>
          QWERTY = the selected instrument
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {KEY_CAPS.map((k, i) => {
            const active = i === step && f > 30;
            return (
              <div key={k.cap} style={{ textAlign: "center" }}>
                {active && (
                  <div style={{ fontFamily: MONO, fontSize: 15, color: ACCENT, marginBottom: 6 }}>{k.note}</div>
                )}
                <div
                  style={{
                    width: 62,
                    height: 62,
                    borderRadius: 8,
                    border: `1px solid ${INK(active ? 0.5 : 0.14)}`,
                    background: active ? "rgba(245,158,11,0.22)" : "rgba(255,255,255,0.05)",
                    boxShadow: active ? "0 0 26px rgba(245,158,11,0.55)" : "none",
                    transform: active ? "translateY(-5px)" : "none",
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "center",
                    paddingBottom: 8,
                    fontFamily: MONO,
                    fontSize: 16,
                    color: INK(active ? 1 : 0.6),
                  }}
                >
                  {k.cap}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 14, color: INK(0.4), marginTop: 12 }}>Z / X = octave</div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 170,
          top: 380,
          width: 560,
          padding: 24,
          borderRadius: 16,
          border: `1px solid ${INK(0.14)}`,
          background: "rgba(12,16,26,0.9)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: INK(0.9) }}>🤖 KYX · DRUMS</span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 13,
              color: ACCENT,
              border: `1px solid ${ACCENT}`,
              borderRadius: 999,
              padding: "2px 10px",
            }}
          >
            ONLINE
          </span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 13, color: BLUE, marginTop: 10 }}>
          SCENE: DROP — builds the fill, holds the break
        </div>
        <div style={{ marginTop: 22 }}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: INK(0.5), marginBottom: 6 }}>YOU PLAYED</div>
          <div style={{ display: "flex", gap: 6 }}>
            {Array.from({ length: 16 }).map((_, s) => {
              const on = [0, 3, 6, 10].includes(s);
              return (
                <div
                  key={`h${s}`}
                  style={{
                    width: 22,
                    height: on ? 20 : 8,
                    borderRadius: 3,
                    background: on ? BLUE : INK(0.1),
                  }}
                />
              );
            })}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: INK(0.5), margin: "12px 0 6px" }}>KYX ANSWERS</div>
          <div style={{ display: "flex", gap: 6 }}>
            {Array.from({ length: 16 }).map((_, s) => {
              const on = [2, 3, 7, 10, 14].includes(s);
              const fresh = on && f % 30 < 15;
              return (
                <div
                  key={`b${s}`}
                  style={{
                    width: 22,
                    height: on ? 20 : 8,
                    borderRadius: 3,
                    background: on ? ACCENT : INK(0.1),
                    opacity: on ? (fresh ? 1 : 0.75) : 1,
                  }}
                />
              );
            })}
          </div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 13, color: INK(0.45), marginTop: 18 }}>
          it listens. it answers. you stay the lead.
        </div>
      </div>
      <div style={{ position: "absolute", left: 170, top: 760 }}>
        <Word text="Jam like a band." at={120} size={58} color={INK(0.9)} />
      </div>
      <div
        style={{
          position: "absolute",
          right: 170,
          top: 900,
          opacity: beatPulse * 0.6 + 0.3,
          fontFamily: MONO,
          fontSize: 16,
          color: ACCENT,
        }}
      >
        ▶ 124.0
      </div>
    </AbsoluteFill>
  );
};

// ── S6 · Publish loop ────────────────────────────────────────────────────────
const S6Publish: React.FC = () => {
  const f = useCurrentFrame();
  const btnK = spring({ frame: f - 4, fps: 30, config: { damping: 200 } });
  const cardK = spring({ frame: f - 52, fps: 30, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", top: 200, textAlign: "center", width: "100%" }}>
        <Word text="…and when the jam lands?" at={0} size={58} color={INK(0.75)} />
      </div>
      <div
        style={{
          transform: `scale(${0.94 + btnK * 0.06})`,
          padding: "26px 60px",
          borderRadius: 14,
          border: `2px solid ${ACCENT}`,
          color: ACCENT,
          fontSize: 44,
          fontWeight: 800,
          fontFamily: MONO,
          letterSpacing: "0.06em",
        }}
      >
        PUBLISH THIS JAM ▸
      </div>
      <Cursor x={1180} y={520} scale={1.5} clickAt={46} />
      <div
        style={{
          position: "absolute",
          bottom: 210,
          opacity: cardK,
          transform: `translateY(${(1 - cardK) * 30}px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "24px 36px",
            borderRadius: 16,
            border: `1px solid ${INK(0.14)}`,
            background: "rgba(12,16,26,0.9)",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 12,
              background: ACCENT,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
              color: "#0a0e16",
            }}
          >
            ▶
          </div>
          <div>
            <div style={{ fontSize: 30, fontWeight: 800, color: INK(0.95) }}>Midnight Wire — Live Jam</div>
            <div style={{ fontFamily: MONO, fontSize: 14, color: INK(0.5), marginTop: 4 }}>
              ▶ 8 plays · 🎸 remixes open · from "Midnight Wire"
            </div>
          </div>
          <span style={{ ...chipStyle, color: ACCENT, borderColor: ACCENT }}>IN GALLERY ✓</span>
        </div>
        <div style={{ textAlign: "center", marginTop: 18, fontFamily: MONO, fontSize: 16, color: INK(0.5) }}>
          the loop closes: beat → jam → beat → jam…
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── S7 · CTA ─────────────────────────────────────────────────────────────────
const S7CTA: React.FC = () => {
  const f = useCurrentFrame();
  const out = interpolate(f, [216, 252], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pulse = 0.8 + 0.2 * Math.sin(beatPhase(f) * Math.PI * 2);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: out }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ display: "flex", gap: 26, justifyContent: "center" }}>
          {["K", "Y", "X"].map((ch, i) => {
            const k = spring({ frame: f - 6 - i * 8, fps: 30, config: { damping: 12, stiffness: 120 } });
            return (
              <span
                key={ch}
                style={{
                  fontSize: 190,
                  fontWeight: 900,
                  color: i === 2 ? ACCENT : INK(0.96),
                  display: "inline-block",
                  transform: `translateY(${(1 - k) * 90}px) scale(${pulse * (i === 2 ? 1.03 : 1)})`,
                  opacity: k,
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>
        <div style={{ marginTop: 36 }}>
          <Word text="Free. In your browser. Right now." at={70} size={52} color={INK(0.85)} />
        </div>
        <div
          style={{
            marginTop: 44,
            opacity: interpolate(f, [110, 130], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          <span style={{ ...chipStyle, fontSize: 24, padding: "12px 30px", color: ACCENT, borderColor: ACCENT }}>
            kyx.app — START FORGING
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── Main composition ─────────────────────────────────────────────────────────
export const PulseForgePromo: React.FC = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeOut = interpolate(f, [durationInFrames - 26, durationInFrames - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ background: BG, fontFamily: "Inter, system-ui, sans-serif" }}>
      <Backdrop />
      <Audio src={staticFile("beat.wav")} loop volume={0.9} />

      <Sequence from={0} durationInFrames={108}>
        <S1ColdOpen />
      </Sequence>
      <Sequence from={108} durationInFrames={240}>
        <S2Studio />
      </Sequence>
      <Sequence from={348} durationInFrames={180}>
        <S3SoundDepth />
      </Sequence>
      <Sequence from={528} durationInFrames={300}>
        <S4InstantJam />
      </Sequence>
      <Sequence from={828} durationInFrames={270}>
        <S5Band />
      </Sequence>
      <Sequence from={1098} durationInFrames={150}>
        <S6Publish />
      </Sequence>
      <Sequence from={1248} durationInFrames={252}>
        <S7CTA />
      </Sequence>

      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          height: 4,
          width: `${(f / durationInFrames) * 100}%`,
          background: ACCENT,
          opacity: 0.8,
        }}
      />
      <AbsoluteFill style={{ background: "#000", opacity: 1 - fadeOut, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
