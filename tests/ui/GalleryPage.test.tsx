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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as [unknown, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.title).toBe("My Jam");
    expect(body.author).toBe("me");
    expect(body.tags).toEqual(["house", "deep"]); // lowercased, split on comma+space
    expect(body.code.length).toBeGreaterThan(16);
    expect(await screen.findByText(/Published!/)).toBeTruthy();
    // The feed reloads after publish.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
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
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial GET
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
