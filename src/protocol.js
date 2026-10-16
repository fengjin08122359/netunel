// 自研隧道协议 NTP (Netunel Tunnel Protocol) —— 帧编解码
// 帧格式 (TCP 流):
//   [4 字节大端长度 L] [1 字节 type] [payload ... L-1 字节]
// type:
//   1 HANDSHAKE 握手/认证控制
//   2 CONNECT   请求建立到 host:port 的隧道 (payload 为 JSON)
//   3 DATA      隧道流数据 (payload 为 GCM 加密后数据: iv|tag|data)
//   4 CLOSE     关闭指定隧道
//   5 ERROR     错误/状态
import { encrypt, decrypt, randomBytes } from './crypto.js';

export const T = { HANDSHAKE: 1, CONNECT: 2, DATA: 3, CLOSE: 4, ERROR: 5 };
export const TNAMES = { 1:'HANDSHAKE',2:'CONNECT',3:'DATA',4:'CLOSE',5:'ERROR' };

const MAX_FRAME = 2 * 1024 * 1024; // 单帧上限 2MB

export function encodeFrame(type, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, body]);
}

export function encodeJsonFrame(type, obj) {
  return encodeFrame(type, Buffer.from(JSON.stringify(obj), 'utf8'));
}

// 从 socket 读取帧的异步解析器
export function createFrameReader(onFrame, onError) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(0);
      const type = buf[4];
      if (len < 1 || len > MAX_FRAME) { onError(new Error('非法帧长度 ' + len)); buf = Buffer.alloc(0); return; }
      if (buf.length < 5 + (len - 1)) break; // 等待更多数据
      const payload = buf.subarray(5, 5 + (len - 1));
      buf = buf.subarray(5 + (len - 1));
      onFrame(type, payload);
    }
  };
}

// ---- 数据帧加解密 (每条 DATA 独立 GCM) ----
// DATA payload = iv(12) + tag(16) + ciphertext
export function encodeDataFrame(key, plaintext, tunnelId) {
  // tunnelId 放到 CONNECT/CLOSE 里; 这里 DATA 帧 payload 只含加密流
  const { iv, tag, data } = encrypt(key, plaintext);
  return encodeFrame(T.DATA, Buffer.concat([iv, tag, data]));
}

export function decodeDataFrame(key, payload) {
  if (payload.length < 12 + 16) throw new Error('DATA 帧过短');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  return decrypt(key, iv, tag, data);
}

// 心跳/保活用: 发送一个空 DATA 帧 (也可做隧道复用探测)
export function heartbeatFrame(key) {
  return encodeDataFrame(key, Buffer.from([0]), 0);
}

