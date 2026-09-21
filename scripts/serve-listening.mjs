/**
 * Tiny static server for the MORPH listening pack —
 * http://127.0.0.1:5179  (serves listening/ with correct WAV mime type).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "/morph/") rel = "/morph/index.html";
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
