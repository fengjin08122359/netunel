// 本地 Web 控制面板 (HTTP + JSON API)
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWebUi({ host = '127.0.0.1', port = 8899, manager }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    try {
      if (url.pathname.startsWith('/api/')) return await apiRoute(req, res, url, manager);
      return staticRoute(req, res, url.pathname);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function apiRoute(req, res, url, m) {
  const method = req.method;
  const p = url.pathname;

  if (p === '/api/status' && method === 'GET') {
    return json(res, m.status());
  }
  if (p === '/api/nodes' && method === 'GET') {
    return json(res, { ok: true, nodes: m.listNodes() });
  }
  if (p === '/api/nodes' && method === 'POST') {
    const body = await readBody(req);
    const node = m.addNode(body.node);
    return json(res, { ok: true, node });
  }
  if (p.startsWith('/api/nodes/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/nodes/'.length));
    m.deleteNode(id);
    return json(res, { ok: true });
  }
  if (p === '/api/node/select' && method === 'POST') {
    const body = await readBody(req);
    m.selectNode(body.id);
    return json(res, { ok: true });
  }
  if (p === '/api/subscription/fetch' && method === 'POST') {
    const body = await readBody(req);
    const result = await m.fetchSubscription(body.url, body.name);
    return json(res, result);
  }
  if (p === '/api/connect' && method === 'POST') {
    const result = await m.connectClient();
    return json(res, result);
  }
  if (p === '/api/disconnect' && method === 'POST') {
    m.disconnectClient();
    return json(res, { ok: true });
  }
  if (p === '/api/server/start' && method === 'POST') {
    const body = await readBody(req);
    const result = await m.startServer(body);
    return json(res, result);
  }
  if (p === '/api/server/stop' && method === 'POST') {
    m.stopServer();
    return json(res, { ok: true });
  }
  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    m.saveSettings(body);
    return json(res, { ok: true });
  }
  return json(res, { ok: false, error: 'not found' }, 404);
}

function staticRoute(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(__dirname, 'ui', file);
  if (!full.startsWith(path.join(__dirname, 'ui'))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

