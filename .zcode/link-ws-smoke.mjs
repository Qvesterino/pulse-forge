import { WebSocket } from "ws";
const ws = new WebSocket("ws://127.0.0.1:20932");
const seen = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name: "smoke", tempo: 140, playing: false })));
ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  seen.push(msg);
  if (msg.type === "link" && msg.tempo === 140) {
    console.log("ROUND-TRIP OK: adopted tempo 140, beat", msg.beat.toFixed(2), "peers", msg.peers);
    ws.close();
    process.exit(0);
  }
  if (seen.length > 20) {
    console.error("FAIL: no adopted frame, seen:", JSON.stringify(seen.slice(0, 3)));
    process.exit(1);
  }
});
ws.on("error", (e) => { console.error("WS error", e.message); process.exit(1); });
setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 5000);
