import { createServer } from "vite";
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: 5303, host: "127.0.0.1", strictPort: true } });
await server.listen();
const targets = ["/src/ai/grooves/house.ts", "/src/plugin-audit-checks.ts", "/src/project-model/templates.ts"];
for (const t of targets) {
  const res = await fetch(`http://127.0.0.1:5303${t}`);
  console.log(res.status, t);
}
await server.close();
