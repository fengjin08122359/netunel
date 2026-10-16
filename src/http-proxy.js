// 本地 HTTP 代理: 接收浏览器/系统 HTTP 代理请求, 通过 NTP 隧道转发
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { splitHostPort } from './hostport.js';

export class HttpProxy extends EventEmitter {
  constructor({ relay, host = '127.0.0.1', port = 1080 }) {
    super();
    this.relay = relay;
    this.host = host;
    this.port = port;
    this.server = null;
    this.stats = { requests: 0, connects: 0 };
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._onConn(sock));
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  address() { return this.server ? this.server.address() : null; }

  _onConn(sock) {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      this._tryHandle(sock, buf);
    });
    sock.on('error', () => sock.destroy());
  }

  _tryHandle(sock, buf) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) {
      if (buf.length > 65536) sock.destroy();
      return;
    }
    const head = buf.subarray(0, idx).toString('latin1');
    const rest = buf.subarray(idx + 4);
    sock.removeAllListeners('data');
    this._route(sock, head, rest);
  }

  _route(sock, head, rest) {
    const lines = head.split('\r\n');
    const parts = (lines[0] || '').split(' ');
    const method = (parts[0] || '').toUpperCase();
    const target = parts[1] || '';

    if (method === 'CONNECT') { this._doConnect(sock, target, rest, lines); return; }

    // 常规 HTTP 转发
    let host = null;
    for (const l of lines.slice(1)) {
      const m = /^Host:\s*(.+)$/i.exec(l);
      if (m) { host = m[1].trim(); break; }
    }
    if (!host) { this._err400(sock); return; }
    let path = target;
    let useHost = host;
    try {
      const u = new URL(target.startsWith('http') ? target : 'http://' + host + target);
      path = u.pathname + u.search;
      useHost = u.port ? (u.hostname + ':' + u.port) : u.hostname;
    } catch (e) { /* keep raw */ }
    const [h, p] = splitHostPort(useHost, 80);
    const newHead = [method + ' ' + path + ' HTTP/1.1', ...lines.slice(1)].join('\r\n') + '\r\n\r\n';
    this.stats.requests++;
    this._openAndPipe(sock, h, p, Buffer.concat([Buffer.from(newHead, 'latin1'), rest]));
  }

  _doConnect(sock, target, rest, lines) {
    const [h, p] = splitHostPort(target, 443);
    this.stats.connects++;
    this.relay.openTunnel(h, p).then((tun) => {
      try { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); } catch (e) { tun.close(); return; }
      this._pipe(sock, tun);
      if (rest && rest.length) tun.write(rest);
    }).catch(() => this._err502(sock));
  }

  _openAndPipe(sock, host, port, firstBuf) {
    this.relay.openTunnel(host, port).then((tun) => {
      if (firstBuf && firstBuf.length) tun.write(firstBuf);
      this._pipe(sock, tun);
    }).catch(() => this._err502(sock));
  }

  _pipe(sock, tun) {
    sock.on('data', (d) => tun.write(d));
    sock.on('end', () => tun.close());
    sock.on('error', () => tun.close());
    sock.on('close', () => tun.close());
    tun.onData = (d) => { if (!sock.destroyed) { try { sock.write(d); } catch (e) {} } };
    tun.onClose = () => { if (!sock.destroyed) { try { sock.end(); } catch (e) {} } };
    tun.onError = () => { if (!sock.destroyed) { try { sock.end(); } catch (e) {} } };
  }

  _err400(sock) { try { sock.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); } catch (e) {} sock.end(); }
  _err502(sock) { try { sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch (e) {} sock.end(); }

  close() { if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; } }
}

