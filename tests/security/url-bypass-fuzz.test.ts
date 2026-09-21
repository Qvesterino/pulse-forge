/**
 * Property-based fuzz for the collab `?server=` URL gate.
 *
 * `isAllowedServerUrl` (private to src/collab/collabShared.ts) is exercised
 * through its public caller `collabParamsFromSearch`, which routes every
 * `?server=` override through the gate and otherwise falls back to the
 * default relay. The test asserts the gate is *closed* on a wide corpus of
 * hostile inputs — wrong hostnames, dangerous schemes, IP literals,
 * loopback names, port-hopping, malformed URLs, embedded quote/angle
 * characters, Unicode look-alikes.
 *
 * Loop-based fuzz only (50+ random inputs per category). No fast-check.
 */
import { describe, expect, it } from "vitest";
import { collabParamsFromSearch } from "../../src/collab/collabShared";

/**
 * Probe a server override through the gate.
 *
 * Returns the URL the gate accepted (with the probe tag), or `null` if it
 * fell back to the default — i.e. the gate rejected the input.
 *
 * We can't export `isAllowedServerUrl` (it's private), so we test its
 * negative space: a hostile override never reaches the public output as
 * a non-default URL. The probe tag (`#probe=z9`) is appended inside this
 * helper so the caller can pass a plain host URL and we distinguish
 * "override accepted" from "default returned" by the tag surviving.
 */
function probeOverride(serverOverride: string): string | null {
  const tagged = `${serverOverride}#probe=z9`;
  const parsed = collabParamsFromSearch(`?collab=z9&server=${encodeURIComponent(tagged)}`);
  if (!parsed) return null;
  return parsed.serverUrl === tagged ? tagged : null;
}

const GOOD_CORNER_HOST = location.hostname;
const GOOD_CORNER_PROTOCOL = location.protocol === "https:" ? "wss:" : "ws:";

describe("security: isAllowedServerUrl rejects hostile ?server= overrides", () => {
  describe("wrong hostname (off-origin redirects)", () => {
    it("rejects foreign domains on standard ports", () => {
      const hosts = [
        "evil.com",
        "wss.evil.com",
        "evil.example",
        "sub.evil.example",
        "attacker.co",
        "wss.attacker.co",
        "localhost.evil.com",
        "evil.com.localhost",
        "google.com",
        "cloudflare.com",
      ];
      for (const h of hosts) {
        expect(probeOverride(`ws://${h}:1234`)).toBeNull();
        expect(probeOverride(`wss://${h}:1234`)).toBeNull();
        expect(probeOverride(`ws://${h}`)).toBeNull();
        expect(probeOverride(`wss://${h}`)).toBeNull();
      }
    });

    it("rejects subdomain / DNS-rebinding look-alikes of the app host", () => {
      // Pretend the app origin is "example.com" — anything containing it
      // but with extra labels should be rejected. (Hostname comparison is
      // case-insensitive per RFC 3986, so uppercase "LOCALHOST" is the
      // same host and would correctly be accepted — that's tested
      // elsewhere.)
      const lookalikes = [
        `${GOOD_CORNER_HOST}.evil.com`,
        `${GOOD_CORNER_HOST}-evil.com`,
        `evil.${GOOD_CORNER_HOST}`,
        `${GOOD_CORNER_HOST}1`,
        `${GOOD_CORNER_HOST}.example`,
        `${GOOD_CORNER_HOST.toUpperCase()}.evil.com`, // mixed-case look-alike
      ];
      for (const h of lookalikes) {
        expect(probeOverride(`ws://${h}:1234`)).toBeNull();
      }
    });
  });

  describe("loopback hostnames (anti DNS rebinding on public origin)", () => {
    // The loopback-rejection rule only matters when the app itself is on a
    // non-loopback host. On a dev origin (location.hostname == localhost),
    // loopback overrides are the same-host legitimate path. Skip the
    // rejection assertions when running on dev and only test the
    // port-hopping variant (which is also dev-relevant).
    const onLoopback = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(
      location.hostname.toLowerCase(),
    );

    it("rejects localhost / 127.0.0.1 / 0.0.0.0 / ::1 overrides (non-loopback origin)", () => {
      if (onLoopback) return; // covered by the same-host allow-list above
      const loopback = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"];
      for (const h of loopback) {
        expect(probeOverride(`ws://${h}:1234`)).toBeNull();
        expect(probeOverride(`wss://${h}:1234`)).toBeNull();
        expect(probeOverride(`ws://${h}`)).toBeNull();
      }
    });

    it("case-insensitive: 'LOCALHOST' is the same host and is accepted (loopback origin)", () => {
      // RFC 3986: hostname comparison is case-insensitive. When the app
      // itself is on loopback (dev), upper-case LOCALHOST is the same
      // authority and is accepted. The other port-hopping tests verify
      // the tightening.
      if (!onLoopback) return;
      const input = `ws://${GOOD_CORNER_HOST.toUpperCase()}:1234`;
      expect(probeOverride(input)).toBe(`${input}#probe=z9`);
    });

    it("rejects loopback with a non-default port (port-hopping)", () => {
      for (const port of ["80", "443", "8080", "9999", "12345"]) {
        expect(probeOverride(`ws://localhost:${port}`)).toBeNull();
        expect(probeOverride(`ws://127.0.0.1:${port}`)).toBeNull();
      }
    });

    it("rejects default-port ws:// (port stripped by URL ctor → must be explicit)", () => {
      // ws://host:80 is normalised by URL ctor to url.port === "". The
      // gate must reject any override that doesn't carry an explicit port
      // — it can't tell the difference between "user meant :80" and "user
      // meant default 80".
      expect(probeOverride(`ws://${GOOD_CORNER_HOST}:80`)).toBeNull();
      expect(probeOverride(`wss://${GOOD_CORNER_HOST}:443`)).toBeNull();
      expect(probeOverride(`ws://${GOOD_CORNER_HOST}`)).toBeNull();
    });
  });

  describe("IPv4 / IPv6 literal hostnames", () => {
    it("rejects IPv4 literals on any port", () => {
      const ips = ["192.168.1.5", "10.0.0.1", "169.254.169.254", "8.8.8.8", "1.1.1.1", "255.255.255.255"];
      for (const ip of ips) {
        expect(probeOverride(`ws://${ip}:1234`)).toBeNull();
        expect(probeOverride(`wss://${ip}:443`)).toBeNull();
      }
    });

    it("rejects IPv6 literals on any port", () => {
      const ips = [
        "[::1]",
        "[fe80::1]",
        "[2001:db8::1]",
        "[::ffff:192.168.1.5]",
        "::1", // bare (URL ctor normalises to [::1])
        "fe80::1",
      ];
      for (const ip of ips) {
        expect(probeOverride(`ws://${ip}:1234`)).toBeNull();
        expect(probeOverride(`wss://${ip}:443`)).toBeNull();
      }
    });

    it("rejects IPv4-shaped strings with extra labels (regex precision)", () => {
      const tricky = [
        "1.2.3.4.5",
        "999.999.999.999",
        "1.2.3",
        "1.2.3.4 ",
        " 1.2.3.4",
      ];
      for (const t of tricky) {
        expect(probeOverride(`ws://${t}:1234`)).toBeNull();
      }
    });
  });

  describe("non-ws schemes", () => {
    it("rejects http / https / file / blob / data / javascript / vbscript", () => {
      const schemes = [
        "http://evil.com",
        "https://evil.com",
        "file:///etc/passwd",
        "blob:https://evil.com/abc",
        "data:text/html,<script>alert(1)</script>",
        "javascript:alert(1)",
        "vbscript:msgbox(1)",
        "ftp://evil.com",
        "ssh://evil.com",
        "telnet://evil.com",
        "wss-+://evil.com",
      ];
      for (const s of schemes) {
        expect(probeOverride(s)).toBeNull();
      }
    });

    it("rejects scheme-with-host tricks that fool URL parsing", () => {
      // `javascript://evil.com/%0Aalert(1)` parses as protocol=javascript
      // in modern engines. The string-prefix defence-in-depth gate catches
      // the raw prefix.
      const tricky = [
        "javascript://evil.com",
        "JavaScript://evil.com",
        "  javascript://evil.com",
        "DATA://evil.com",
        "blob://evil.com",
      ];
      for (const s of tricky) {
        expect(probeOverride(s)).toBeNull();
      }
    });
  });

  describe("port-hopping and non-standard ports", () => {
    it("rejects unusual ports on the same host", () => {
      for (const port of ["22", "25", "80", "443", "3389", "6379", "8080", "8443", "9999", "31337", "12345"]) {
        expect(probeOverride(`${GOOD_CORNER_PROTOCOL}//${GOOD_CORNER_HOST}:${port}`)).toBeNull();
      }
    });

    it("rejects the default relay port from the wrong protocol", () => {
      // ws://<host>:1234 is fine on http origin, but wss://<host>:1234 on
      // an http origin is not a legitimate wss relay.
      if (location.protocol !== "https:") {
        expect(probeOverride(`wss://${GOOD_CORNER_HOST}:1234`)).toBeNull();
      }
    });

    it("rejects scheme-default port (URL ctor strips :80/:443/:443 → must be explicit)", () => {
      // Defence-in-depth: ws://h:80 and wss://h:443 have url.port === "".
      // The gate requires an explicit port (per the port-check tightening)
      // so this case is already covered; assert it explicitly here.
      expect(probeOverride(`ws://${GOOD_CORNER_HOST}:80`)).toBeNull();
      expect(probeOverride(`wss://${GOOD_CORNER_HOST}:443`)).toBeNull();
      expect(probeOverride(`ws://${GOOD_CORNER_HOST}`)).toBeNull();
    });
  });

  describe("malformed / unparseable input", () => {
    it("rejects junk without throwing", () => {
      const junk = [
        "",
        " ",
        "://",
        ":",
        "/",
        "//",
        "ws:",
        "wss:",
        "ws://",
        "wss://",
        "http://[",
        "ws://\u0000evil",
        "ws://evil\u0000",
        "\u0000ws://evil.com",
        "ws://%XX",
        "ws://" + "a".repeat(5000),
      ];
      for (const j of junk) {
        expect(() => probeOverride(j)).not.toThrow();
        expect(probeOverride(j)).toBeNull();
      }
    });
  });

  describe("userinfo / authority-confusion attacks", () => {
    it("rejects URL ctor's userinfo confusion", () => {
      // new URL("ws://user:pass@evil") → hostname=evil, which fails the
      // same-host gate. Verify it doesn't slip through.
      const tricky = [
        "ws://anything:secret@evil.com:1234",
        "wss://anything@evil.com:1234",
        "ws://localhost:secret@evil.com:1234",
      ];
      for (const t of tricky) {
        expect(probeOverride(t)).toBeNull();
      }
    });
  });

  describe("fuzz: random strings must never crash and must always reject", () => {
    it("60+ random strings → none accepted, no throws", () => {
      const alphabets = [
        // Random printable ASCII
        () => {
          const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;:,.<>?/~`";
          let s = "";
          for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
          return s;
        },
        // URL-like, but EXCLUDING same-host with port 1234 (which is the
        // legitimate same-host override and would be accepted).
        () => {
          const schemes = ["ws", "wss", "http", "javascript", "data", "file"];
          // Always a different host than location.hostname, OR a hostile
          // literal — none of these should ever be accepted.
          const hostileHosts = [
            "evil.com",
            "127.0.0.1",
            "0.0.0.0",
            "[::1]",
            "192.168.1.5",
            "10.0.0.1",
            "169.254.169.254",
            "8.8.8.8",
            "attacker.example",
            `${GOOD_CORNER_HOST}.evil.com`,
          ];
          const ports = ["", ":80", ":9999", ":31337"];
          const paths = ["", "/", "/x", "/x?y=1#z"];
          return `${schemes[Math.floor(Math.random() * schemes.length)]}://${hostileHosts[Math.floor(Math.random() * hostileHosts.length)]}${ports[Math.floor(Math.random() * ports.length)]}${paths[Math.floor(Math.random() * paths.length)]}`;
        },
        // Unicode / RTL mix
        () => {
          const bases = ["ws://evil.com:1234", "evil.com", "127.0.0.1"];
          const inserts = ["\u200B", "\u202E", "\uFEFF", "\u0000", "\u2028", "\uD83D\uDE00"];
          const b = bases[Math.floor(Math.random() * bases.length)];
          const ins = inserts[Math.floor(Math.random() * inserts.length)];
          const pos = Math.floor(Math.random() * (b.length + 1));
          return b.slice(0, pos) + ins + b.slice(pos);
        },
      ];
      for (let i = 0; i < 60; i++) {
        const gen = alphabets[i % alphabets.length];
        const input = gen();
        expect(() => probeOverride(input)).not.toThrow();
        expect(probeOverride(input)).toBeNull();
      }
    });
  });

  describe("positive control: same-host override with the correct rel-port is accepted", () => {
    it("accepts ws://<host>:1234 on http origin", () => {
      if (location.protocol === "https:") return; // not applicable
      const input = `ws://${GOOD_CORNER_HOST}:1234`;
      expect(probeOverride(input)).toBe(`${input}#probe=z9`);
    });
  });
});
