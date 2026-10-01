import { useState, type ReactNode } from "react";
import { appUrl } from "../shared/mountBase";

/**
 * /agents — the MCP onboarding page: how to connect an AI assistant
 * (Claude Desktop or any MCP-capable client) to KYX over either transport,
 * with copy-paste configs, the agent-session video, the safety story, and
 * the tool surface summary. Pure marketing/docs — no studio boot.
 *
 * The configs mirror the REAL shapes the app generates:
 *  - desktop: desktop/mcp-host-manager.cjs `clientConfig` (stdio forwarder
 *    with ELECTRON_RUN_AS_NODE + loopback token)
 *  - web: POST /mcp + WS /mcp-relay on the collab server (MCP_TOKEN)
 */

const TRANSPORT_TABS = ["desktop", "web"] as const;
type Transport = (typeof TRANSPORT_TABS)[number];

/** Copy-to-clipboard code block with a copied confirmation tick. */
function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — the text stays selectable */
    }
  };
  return (
    <div className="agents-code" aria-label={`${label} config`}>
      <div className="agents-code-head">
        <span>{label}</span>
        <button type="button" className="agents-copy" onClick={() => void copy()}>
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const Step: React.FC<{ n: number; title: string; children: ReactNode }> = ({ n, title, children }) => (
  <div className="landing-card agents-step">
    <span className="landing-step-n">{n}</span>
    <h3>{title}</h3>
    <div className="agents-step-body">{children}</div>
  </div>
);

const DESKTOP_CONFIG = `{
  "mcpServers": {
    "kyx": {
      "command": "C:\\\\Users\\\\YOU\\\\AppData\\\\Local\\\\Programs\\\\KYX\\\\KYX.exe",
      "args": [
        "C:\\\\Users\\\\YOU\\\\AppData\\\\Local\\\\Programs\\\\KYX\\\\resources\\\\app\\\\desktop\\\\mcp-server.cjs"
      ],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "KYX_MCP_BRIDGE_URL": "http://127.0.0.1:8477/rpc",
        "KYX_MCP_TOKEN": "PASTE-THE-TOKEN-FROM-THE-KYX-CHIP"
      }
    }
  }
}`;

const WEB_SNIPPET_URL = "https://your-kyx-server.example.com/mcp";

const WEB_CONFIG = `{
  "mcpServers": {
    "kyx": {
      "url": "${WEB_SNIPPET_URL}",
      "headers": { "Authorization": "Bearer YOUR-MCP_TOKEN" }
    }
  }
}`;

const TOOL_FAMILIES: Array<{ group: string; tools: string }> = [
  { group: "Compose", tools: "kyx_generate · kyx_steps · kyx_groove · kyx_song · kyx_pattern" },
  { group: "Mix & FX", tools: "kyx_mix · kyx_fx · kyx_plugin_param · kyx_catalog · kyx_loudness" },
  { group: "Arrange", tools: "kyx_arrange · kyx_sections · kyx_clips · kyx_markers · kyx_routing" },
  { group: "Inspect", tools: "kyx_state · kyx_meter · kyx_takes · kyx_transport · kyx_undo · kyx_history" },
  { group: "Safety", tools: "kyx_checkpoint (save/restore) · kyx_batch (one undo frame)" },
];

export function AgentsPage() {
  const [transport, setTransport] = useState<Transport>("desktop");
  return (
    <div className="agents-page">
      <header className="agents-hero">
        <div className="landing-shell">
          <p className="landing-eyebrow">Open protocol · Model Context Protocol</p>
          <h1>
            Connect your AI to <span className="agents-accent">KYX</span>.
          </h1>
          <p className="agents-lede">
            Claude Desktop or any MCP-capable assistant becomes a co-producer: it reads the project, composes, mixes and
            arranges — every step verified, every step undoable. No lock-in, no black box.
          </p>
          <div className="agents-hero-cta">
            <a className="landing-btn landing-btn-primary landing-btn-lg" href={appUrl("/download")}>
              Get the desktop app →
            </a>
            <a className="landing-btn landing-btn-lg" href={appUrl("/?landing")}>
              Try the studio in-browser
            </a>
          </div>
        </div>
      </header>

      <section className="landing-section landing-section-tight" aria-label="See it work">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">See it work</p>
            <h2>A real agent session, replayed</h2>
          </div>
          <div className="landing-video-frame">
            <video
              src="/landing/mcp-agent-session.mp4"
              className="landing-agent-video"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              aria-label="Replay of an AI agent session in KYX: generate a drill pattern, edit steps, apply a measured mix, arrange the song form, then roll back an experiment via a checkpoint"
            />
          </div>
        </div>
      </section>

      <section className="landing-section" aria-label="Connect your client">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">Setup</p>
            <h2>Two-minute setup</h2>
          </div>

          <div className="agents-tabs" role="tablist" aria-label="Transport">
            {TRANSPORT_TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={transport === t}
                className={`agents-tab${transport === t ? " agents-tab-active" : ""}`}
                onClick={() => setTransport(t)}
              >
                {t === "desktop" ? "Desktop (Claude Desktop)" : "Web (HTTP server)"}
              </button>
            ))}
          </div>

          {transport === "desktop" ? (
            <div className="landing-grid landing-grid-3">
              <Step n={1} title="Enable the MCP server in KYX">
                <p>
                  Open KYX Desktop, click the <strong>⚡ chip</strong> in the intent panel and enable the MCP server.
                  KYX generates a token and shows the exact client config — copy it from there when you can.
                </p>
              </Step>
              <Step n={2} title="Paste the server into Claude Desktop">
                <p>
                  Claude Desktop → <em>Settings → Developer → Edit Config</em>, then merge this into{" "}
                  <code>claude_desktop_config.json</code> (replace the paths and token with the ones KYX shows you):
                </p>
              </Step>
              <Step n={3} title="Say hello">
                <p>
                  Restart Claude Desktop and ask it to <em>“list my KYX tools and read the kyx://playbook resource”</em>
                  . It will introduce itself and start producing.
                </p>
              </Step>
            </div>
          ) : (
            <div className="landing-grid landing-grid-3">
              <Step n={1} title="Run a collab server with MCP on">
                <p>
                  <code>MCP_TOKEN=your-secret npm run collab</code> — the server exposes <code>POST /mcp</code> for
                  clients and <code>WS /mcp-relay</code> for the KYX window.
                </p>
              </Step>
              <Step n={2} title="Enable the relay in KYX">
                <p>
                  In the browser studio, open the <strong>⚡ chip</strong>, paste the same token, and connect. The relay
                  rides the same server as your collab rooms.
                </p>
              </Step>
              <Step n={3} title="Point any HTTP MCP client at it">
                <p>Streamable-HTTP clients connect with the endpoint URL and the bearer token:</p>
              </Step>
            </div>
          )}

          <div className="agents-config-wrap">
            {transport === "desktop" ? (
              <>
                <CodeBlock
                  label="claude_desktop_config.json (Windows paths — the KYX chip shows yours)"
                  code={DESKTOP_CONFIG}
                />
                <p className="agents-note">
                  The desktop bridge binds <strong>127.0.0.1 only</strong> — nothing leaves your machine. The stdio
                  forwarder holds no project data; every tool call executes through KYX's deterministic command layer.
                </p>
              </>
            ) : (
              <>
                <CodeBlock label="any streamable-HTTP MCP client" code={WEB_CONFIG} />
                <p className="agents-note">
                  The web endpoint is <strong>opt-in and token-authed</strong> — without <code>MCP_TOKEN</code> the
                  server refuses every MCP call. Point clients at your own deployment; the token is the same one you
                  paste into the KYX ⚡ chip.
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="landing-section landing-section-tight" aria-label="What the agent can do">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">The surface</p>
            <h2>26 tools, one contract</h2>
            <p className="landing-section-sub">
              Every mutating tool returns a <strong>verification read-back</strong> of the resulting state — your agent
              proves what it did, it never guesses. It starts each session by reading <code>kyx://playbook</code>, the
              built-in producer manual, and <code>kyx://vocab</code> for the natural-language commands.
            </p>
          </div>
          <div className="landing-grid landing-grid-3">
            {TOOL_FAMILIES.map((family) => (
              <div key={family.group} className="landing-card">
                <h3>{family.group}</h3>
                <p className="agents-tools">{family.tools}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section landing-section-tight" aria-label="Safety">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">Safety</p>
            <h2>The only DAW where AI can't break your track</h2>
          </div>
          <div className="landing-grid landing-grid-3">
            <div className="landing-card">
              <h3>Checkpoints before experiments</h3>
              <p>
                The agent saves a named checkpoint before risky moves and restores it in one step — you just watched it
                do exactly that in the video.
              </p>
            </div>
            <div className="landing-card">
              <h3>Destructive ops stay locked</h3>
              <p>
                Deleting tracks, takes or sections requires an explicit allow from you, flipped in the KYX window. The
                agent gets an honest refusal, never a silent pass-through.
              </p>
            </div>
            <div className="landing-card">
              <h3>Everything is one undo step</h3>
              <p>
                Every mutation flows through the same deterministic command layer as your own edits — clamped, strict,
                and reversible. Batches fold into a single undo entry.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-cta-band" aria-label="Get started with agents">
        <div className="landing-shell">
          <div className="landing-cta-panel">
            <h2>Your AI is ready to produce.</h2>
            <p>Get the desktop app, flip the ⚡ chip, paste one config — and make beats together.</p>
            <a className="landing-btn landing-btn-primary landing-btn-lg" href={appUrl("/download")}>
              Download KYX Desktop →
            </a>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-shell landing-footer-inner">
          <span>KYX — AI-agent ready (MCP)</span>
          <span>Open protocol · Token-authed · Loopback-only on desktop</span>
        </div>
      </footer>
    </div>
  );
}
