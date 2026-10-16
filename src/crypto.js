// 自研认证与加密原语 (Netunel)
// 不依赖第三方库, 基于 Node 内置 crypto:
//   - 密钥派生: scrypt(password, salt, 32)
//   - 数据加密: AES-256-GCM (每条消息独立 IV + 认证标签)
//   - 握手认证: HMAC-SHA256(password-derived key, 双方随机数)
import crypto from 'node:crypto';

export const PROTO_VERSION = 1;
export const PROTO_NAME = 'NTP';

// ---- 密钥派生 ----
export function deriveKey(password, salt) {
  // salt: Buffer (>=16 bytes), 返回 32 字节 key
  return crypto.scryptSync(String(password), salt, 32);
}

export function randomBytes(n = 16) { return crypto.randomBytes(n); }

// ---- 对称加密 AES-256-GCM ----
// 返回 { iv, tag, data }
export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, data };
}

export function decrypt(key, iv, tag, data) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ---- 握手 HMAC 认证 ----
// 双方交换随机数后, 各自用派生 key 计算证明值
export function handshakeProof(key, cNonce, sNonce, role) {
  // role: 'C2S' | 'S2C'
  return crypto.createHmac('sha256', key)
    .update(Buffer.concat([cNonce, sNonce, Buffer.from(role, 'utf8')]))
    .digest();
}

// 常量时间比较
export function timingSafeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

