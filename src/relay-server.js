// 服务端: 接收 NTP 隧道客户端, 建立到目标 host:port 的真实连接并双向转发
import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  PROTO_VERSION, PROTO_NAME, deriveKey, randomBytes, handshakeProof, timingSafeEqual
} from './crypto.js';
import {
  T, encodeJsonFrame, encodeDataFrame, decodeDataFrame, createFrameReader
} from './protocol.js';

const MAX_TUNNELS_PER_CLIENT = 256;

export class RelayServer extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host || '0.0.0.0';
    this.port = opts.port;
    this.password = opts.password;
    this.allowlist = opts.allowlist || null; // (host, port) => boolean
    this.server = null;
    this.clients = new Set();
    this.stats = { upBytes: 0, downBytes: 0, clients: 0, tunnelsOpened: 0 };
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._onClient(sock));
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  address() { return this.server ? this.server.address() : null; }

  _onClient(sock) {
    sock.setNoDelay(true);
    const ctx = {
      sock, key: null, tunnels: new Map(),
      cNonce: null, sNonce: null, salt: null, authed: false
    };
    this.clients.add(ctx);
    this.stats.clients = this.clients.size;
    const reader = createFrameReader(
      (type, payload) => this._onFrame(ctx, type, payload),
      (e) => this._dropClient(ctx, e)
    );
    sock.on('data', reader);
    sock.on('error', () => this._dropClient(ctx));
    sock.on('close', () => this._dropClient(ctx));
    this.emit('client-connect', sock);
  }

  _onFrame(ctx, type, payload) {
    // 握手阶段只处理 HANDSHAKE
    if (type === T.HANDSHAKE) { this._onHandshake(ctx, payload); return; }
    if (!ctx.authed) { ctx.sock.destroy(); return; }

    if (type === T.DATA) {
      if (!ctx.key) return;
      let plain;
      try { plain = decodeDataFrame(ctx.key, payload); } catch (e) { this._dropClient(ctx, e); return; }
      if (plain.length < 4) return;
      const id = plain.readUInt32BE(0);
      const body = plain.subarray(4);
      if (id === 0) return; // heartbeat
      const real = ctx.tunnels.get(id);
      if (real && !real.destroyed) { real.write(body); this.stats.downBytes += body.length; }
    } else if (type === T.CONNECT) {
      this._handleConnect(ctx, payload);
    } else if (type === T.CLOSE) {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        const real = ctx.tunnels.get(msg.t);
        if (real) { ctx.tunnels.delete(msg.t); real.destroy(); }
      } catch (e) { /* ignore */ }
    }
  }

  _onHandshake(ctx, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { ctx.sock.destroy(); return; }

    if (!ctx.cNonce) {
      // client hello
      if (msg.v !== PROTO_VERSION || msg.name !== PROTO_NAME) {
        ctx.sock.write(encodeJsonFrame(T.HANDSHAKE, { ok: false, msg: '协议不匹配' }));
        ctx.sock.end(); return;
      }
      ctx.cNonce = Buffer.from(msg.c, 'hex');
      ctx.sNonce = randomBytes(16);
      ctx.salt = randomBytes(16);
      ctx.key = deriveKey(this.password, ctx.salt);
      ctx.sock.write(encodeJsonFrame(T.HANDSHAKE, {
        v: PROTO_VERSION, name: PROTO_NAME,
        s: ctx.sNonce.toString('hex'), salt: ctx.salt.toString('hex')
      }));
    } else {
      // client proof
      const proof = Buffer.from(msg.p, 'hex');
      const expect = handshakeProof(ctx.key, ctx.cNonce, ctx.sNonce, 'C2S');
      if (!timingSafeEqual(proof, expect)) {
        ctx.sock.write(encodeJsonFrame(T.HANDSHAKE, { ok: false, msg: '认证失败' }));
        ctx.sock.end(); return;
      }
      ctx.authed = true;
      ctx.sock.write(encodeJsonFrame(T.HANDSHAKE, { ok: true, session: randomBytes(8).toString('hex') }));
      this.emit('client-auth', ctx);
    }
  }

  _handleConnect(ctx, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) {
      ctx.sock.write(encodeJsonFrame(T.ERROR, { t: -1, msg: 'CONNECT 解析失败' })); return;
    }
    if (ctx.tunnels.size >= MAX_TUNNELS_PER_CLIENT) {
      ctx.sock.write(encodeJsonFrame(T.CONNECT, { t: msg.t, ok: false, msg: '隧道数超限' })); return;
    }
    const id = msg.t;
    const host = String(msg.h || '');
    const port = Number(msg.p);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      ctx.sock.write(encodeJsonFrame(T.CONNECT, { t: id, ok: false, msg: '非法目标地址' })); return;
    }
    if (this.allowlist && !this.allowlist(host, port)) {
      ctx.sock.write(encodeJsonFrame(T.CONNECT, { t: id, ok: false, msg: '目标被策略拒绝' })); return;
    }
    const real = net.createConnection({ host, port });
    ctx.tunnels.set(id, real);
    this.stats.tunnelsOpened++;
    real.setNoDelay(true);
    real.on('connect', () => {
      ctx.sock.write(encodeJsonFrame(T.CONNECT, { t: id, ok: true }));
    });
    real.on('data', (chunk) => {
      const h = Buffer.alloc(4); h.writeUInt32BE(id, 0);
      ctx.sock.write(encodeDataFrame(ctx.key, Buffer.concat([h, chunk]), id));
      this.stats.upBytes += chunk.length;
    });
    real.on('error', (e) => {
      ctx.tunnels.delete(id);
      try { ctx.sock.write(encodeJsonFrame(T.CONNECT, { t: id, ok: false, msg: e.message })); } catch (err) {}
      real.destroy();
    });
    real.on('close', () => {
      ctx.tunnels.delete(id);
      try { ctx.sock.write(encodeJsonFrame(T.CLOSE, { t: id })); } catch (e) {}
    });
  }

  _dropClient(ctx, err) {
    if (!this.clients.has(ctx)) return;
    this.clients.delete(ctx);
    this.stats.clients = this.clients.size;
    for (const [, real] of ctx.tunnels) { try { real.destroy(); } catch (e) {} }
    ctx.tunnels.clear();
    try { ctx.sock.destroy(); } catch (e) {}
    this.emit('client-drop', ctx, err);
  }

  close() {
    for (const ctx of [...this.clients]) this._dropClient(ctx);
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
  }
}

