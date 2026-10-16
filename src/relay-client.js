// 客户端隧道层: 与自研 NTP 服务端建立加密连接, 复用单连接承载多条隧道
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  PROTO_VERSION, PROTO_NAME, deriveKey, randomBytes, handshakeProof
} from './crypto.js';
import {
  T, encodeJsonFrame, encodeDataFrame, decodeDataFrame, createFrameReader
} from './protocol.js';

const CONNECT_TIMEOUT = 15000;
const HEARTBEAT_MS = 30000;

export class RelayClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.password = opts.password;
    this.key = null;
    this.socket = null;
    this.tunnels = new Map();   // id -> tunnel object (含 onData/onClose/onError 回调)
    this.nextTunnelId = 1;
    this.connected = false;
    this.connecting = false;
    this.stats = { upBytes: 0, downBytes: 0, tunnelsOpened: 0 };
    this._hb = null;
    this._reader = null;
  }

  async connect() {
    if (this.connected || this.connecting) return;
    this.connecting = true;
    try {
      await new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: this.host, port: this.port });
        this.socket = sock;
        const to = setTimeout(() => { reject(new Error('连接服务端超时')); sock.destroy(); }, CONNECT_TIMEOUT);
        sock.once('connect', () => { clearTimeout(to); resolve(); });
        sock.once('error', (e) => { clearTimeout(to); reject(e); });
      });
      await this._handshake();
      this.connected = true;
      this.connecting = false;
      this._startHeartbeat();
      this.emit('connect');
    } catch (e) {
      this.connecting = false;
      if (this.socket) { try { this.socket.destroy(); } catch (_) {} this.socket = null; }
      throw e;
    }
  }

  _handshake() {
    return new Promise((resolve, reject) => {
      const sock = this.socket;
      const cNonce = cryptoRandom(16);
      let sNonce = null, salt = null;
      let stage = 'hello';
      let done = false;
      const fail = (e) => { if (!done) { done = true; reject(e); sock.destroy(); } };

      const reader = createFrameReader(
        (type, payload) => {
          if (done) return;
          try {
            if (stage === 'hello') {
              const hello = JSON.parse(payload.toString('utf8'));
              if (hello.name !== PROTO_NAME || hello.v !== PROTO_VERSION) throw new Error('协议不匹配');
              sNonce = Buffer.from(hello.s, 'hex');
              salt = Buffer.from(hello.salt, 'hex');
              this.key = deriveKey(this.password, salt);
              const proof = handshakeProof(this.key, cNonce, sNonce, 'C2S');
              stage = 'auth';
              sock.write(encodeJsonFrame(T.HANDSHAKE, { p: proof.toString('hex') }));
            } else if (stage === 'auth') {
              const auth = JSON.parse(payload.toString('utf8'));
              if (auth.ok !== true) throw new Error('认证失败: ' + (auth.msg || '密码错误'));
              done = true;
              sock.off('data', reader);
              this._installReader();
              resolve();
            }
          } catch (e) { fail(e); }
        },
        (e) => fail(e)
      );
      sock.on('data', reader);
      sock.on('error', (e) => fail(e));
      sock.write(encodeJsonFrame(T.HANDSHAKE, { v: PROTO_VERSION, name: PROTO_NAME, c: cNonce.toString('hex') }));
    });
  }

  _installReader() {
    const sock = this.socket;
    const reader = createFrameReader((type, payload) => {
      if (type === T.DATA) this._onData(payload);
      else if (type === T.CONNECT) this._onConnect(payload);
      else if (type === T.CLOSE) this._onClose(payload);
      else if (type === T.ERROR) this._onError(payload);
    }, (e) => this._fail(e));
    sock.on('data', reader);
  }

  _onConnect(payload) {
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      const tun = this.tunnels.get(msg.t);
      if (!tun) return;
      if (msg.ok === true) { tun.pending = false; tun.onReady && tun.onReady(); }
      else { this.tunnels.delete(msg.t); tun.onError && tun.onError(new Error(msg.msg || '远端连接失败')); }
    } catch (e) { /* ignore */ }
  }

  _onData(payload) {
    if (!this.key) return;
    let plain;
    try { plain = decodeDataFrame(this.key, payload); } catch (e) { this._fail(e); return; }
    if (plain.length < 4) return;
    const id = plain.readUInt32BE(0);
    const body = plain.subarray(4);
    const tun = this.tunnels.get(id);
    if (id === 0) return; // heartbeat
    if (tun && tun.onData) { try { tun.onData(body); } catch (e) {} }
    this.stats.downBytes += body.length;
  }

  _onClose(payload) {
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      const tun = this.tunnels.get(msg.t);
      if (tun) { this.tunnels.delete(msg.t); tun.onClose && tun.onClose(); }
    } catch (e) { /* ignore */ }
  }

  _onError(payload) {
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      const tun = this.tunnels.get(msg.t);
      if (tun) { this.tunnels.delete(msg.t); tun.onError && tun.onError(new Error(msg.msg || '远端错误')); }
    } catch (e) { /* ignore */ }
  }

  // 打开一条隧道到远端 host:port
  openTunnel(host, port) {
    if (!this.connected) return Promise.reject(new Error('未连接服务端'));
    const id = this.nextTunnelId++;
    return new Promise((resolve, reject) => {
      const tun = {
        id, pending: true,
        onData: null, onClose: null, onError: null, onReady: null,
        write: (buf) => this._writeData(id, buf),
        close: () => this.closeTunnel(id)
      };
      tun.onReady = () => { resolve(tun); };
      tun.onError = (e) => { reject(e); };
      this.tunnels.set(id, tun);
      this.socket.write(encodeJsonFrame(T.CONNECT, { t: id, h: host, p: port }));
      this.stats.tunnelsOpened++;
    });
  }

  _writeData(id, buf) {
    if (!this.connected || !this.socket || this.socket.destroyed) return false;
    const head = Buffer.alloc(4); head.writeUInt32BE(id, 0);
    this.socket.write(encodeDataFrame(this.key, Buffer.concat([head, buf]), id));
    this.stats.upBytes += buf.length;
    return true;
  }

  closeTunnel(id) {
    const tun = this.tunnels.get(id);
    if (tun) {
      this.tunnels.delete(id);
      this.socket && this.socket.write(encodeJsonFrame(T.CLOSE, { t: id }));
      tun.onClose && tun.onClose();
    }
  }

  _startHeartbeat() {
    this._hb = setInterval(() => {
      if (this.connected && this.socket && !this.socket.destroyed) {
        this.socket.write(encodeDataFrame(this.key, Buffer.from([0,0,0,0,0]), 0));
      }
    }, HEARTBEAT_MS);
    this._hb.unref && this._hb.unref();
  }

  _fail(err) {
    this.connected = false;
    this.connecting = false;
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
    for (const [, tun] of this.tunnels) { try { tun.onError && tun.onError(err); } catch (e) {} }
    this.tunnels.clear();
    if (this.socket) { try { this.socket.destroy(); } catch (e) {} this.socket = null; }
    this.emit('error', err);
  }

  close() {
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
    this.connected = false;
    if (this.socket) { try { this.socket.destroy(); } catch (e) {} this.socket = null; }
    this.tunnels.clear();
    this.emit('close');
  }
}

function cryptoRandom(n) {
  return crypto.randomBytes(n);
}

