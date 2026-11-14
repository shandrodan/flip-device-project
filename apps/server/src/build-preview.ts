import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { devServer, insideProject, localBuild } from "./build-host.js";
import { machines } from "./machines.js";
import { state } from "./store.js";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type FileResult = { body: Buffer } | { error: string };

function previewPath(requestPath: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) return null;
  return parts.join("/") || "index.html";
}

function projectPath(relativePath: string) {
  return [state.build.dir.replace(/\/+$/, ""), relativePath].join("/");
}

function fileData(value: unknown): value is { text: string; truncated?: boolean } {
  return !!value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string";
}

async function readPreviewFile(relativePath: string): Promise<FileResult> {
  if (localBuild()) {
    // BUILD_HOST=server (ADR 0033): the project is on this machine.
    const file = insideProject(relativePath);
    if (!file) return { error: "ENOENT" };
    try {
      return { body: await fs.promises.readFile(file) };
    } catch (error) {
      return { error: (error as NodeJS.ErrnoException).code === "EISDIR" ? "is a directory" : (error as Error).message };
    }
  }
  try {
    const result = await machines.pick().run("fs.read", { path: projectPath(relativePath), encoding: "base64" }, undefined, 15_000);
    if (!result.ok) return { error: result.output || "The Build machine could not read this file." };
    if (!fileData(result.data) || result.data.truncated) return { error: "The Build preview file is unavailable." };
    return { body: Buffer.from(result.data.text, "base64") };
  } catch (error) {
    return { error: (error as Error).message || "The Build machine is offline." };
  }
}

function missing(error: string) {
  return /ENOENT|no such file|is a directory/i.test(error);
}

function errorPage(status: number, message: string) {
  return `<!doctype html><title>Build preview</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#f2f2f4;color:#1d1d1f;font:500 16px/1.45 system-ui}main{max-width:28rem;padding:2rem;text-align:center}h1{margin:0 0 .5rem;font-size:1.3rem}p{margin:0;color:#6e6e73}</style><main><h1>Build preview unavailable</h1><p>${message}</p></main>`;
}

function sendError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(errorPage(status, message));
}

/** The Device's preview frame is sandboxed, so its origin is "null": scripts load as CORS requests. */
const OPEN = { "access-control-allow-origin": "*" };

/** With a dev server running on this machine, /preview/ streams it. It runs with base path /preview/. */
function proxyToDev(req: IncomingMessage, res: ServerResponse, port: number) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers.origin;
  const upstream = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers }, response => {
    res.writeHead(response.statusCode ?? 502, { ...response.headers, ...OPEN });
    response.pipe(res);
  });
  upstream.on("error", () => sendError(res, 502, "The dev server is not answering. Ask the Build agent to start it again."));
  req.pipe(upstream);
}

/** Hot reload: pass the dev server's WebSocket through. */
export function upgradeBuildPreview(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const running = localBuild() ? devServer() : null;
  if (!running?.running) return socket.destroy();
  const upstream = net.connect(running.port, "127.0.0.1", () => {
    const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${running.port}` })
      .filter(([key]) => key !== "origin").map(([key, value]) => `${key}: ${value}`).join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

export async function serveBuildPreview(req: IncomingMessage, res: ServerResponse, requestPath: string) {
  const running = localBuild() ? devServer() : null;
  if (running?.running) return proxyToDev(req, res, running.port);
  res.setHeader("access-control-allow-origin", "*");
  const requested = previewPath(requestPath);
  if (!requested) return sendError(res, 400, "That preview path is not valid.");

  const primary = await readPreviewFile(requested);
  if ("body" in primary) {
    return res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(requested).toLowerCase()] || "application/octet-stream",
      "content-length": primary.body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }).end(primary.body);
  }

  const canFallBackToIndex = requested !== "index.html" && !path.posix.basename(requested).includes(".");
  if (canFallBackToIndex && missing(primary.error)) {
    const index = await readPreviewFile("index.html");
    if ("body" in index) {
      return res.writeHead(200, {
        "content-type": MIME_TYPES[".html"],
        "content-length": index.body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      }).end(index.body);
    }
    if (!missing(index.error)) return sendError(res, 503, "The Build machine is not available.");
  }

  if (missing(primary.error)) return sendError(res, 404, "No file exists here yet. Ask the agent to create index.html in the Build project.");
  return sendError(res, 503, "The Build machine is not available.");
}
