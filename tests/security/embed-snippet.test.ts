/**
 * Property-based fuzz for embedSnippet (src/export/shareCode.ts).
 *
 * The function interpolates a user-provided URL into an HTML iframe snippet
 * intended for paste-into-Discord/Reddit/website. Before the fix it was
 * pure concatenation — a URL with a `"` could break out of the `src="..."`
 * attribute and inject HTML. After the fix it escapes `&`, `"`, `<` and `>`
 * with their HTML entity equivalents.
 *
 * Test invariant: inside the `src="..."` attribute value, no raw `<`, `>`
 * or `"` may survive — only escaped entities. `&` must be escaped (never
 * appear raw unless followed by a recognised entity name).
 */
import { describe, expect, it } from "vitest";
import { embedSnippet } from "../../src/export/shareCode";

/**
 * Extract the `src="..."` attribute value (the URL-bearing region) from a
 * generated iframe snippet. This is the only region where URL characters
 * can break out of the HTML — everything else (`style`, `title`, `width`)
 * is constant and under our control.
 */
function srcAttributeValue(snippet: string): string {
  const m = snippet.match(/^<iframe src="([^"]*)"/);
  if (!m) throw new Error(`snippet did not start with <iframe src="…": ${snippet.slice(0, 80)}`);
  return m[1];
}

/** Assert the src attribute value is well-formed. */
function assertSrcAttributeIsSafe(snippet: string): void {
  const inside = srcAttributeValue(snippet);
  // No raw <, >, " allowed inside the attribute value (would break out).
  expect(inside.includes("<")).toBe(false);
  expect(inside.includes(">")).toBe(false);
  expect(inside.includes('"')).toBe(false);
  // `&` allowed only as a valid entity reference (`&amp;`, `&quot;`,
  // `&lt;`, `&gt;`, or numeric `&#NNN;`).
  const badAmp = /&(?!(?:amp|quot|lt|gt|#\d+);)/;
  expect(badAmp.test(inside)).toBe(false);
}

describe("security: embedSnippet escapes HTML-significant chars in the URL", () => {
  it("positive — ordinary URL is interpolated unchanged", () => {
    const snippet = embedSnippet("https://forge.app/embed/#p=abc");
    expect(snippet).toContain('<iframe src="https://forge.app/embed/#p=abc"');
    expect(snippet).toContain('title="KYX beat"');
    assertSrcAttributeIsSafe(snippet);
  });

  it("positive — query string with no special chars passes through verbatim", () => {
    const url = "https://forge.app/embed/?p=abc&q=v";
    const snippet = embedSnippet(url);
    // `&` inside a URL is HTML-significant → gets escaped to `&amp;`.
    expect(snippet).toContain('src="https://forge.app/embed/?p=abc&amp;q=v"');
    assertSrcAttributeIsSafe(snippet);
  });

  describe("individual breakout characters are escaped", () => {
    it('"  →  &quot;', () => {
      const url = 'https://forge.app/embed/#p="break"';
      const out = embedSnippet(url);
      assertSrcAttributeIsSafe(out);
      const inside = srcAttributeValue(out);
      expect(inside).toContain("&quot;break&quot;");
      // No raw `"` survives inside the attribute.
      expect(inside.includes('"')).toBe(false);
      // No `p="break"` substring (would mean raw `"` survived).
      expect(inside).not.toContain(`p="break"`);
    });

    it("<  →  &lt;   and   >  →  &gt;", () => {
      const url = "https://forge.app/embed/#p=<script>";
      const out = embedSnippet(url);
      assertSrcAttributeIsSafe(out);
      const inside = srcAttributeValue(out);
      expect(inside).toContain("&lt;script&gt;");
      expect(inside.includes("<")).toBe(false);
      expect(inside.includes(">")).toBe(false);
    });

    it("&  →  &amp;  (escaped first so subsequent substitutions don't double-escape)", () => {
      // Input contains both `&` and `"`. After the fix the `&` is escaped
      // first (`&` → `&amp;`), THEN `"` → `&quot;`. We must end up with
      // `&amp;` + `&quot;` once each, not `&amp;quot;` (double-escape).
      const url = 'https://forge.app/embed/?a=1&b="x"';
      const out = embedSnippet(url);
      assertSrcAttributeIsSafe(out);
      const inside = srcAttributeValue(out);
      expect(inside).toContain("&amp;");
      expect(inside).toContain("&quot;");
      expect(inside).not.toContain("&amp;quot;");
    });
  });

  describe("XSS-shaped payloads are neutralised", () => {
    it("iframe breakout attempt cannot introduce a new tag", () => {
      const url = '" onclick="alert(1)"><img src=x onerror=alert(2)>';
      const out = embedSnippet(url);
      assertSrcAttributeIsSafe(out);
      // The literal `<img` would inject a new element — must be escaped.
      // (Note: `</` and `onerror` appear in the snippet — as part of the
      // closing `</iframe>` tag and as inert text inside the quoted src
      // attribute — but neither is parsed as a new element.)
      expect(out.includes("<img")).toBe(false);
      expect(out.includes("<script")).toBe(false);
      // Exactly one `<iframe` opener — the outer wrapper. (There is also
      // a closing `</iframe>` so we count only opens.)
      const iframeOpens = (out.match(/<iframe\b/g) || []).length;
      expect(iframeOpens).toBe(1);
      // Exactly one `</iframe>` close.
      const iframeCloses = (out.match(/<\/iframe>/g) || []).length;
      expect(iframeCloses).toBe(1);
    });

    it("single-quote breakout is harmless (the attribute uses double quotes)", () => {
      const url = "https://forge.app/embed/#p='><script>alert(1)</script>";
      const out = embedSnippet(url);
      // `<` and `>` must still be escaped even when `"` isn't used in the
      // breakout attempt.
      assertSrcAttributeIsSafe(out);
      const inside = srcAttributeValue(out);
      expect(inside.includes("<script>")).toBe(false);
    });
  });

  describe("fuzz: random URL-like strings never produce raw breakout chars", () => {
    it("60+ random inputs all pass the no-raw-meta-chars invariant", () => {
      const alphabets = [
        // Quote / angle / ampersand soup
        () => {
          const metas = ['"', "<", ">", "&", "'"];
          let s = "";
          for (let i = 0; i < 8; i++) s += metas[Math.floor(Math.random() * metas.length)];
          return s;
        },
        // URL with embedded meta chars
        () => {
          const prefix = ["https://x/", "ws://x/", "/path?", "#hash="];
          const suffix = [
            '"><script>alert(1)</script>',
            '" onerror="alert(1)"',
            '&redirect=evil&x="y"',
            '<img/src=x onerror=alert(1)>',
            "normal-path/with?key=value&other=1",
          ];
          return prefix[Math.floor(Math.random() * prefix.length)] + suffix[Math.floor(Math.random() * suffix.length)];
        },
        // Plain URL with random tail chars
        () => {
          const safe = "abcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&'()*+,;=";
          let s = "https://example.com/";
          for (let i = 0; i < 16; i++) s += safe[Math.floor(Math.random() * safe.length)];
          return s;
        },
      ];
      for (let i = 0; i < 60; i++) {
        const gen = alphabets[i % alphabets.length];
        const url = gen();
        const out = embedSnippet(url);
        // The output must always be well-formed at the boundaries.
        expect(out.startsWith('<iframe src="')).toBe(true);
        // The closing `"…"></iframe>` boundary (the part right after the
        // src value) must be intact — no breakout into the rest of the
        // opening tag.
        const closingTag = out.indexOf('" ');
        expect(closingTag).toBeGreaterThan(0);
        expect(out.endsWith('"></iframe>')).toBe(true);
        // No XSS injection through the URL value.
        expect(out.includes("</script>")).toBe(false);
        expect(out.includes("<script>")).toBe(false);
        assertSrcAttributeIsSafe(out);
      }
    });
  });

  describe("structural invariants hold regardless of input", () => {
    it("output always contains the iframe + title", () => {
      const inputs = [
        "",
        "https://forge.app/embed/#p=abc",
        'javascript:alert(1)"',
        "<x>",
        "&<>",
        "data:text/html,foo",
      ];
      for (const url of inputs) {
        const out = embedSnippet(url);
        expect(out).toContain("<iframe");
        expect(out).toContain("</iframe>");
        expect(out).toContain('title="KYX beat"');
      }
    });
  });
});