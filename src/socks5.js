// 本地 SOCKS5 代理 (RFC 1928): 只支持 CONNECT 命令
import net from 'node:net';
import { EventEmitter } from 'node:events';

const REP_OK = 0x00;
const REP_CMD_NOT_SUPPORTED = 0x07;
const REP_HOST_UNREACHABLE = 0x04;
const REP_GENERAL = 0x01;

export class Socks5Proxy extends EventEmitter {
  constructor({ relay, host = '127.0.0.1', port = 1081 }) {
    super();
    this.relay = relay;
    this.host = host;
    this.port = port;
    this.server = null;
    this.stats = { connects: 0 };
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
    const state = { buf: Buffer.alloc(0), stage: 'greeting' };
    sock.on('data', (chunk) => {
      try { this._feed(sock, state, chunk); } catch (e) { sock.destroy(); }
    });
    sock.on('error', () => sock.destroy());
  }

  _feed(sock, state, chunk) {
    state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
    if (state.stage === 'greeting') {
      if (state.buf.length < 2) return;
      const nmethods = state.buf[1];
      if (state.buf.length < 2 + nmethods) return;
      const methods = [...state.buf.subarray(2, 2 + nmethods)];
      const chosen = methods.includes(0x00) ? 0x00 : 0xff;
      if (chosen !== 0x00) { try { sock.write(Buffer.from([5, 0xff])); } catch (e) {} sock.destroy(); return; }
      try { sock.write(Buffer.from([5, 0x00])); } catch (e) { sock.destroy(); return; }
      state.buf = state.buf.subarray(2 + nmethods);
      state.stage = 'request';
      this._parseRequest(sock, state);
      return;
    }
    if (state.stage === 'request') {
      this._parseRequest(sock, state);
    }
  }

  _parseRequest(sock, state) {
    const buf = state.buf;
    if (buf.length < 4) return;
    if (buf[0] !== 5) { this._reply(sock, REP_GENERAL); sock.destroy(); return; }
    const cmd = buf[1];
    const atyp = buf[3];
    let host = null, headerLen = 4;
    if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); headerLen = 10; }
    else if (atyp === 3) { const len = buf[4]; if (buf.length < 5 + len + 2) return; host = buf.subarray(5, 5 + len).toString('utf8'); headerLen = 5 + len + 2; }
    else if (atyp === 4) { if (buf.length < 22) return; host = ipv6(buf.subarray(4, 20)); headerLen = 22; }
    else { this._reply(sock, REP_CMD_NOT_SUPPORTED); sock.destroy(); return; }
    const port = buf.readUInt16BE(headerLen - 2);

    if (cmd !== 0x01) { this._reply(sock, REP_CMD_NOT_SUPPORTED); sock.destroy(); return; }

    this.stats.connects++;
    this.relay.openTunnel(host, port).then((tun) => {
      if (sock.destroyed) { tun.close(); return; }
      this._reply(sock, REP_OK);
      state.stage = 'done';
      const rest = state.buf.subarray(headerLen);
      this._pipe(sock, tun);
      if (rest && rest.length) tun.write(rest);
    }).catch(() => { this._reply(sock, REP_HOST_UNREACHABLE); sock.destroy(); });
  }

  _reply(sock, rep) {
    try { sock.write(Buffer.from([5, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (e) {}
  }

  _pipe(sock, tun) {
    sock.removeAllListeners('data');
    sock.on('data', (d) => tun.write(d));
    sock.on('end', () => tun.close());
    sock.on('error', () => tun.close());
    sock.on('close', () => tun.close());
    tun.onData = (d) => { if (!sock.destroyed) { try { sock.write(d); } catch (e) {} } };
    tun.onClose = () => { if (!sock.destroyed) { try { sock.end(); } catch (e) {} } };
    tun.onError = () => { if (!sock.destroyed) { try { sock.end(); } catch (e) {} } };
  }

  close() { if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; } }
}

function ipv6(bytes) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(bytes.readUInt16BE(i).toString(16));
  return parts.join(':');
}

