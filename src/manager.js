// 编排层: 管理配置、客户端代理、服务端、Web 面板
import { EventEmitter } from 'node:events';
import { ConfigStore } from './config.js';
import { RelayClient } from './relay-client.js';
import { RelayServer } from './relay-server.js';
import { HttpProxy } from './http-proxy.js';
import { Socks5Proxy } from './socks5.js';
import { parseNode, parseSubscription } from './subscription.js';

export class Manager extends EventEmitter {
  constructor(dataDir) {
    super();
    this.store = new ConfigStore(dataDir);
    this.client = null;
    this.httpProxy = null;
    this.socksProxy = null;
    this.server = null;
    this._runtime = { mode: 'idle', selectedId: null, startedAt: null, lastError: null };
  }

  listNodes() { return this.store.get().nodes; }

  addNode(nodeObj) {
    // nodeObj 可以是 URL 字符串或对象
    let node = nodeObj;
    if (typeof nodeObj === 'string') node = parseNode(nodeObj);
    if (!node) throw new Error('无法解析节点');
    const nodes = this.store.get().nodes;
    nodes.push(node);
    this.store.setNodes(nodes);
    if (!this.store.get().selectedId) { this.store.setSelected(node.id); }
    return node;
  }

  deleteNode(id) {
    const nodes = this.store.get().nodes.filter((n) => n.id !== id);
    this.store.setNodes(nodes);
    if (this.store.get().selectedId === id) this.store.setSelected(nodes.length ? nodes[0].id : null);
  }

  selectNode(id) {
    if (!this.store.get().nodes.find((n) => n.id === id)) throw new Error('节点不存在');
    this.store.setSelected(id);
    return { ok: true };
  }

  getSelectedNode() {
    const d = this.store.get();
    return d.nodes.find((n) => n.id === d.selectedId) || d.nodes[0] || null;
  }

  async fetchSubscription(url, name) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('订阅请求失败: HTTP ' + res.status);
    const text = await res.text();
    const nodes = parseSubscription(text);
    const ntp = nodes.filter((n) => n.proto === 'ntp');
    if (!nodes.length) throw new Error('订阅未解析出任何节点');
    const subs = this.store.get().subscriptions;
    subs.push({ url, name: name || url, lastUpdate: new Date().toISOString(), nodes: nodes.length });
    this.store.setSubscriptions(subs);
    // 追加节点
    const all = this.store.get().nodes;
    for (const n of nodes) {
      if (!all.find((x) => x.id === n.id)) all.push(n);
    }
    this.store.setNodes(all);
    return { ok: true, total: nodes.length, ntpCompatible: ntp.length, nodes };
  }

  status() {
    const sel = this.getSelectedNode();
    return {
      mode: this._runtime.mode,
      connected: this.client ? this.client.connected : false,
      selectedNode: sel,
      httpPort: this.store.get().httpPort,
      socksPort: this.store.get().socksPort,
      serverPort: this.store.get().serverPort,
      startedAt: this._runtime.startedAt,
      lastError: this._runtime.lastError,
      stats: {
        client: this.client ? this.client.stats : null,
        http: this.httpProxy ? this.httpProxy.stats : null,
        socks: this.socksProxy ? this.socksProxy.stats : null,
        server: this.server ? this.server.stats : null
      }
    };
  }

  async connectClient() {
    if (this._runtime.mode === 'client') return { ok: true };
    const node = this.getSelectedNode();
    if (!node) throw new Error('请先添加并选择一个节点');
    if (node.proto !== 'ntp') throw new Error('当前只支持自研 NTP 节点 (ntp://)，该节点协议为 ' + node.proto);

    this.disconnectClient();
    this.client = new RelayClient({ host: node.host, port: node.port, password: node.password });
    this.client.on('error', (e) => { this._runtime.lastError = String(e && e.message || e); });
    await this.client.connect();
    this.httpProxy = new HttpProxy({ relay: this.client, port: this.store.get().httpPort });
    this.socksProxy = new Socks5Proxy({ relay: this.client, port: this.store.get().socksPort });
    await this.httpProxy.listen();
    await this.socksProxy.listen();
    this._runtime.mode = 'client';
    this._runtime.startedAt = Date.now();
    this._runtime.lastError = null;
    this.emit('change');
    return { ok: true, http: this.httpProxy.address(), socks: this.socksProxy.address() };
  }

  disconnectClient() {
    if (this.httpProxy) { try { this.httpProxy.close(); } catch (e) {} this.httpProxy = null; }
    if (this.socksProxy) { try { this.socksProxy.close(); } catch (e) {} this.socksProxy = null; }
    if (this.client) { try { this.client.close(); } catch (e) {} this.client = null; }
    if (this._runtime.mode === 'client') this._runtime.mode = 'idle';
  }

  async startServer(body) {
    if (this._runtime.mode === 'server') return { ok: true };
    this.stopServer();
    const host = (body && body.host) || this.store.get().serverHost;
    const port = (body && body.port) || this.store.get().serverPort;
    const password = (body && body.password) || this.store.get().password;
    if (!password) throw new Error('请设置服务端密码');
    this.store.setServerConfig(host, port, password);
    this.server = new RelayServer({ host, port, password });
    await this.server.listen();
    this._runtime.mode = 'server';
    this._runtime.startedAt = Date.now();
    this._runtime.lastError = null;
    this.emit('change');
    return { ok: true, address: this.server.address() };
  }

  stopServer() {
    if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
    if (this._runtime.mode === 'server') this._runtime.mode = 'idle';
  }

  saveSettings(body) {
    if (body.httpPort) this.store.setPorts(Number(body.httpPort), Number(body.socksPort || this.store.get().socksPort));
    if (body.socksPort) this.store.setPorts(Number(body.httpPort || this.store.get().httpPort), Number(body.socksPort));
    return { ok: true };
  }

  close() {
    this.disconnectClient();
    this.stopServer();
  }
}

