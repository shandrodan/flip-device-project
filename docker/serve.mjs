// Tiny static server for the built Device app, no dependencies. Proxies /ws, /setup, /health and the
// Build preview (/preview/, with its hot-reload socket) to the server, so the Device keeps one origin
// and a server on another machine needs no public port. SERVER_URL=http://server:8787 PORT=5173 node serve.mjs
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.ROOT || "./dist");
const port = Number(process.env.PORT || 5173);
const upstream = new URL(process.env.SERVER_URL || "http://127.0.0.1:8787");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname === "/setup" || url.pathname === "/health" || url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
    const up = http.request({ host: upstream.hostname, port: upstream.port || 80, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on("error", () => res.writeHead(502).end("server unreachable"));
    return req.pipe(up);
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html"); // SPA: /, /dock
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
  fs.createReadStream(file).pipe(res);
});

// WebSocket pass-through: replay the upgrade request upstream and pipe both ways.
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws") && !req.url?.startsWith("/preview/")) return socket.destroy();
  const up = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(port, "0.0.0.0", () => console.log(`Device app on :${port} (server ${upstream.origin})`));
