/**
 * Local Listening Inbox and static listening-pack server —
 * http://127.0.0.1:5179/ (serves listening/ with correct WAV mime type).
 */
import { createServer } from "node:http";
import { readFile, stat, writeFile, readdir } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildListeningCatalog } from "./listening-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_ROOT = path.join(ROOT, "listening");
const PORT = Number(process.env.PORT) || 5179;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".wav": "audio/wav",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const VERDICTS = path.join(SERVE_ROOT, "verdicts.json");

// Flat listening packs that live OUTSIDE listening/ — the PACKY tab reads
// them through /api/packs + /pack/<name>/<file>. Only whitelisted names.
const PACKS = {
  "groove-listening": path.join(ROOT, "groove-listening"),
  "v1v3-listening": path.join(ROOT, "v1v3-listening"),
  "golden-review": path.join(ROOT, "golden-review"),
};

const readVerdicts = async () => {
  try {
    const parsed = JSON.parse(await readFile(VERDICTS, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    // Verdict API — the room page teaches the intent engine through here.
    if (url.pathname === "/api/verdict" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const verdict = JSON.parse(body);
      if (!verdict || typeof verdict !== "object" || typeof verdict.kind !== "string") {
        res.writeHead(400).end('{"error":"invalid verdict"}');
        return;
      }
      const verdicts = await readVerdicts();
      verdicts.push({ ...verdict, receivedAt: Date.now() });
      await writeFile(VERDICTS, JSON.stringify(verdicts, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, count: verdicts.length }));
      return;
    }
    // ABX forced-choice trials (listening/abx/trials.jsonl) — appended by
    // the abx page, aggregated by src/listening/abx-stats.ts via the ingest.
    if (url.pathname === "/api/abx-trial" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let trial;
      try {
        trial = JSON.parse(body);
      } catch {
        res.writeHead(400).end('{"error":"invalid trial"}');
        return;
      }
      if (
        trial == null ||
        typeof trial !== "object" ||
        typeof trial.lane !== "string" ||
        (trial.xWas !== "A" && trial.xWas !== "B") ||
        (trial.answer !== "A" && trial.answer !== "B")
      ) {
        res.writeHead(400).end('{"error":"invalid abx trial"}');
        return;
      }
      const trialsPath = path.join(SERVE_ROOT, "abx", "trials.jsonl");
      mkdirSync(path.dirname(trialsPath), { recursive: true });
      const { appendFile } = await import("node:fs/promises");
      await appendFile(trialsPath, JSON.stringify({ ...trial, receivedAt: Date.now() }) + "\n");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/abx-trials" && req.method === "GET") {
      const trialsPath = path.join(SERVE_ROOT, "abx", "trials.jsonl");
      let content = "";
      try {
        content = await readFile(trialsPath, "utf8");
      } catch {
        content = "";
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(content);
      return;
    }
    // Dice ★ packs from the app (dice tray ⬇★ export can POST here) —
    // everything lands in listening/dice-packs/ for train-my-taste.
    if (url.pathname === "/api/favorites" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const pack = JSON.parse(body);
      if (!pack || pack.version !== 1 || !Array.isArray(pack.entries)) {
        res.writeHead(400).end('{"error":"expected a FavoritesPack"}');
        return;
      }
      const dir = path.join(SERVE_ROOT, "dice-packs");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `posted-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(pack, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, entries: pack.entries.length }));
      return;
    }
    if (url.pathname === "/api/verdicts" && req.method === "GET") {
      const verdicts = await readVerdicts();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: verdicts.length, verdicts }));
      return;
    }
    // PACKS — the flat listening packs, listed and served for the PACKY tab.
    if (url.pathname === "/api/packs" && req.method === "GET") {
      const packs = [];
      for (const [name, dir] of Object.entries(PACKS)) {
        try {
          const entries = await readdir(dir);
          packs.push({ name, files: entries.filter((f) => f.endsWith(".wav")).sort() });
        } catch {
          packs.push({ name, files: [] }); // not rendered on this machine
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ packs }));
      return;
    }
    if (url.pathname === "/api/listening-catalog" && req.method === "GET") {
      const catalog = await buildListeningCatalog(ROOT);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(catalog));
      return;
    }
    {
      const packMatch = /^\/pack\/([\w-]+)\/([^/]+)$/.exec(url.pathname);
      if (packMatch) {
        const packDir = PACKS[packMatch[1]];
        if (!packDir) throw new Error("unknown pack");
        const abs = path.join(packDir, path.basename(packMatch[2]));
        if (!abs.startsWith(packDir)) throw new Error("traversal");
        const data = await readFile(abs);
        res.writeHead(200, {
          "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
          "content-length": data.length,
          "accept-ranges": "none",
        });
        res.end(data);
        return;
      }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const data = await readFile(path.join(ROOT, "scripts", "listening-index-template.html"));
      res.writeHead(200, {
        "content-type": MIME[".html"],
        "content-length": data.length,
        "cache-control": "no-store",
      });
      res.end(data);
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/morph/") rel = "/morph/index.html";
    if (rel === "/abx/" || rel === "/abx") rel = "/abx/index.html";
    if (rel === "/room/" || rel === "/room") rel = "/room/room.html";
    const abs = path.join(SERVE_ROOT, rel);
    if (!abs.startsWith(SERVE_ROOT)) throw new Error("traversal");
    const info = await stat(abs);
    if (!info.isFile()) throw new Error("not a file");
    const data = await readFile(abs);
    res.writeHead(200, {
      "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "content-length": data.length,
      "accept-ranges": "none",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening inbox: http://127.0.0.1:${PORT}/`);
  console.log(`Listening Room: http://127.0.0.1:${PORT}/room/`);
  console.log(`ABX: http://127.0.0.1:${PORT}/abx/`);
  console.log("(Ctrl+C to stop)");
});
