// 命令行入口
import { Manager } from './manager.js';
import { startWebUi } from './webui.js';

function parseFlags(args) {
  const flags = { data: undefined, httpPort: 1080, socksPort: 1081, uiPort: 8899, password: undefined, host: undefined, port: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--data' && args[i+1]) flags.data = args[++i];
    else if (a === '--http-port' && args[i+1]) flags.httpPort = Number(args[++i]);
    else if (a === '--socks-port' && args[i+1]) flags.socksPort = Number(args[++i]);
    else if (a === '--ui-port' && args[i+1]) flags.uiPort = Number(args[++i]);
    else if (a === '--password' && args[i+1]) flags.password = args[++i];
    else if (a === '--host' && args[i+1]) flags.host = args[++i];
    else if (a === '--port' && args[i+1]) flags.port = Number(args[++i]);
  }
  return flags;
}

export async function program(argv) {
  const args = [...argv];
  const flags = parseFlags(args);
  const cmd = args.find((a) => !a.startsWith('--'));
  const manager = new Manager(flags.data);

  if (cmd === 'add') {
    const node = args[1];
    if (!node) { console.log('usage: netunel add \"ntp://host:port?password=...\"'); process.exit(1); }
    try {
      const n = manager.addNode(node);
      console.log('added node:', n.name, '(' + n.proto + '://' + n.host + ':' + n.port + ')');
    } catch (e) { console.error('add failed:', e.message); process.exit(1); }
    return;
  }

  if (cmd === 'server') {
    // 密码优先级: --password > NETUNEL_PASSWORD 环境变量 > 配置
    const pw = flags.password || process.env.NETUNEL_PASSWORD || manager.store.get().password;
    // 端口: --port > PORT 环境变量(容器平台) > NETUNEL_PORT > 配置
    const srvPort = flags.port || (process.env.PORT && Number(process.env.PORT)) ||
                    (process.env.NETUNEL_PORT && Number(process.env.NETUNEL_PORT)) ||
                    manager.store.get().serverPort;
    try {
      const s = await manager.startServer({ host: flags.host || process.env.NETUNEL_HOST, port: srvPort, password: pw });
      console.log('NTP server listening:', JSON.stringify(s.address));
    } catch (e) { console.error('server failed:', e.message); process.exit(1); }
    keepAlive(manager);
    return;
  }

  manager.store.setPorts(flags.httpPort, flags.socksPort);
  const server = await startWebUi({ port: flags.uiPort, manager });
  const addr = server.address();
  console.log('');
  console.log('  Netunel panel: http://127.0.0.1:' + addr.port);
  console.log('  add a node, then click \"start client\"; run `netunel server` on your VPS');
  console.log('');
  keepAlive(manager);
}

function keepAlive(manager) {
  const shutdown = () => { manager.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => manager.close());
}
