// Netunel 面板前端逻辑
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  return res.json();
};
const fmt = (b) => {
  if (b == null) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};

let nodes = [];

function renderNodes() {
  const list = $('nodeList');
  if (!nodes.length) { list.innerHTML = '<div class="hint">暂无节点，请添加或导入订阅。</div>'; return; }
  list.innerHTML = nodes.map((n) => `
    <div class="node ${n.active ? 'active' : ''}">
      <div>
        <span class="nm">${esc(n.name)}</span><span class="tag">${n.proto}</span>
        <div class="meta">${esc(n.host)}:${n.port}</div>
      </div>
      <div class="flex">
        <button onclick="selectNode('${n.id}')">选择</button>
        <button class="danger" onclick="delNode('${n.id}')">删</button>
      </div>
    </div>`).join('');
}

function renderStatus(s) {
  const pill = $('modePill');
  const cls = s.mode === 'client' ? 'client' : s.mode === 'server' ? 'server' : 'idle';
  const label = s.mode === 'client' ? '客户端运行中' : s.mode === 'server' ? '服务端运行中' : '未运行';
  pill.className = 'pill ' + cls; pill.textContent = label;
  const sel = s.selectedNode ? `${s.selectedNode.name} (${s.selectedNode.host}:${s.selectedNode.port})` : '未选择';
  $('statusLine').textContent = `选中节点: ${sel}  |  HTTP 代理: 127.0.0.1:${s.httpPort}  |  SOCKS5: 127.0.0.1:${s.socksPort}`;
  $('errLine').textContent = s.lastError ? '上次错误: ' + s.lastError : '';
  const st = s.stats || {};
  const c = st.client || {};
  const h = st.http || {};
  const so = st.socks || {};
  const sv = st.server || {};
  $('statsBox').innerHTML = [
    stat('客户端连接', s.connected ? '已连接' : '未连接'),
    stat('上行流量', fmt(c.upBytes)), stat('下行流量', fmt(c.downBytes)),
    stat('已开隧道数', c.tunnelsOpened || 0),
    stat('HTTP 请求', h.requests || 0), stat('HTTP CONNECT', h.connects || 0),
    stat('SOCKS5 连接', so.connects || 0),
    stat('服务端在线客户端', sv.clients || 0), stat('服务端隧道', sv.tunnelsOpened || 0)
  ].join('');
}

const stat = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function refresh() {
  try {
    const [st, nl] = await Promise.all([api('/api/status'), api('/api/nodes')]);
    nodes = (nl.nodes || []).map((n) => ({ ...n, active: st.selectedNode && st.selectedNode.id === n.id }));
    renderNodes();
    renderStatus(st);
  } catch (e) { $('errLine').textContent = '刷新失败: ' + e.message; }
}

window.selectNode = async (id) => { await api('/api/node/select', { method: 'POST', body: { id } }); refresh(); };
window.delNode = async (id) => { await api('/api/nodes/' + encodeURIComponent(id), { method: 'DELETE' }); refresh(); };

$('btnConnect').onclick = async () => {
  const r = await api('/api/connect', { method: 'POST' });
  if (!r.ok) $('errLine').textContent = r.error || '启动失败'; else refresh();
};
$('btnDisconnect').onclick = async () => { await api('/api/disconnect', { method: 'POST' }); refresh(); };
$('btnAddNode').onclick = async () => {
  const host = prompt('服务端 IP/域名');
  if (!host) return;
  const port = prompt('端口', '9443') || '9443';
  const password = prompt('密码') || '';
  const name = prompt('节点名称', host) || host;
  const r = await api('/api/nodes', { method: 'POST', body: { node: { id: 'ntp-' + host + '-' + port, name, proto: 'ntp', host, port: Number(port), password, raw: '' } } });
  if (!r.ok) $('errLine').textContent = r.error || '添加失败'; else refresh();
};
$('btnAddByUrl').onclick = async () => {
  const u = prompt('粘贴节点链接（ntp:// vmess:// vless:// trojan:// ss://）');
  if (!u) return;
  const r = await api('/api/nodes', { method: 'POST', body: { node: u } });
  if (!r.ok) $('errLine').textContent = r.error || '解析失败'; else refresh();
};
$('btnFetchSub').onclick = async () => {
  const url = $('subUrl').value.trim();
  if (!url) return;
  const r = await api('/api/subscription/fetch', { method: 'POST', body: { url } });
  if (!r.ok) $('subLine').textContent = '导入失败: ' + (r.error || '');
  else {
    $('subLine').textContent = `成功导入 ${r.total} 个节点（其中 NTP 直连可用 ${r.ntpCompatible} 个）`;
    refresh();
  }
};
$('btnSrvStart').onclick = async () => {
  const r = await api('/api/server/start', { method: 'POST', body: { host: $('srvHost').value, port: Number($('srvPort').value), password: $('srvPwd').value } });
  if (!r.ok) $('srvLine').textContent = '启动失败: ' + (r.error || '');
  else $('srvLine').textContent = '服务端已监听 ' + (r.address && r.address.address) + ':' + (r.address && r.address.port);
  refresh();
};
$('btnSrvStop').onclick = async () => { await api('/api/server/stop', { method: 'POST' }); refresh(); };

refresh();
setInterval(refresh, 3000);

