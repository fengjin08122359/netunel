# Netunel · 自研科学上网代理框架

一个**从零自研**的本地代理隧道框架：本地提供 HTTP / SOCKS5 代理，通过**自研 NTP 加密隧道协议**转发到你自己服务器上运行的服务端，再由服务端做真实出站。含 Web 控制面板、CLI、订阅/节点解析。**不依赖任何第三方代理库**，全部基于 Node 内置模块（`net` / `crypto` / `http`）实现。

> 本项目只提供**自研客户端/服务端框架**，不包含任何翻墙节点、机场、服务器。请自行准备境外 VPS。
> 免费部署到境外免费平台的逐步教程见 **docs/DEPLOY-FREE.md**（推荐 Oracle Always Free，含一键脚本 scripts/deploy-oracle.sh）。

---

## 特性

- **自研 NTP 隧道协议**（Netunel Tunnel Protocol）：自定帧格式 + 握手认证 + AES-256-GCM 加密复用单连接多路隧道
- **本地双代理**：HTTP 代理（CONNECT + 转发）+ SOCKS5 代理（RFC 1928 CONNECT）
- **服务端**：在你自己的 VPS 上运行，接收 NTP 隧道并做真实出站
- **Web 控制面板**：添加/选择节点、导入订阅、启停客户端/服务端、查看实时流量统计
- **CLI**：`add` 添加节点、`server` 启动服务端、默认启动面板
- **订阅解析**：支持 `ntp://`（自研直连）、`vmess://`、`vless://`、`trojan://`、`ss://` 的统一解析
- **多路复用**：一条加密连接承载多条并发隧道（类似 mini-VMess 的复用模型）

---

## 架构与自研协议

```
浏览器/系统代理 ──> 本地 HTTP/SOCKS5 代理 ──> RelayClient ──(NTP 加密隧道)──> RelayServer(你的VPS) ──> 目标站点
```

### 自研 NTP 协议（`src/protocol.js` + `src/crypto.js`）

**帧格式**（TCP 流）：

```
[4 字节大端长度 L] [1 字节 type] [payload ... L-1 字节]
```

| type | 名称 | 用途 |
| --- | --- | --- |
| 1 | HANDSHAKE | 握手 / 认证 |
| 2 | CONNECT | 请求建立到 `host:port` 的隧道 |
| 3 | DATA | 隧道流数据（GCM 加密） |
| 4 | CLOSE | 关闭隧道 |
| 5 | ERROR | 错误 / 状态 |

**握手认证**（防中间人/防密码爆破）：

1. 客户端 → 服务端：`client hello`（协议名 + 版本 + 16B 随机数 C）
2. 服务端 → 客户端：`server hello`（随机数 S + 随机盐 salt）
3. 双方用 `scrypt(password, salt)` 派生 32 字节会话密钥
4. 客户端 → 服务端：`HMAC-SHA256(key, C‖S‖"C2S")`，服务端**常量时间比较**验证
5. 验证通过后建立会话，后续所有 DATA 用 `AES-256-GCM` 加密（每条独立 IV + 认证标签）

**隧道多路复用**：每条隧道一个整数 id。DATA 帧 payload = `[4B tunnelId][加密流]`，单条加密连接承载多条并发隧道。

---

## 快速开始

需要 Node.js ≥ 18。

```bash
cd dsh-netunel
npm install          # 无外部依赖，仅占位
```

### 1. 在你的 VPS 上启动服务端

```bash
node bin/netunel.js server --data /opt/netunel
# 首次需设置密码:
#   编辑 /opt/netunel/config.json 的 "password" 字段，或稍后通过面板设置
```

> 生产建议：用 `systemd`/`pm2` 守护，并让 `server` 监听公网 `0.0.0.0:9443`。**务必设置强密码**，并建议在防火墙只开放该端口。

### 2. 本机启动客户端 + Web 面板

```bash
node bin/netunel.js            # 默认 http://127.0.0.1:8899
```

浏览器打开面板，两种方式添加节点：

- **手动**：点击「+ 添加 NTP 节点」，填服务端 IP/端口/密码；或命令行 `node bin/netunel.js add "ntp://YOUR_SERVER:9443?password=YOUR_PWD#名称"`
- **订阅导入**：粘贴 v2ray/sub 订阅 URL，自动解析并导入节点

选中节点后点「启动客户端」，即可在系统/浏览器设置里使用：

- **HTTP 代理**：`127.0.0.1:1080`
- **SOCKS5 代理**：`127.0.0.1:1081`

### CLI 一览

```bash
node bin/netunel.js                     # 启动 Web 面板（客户端模式）
node bin/netunel.js server              # 启动服务端
node bin/netunel.js add "ntp://..."     # 添加节点
node bin/netunel.js --http-port 8888 --socks-port 8889 --ui-port 9000
```

---

## 订阅 / 节点格式

订阅解析（`src/subscription.js`）会把各类链接统一成节点模型：

- **`ntp://host:port?password=...`** — 自研协议节点，**可直接连接**
- `vmess://` / `vless://` / `trojan://` / `ss://` — 统一解析为标准节点模型，**供展示与导入**。连接它们需要对应协议的适配器（当前版本原生只支持 NTP；如需连接标准协议节点，请把该服务器换成 NTP 服务端，或等待后续适配器）。

面板「节点管理」会标注每个节点的协议类型，`NTP` 节点标记为可直接使用。

---

## 测试

```bash
cd dsh-netunel
npm test
# 或: node --test --test-force-exit test/integration.test.js
```

集成测试覆盖：NTP 隧道数据往返、HTTP 代理 CONNECT 转发、SOCKS5 转发、订阅/节点解析（4 项全部通过）。

---

## 项目结构

```
dsh-netunel/
├── bin/netunel.js          # CLI 入口
├── src/
│   ├── crypto.js           # 自研认证/加密原语 (scrypt + AES-256-GCM + HMAC)
│   ├── protocol.js         # 自研 NTP 帧编解码
│   ├── relay-client.js     # 客户端隧道层（连接服务端 + 多路复用）
│   ├── relay-server.js     # 服务端（接收隧道 + 真实出站）
│   ├── http-proxy.js       # 本地 HTTP 代理
│   ├── socks5.js           # 本地 SOCKS5 代理
│   ├── subscription.js     # 订阅/节点解析
│   ├── config.js           # 配置持久化
│   ├── manager.js          # 编排层
│   ├── webui.js            # Web 面板 HTTP + API
│   └── ui/                 # 面板前端 (index.html + app.js)
├── scripts/deploy-oracle.sh # Oracle Always Free 一键部署脚本
├── docs/DEPLOY-FREE.md      # 免费平台部署教程
├── Dockerfile               # 容器化 (PaaS 部署)
├── fly.toml / render.yaml   # Fly.io / Render 部署配置
└── test/integration.test.js
```

## 安全说明

- 会话密钥用 `scrypt` 从密码派生，握手用 HMAC 常量时间比较，防止时序攻击。
- 所有隧道数据 `AES-256-GCM` 加密 + 认证，防篡改、防窃听。
- 服务端未内置内网/SSRF 策略；若需要可给 `RelayServer` 传 `allowlist(host, port)` 回调做目标限制。
- 密码以明文存于本地 `config.json`（`data/`），请控制好文件权限。
