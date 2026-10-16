# 免费平台部署指南

> 本工具不含任何翻墙节点/机场，需要**你自己准备一台能长期在线的服务器**来跑自研 NTP 服务端。
> 本文整理**免费平台**（永久免费 VPS / 免费 PaaS），并给出把 `netunel server` 跑起来的一键部署方式。
> ⚠️ 平台额度与政策会变动，部署前请以各平台官网最新说明为准。

## 一、方案选型（针对我们的 NTP TCP 服务端）

| 平台 | 免费额度 | 是否适合 NTP 常驻 | 备注 |
| --- | --- | --- | --- |
| **Fly.io** | 免费额度可跑小型 TCP 应用 | ✅ 最合适 | 支持 TCP 长连接，有 `fly.toml`，见下文 |
| **Oracle Cloud Always Free** | 2 台 AMD/ARM VM（各 1GB）| ✅ 最稳定 | 永久免费 VPS，注册需绑卡（不扣费），闲置/违规会被回收 |
| **Google Cloud Free Tier** | e2-micro 1 台永久 | ✅ 可以 | 需绑卡，注意流量/地区限制 |
| **Render** | 免费 web service | ⚠️ 会休眠 | 适合测试，不适合常驻代理 |
| **AWS / Azure** | 750h/月 12 个月 | ⚠️ 非永久 | 到期收费 |
| **Hetzner / DigitalOcean / Vultr** | 试用赠金 | ⚠️ 非永久 | 需留意到期 |

**结论**：常驻代理首推 **Oracle Cloud Always Free**（有真实公网 IPv4 + 永久免费 VPS，最稳）。
> ⚠️ Fly.io 试用/免费组织**不能分配公网 IPv4**（会提示需绑卡），若你不想绑卡，**不要选 Fly**。

---

## 二、方案 A：Oracle Cloud Always Free VPS（推荐）

**优点**：真正的免费 VPS + 独立公网 IPv4，最贴合我们的 TCP 服务端，可长期常驻。

**前提**：注册 Oracle Cloud 账号（需境外信用卡/借记卡做验证，Always Free 额度不扣费），开通 **Always Free** 的 AMD 或 ARM 实例（Ubuntu 22.04/24.04），并在**实例安全组/安全列表放行 TCP 9443**。

### 方式 1：一键脚本（推荐）
把项目传到服务器后执行：

```bash
# 在服务器上
export NETUNEL_PASSWORD="你的强密码"     # 必填
export NETUNEL_PORT=9443                 # 可选，默认 9443
bash scripts/deploy-oracle.sh            # 自动装 Node + systemd 常驻 + 放行端口
```

脚本会自动：安装 Node 20 → 写 systemd 服务（开机自启/崩溃重启）→ 放行防火墙 → 打印公网 IP 和客户端添加命令。

### 方式 2：手动（逐步）
```bash
# 装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 上传/克隆本项目到服务器
cd /opt/netunel

# 用 systemd 常驻
sudo tee /etc/systemd/system/netunel.service >/dev/null <<'EOF'
[Unit]
Description=Netunel NTP Server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/netunel
Environment=NETUNEL_PASSWORD=你的强密码
Environment=NETUNEL_HOST=0.0.0.0
Environment=NETUNEL_PORT=9443
ExecStart=/usr/bin/node /opt/netunel/bin/netunel.js server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now netunel
# 放行端口（ufw 或云安全组都需配置）
sudo ufw allow 9443/tcp
```

---

## 三、方案 B：Fly.io（免费试用组织无法分配 IPv4，需绑卡）

需要：`flyctl` CLI（Windows 用 `iwr https://fly.io/install.ps1 -useb | iex`）、Fly 账号（免费）。

> ⚠️ 试用/免费 org 连 shared IPv4 都会报 `disabled for trial organizations`，**必须绑信用卡**（免费额度内不扣费）。愿意绑卡可继续：

```bash
cd dsh-netunel

# 1. 初始化并创建应用（不自动部署）
fly launch --no-deploy

# 2. 设置强密码（通过 Fly secrets，容器内用 NETUNEL_PASSWORD 读取）
fly secrets set NETUNEL_PASSWORD="换成你的强密码"

# 3. 部署
fly deploy

# 4. 查看公网地址（IPv4）
fly ips list
# 得到形如 1.2.3.4 的公网 IP；服务端监听 9443（tcp）
```

**本地客户端连接**：

```bash
node bin/netunel.js add "ntp://<Fly公网IP>:9443?password=<你的强密码>#Fly免费节点"
node bin/netunel.js      # 打开面板 http://127.0.0.1:8899 → 选中该节点 → 启动客户端
```

---

## 四、方案 C：Render（免费，仅测试）

```bash
cd dsh-netunel
# 上传到 GitHub 后，在 Render Dashboard 用 Blueprint 部署 render.yaml
# 首次部署后在 Dashboard → Environment 里设置 NETUNEL_PASSWORD
# Render 免费服务会休眠（无流量约 15 分钟），不适合常驻代理
```

---

## 五、通用说明

- **端口**：容器平台常动态分配端口，服务端按 `PORT` 或 `NETUNEL_PORT` 环境变量读取；本机/自管 VPS 默认 9443。
- **密码**：优先级 `--password` > `NETUNEL_PASSWORD` 环境变量 > `config.json` 的 `password` 字段。容器/平台请用 **secret/env** 注入，别写死在代码或配置里。
- **安全**：务必用强密码；公网只开放 NTP 端口；生产建议用防火墙/安全组限制来源（如果只给自己用，可把端口限制到你的出口 IP）。
- **稳定性**：机场/免费节点变动快；自建 + 免费 PaaS 的好处是节点、流量、密码全在你手里，不依赖第三方。
