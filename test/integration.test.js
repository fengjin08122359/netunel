// 端到端集成测试: 自研 NTP 隧道客户端+服务端, HTTP/SOCKS5 代理
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { RelayServer } from '../src/relay-server.js';
import { RelayClient } from '../src/relay-client.js';
import { HttpProxy } from '../src/http-proxy.js';
import { Socks5Proxy } from '../src/socks5.js';
import { parseNode, parseSubscription } from '../src/subscription.js';

const PASSWORD = 'test-secret-123';

// 目标 HTTP 服务器 (模拟被墙网站)
function startTarget() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('HELLO-FROM-TARGET:' + req.url);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('NTP 隧道客户端<->服务端 数据往返', async () => {
  const server = new RelayServer({ host: '127.0.0.1', port: 0, password: PASSWORD });
  await server.listen();
  const srvPort = server.address().port;

  const target = await startTarget();
  const url = 'http://127.0.0.1:' + target.port + '/hello';

  const client = new RelayClient({ host: '127.0.0.1', port: srvPort, password: PASSWORD });
  await client.connect();
  assert.ok(client.connected, '客户端应已连接');

  // 打开隧道到目标 HTTP 服务器
  const tun = await client.openTunnel('127.0.0.1', target.port);
  let resp = Buffer.alloc(0);
  tun.onData = (d) => { resp = Buffer.concat([resp, d]); };
  tun.write(Buffer.from('GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(resp.toString('utf8').includes('HELLO-FROM-TARGET:/hello'), '应收到目标响应: ' + resp.toString('utf8'));

  tun.close();
  client.close();
  server.close();
  target.srv.close();
});

test('HTTP 代理 CONNECT 经 NTP 隧道转发', async () => {
  const server = new RelayServer({ host: '127.0.0.1', port: 0, password: PASSWORD });
  await server.listen();
  const client = new RelayClient({ host: '127.0.0.1', port: server.address().port, password: PASSWORD });
  await client.connect();
  const proxy = new HttpProxy({ relay: client, host: '127.0.0.1', port: 0 });
  await proxy.listen();
  const proxyPort = proxy.address().port;

  const target = await startTarget();

  // 用 CONNECT 建隧道, 再发 HTTP
  const res = await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    let out = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write('CONNECT 127.0.0.1:' + target.port + ' HTTP/1.1\r\nHost: 127.0.0.1:' + target.port + '\r\n\r\n');
    });
    sock.on('data', (d) => {
      out = Buffer.concat([out, d]);
      if (out.includes('200')) {
        sock.write('GET /via-connect HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      }
      if (out.includes('HELLO-FROM-TARGET')) resolve(out.toString('utf8'));
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
  assert.ok(res.includes('HELLO-FROM-TARGET:/via-connect'), 'CONNECT 转发应成功: ' + res);

  proxy.close(); client.close(); server.close(); target.srv.close();
});

test('SOCKS5 代理经 NTP 隧道转发', async () => {
  const server = new RelayServer({ host: '127.0.0.1', port: 0, password: PASSWORD });
  await server.listen();
  const client = new RelayClient({ host: '127.0.0.1', port: server.address().port, password: PASSWORD });
  await client.connect();
  const proxy = new Socks5Proxy({ relay: client, host: '127.0.0.1', port: 0 });
  await proxy.listen();
  const proxyPort = proxy.address().port;
  const target = await startTarget();

  const res = await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    let out = Buffer.alloc(0);
    sock.on('connect', () => {
      // greeting: ver=5 nmethods=1 method=0
      sock.write(Buffer.from([5, 1, 0]));
    });
    sock.on('data', (d) => {
      out = Buffer.concat([out, d]);
      if (out.length === 2 && out[1] === 0 && !sock._sentConnect) {
        sock._sentConnect = true;
        // CONNECT request: ver=5 cmd=1 rsv=0 atyp=1(IPv4) + 4 bytes + port
        const pbuf = Buffer.alloc(2); pbuf.writeUInt16BE(target.port, 0);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 1, 127, 0, 0, 1]), pbuf]));
      }
      if (out.length >= 12 && out[3] === 0 && !sock._sentHttp) {
        // CONNECT 成功 (rep=0), 发送真实 HTTP 请求
        sock._sentHttp = true;
        sock.write('GET /via-socks HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      }
      if (out.includes('HELLO-FROM-TARGET')) resolve(out.toString('utf8'));
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
  assert.ok(res.includes('HELLO-FROM-TARGET:/via-socks'), 'SOCKS5 转发应成功: ' + res);

  proxy.close(); client.close(); server.close(); target.srv.close();
});

test('订阅/节点解析', () => {
  // 自研 ntp
  const n = parseNode('ntp://1.2.3.4:9443?password=abc#MyNode');
  assert.equal(n.proto, 'ntp');
  assert.equal(n.host, '1.2.3.4');
  assert.equal(n.password, 'abc');
  assert.equal(n.name, 'MyNode');

  // ss
  const ss = parseNode('ss://' + Buffer.from('aes-256-gcm:pass123').toString('base64') + '@5.6.7.8:8388#SS-Node');
  assert.equal(ss.proto, 'ss');
  assert.equal(ss.host, '5.6.7.8');
  assert.equal(ss.password, 'pass123');

  // vmess
  const vm = Buffer.from(JSON.stringify({ add: '9.9.9.9', port: 443, id: 'uuid', ps: 'VmessNode', net: 'ws' })).toString('base64');
  const v = parseNode('vmess://' + vm);
  assert.equal(v.proto, 'vmess');
  assert.equal(v.host, '9.9.9.9');
  assert.equal(v.name, 'VmessNode');
});

