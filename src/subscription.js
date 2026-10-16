// 订阅链接 / 节点解析: 统一成 Node 模型
// 支持: ntp:// (自研协议), vmess://, vless://, trojan://, ss://
// 说明: 本工具原生协议为 NTP; vmess/vless/trojan/ss 节点解析后仅供展示与作为参考
//       (连接它们需要对应协议适配器, 或用 ntp:// 自建节点).

export function parseNode(rawUrl) {
  let s = String(rawUrl || '').trim();
  if (!s) return null;
  let fragment = null;
  // 取 #name
  const hashIdx = s.indexOf('#');
  if (hashIdx >= 0) {
    try { fragment = decodeURIComponent(s.slice(hashIdx + 1)); } catch (e) { fragment = s.slice(hashIdx + 1); }
    s = s.slice(0, hashIdx);
  }

  if (s.startsWith('ntp://')) return parseNtp(s, fragment);
  if (s.startsWith('ss://')) return parseSS(s, fragment);
  if (s.startsWith('vmess://')) return parseVmess(s, fragment);
  if (s.startsWith('vless://')) return parseVlessTrojan(s, 'vless', fragment);
  if (s.startsWith('trojan://')) return parseVlessTrojan(s, 'trojan', fragment);
  return null;
}

function parseNtp(s, fragment) {
  const u = new URL(s);
  const host = u.hostname;
  const port = u.port ? Number(u.port) : 9443;
  return {
    id: 'ntp-' + host + '-' + port,
    name: fragment || (host + ':' + port),
    proto: 'ntp', host, port,
    password: u.searchParams.get('password') || u.searchParams.get('key') || '',
    raw: s
  };
}

function parseSS(s, fragment) {
  // ss://base64(method:password)@host:port  (旧式)
  // ss://base64(method:password@host:port)#name (SIP002)
  let body = s.slice('ss://'.length);
  let hostPort = null, methodPass = null;
  if (body.includes('@')) {
    // SIP002: ss://base64(method:password)@host:port
    const at = body.lastIndexOf('@');
    const b64part = body.slice(0, at);
    hostPort = body.slice(at + 1);
    try {
      const dec = Buffer.from(b64part, 'base64').toString('utf8');
      const i = dec.indexOf(':');
      methodPass = [dec.slice(0, i), dec.slice(i + 1)];
    } catch (e) { methodPass = [b64part, '']; }
  } else {
    // 旧式: ss://base64(method:password@host:port)
    try {
      const dec = Buffer.from(body, 'base64').toString('utf8');
      const i = dec.indexOf('@');
      methodPass = dec.slice(0, i).split(':');
      hostPort = dec.slice(i + 1);
    } catch (e) { return null; }
  }
  if (!hostPort || !methodPass || methodPass.length < 2) return null;
  const [host, port] = splitHostPort(hostPort, 443);
  return {
    id: 'ss-' + host + '-' + port,
    name: fragment || (host + ':' + port),
    proto: 'ss', host, port: Number(port),
    method: methodPass[0], password: methodPass[1],
    raw: s
  };
}

function parseVmess(s, fragment) {
  let raw = s.slice('vmess://'.length);
  let obj = null;
  try { obj = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch (e) {
    try { obj = JSON.parse(decodeURIComponent(raw)); } catch (e2) { return null; }
  }
  const host = obj.add || obj.host || '';
  const port = Number(obj.port || 443);
  return {
    id: 'vmess-' + host + '-' + port,
    name: fragment || obj.ps || (host + ':' + port),
    proto: 'vmess', host, port,
    uuid: obj.id, aid: obj.aid, network: obj.net, tls: obj.tls, path: obj.path, sni: obj.sni,
    raw: s
  };
}

function parseVlessTrojan(s, proto, fragment) {
  const body = s.slice((proto + '://').length);
  // 去掉 query 部分
  const qIdx = body.indexOf('?');
  let addrPort = qIdx >= 0 ? body.slice(0, qIdx) : body;
  let password = null;
  if (addrPort.includes('@')) {
    const at = addrPort.lastIndexOf('@');
    password = decodeURIComponent(addrPort.slice(0, at));
    addrPort = addrPort.slice(at + 1);
  }
  const [host, port] = splitHostPort(addrPort, 443);
  return {
    id: proto + '-' + host + '-' + port,
    name: fragment || (host + ':' + port),
    proto, host, port: Number(port),
    password,
    raw: s
  };
}

// 解析整份订阅文本 -> Node[]
export function parseSubscription(text) {
  const lines = String(text || '').split(/[\r\n]+/);
  const nodes = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 可能整份是 base64
    if (t.startsWith('vmess') || t.startsWith('vless') || t.startsWith('trojan') ||
        t.startsWith('ss://') || t.startsWith('ntp://')) {
      const n = parseNode(t);
      if (n) nodes.push(n);
    } else {
      // 尝试 base64 解码为一行行节点
      try {
        const dec = Buffer.from(t, 'base64').toString('utf8');
        for (const ll of dec.split(/[\r\n]+/)) {
          const n = parseNode(ll.trim());
          if (n) nodes.push(n);
        }
      } catch (e) { /* ignore */ }
    }
  }
  return nodes;
}

function splitHostPort(str, defPort) {
  str = (str || '').trim();
  if (str.startsWith('[')) { const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(str); if (m) return [m[1], m[2] ? Number(m[2]) : defPort]; }
  const i = str.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(str.slice(i + 1))) { const p = Number(str.slice(i + 1)); if (p > 0 && p <= 65535) return [str.slice(0, i), p]; }
  return [str, defPort];
}

