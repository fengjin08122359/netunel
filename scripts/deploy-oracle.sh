#!/usr/bin/env bash
# Netunel NTP 服务端 —— Oracle Cloud Always Free VPS 一键部署 (Ubuntu 22.04/24.04)
# 用法 (在 Oracle VPS 上执行):
#   bash <(curl -fsSL https://raw.githubusercontent.com/你的仓库/dsh-netunel/main/scripts/deploy-oracle.sh)
# 或: 把本脚本拷到服务器后执行  bash deploy-oracle.sh
#
# 需要先设置环境变量 NETUNEL_PASSWORD (必填) 和 NETUNEL_PORT (可选, 默认 9443)

set -euo pipefail

# ---- 1. 参数/密码 ----
if [ -z "${NETUNEL_PASSWORD:-}" ]; then
  echo "❌ 请先设置 NETUNEL_PASSWORD 环境变量:  export NETUNEL_PASSWORD='你的强密码'" >&2
  exit 1
fi
NETUNEL_PORT="${NETUNEL_PORT:-9443}"
APP_DIR="/opt/netunel"

# ---- 2. 安装 Node 20 (若缺失) ----
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | sed 's/^v//;s/\..*//')" -lt 20 ]; then
  echo "==> 安装 Node.js 20 ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node -v)"

# ---- 3. 部署代码 ----
echo "==> 部署代码到 ${APP_DIR} ..."
mkdir -p "${APP_DIR}"
# 从本仓库复制 (若你已上传到服务器则跳过下面的 git clone)
if [ -d "${APP_DIR}/src" ]; then
  echo "    已存在, 更新源码..."
  cd "${APP_DIR}"
  git pull 2>/dev/null || true
else
  echo "    请把本项目放到 ${APP_DIR} (scp 或 git clone), 或修改下面 URL"
  # 例: git clone <你的仓库URL> "${APP_DIR}"
  exit 1
fi

# ---- 4. 写 systemd 服务 (常驻 + 开机自启 + 崩溃自动重启) ----
echo "==> 写入 systemd 服务 ..."
cat > /etc/systemd/system/netunel.service <<EOF
[Unit]
Description=Netunel NTP Server (自研代理服务端)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NETUNEL_PASSWORD=${NETUNEL_PASSWORD}
Environment=NETUNEL_HOST=0.0.0.0
Environment=NETUNEL_PORT=${NETUNEL_PORT}
ExecStart=/usr/bin/node ${APP_DIR}/bin/netunel.js server
Restart=always
RestartSec=3
# 安全加固(可选)
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now netunel
echo "==> 服务状态:"
systemctl --no-pager status netunel --lines=5 || true

# ---- 5. 防火墙放行 (Oracle 安全组也需放行) ----
echo "==> 放行端口 ${NETUNEL_PORT}/tcp ..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${NETUNEL_PORT}"/tcp >/dev/null 2>&1 || true
  ufw reload >/dev/null 2>&1 || true
fi

# ---- 6. 打印公网 IP 和客户端连接方式 ----
PUBIP="$(curl -4 -fsSL --max-time 8 https://api.ipify.org 2>/dev/null || echo '<公网IP>')"
echo ""
echo "================================================================"
echo "✅ Netunel NTP 服务端已部署"
echo "   监听:   0.0.0.0:${NETUNEL_PORT}"
echo "   公网IP: ${PUBIP}"
echo ""
echo "⚠️  别忘在 Oracle Cloud 控制台的安全组(安全列表)放行 TCP ${NETUNEL_PORT}"
echo ""
echo "   本机客户端添加节点:"
echo "   node bin/netunel.js add \"ntp://${PUBIP}:${NETUNEL_PORT}?password=<你的密码>#Oracle免费\""
echo "================================================================"

