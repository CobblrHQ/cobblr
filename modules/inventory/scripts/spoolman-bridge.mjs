import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

export function startSpoolmanBridge({ upstream, token, host = "127.0.0.1", port = 7912, pollMs = 5000 }) {
  const base = new URL(upstream);
  const sockets = new WebSocketServer({ noServer: true });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const allowed = (path, method) => method === "GET" && /^\/api\/v1\/(info|spool(?:\/\d+)?|filament|vendor)$/.test(path) || method === "PUT" && /^\/api\/v1\/spool\/\d+\/use$/.test(path);
  const request = (path, options = {}) => fetch(new URL(base.href.replace(/\/$/, "") + path), { ...options, headers, signal: AbortSignal.timeout(15000) });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (!allowed(url.pathname, req.method)) { res.writeHead(404); res.end("{}"); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { res.writeHead(413); res.end("{}"); return; }
        chunks.push(chunk);
      }
      const reply = await request(url.pathname + url.search, { method: req.method, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(await reply.text());
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Cobblr could not be reached." }));
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://localhost").pathname !== "/api/v1/spool") { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
  });
  let previous = new Map();
  let stopped = false;
  let timer;
  const broadcast = (type, payload) => {
    const event = JSON.stringify({ resource: "spool", type, payload });
    for (const ws of sockets.clients) if (ws.readyState === WebSocket.OPEN) ws.send(event);
  };
  const poll = async () => {
    try {
      const next = new Map();
      for (let offset = 0; ; offset += 100) {
        const reply = await request(`/api/v1/spool?allow_archived=true&limit=100&offset=${offset}`);
        if (!reply.ok) throw new Error("read failed");
        const rows = await reply.json();
        if (!Array.isArray(rows)) throw new Error("bad response");
        for (const spool of rows) next.set(spool.id, spool);
        if (rows.length < 100) break;
      }
      const deleted = [];
      // Offset pages shift when a preceding spool disappears. A missing row
      // is not a deletion until its own address returns not found.
      for (const [id] of previous) if (!next.has(id)) {
        const reply = await request(`/api/v1/spool/${encodeURIComponent(id)}`);
        if (reply.status === 404) deleted.push(id);
        else {
          if (!reply.ok) throw new Error("read failed");
          const spool = await reply.json();
          if (!spool || spool.id !== id) throw new Error("bad response");
          next.set(id, spool);
        }
      }
      for (const [id, spool] of next) {
        if (!previous.has(id)) broadcast("added", spool);
        else if (JSON.stringify(previous.get(id)) !== JSON.stringify(spool)) broadcast("updated", spool);
      }
      for (const id of deleted) broadcast("deleted", { id });
      previous = next;
      for (const ws of sockets.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
    } catch {
      // A failed poll never announces deletion. A manager stops reporting
      // while its socket is down and keeps the unreported length for later.
      for (const ws of sockets.clients) ws.close(1013, "Cobblr unavailable");
    } finally {
      if (!stopped && pollMs > 0) timer = setTimeout(poll, pollMs);
    }
  };
  server.listen(port, host, () => { if (pollMs > 0) void poll(); });
  return { server, refresh: poll, close: async () => {
    stopped = true;
    clearTimeout(timer);
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [upstream, tokenFile, port, host] = process.argv.slice(2);
  if (!upstream || !tokenFile) throw new Error("Usage: node spoolman-bridge.mjs <Cobblr native base URL> <token file> [port] [bind address]");
  const token = (await readFile(tokenFile, "utf8")).split("\n").find((l) => l.trim() && !l.trim().startsWith("#"))?.trim();
  if (!token) throw new Error("The token file has no token.");
  const bridge = startSpoolmanBridge({ upstream, token, port: Number(port || 7912), host: host || "127.0.0.1" });
  const stop = () => { void bridge.close().then(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log("Spoolman compatibility bridge started.");
}
