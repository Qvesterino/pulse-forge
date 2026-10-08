// What does the server actually return for /?
import { createServer } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, logLevel: "error", server: { port: 5233, host: "127.0.0.1", strictPort: true } });
await server.listen();
await new Promise((r) => setTimeout(r, 500));
const res = await fetch("http://127.0.0.1:5233/");
const text = await res.text();
console.log("status:", res.status, "len:", text.length);
console.log("head:", text.slice(0, 300).replace(/\n/g, " | "));
await server.close();
