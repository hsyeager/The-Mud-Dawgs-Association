#!/usr/bin/env node
/**
 * Minimal static server for local development.
 *
 * The site uses native ES modules, which browsers refuse to load over file://,
 * so previewing needs a real HTTP origin. Node's built-in http module is enough
 * -- this keeps the project at zero dependencies.
 *
 *   npm run serve        # http://localhost:4173
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // Strip the leading slash and normalize, then confirm the result is still
    // inside ROOT so a crafted path cannot escape the project directory.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let filePath = resolve(join(ROOT, rel));

    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = join(filePath, "index.html");
      info = await stat(filePath).catch(() => null);
    }

    if (!info) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`Mud Dawgs dev server -> http://localhost:${PORT}`);
});
