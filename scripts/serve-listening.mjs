/**
 * Tiny static server for the MORPH listening pack —
 * http://127.0.0.1:5179  (serves listening/ with correct WAV mime type).
 */
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_ROOT = path.join(ROOT, "listening");
const PORT = Number(process.env.PORT) || 5179;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".wav": "audio/wav",
  ".md": "text/plain; charset=utf-8",
};

const VERDICTS = path.join(SERVE_ROOT, "verdicts.json");

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
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "/morph/") rel = "/morph/index.html";
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
  console.log(`listening pack: http://127.0.0.1:${PORT}/morph/`);
  console.log("(Ctrl+C to stop)");
});
