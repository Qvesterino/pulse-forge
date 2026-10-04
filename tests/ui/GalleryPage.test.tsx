/**
 * Beat Gallery page — feed rendering, tag filter, publish flow, embed play.
 * fetch is mocked; the share codes are real (lz-string + house template) so
 * extractShareCode/decode paths run for real.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { compressToEncodedURIComponent } from "lz-string";
import { GalleryPage } from "../../src/gallery/GalleryPage";
import { extractShareCode } from "../../src/gallery/galleryApi";
import { createProjectFromTemplate } from "../../src/project-model/templates";

const REAL_FETCH = globalThis.fetch;

function code(doc = createProjectFromTemplate("house")): string {
  return compressToEncodedURIComponent(JSON.stringify(doc));
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function feedResponse() {
  return jsonResponse({
    items: [
      {
        id: "b1",
        title: "Midnight 808",
        author: "qveen",
        tags: ["phonk", "808"],
        code: code(),
        bpm: 124,
        projectName: "house",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
      {
        id: "b2",
        title: "Garage Skank",
        author: "matej",
        tags: ["ukg"],
        code: code(),
        bpm: 135,
        projectName: "house",
        createdAt: "2026-09-01T11:00:00.000Z",
      },
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe("extractShareCode", () => {
  it("accepts a raw share code, a studio link, an embed link and an iframe snippet", () => {
    const c = code();
    expect(extractShareCode(c)).toBe(c);
    expect(extractShareCode(`http://localhost:5173/?import=${c}`)).toBe(c);
    expect(extractShareCode(`http://localhost:5173/embed/#p=${c}`)).toBe(c);
    expect(extractShareCode(`<iframe src="http://x/embed/#p=${c}"></iframe>`)).toBe(c);
    expect(extractShareCode("garbage")).toBeNull();
    expect(extractShareCode("")).toBeNull();
  });
});

describe("GalleryPage — battles", () => {
  function routeFetch(routes: Array<[string, unknown]>) {
    return vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      for (const [marker, body] of routes) {
        if (url.includes(marker)) return Promise.resolve(jsonResponse(body));
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });
  }

  it("runs a blind battle: pair with no titles, vote, reveal, leaderboard refresh", async () => {
    const beatCode = code();
    const fetchMock = routeFetch([
      [
        "/api/gallery/battles/pair",
        {
          pair: {
            a: { id: "b1", code: beatCode },
            b: { id: "b2", code: beatCode },
          },
        },
      ],
      [
        "/api/gallery/battles/vote",
        {
          reveal: {
            a: { id: "b1", title: "Midnight 808", author: "qveen", origin: "human", genre: "house", bpm: 124 },
            b: { id: "b2", title: "Garage Skank", author: "matej", origin: "agent", agent: "KYX Agent", bpm: 135 },
          },
          ratings: {
            a: { elo: 1016, wins: 1, losses: 0, ties: 0, bothBad: 0 },
            b: { elo: 984, wins: 0, losses: 1, ties: 0, bothBad: 0 },
          },
        },
      ],
      [
        "/api/gallery/battles/leaderboard",
        { leaders: [{ id: "b1", title: "Midnight 808", author: "qveen", elo: 1016, battles: 1 }] },
      ],
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<GalleryPage />);

    fireEvent.click(await screen.findByText("FIND A BATTLE"));

    // Blind phase: players mounted, no titles anywhere.
    await waitFor(() => expect(screen.getAllByRole("document", { name: "KYX beat player" })).toHaveLength(2));
    expect(screen.queryByText("Midnight 808")).toBeNull();
    expect(screen.queryByText("Garage Skank")).toBeNull();

    fireEvent.click(screen.getByText("A WINS"));

    // Reveal: titles + provenance + the Elo the vote caused.
    expect(await screen.findByText(/Midnight 808/)).toBeTruthy();
    expect(screen.getByText(/Garage Skank/)).toBeTruthy();
    expect(screen.getByText(/🤖/)).toBeTruthy();
    expect(screen.getByText(/elo 1016/)).toBeTruthy();
    expect(screen.getByText(/elo 984/)).toBeTruthy();
    expect(screen.getByText(/#1 Midnight 808/)).toBeTruthy();

    const voteCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/battles/vote"));
    expect(voteCall).toBeTruthy();
    const sent = JSON.parse(String(voteCall![1].body));
    expect(sent).toMatchObject({ a: "b1", b: "b2", winner: "a" });
    expect(typeof sent.session).toBe("string");
    expect(sent.session.length).toBeGreaterThan(0);
  });

  it("treats a duplicate vote (409) as a fresh battle, not an error wall", async () => {
    const duplicate = { ok: false, status: 409, json: async () => ({ error: "already voted" }) } as Response;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/battles/vote")) return Promise.resolve(duplicate);
      if (url.includes("/battles/pair")) {
        return Promise.resolve(jsonResponse({ pair: { a: { id: "x", code: code() }, b: { id: "y", code: code() } } }));
      }
      if (url.includes("/battles/leaderboard")) return Promise.resolve(jsonResponse({ leaders: [] }));
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GalleryPage />);

    fireEvent.click(await screen.findByText("FIND A BATTLE"));
    fireEvent.click(await screen.findByText("A WINS"));
    // The panel recovered on its own — back to a blind arena, no error banner.
    await waitFor(() => expect(screen.getByText(/already voted on this battle/)).toBeTruthy());
    expect(screen.getAllByRole("document", { name: "KYX beat player" }).length).toBe(2);
    expect(screen.getByText("A WINS")).toBeTruthy();
  });
});

describe("GalleryPage", () => {
  it("renders the feed as cards with Open in Forge links", async () => {
    const fetchMock = vi.fn().mockResolvedValue(feedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<GalleryPage />);

    expect(await screen.findByText("Midnight 808")).toBeTruthy();
    expect(screen.getByText("Garage Skank")).toBeTruthy();

    const openLinks = container.querySelectorAll<HTMLAnchorElement>("a.gallery-open");
    expect(openLinks).toHaveLength(2);
    expect(openLinks[0].href).toContain("?import=");
    expect(openLinks[0].target).toBe("_blank");

    // Tags rendered as filter chips.
    expect(screen.getAllByText("#phonk").length).toBeGreaterThan(0);
    // GET was pointed at the local collab server.
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/gallery");
  });

  it("filters by tag when a tag chip is clicked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse()));
    render(<GalleryPage />);

    await screen.findByText("Midnight 808");
    fireEvent.click(screen.getAllByText("#phonk")[0]);
    await waitFor(() => expect(screen.queryByText("Garage Skank")).toBeNull());
    expect(screen.getByText("Midnight 808")).toBeTruthy();
    // Any active chip (toolbar or tag row) toggles the filter off again.
    fireEvent.click(screen.getAllByText(/#phonk/)[0]);
    await waitFor(() => expect(screen.getByText("Garage Skank")).toBeTruthy());
  });

  it("shows the unreachable-server state with a retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    render(<GalleryPage />);
    expect(await screen.findByText(/Gallery server unreachable/)).toBeTruthy();
    expect(screen.getByText(/npm run collab/)).toBeTruthy();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse()));
    fireEvent.click(screen.getByText("RETRY"));
    expect(await screen.findByText("Midnight 808")).toBeTruthy();
  });

  it("lets a visitor submit a moderation report without exposing reporter data", async () => {
    const fetchMock = vi.fn((url: unknown) =>
      String(url).includes("/report")
        ? Promise.resolve(jsonResponse({ accepted: true }, 202))
        : Promise.resolve(feedResponse()),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<GalleryPage />);

    await screen.findByText("Midnight 808");
    fireEvent.click(screen.getAllByRole("button", { name: "REPORT" })[0]);
    const reportGroup = screen.getByRole("group", { name: "Report Midnight 808" });
    fireEvent.change(screen.getByRole("combobox", { name: "WHY?" }), {
      target: { value: "copyright or ownership issue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "SEND REPORT" }));

    // Generous timeout: under full-suite CPU load the fetch round-trip can
    // outrun waitFor's 1s default (same rationale as tests/ui/midi-io).
    await waitFor(() => expect(screen.getByText("REPORT SENT ✓")).toBeTruthy(), { timeout: 10_000 });
    expect(reportGroup).toBeTruthy();
    const reportCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/report")) as unknown as [
      unknown,
      RequestInit,
    ];
    expect(reportCall).toBeTruthy();
    expect(JSON.parse(String(reportCall[1].body))).toEqual({ reason: "copyright or ownership issue" });
  });

  it("publishes: opens the form, parses the pasted share link, POSTs the payload", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(
            jsonResponse(
              {
                item: {
                  id: "new",
                  title: "My Jam",
                  author: "me",
                  tags: ["house"],
                  code: "abc",
                  bpm: 124,
                  projectName: "house",
                  createdAt: new Date().toISOString(),
                },
              },
              201,
            ),
          )
        : Promise.resolve(feedResponse()),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<GalleryPage />);

    fireEvent.click(await screen.findByText("+ DROP YOUR BEAT"));
    fireEvent.change(screen.getByLabelText("Beat title"), { target: { value: "My Jam" } });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "me" } });
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "house, Deep" } });
    fireEvent.change(screen.getByLabelText("Share link or code"), {
      target: { value: `http://localhost:5173/?import=${code()}` },
    });
    fireEvent.click(screen.getByText("PUBLISH TO GALLERY"));

    // The gallery page also pings the battle leaderboard on mount, so assert
    // on the POST call itself rather than on exact call counts.
    await waitFor(() => expect(fetchMock.mock.calls.some(([, postInit]) => postInit?.method === "POST")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, postInit]) => postInit?.method === "POST") as [unknown, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.title).toBe("My Jam");
    expect(body.author).toBe("me");
    expect(body.tags).toEqual(["house", "deep"]); // lowercased, split on comma+space
    expect(body.code.length).toBeGreaterThan(16);
    expect(await screen.findByText(/Published!/)).toBeTruthy();
    // The feed reloads after publish (initial feed + leaderboard GET + POST + reload GET ≥ 4).
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4));
  });

  it("flags an invalid share code instead of POSTing junk", async () => {
    const fetchMock = vi.fn().mockResolvedValue(feedResponse());
    vi.stubGlobal("fetch", fetchMock);
    render(<GalleryPage />);

    fireEvent.click(await screen.findByText("+ DROP YOUR BEAT"));
    fireEvent.change(screen.getByLabelText("Beat title"), { target: { value: "No code" } });
    fireEvent.change(screen.getByLabelText("Share link or code"), { target: { value: "totally not a code" } });
    fireEvent.click(screen.getByText("PUBLISH TO GALLERY"));

    expect(await screen.findByText(/Paste a valid share link/)).toBeTruthy();
    // The mount also pings the battle leaderboard — the pin is that NO POST
    // left the page with the junk code.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("prefills the publish form from a studio hand-off (sessionStorage)", async () => {
    sessionStorage.setItem("pf-publish-code", code());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse()));
    render(<GalleryPage />);

    expect(await screen.findByText(/Project loaded from the studio/)).toBeTruthy();
    const textarea = screen.getByLabelText("Share link or code") as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(16);
    expect(screen.getByText("✕", { selector: ".gallery-publish-close" })).toBeTruthy();
  });
});

describe("gallery flywheel", () => {
  function itemWithStats() {
    return {
      items: [
        {
          id: "b1",
          title: "Popular Beat",
          author: "qveen",
          tags: ["phonk"],
          code: code(),
          bpm: 124,
          projectName: "house",
          createdAt: "2026-09-01T10:00:00.000Z",
          plays: 1234,
          remixCount: 3,
        },
      ],
    };
  }

  it("shows play + remix badges formatted for humans", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(itemWithStats())));
    const { container } = render(<GalleryPage />);
    expect(await screen.findByText("Popular Beat")).toBeTruthy();
    expect(screen.getByText("▶ 1.2k")).toBeTruthy();
    expect(screen.getByText("🎸 3 remixes")).toBeTruthy();
    expect(container.querySelector(".gallery-card-stats")).toBeTruthy();
  });

  it("counts a play once per session and shows the optimistic tick", async () => {
    const fetchMock = vi.fn((input: unknown) =>
      typeof input === "string" && input.includes("/play")
        ? Promise.resolve(jsonResponse({ plays: 1235 }))
        : Promise.resolve(jsonResponse(itemWithStats())),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<GalleryPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Play preview" }));

    await waitFor(() => expect(screen.getByText("▶ 1.2k")).toBeTruthy());
    const playCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/play")) as
      [unknown, RequestInit?] | undefined;
    expect(playCall).toBeTruthy();
    expect(playCall![1]?.method).toBe("POST");
    // Second toggle (stop) does not ping again — session dedup.
    fireEvent.click(screen.getByRole("button", { name: "Stop preview" }));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/play"))).toHaveLength(1);
  });

  it("FORK remembers the remix parent and opens the studio with remixOf", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(itemWithStats())));
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<GalleryPage />);
    fireEvent.click(await screen.findByText("FORK 🎸"));

    const stored = JSON.parse(localStorage.getItem("pf-remix-parent") ?? "{}");
    expect(stored.id).toBe("b1");
    expect(stored.title).toBe("Popular Beat");
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(String(openSpy.mock.calls[0][0])).toContain("remixOf=b1");
    localStorage.clear();
  });

  it("publish form chains the remix parent and persists the creator handle", async () => {
    localStorage.setItem("pf-remix-parent", JSON.stringify({ id: "b1", title: "Popular Beat", savedAt: Date.now() }));
    const fetchMock = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(
            jsonResponse(
              {
                item: {
                  id: "child",
                  title: "My Remix",
                  author: "qveen",
                  tags: [],
                  code: "abc",
                  bpm: 124,
                  projectName: "x",
                  createdAt: new Date().toISOString(),
                  parentId: "b1",
                },
              },
              201,
            ),
          )
        : Promise.resolve(jsonResponse({ items: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<GalleryPage />);

    fireEvent.click(await screen.findByText("+ DROP YOUR BEAT"));
    // Remix chip from the FORK hand-off is visible and removable.
    expect(screen.getByText(/Remix of:/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Beat title"), { target: { value: "My Remix" } });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Qveen" } });
    fireEvent.change(screen.getByLabelText("Share link or code"), { target: { value: code() } });
    fireEvent.click(screen.getByText("PUBLISH TO GALLERY"));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const [, postInit] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST") as [unknown, RequestInit];
    const body = JSON.parse(String(postInit.body));
    expect(body.parentId).toBe("b1");
    // Handle persisted for the next publish.
    expect(localStorage.getItem("pf-creator-name")).toBe("Qveen");
    // Chain cleared after publish.
    expect(localStorage.getItem("pf-remix-parent")).toBeNull();
    localStorage.clear();
  });
});

describe("GalleryPage — Remix-DNA family", () => {
  function familyFeed() {
    const root = {
      id: "g-root",
      title: "Root Beat",
      author: "qveen",
      tags: [],
      code: code(),
      bpm: 124,
      projectName: "house",
      createdAt: "2026-09-01T10:00:00.000Z",
      docId: "doc-root",
      depth: 0,
      childrenCount: 1,
    };
    const child = {
      id: "g-child",
      title: "Child Beat",
      author: "matej",
      tags: [],
      code: code(),
      bpm: 124,
      projectName: "house",
      createdAt: "2026-09-01T11:00:00.000Z",
      docId: "doc-child",
      parentDocId: "doc-root",
      rootDocId: "doc-root",
      depth: 1,
      childrenCount: 0,
    };
    return jsonResponse({ items: [child, root] });
  }

  it("badges children counts and expands the ancestor/child tree", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(familyFeed()));
    render(<GalleryPage />);
    expect(await screen.findByText("Root Beat")).toBeTruthy();
    // 🧬 badge with the server count on the parent card.
    expect(screen.getByTitle("1 published children of this beat")).toBeTruthy();
    // Family toggle lists the ancestor above and the child below (feed
    // order: child card first, root card second).
    const toggles = screen.getAllByRole("button", { name: /FAMILY/ });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]); // child card → ancestor
    expect(screen.getByRole("group", { name: "Ancestors" })).toHaveTextContent("Root Beat");
    fireEvent.click(toggles[1]); // root card → children
    expect(screen.getByRole("group", { name: "Children" })).toHaveTextContent("Child Beat");
    // Family links open beats in the studio.
    const ancestorLink = screen.getByRole("group", { name: "Ancestors" }).querySelector("a")!;
    expect(ancestorLink.getAttribute("href")).toContain("?import=");
    expect(ancestorLink.getAttribute("target")).toBe("_blank");
  });

  it("stays quiet on beats without lineage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse()));
    render(<GalleryPage />);
    expect(await screen.findByText("Midnight 808")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /FAMILY/ })).toBeNull();
    expect(screen.queryByText(/🧬/)).toBeNull();
  });
});
