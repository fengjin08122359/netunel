// host:port 拆分工具
export function splitHostPort(str, defPort) {
  str = (str || '').trim();
  if (str.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(str);
    if (m) return [m[1], m[2] ? Number(m[2]) : defPort];
  }
  const i = str.lastIndexOf(':');
  if (i > 0) {
    const maybePort = str.slice(i + 1);
    if (/^\d+$/.test(maybePort)) {
      const port = Number(maybePort);
      if (port > 0 && port <= 65535) return [str.slice(0, i), port];
    }
  }
  return [str, defPort];
}

