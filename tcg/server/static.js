// HOSTILE TAKEOVER — HTTP layer: static file serving + JSON API endpoints.
// Plain node:http, no Express. Path-traversal safe, correct MIME types.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

function sendJson(res, status, jsonString) {
  sendText(res, status, jsonString, 'application/json; charset=utf-8');
}

function notFound(res) {
  sendText(res, 404, '404 — asset not found. The department responsible has been dissolved.\n');
}

/**
 * createRequestHandler({ clientDir, cardsJson, getStatus })
 *  - clientDir:  absolute path of the static root (../client)
 *  - cardsJson:  pre-serialized JSON string for GET /api/cards (cached at boot)
 *  - getStatus:  () => ({ online, inQueue, activeGames })
 */
export function createRequestHandler({ clientDir, cardsJson, getStatus }) {
  const root = path.resolve(clientDir);

  return async function handleRequest(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendText(res, 405, 'Method Not Allowed\n');
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        sendText(res, 400, 'Bad Request\n');
        return;
      }
      if (pathname.includes('\0')) {
        sendText(res, 400, 'Bad Request\n');
        return;
      }

      // --- API endpoints ---------------------------------------------------
      if (pathname === '/api/cards') {
        sendJson(res, 200, cardsJson);
        return;
      }
      if (pathname === '/api/status') {
        let status;
        try {
          status = getStatus();
        } catch {
          status = { online: 0, inQueue: 0, activeGames: 0 };
        }
        sendJson(res, 200, JSON.stringify(status));
        return;
      }
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, '{"error":"unknown endpoint"}');
        return;
      }

      // --- static files ----------------------------------------------------
      if (pathname.endsWith('/')) pathname += 'index.html';
      const filePath = path.normalize(path.join(root, pathname));
      // Traversal guard: resolved path must stay inside the client root.
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        notFound(res);
        return;
      }

      let info;
      let finalPath = filePath;
      try {
        info = await stat(finalPath);
        if (info.isDirectory()) {
          finalPath = path.join(finalPath, 'index.html');
          info = await stat(finalPath);
        }
      } catch {
        notFound(res);
        return;
      }
      if (!info.isFile()) {
        notFound(res);
        return;
      }

      const type = MIME[path.extname(finalPath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(finalPath);
      stream.on('error', () => {
        // File vanished between stat and read — terminate cleanly.
        if (!res.headersSent) notFound(res);
        else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      // Absolute last line of defense: never let an HTTP request crash the process.
      try {
        if (!res.headersSent) sendText(res, 500, 'Internal Server Error\n');
        else res.destroy();
      } catch {
        /* socket already gone */
      }
    }
  };
}
