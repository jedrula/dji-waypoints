#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { detect, listSlots, pullSlot, install } from './bridge.mjs';

// Static server for development. The one thing it does that `python3 -m
// http.server` does not is refuse to let the browser cache anything -- ES
// modules are cached aggressively, and a stale module after an edit shows up
// as a baffling "does not provide an export named ..." error.
//
// It also carries /api/*, which is what lets the page install a mission onto a
// connected controller. The published copy on GitHub Pages has no such server,
// so the page treats the whole panel as absent when these routes 404.

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8123);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.kmz': 'application/vnd.google-earth.kmz',
};

// Overwriting missions is destructive, so the API answers the loopback address
// only. Planning from a phone against this server still works; installing is a
// thing you do standing at the Mac the controller is plugged into.
const ALLOW_LAN = process.env.BRIDGE_ALLOW_LAN === '1';
function localOnly(req) {
  const a = req.socket.remoteAddress ?? '';
  return ALLOW_LAN || a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

async function readBody(req, limit = 64 << 20) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function api(req, res, url, params) {
  if (!localOnly(req)) return sendJson(res, 403, { error: 'the install API is loopback-only (set BRIDGE_ALLOW_LAN=1 to change that)' });

  if (url === '/api/controller') return sendJson(res, 200, detect());

  if (url === '/api/slots') {
    const t = params.get('transport');
    if (!t) return sendJson(res, 400, { error: 'transport required' });
    return sendJson(res, 200, { transport: t, slots: listSlots(t) });
  }

  // Pull a mission back off the controller -- a real DJI-written KMZ is the
  // reference `npm run check -- ours.kmz theirs.kmz` wants.
  if (url === '/api/slot') {
    const t = params.get('transport');
    const slot = params.get('slot');
    if (!t || !slot) return sendJson(res, 400, { error: 'transport and slot required' });
    const buf = pullSlot(t, slot);
    res.writeHead(200, {
      'Content-Type': TYPES['.kmz'],
      'Content-Disposition': `attachment; filename="${slot}.kmz"`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  if (url === '/api/install' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const { transport, items } = body;
    if (!transport || !Array.isArray(items) || !items.length) {
      return sendJson(res, 400, { error: 'transport and items required' });
    }
    const installed = [];
    for (const it of items) {
      installed.push(install(transport, it.slot, Buffer.from(it.b64, 'base64')));
    }
    return sendJson(res, 200, { installed });
  }

  return sendJson(res, 404, { error: `no such route: ${url}` });
}

createServer(async (req, res) => {
  const raw = req.url ?? '/';
  const url = decodeURIComponent(raw.split('?')[0]);

  if (url.startsWith('/api/')) {
    try {
      await api(req, res, url, new URLSearchParams(raw.split('?')[1] ?? ''));
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) throw new Error('directory');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${rel}`);
  }
}).listen(PORT, () => {
  console.log(`3DGS mission planner  →  http://localhost:${PORT}`);
  console.log('(no-store: edits show up on plain reload)');
});
