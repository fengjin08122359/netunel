// 配置持久化: 数据目录 data/ 下的 JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

export class ConfigStore {
  constructor(dataDir = process.env.NETUNEL_DATA || DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) { /* ignore */ }
    return {
      nodes: [],            // Node[] 手填 + 订阅导入
      selectedId: null,
      subscriptions: [],    // [{url, name, lastUpdate}]
      httpPort: 1080,
      socksPort: 1081,
      serverMode: false,    // 是否是服务端模式
      serverPort: 9443,
      serverHost: '0.0.0.0',
      password: ''
    };
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get() { return this.data; }

  setNodes(nodes) { this.data.nodes = nodes; this.save(); }
  setSelected(id) { this.data.selectedId = id; this.save(); }
  setPorts(httpPort, socksPort) { this.data.httpPort = httpPort; this.data.socksPort = socksPort; this.save(); }
  setServerConfig(host, port, password) { this.data.serverHost = host; this.data.serverPort = port; this.data.password = password; this.save(); }
  setSubscriptions(subs) { this.data.subscriptions = subs; this.save(); }
  setServerMode(on) { this.data.serverMode = on; this.save(); }
}

