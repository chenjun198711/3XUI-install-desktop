/**
 * 3X-UI 小白一键安装器 - 后端服务
 * 原理：本地启动 Web UI → 用户填写 VPS 信息 → 通过 SSH 直连用户自己的服务器执行官方安装脚本
 * 安全说明：所有凭据仅存在本机内存中，只与用户自己的 VPS 通信，不经过任何第三方服务器
 */
const path = require('path');
const dns = require('dns').promises;
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');
const crypto = require('crypto');
const qrcode = require('qrcode');

const PORT = process.env.PORT || 3930;
const HOST = '127.0.0.1'; // 仅本机可访问，防止凭据被局域网嗅探

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静态资源
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '1.0.0' }));

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 转义 shell 双引号内的特殊字符 */
function shEsc(s) {
  return String(s).replace(/(["\\$`])/g, '\\$1');
}

/**
 * 本地生成 X25519 密钥对（与 `xray x25519` 完全等价，均为标准 Curve25519）。
 * 这样创建 Reality 节点不再依赖服务器上的 xray 二进制是否存在。
 * xray 的 privateKey / publicKey 字段就是 32 字节原始密钥的 base64。
 */
function genX25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  return { privateKey: privRaw.toString('base64'), publicKey: pubRaw.toString('base64') };
}

/**
 * 生成 3X-UI 官方安装命令（含预设答案，通过 stdin 管道喂给安装脚本）
 * 官方脚本交互问题：
 *   1. Do you want to customize the panel settings? [y/n]  → y
 *   2. Please set up your username                          → 用户名
 *   3. Please set up your password                          → 密码
 *   4. Please set up the panel port                         → 端口
 *   5. Please set up the web base path (可留空自动生成)       → 路径
 */
/**
 * 生成「多镜像自动切换 + 手动部署」安装脚本
 * 官方 install.sh 硬编码 github.com 且无镜像支持，VPS 直连 GitHub 不通时必失败。
 * 这里改为：多路 API 拿版本 → 多个 GitHub 镜像按序自动切换下载 → 解压部署 →
 * systemd 服务 → 数据库直写管理员账号（bcrypt，绕开 x-ui setting 写用户名失败的坑）→
 * 端口/路径设置 → 重启 → 输出最终配置。
 */
/** 生成随机 Web 访问路径（类似官方脚本的随机 basePath，避免裸路径被扫描） */
function genRandomBasePath() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s + '/';
}

function buildInstallCommand(cfg) {
  const userArg = shSingle(cfg.panelUser || 'admin'); // shell 单引号参数
  const passArg = shSingle(cfg.panelPass || '');
  const port = Number(cfg.panelPort) || 2083;
  // 访问路径：官方脚本用无斜杠随机串（面板自动规范化显示为 /xxx/）
  const bp = normalizeBasePath(cfg.basePath || '') || genRandomBasePath();
  const basePathRaw = bp.replace(/^\/+|\/+$/g, ''); // 去斜杠，贴近官方 gen_random_string 格式
  cfg.effectiveBasePath = fixBasePath(basePathRaw);
  const basePathArg = shSingle(basePathRaw);
  // 填了域名 → 自动用 acme.sh 签发 Let's Encrypt 证书（XUI_SSL_MODE=domain），与 FinalShell 手动装行为一致
  // 没填域名 → 纯 HTTP（XUI_SSL_MODE=none）
  const sslModeEnv = cfg.domain
    ? `XUI_SSL_MODE=domain XUI_DOMAIN=${shSingle(cfg.domain)} XUI_ACME_HTTP_PORT=80 `
    : `XUI_SSL_MODE=none `;
  return [
    // ---------- 1. 清理旧安装（确保官方脚本走全新安装流程） ----------
    'systemctl stop x-ui 2>/dev/null; sleep 1',
    'rm -rf /usr/local/x-ui /etc/x-ui /etc/systemd/system/x-ui.service 2>/dev/null',
    'systemctl daemon-reload',
    'rm -f /usr/local/bin/x-ui /usr/local/bin/x-ui.sh 2>/dev/null',
    // ---------- 2. 下载官方安装脚本（多镜像自动切换） ----------
    'OK=0',
    'for u in "https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh" "https://ghfast.top/https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh" "https://ghproxy.net/https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh" "https://gh-proxy.com/https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh" "https://ghproxy.cc/https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh"; do',
    '  echo "[1/4] 尝试下载官方安装脚本: $u"',
    '  if curl -fsSL --connect-timeout 10 --max-time 40 -o /tmp/xui_install.sh "$u" 2>/dev/null && [ -s /tmp/xui_install.sh ]; then',
    '    SZ=$(stat -c%s /tmp/xui_install.sh 2>/dev/null || echo 0)',
    '    if [ "$SZ" -gt 10000 ]; then echo "      ✓ 脚本下载成功（$SZ 字节）"; OK=1; break; fi',
    '  fi',
    '  rm -f /tmp/xui_install.sh',
    'done',
    'if [ "$OK" != "1" ]; then echo "[失败] 无法下载官方安装脚本，请检查服务器外网"; exit 1; fi',
    // ---------- 3. 官方脚本全自动安装（NONINTERACTIVE 环境变量传参，跳过所有交互） ----------
    // 填了域名 → 自动用 acme.sh 签发 Let's Encrypt 证书（XUI_SSL_MODE=domain），与 FinalShell 手动装行为一致
    // 没填域名 → 纯 HTTP（XUI_SSL_MODE=none）
    `echo "[2/4] 开始安装 3X-UI（端口 ${port} / 路径 ${basePathRaw} / 账号 ${cfg.panelUser || 'admin'}${cfg.domain ? ' / 域名 ' + cfg.domain + '（自动申请SSL证书 + 自动续签）' : ''}）..."`,
    'cd /tmp && XUI_NONINTERACTIVE=1 ' +
      `XUI_USERNAME=${userArg} XUI_PASSWORD=${passArg} XUI_PANEL_PORT=${port} ` +
      `XUI_WEB_BASE_PATH=${basePathArg} XUI_DB_TYPE=sqlite ` + sslModeEnv +
      `XUI_ENABLE_FAIL2BAN=true ` +
      'bash /tmp/xui_install.sh',
    'INSTALL_RC=$?',  // 捕获官方安装脚本的真实退出码；脚本最终 exit 该值，避免被后续 systemctl/查询的副作用污染（这是之前"退出码 3 误报"的根因：旧脚本最后一行是 systemctl is-active，遇到"activating"会返回 3，把成功的安装拖成失败）
    'sleep 2',
    // ---------- 3.5 强制应用我们选定的配置（覆盖官方脚本忽略 env 的情况） ----------
    // 官方脚本在检测到"已有安装"（首次运行会自动初始化默认 webBasePath，长度 ≥4）时会走 existing 分支，
    // 该分支忽略 XUI_WEB_BASE_PATH、端口沿用旧值，导致面板最终是随机路径/旧端口。
    // 这里用面板自带命令强制写回用户选定的 端口/路径/账号，再重启，确保最终结果可控、可预测。
    'echo "[2.5/4] 强制应用选定配置（端口 ' + port + ' / 路径 ' + basePathRaw + '）..."',
    '/usr/local/x-ui/x-ui setting -username ' + userArg + ' -password ' + passArg + ' -port ' + port + ' -webBasePath ' + basePathArg,
    'systemctl restart x-ui',
    'sleep 3',
    // ---------- 4. 验证：DB 账号 + 配置 + 真实监听端口 ----------
    'echo "[3/4] 安装完成，验证配置..."',
    'DB=""',
    'for cand in /etc/x-ui/x-ui.db /usr/local/x-ui/bin/x-ui.db; do [ -s "$cand" ] && DB="$cand" && break; done',
    '[ -z "$DB" ] && DB=$(find /usr/local/x-ui /etc/x-ui -name "x-ui.db" 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1)',
    'echo "[账号] 数据库: $DB"',
    // 面板用内置纯 Go sqlite，VPS 不一定自带 sqlite3 命令；缺失会让下面读取返回空 → 误报"账号写入失败"。先装好再读。
    'command -v sqlite3 >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq sqlite3 >/dev/null 2>&1) || (yum install -y -q sqlite >/dev/null 2>&1); echo "[账号] sqlite3: $(command -v sqlite3 || echo MISSING)"',
    // 从数据库直接读 webBasePath（比解析 setting -show 文本输出更可靠，不受 pty 颜色码/格式变化影响）
    `DB_BASE=$(sqlite3 "$DB" "select value from settings where key='webBasePath';" 2>/dev/null)`,
    'echo "DB_WEBBASEPATH=$DB_BASE"',
    // 从数据库直接读 port（官方脚本可能忽略 XUI_PANEL_PORT，用默认/已有端口；DB 值才是面板真实监听端口）
    `DB_PORT=$(sqlite3 "$DB" "select value from settings where key='port';" 2>/dev/null)`,
    'echo "DB_PORT=$DB_PORT"',
    `ACC_USER=$(sqlite3 "$DB" "select username from users where id=(select min(id) from users);" 2>/dev/null)`,
    `ACC_LEN=$(sqlite3 "$DB" "select length(password) from users where id=(select min(id) from users);" 2>/dev/null)`,
    `echo "===XUI_ACCOUNT_BEGIN==="`,
    `echo "ACC_USER=$ACC_USER"`,
    `echo "ACC_LEN=$ACC_LEN"`,
    `echo "===XUI_ACCOUNT_END==="`,
    'echo "===XUI_SETTINGS_BEGIN==="',
    '/usr/local/x-ui/x-ui setting -show true 2>/dev/null',
    'echo "===XUI_SETTINGS_END==="',
    // 真实监听端口（面板 x-ui 进程）
    'echo "===XUI_LISTEN_BEGIN==="',
    'ss -tlnp 2>/dev/null | grep -iE "x-ui|:443 |:2053 |:2083 |:2087 |:8443 |:2096 |:80 |:8080 |:8880 |:2052 |:2082 |:2086 |:2095 " | awk "{print \\$4}" | sed -E "s/.*:([0-9]+).*/\\1/" | sort -u',
    'echo "===XUI_LISTEN_END==="',
    // 等待 x-ui 服务真正进入 active（Type=notify 启动需要几秒），最多轮询 24s，避免读到"activating"
    'SA=""',
    'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do SA=$(systemctl is-active x-ui 2>/dev/null); [ "$SA" = "active" ] && break; sleep 2; done',
    'echo "===XUI_SVC_BEGIN==="',
    'echo "$SA"',
    'echo "===XUI_SVC_END==="',
    // 实测首页能否打开：本地回环探测（绕过域名/证书/CF），确认 webBasePath 真实可用，避免"显示成功但链接打不开"
    'echo "===XUI_PROBE_BEGIN==="',
    'for proto in https http; do for p in "' + basePathRaw + '/" "' + basePathRaw + '/login" "/"; do code=$(curl -s -k -L -o /dev/null -w "%{http_code}" --connect-timeout 5 "$proto://127.0.0.1:' + port + '$p" 2>/dev/null); echo "PROBE $proto $p -> $code"; done; done',
    'echo "===XUI_PROBE_END==="',
    'echo "===XUI_INSTALL_RC_BEGIN===$INSTALL_RC===XUI_INSTALL_RC_END==="',
    'exit "$INSTALL_RC"',  // 脚本最终退出码 = 官方安装脚本退出码（成功 = 0，不受后续验证副作用影响）
  ].join('\n');
}

function buildPostInstallCommand(cfg) {
  const bin = '/usr/local/x-ui/x-ui';
  const basePath = normalizeBasePath(cfg.basePath) || genRandomBasePath();
  cfg.effectiveBasePath = basePath;
  const parts = [
    // 等待安装落盘
    'sleep 1',
    // 强制写入用户设置（幂等）
    `${bin} setting -username ${shQuoted(cfg.panelUser)}`,
    `${bin} setting -password ${shQuoted(cfg.panelPass)}`,
    `${bin} setting -port ${Number(cfg.panelPort)}`,
    // 访问路径：用户没填就自动生成随机路径，总是设置
    `${bin} setting -webBasePath ${shQuoted(basePath)}`,
  ];
  parts.push('systemctl restart x-ui || x-ui restart');
  // 打印最终配置（在输出里打上标记方便前端解析）
  parts.push(`echo "===XUI_SETTINGS_BEGIN==="`);
  parts.push(`${bin} setting -show true`);
  parts.push(`echo "===XUI_SETTINGS_END==="`);
  parts.push('systemctl is-active x-ui');
  return parts.join(' && ');
}

function shQuoted(s) {
  return `"${shEsc(s)}"`;
}
function sqlEsc(s) {
  return String(s).replace(/'/g, "''");
}
// 单引号包裹（用于 shell 参数，密码/用户名含特殊字符也安全）
function shSingle(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function normalizeBasePath(p) {
  if (!p) return '';
  let v = String(p).trim();
  if (!v) return '';
  if (!v.startsWith('/')) v = '/' + v;
  if (!v.endsWith('/')) v = v + '/';
  return v;
}

/** 规范化 Web 访问路径：保证以 / 开头、以 / 结尾（面板可能返回无前导斜杠的路径） */
function fixBasePath(p) {
  if (!p || p === '/') return '/';
  let v = String(p).trim();
  if (!v.startsWith('/')) v = '/' + v;
  if (!v.endsWith('/')) v += '/';
  return v;
}

/**
 * 从本地 HTTP 探测结果挑出"实测可打开"的访问路径。
 * - 优先：带期望 webBasePath 的探测返回 2xx/3xx → 用该路径（面板确实有 base path）
 * - 其次：根路径 "/" 返回 2xx/3xx → 说明面板实际没有 base path（解析回退错了），用 "/"
 * - 都没命中 → 返回 null，调用方沿用解析值
 */
function pickProbePath(probe, wantedBasePath) {
  if (!probe || !probe.length) return null;
  const want = (wantedBasePath || '/').replace(/^\/+|\/+$/g, '');
  for (const pr of probe) {
    const pp = pr.path.replace(/^\/+|\/+$/g, '');
    if (pp === want && /^2|^3/.test(pr.code)) return fixBasePath(pr.path);
  }
  for (const pr of probe) {
    if (pr.path === '/' && /^2|^3/.test(pr.code)) return '/';
  }
  return null;
}

/** 从 x-ui setting -show 输出解析配置 */
function parseSettings(raw) {
  const out = {};
  const m = raw.match(/===XUI_SETTINGS_BEGIN===([\s\S]*?)===XUI_SETTINGS_END===/);
  // 去掉 ANSI 颜色控制码（pty 输出带颜色，会干扰 Username/Password 等行的正则匹配）
  const body = (m ? m[1] : raw).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  // 单独解析 XUI_LISTEN 块（xray 实际监听端口，最可靠的真实端口来源）
  const listenMatch = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').match(/===XUI_LISTEN_BEGIN===([\s\S]*?)===XUI_LISTEN_END===/);
  if (listenMatch) {
    const ports = [...listenMatch[1].matchAll(/(\d{2,5})/g)].map((mm) => mm[1]).filter((v, i, a) => a.indexOf(v) === i);
    out.listenPorts = ports;
  } else {
    out.listenPorts = [];
  }
  const grab = (...labels) => {
    for (const label of labels) {
      const r = new RegExp(label + '\\s*[:：=]\\s*([^\\r\\n]+)', 'i');
      const mm = body.match(r);
      if (mm && mm[1].trim()) return mm[1].trim();
    }
    return '';
  };
  out.username = grab('Username', 'username', '用户名', 'USERNAME');
  out.password = grab('Password', 'password', '密码');
  out.port = grab('Port', '端口');
  const parsedBase = grab('WebBasePath', 'Web Base Path', 'webBasePath');
  // 注意：解析失败时必须返回 ''（falsy），绝不能回退成 '/'。
  // 否则假的 '/' 会短路掉 cfg.effectiveBasePath（工具已知的真实路径），最终给根路径链接导致 404。
  out.webBasePath = parsedBase ? fixBasePath(parsedBase) : '';
  // 从 SQLite 数据库直接读出的 webBasePath（最可靠，优先级高于 setting -show 文本解析）
  const dbBaseM = raw.match(/DB_WEBBASEPATH=(.*)/);
  if (dbBaseM && dbBaseM[1] && dbBaseM[1].trim() && dbBaseM[1].trim() !== '') {
    out.dbWebBasePath = fixBasePath(dbBaseM[1].trim());
  } else {
    out.dbWebBasePath = '';
  }
  // 从 SQLite 数据库直接读出的 port（最可靠，优先级高于 setting -show 文本解析）
  const dbPortM = raw.match(/DB_PORT=(\d+)/);
  out.dbPort = dbPortM ? dbPortM[1] : '';
  // 解析本地 HTTP 探测：确认 webBasePath 真实可打开，避免把"根路径 404"误当成成功链接给用户
  const probeM = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').match(/===XUI_PROBE_BEGIN===([\s\S]*?)===XUI_PROBE_END===/);
  if (probeM) {
    out.probe = [...probeM[1].matchAll(/PROBE\s+(\S+)\s+(\S+)\s+->\s+(\d{3})/g)]
      .map((mm) => ({ proto: mm[1], path: mm[2], code: mm[3] }));
  } else {
    out.probe = [];
  }
  out.twoFA = grab('2FA_ENABLED');
  return out;
}

/* ------------------------------------------------------------------ */
/* Socket 流程                                                         */
/* ------------------------------------------------------------------ */

const activeConn = new Map(); // socketId -> ssh Client

io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    const conn = activeConn.get(socket.id);
    if (conn) { try { conn.end(); } catch (_) {} activeConn.delete(socket.id); }
  });

/** 测试 SSH 连通性（不执行任何命令） */
  socket.on('ssh:test', (cfg, ack) => {
    const conn = new Client();
    const connCfg = makeConnConfig(cfg);
    let settled = false;
    const done = (ok, msg) => {
      if (settled) return; settled = true;
      try { conn.end(); } catch (_) {}
      if (typeof ack === 'function') ack({ ok, msg });
    };
    // 先自查凭据输入（空密码、全角字符、首尾空格），这类问题不该报成「认证失败」
    const pre = inspectCreds(cfg);
    if (!pre.ok) { done(false, pre.msg); return; }
    if (pre.hint) connCfg.__authDetail.inputHint = pre.hint;

    conn.on('ready', () => done(true, '连接成功'))
      .on('error', (e) => done(false, friendlySSHError(e, connCfg.__authDetail)))
      // 服务器在握手/认证阶段直接掐断连接时 ssh2 不报 error，旧版会一直等到前端超时
      .on('close', () => {
        if (!settled) done(false, '连接被中断：服务器在握手或认证阶段主动断开了连接，常见于并发连接限制、防爆破策略或网络抖动。请稍等几秒后重试。');
      })
      .on('timeout', () => {
        if (!settled) done(false, '连接超时：服务器在 20 秒内没有响应握手，请检查服务器状态、网络或安全组设置。');
      });
    // ssh2 对无法解析的私钥会同步抛异常，不接住会把整个本地服务带崩
    try {
      conn.connect(connCfg);
    } catch (e) {
      done(false, friendlySSHError(e, connCfg.__authDetail));
    }
  });

  /** 面板急救箱：查看/重置面板账号、重启面板（无需登录面板） */
  socket.on('rescue:run', (data, ack) => {
    const { server, action, panelUser, panelPass, panelPort } = data;
    const bin = '/usr/local/x-ui/x-ui';
    let cmd = '';
    const ensureSqlite = `(command -v sqlite3 >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq sqlite3) || (yum install -y -q sqlite))`;
    // 自动定位数据库文件（不同版本/安装方式路径可能不同）
    const dbDetect = `DB=$(find /usr/local/x-ui /etc/x-ui -name 'x-ui.db' 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1); if [ -z "$DB" ]; then echo "NO_DB_FILE"; fi`;
    // 注意：SQL 必须用单引号包裹，避免与外层 echo 的双引号冲突导致 USERNAME 解析为空
    const dbUserQuery = `echo "USERNAME=$(sqlite3 "$DB" 'select username from users limit 1;' 2>/dev/null)"`;
    const db2faQuery = `echo "2FA_ENABLED=$(sqlite3 "$DB" 'select secret_enable from users limit 1;' 2>/dev/null)"`;
    if (action === 'show') {
      cmd = [
        `${bin} setting -show true`,
        'echo',
        ensureSqlite,
        dbDetect,
        dbUserQuery,
        db2faQuery,
        'systemctl is-active x-ui || x-ui status',
      ].join('; ');
    } else if (action === 'reset') {
      // 现代版 3X-UI 的密码是 bcrypt 哈希存储（源码 crypto.HashPasswordAsBcrypt），
      // `x-ui setting -password` 在新版不一定可靠，故直接用 htpasswd 生成 bcrypt 哈希写库。
      const u = sqlEsc(panelUser);   // 用于 SQL 单引号内
      const pArg = shSingle(panelPass); // 用于 htpasswd / 官方命令参数
      const parts = [
        'echo "===RESCUE_RESET==="',
        // 先停面板，避免 sqlite 被占用
        'systemctl stop x-ui 2>/dev/null; x-ui stop 2>/dev/null; true',
        // 安装 sqlite3 和 htpasswd（apache2-utils）
        'if ! command -v sqlite3 >/dev/null 2>&1 || ! command -v htpasswd >/dev/null 2>&1; then apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq sqlite3 apache2-utils >/dev/null 2>&1 || yum install -y -q sqlite httpd-tools >/dev/null 2>&1; fi',
        'echo "TOOLS=$(command -v sqlite3 || echo no-sqlite)-$(command -v htpasswd || echo no-htpasswd)"',
        // 定位数据库文件
        'DB=$(find /usr/local/x-ui /etc/x-ui -name "x-ui.db" 2>/dev/null | head -1); echo "DB_PATH=$DB"',
        'if [ -z "$DB" ]; then echo "NO_DB_FILE"; exit 1; fi',
        // 用 bcrypt 生成密码哈希（$2y 转 $2a，Go 的 bcrypt 库认 $2a）
        `HASH=$(htpasswd -bnBC 10 '' ${pArg} | tr -d ':\\n' | sed 's/^\\$2y/\\$2a/'); echo "HASH_PREFIX=\${HASH:0:7}"`,
        `echo "USERS_BEFORE=$(sqlite3 "$DB" "select id||chr(124)||username||chr(124)||substr(password,1,7) from users;" 2>/dev/null)"`,
        // 命中多种可能：id=1 / 管理员标记 / 第一行；用户名与密码一起写
        `if [ -n "$HASH" ]; then
  sqlite3 "$DB" "UPDATE users SET username='${u}', password='$HASH' WHERE id=1;" 2>&1
  sqlite3 "$DB" "UPDATE users SET username='${u}', password='$HASH' WHERE is_admin=1;" 2>&1
  sqlite3 "$DB" "UPDATE users SET username='${u}', password='$HASH' WHERE id=(SELECT MIN(id) FROM users);" 2>&1
else
  echo "HTPSWD_MISSING_FALLBACK"
  ${bin} setting -password ${pArg} 2>&1
  ${bin} setting -username ${pArg} 2>&1
fi`,
        // 关闭两步验证（兼容两种存储：users.secret_enable 或 settings 表）
        `sqlite3 "$DB" "UPDATE users SET secret_enable=0 WHERE secret_enable=1;" 2>/dev/null`,
        `sqlite3 "$DB" "UPDATE settings SET value='false' WHERE key IN ('secretEnable','twoFactorEnable');" 2>/dev/null`,
        // 递增 login_epoch 强制旧会话失效（列不存在则忽略）
        `sqlite3 "$DB" "UPDATE users SET login_epoch = login_epoch + 1;" 2>/dev/null`,
        `echo "USERS_AFTER=$(sqlite3 "$DB" "select id||chr(124)||username||chr(124)||substr(password,1,7) from users;" 2>/dev/null)"`,
        // 重启面板（同时清空内存里的 IP 封禁记录）
        'systemctl start x-ui 2>/dev/null; x-ui start 2>/dev/null; true',
        'sleep 1; systemctl is-active x-ui',
        'echo "===XUI_SETTINGS_BEGIN==="',
        `${bin} setting -show true`,
        `echo "USERNAME=$(sqlite3 "$DB" 'select username from users limit 1;' 2>/dev/null)"`,
        'echo "===XUI_SETTINGS_END==="',
      ];
      cmd = parts.join('; ');
    } else if (action === 'restart') {
      cmd = 'systemctl restart x-ui || x-ui restart; sleep 1; systemctl is-active x-ui';
    } else if (action === 'disable2fa') {
      // 关闭面板两步验证（2FA）：兼容 users.secret_enable 与 settings 表两种存储，并重启
      cmd = [
        'systemctl stop x-ui 2>/dev/null; x-ui stop 2>/dev/null; true',
        ensureSqlite,
        dbDetect,
        `sqlite3 "$DB" "update users set secret_enable=0 where secret_enable=1;" 2>/dev/null`,
        `sqlite3 "$DB" "update settings set value='false' where key in ('secretEnable','twoFactorEnable');" 2>/dev/null`,
        `sqlite3 "$DB" "update users set login_epoch = login_epoch + 1;" 2>/dev/null`,
        'systemctl start x-ui 2>/dev/null; x-ui start 2>/dev/null; true',
        'sleep 1; systemctl is-active x-ui',
        'echo "===XUI_SETTINGS_BEGIN==="; ' + bin + ' setting -show true; echo "===XUI_SETTINGS_END==="',
        db2faQuery,
      ].join('; ');
    } else {
      if (typeof ack === 'function') ack({ ok: false, output: '未知操作' });
      return;
    }

    const conn = new Client();
    let out = '';
    conn.on('ready', () => {
      runCommand(conn, cmd, {
        onOutput: () => {},
        onExit: (code, raw) => {
          try { conn.end(); } catch (_) {}
          if (code !== 0) {
            if (typeof ack === 'function') ack({ ok: false, output: '命令执行失败（退出码 ' + code + '）。若提示 x-ui 不存在，说明该服务器尚未安装面板。' });
          } else {
            const settings = parseSettings(raw);
            if (typeof ack === 'function') ack({ ok: true, output: raw, settings });
          }
        },
      });
    })
      .on('error', (e) => {
        if (typeof ack === 'function') ack({ ok: false, output: friendlySSHError(e) });
      })
      .connect(makeConnConfig(server));
  });

  /* ============ 域名与 HTTPS 管理（针对已部署面板） ============ */

  // 检查域名 DNS 解析是否指向本机、是否 Ping 通
  socket.on('domain:check', (data, ack) => {
    const { server, domain } = data;
    if (!domain) { ack({ ok: false, output: '请填写域名' }); return; }
    const d = shSingle(domain);
    const cmd = [
      `PUB=""; for u in ifconfig.me ip.sb icanhazip.com; do PUB=$(curl -s -m10 "$u" 2>/dev/null); [ -n "$PUB" ] && break; done; echo "PUB_IP=$PUB"`,
      `RES=$(getent ahosts ${d} 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ' '); [ -z "$RES" ] && RES=$(dig +short ${d} 2>/dev/null | tr '\\n' ' '); [ -z "$RES" ] && RES=$(nslookup ${d} 2>/dev/null | grep -oE 'Address: [0-9.]+' | awk '{print $2}' | tr '\\n' ' '); echo "RESOLVED_IPS=$RES"`,
      `MATCH=no; for ip in $RES; do [ "$ip" = "$PUB" ] && MATCH=yes; done; echo "MATCH=$MATCH"`,
      `PINGOUT=$(ping -c3 ${d} 2>&1); if echo "$PINGOUT" | grep -qE 'received.*[1-9]|ttl='; then PINGOK=yes; else PINGOK=no; fi; echo "PING_OK=$PINGOK"; echo "PING_SUMMARY=$(echo "$PINGOUT" | grep -E 'received|packet loss|time=' | tail -2 | tr '\\n' ' ' | head -c 220)"`,
    ].join('; ');
    const conn = new Client();
    conn.on('ready', () => runCommand(conn, cmd, {
      onOutput: () => {},
      onExit: (code, raw) => {
        try { conn.end(); } catch (_) {}
        const g = (k) => { const m = raw.match(new RegExp(k + '=(.*)')); return m ? m[1].trim() : ''; };
        const pubIp = g('PUB_IP');
        const resolved = g('RESOLVED_IPS').split(/\s+/).filter(Boolean);
        const match = g('MATCH') === 'yes';
        const pingOk = g('PING_OK') === 'yes';
        const pingSummary = g('PING_SUMMARY');
        if (!pubIp && resolved.length === 0) {
          ack({ ok: false, output: '无法解析域名，也获取不到服务器公网IP，请检查网络/DNS设置。' });
        } else {
          ack({ ok: true, pubIp, resolvedIps: resolved, match, pingOk, pingSummary });
        }
      },
    })).on('error', (e) => { ack({ ok: false, output: friendlySSHError(e) }); }).connect(makeConnConfig(server));
  });

  // 检查面板当前 HTTPS 状态（证书是否已配置、是否生效、80/443 监听）
  socket.on('ssl:status', (data, ack) => {
    const { server, domain } = data;
    const bin = '/usr/local/x-ui/x-ui';
    const cmd = [
      `PORT=$(${bin} setting -show true 2>/dev/null | grep -iE 'port' | head -1 | grep -oE '[0-9]+' | head -1); echo "PANEL_PORT=$PORT"`,
      `DB=$(find /usr/local/x-ui /etc/x-ui -name 'x-ui.db' 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1)`,
      `CERTS=$(find /root/cert /usr/local/x-ui /etc/x-ui -name '*.pem' 2>/dev/null | head -5 | tr '\\n' '|'); echo "CERT_FILES=$CERTS"`,
      `SK=$(sqlite3 "$DB" "select group_concat(key,',') from settings where key like '%cert%' or key like '%Cert%' or key like '%ssl%' or key like '%SSL%';" 2>/dev/null); echo "SETTINGS_CERT_KEYS=$SK"`,
      `HTTPS_EXPIRY=$( (echo | timeout 5 openssl s_client -connect 127.0.0.1:$PORT 2>/dev/null) | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//' ); echo "HTTPS_EXPIRY=$HTTPS_EXPIRY"; [ -n "$HTTPS_EXPIRY" ] && echo "HTTPS_ACTIVE=yes" || echo "HTTPS_ACTIVE=no"`,
      `ss -tlnp 2>/dev/null | grep -qE ':80 ' && echo "PORT80_LISTEN=yes" || echo "PORT80_LISTEN=no"`,
      `ss -tlnp 2>/dev/null | grep -qE ':443 ' && echo "PORT443_LISTEN=yes" || echo "PORT443_LISTEN=no"`,
    ].join('; ');
    const conn = new Client();
    conn.on('ready', () => runCommand(conn, cmd, {
      onOutput: () => {},
      onExit: (code, raw) => {
        try { conn.end(); } catch (_) {}
        const g = (k) => { const m = raw.match(new RegExp(k + '=(.*)')); return m ? m[1].trim() : ''; };
        const port = g('PANEL_PORT');
        const certFiles = g('CERT_FILES') ? g('CERT_FILES').split('|').filter(Boolean) : [];
        const httpsActive = g('HTTPS_ACTIVE') === 'yes';
        const basePath = (data.webBasePath || '/');
        ack({
          ok: true, port, certFiles, certConfigured: certFiles.length > 0,
          httpsActive, httpsExpiry: g('HTTPS_EXPIRY'),
          port80: g('PORT80_LISTEN') === 'yes', port443: g('PORT443_LISTEN') === 'yes',
          settingsCertKeys: g('SETTINGS_CERT_KEYS'),
          httpsUrl: 'https://' + (domain || server.host) + ':' + port + basePath,
        });
      },
    })).on('error', (e) => { ack({ ok: false, output: friendlySSHError(e) }); }).connect(makeConnConfig(server));
  });

  // 一键申请 Let's Encrypt 证书并配置面板 HTTPS（acme.sh standalone）
  socket.on('ssl:enable', (data) => {
    const { server, domain, email } = data;
    const emit = (t, o) => socket.emit(t, o);
    if (!domain) { emit('ssl:result', { ok: false, output: '请填写域名' }); return; }
    const d = shSingle(domain);
    const mailDomain = (domain || 'example.com').replace(/^\*\./, '');
    const em = shSingle(email || ('admin@' + mailDomain));
    emit('ssl:log', { level: 'info', text: '正在连接服务器，为 ' + domain + ' 申请证书…' });
    const bin = '/usr/local/x-ui/x-ui';
    const cmd = [
      `PUB=""; for u in ifconfig.me ip.sb icanhazip.com; do PUB=$(curl -s -m10 "$u" 2>/dev/null); [ -n "$PUB" ] && break; done`,
      `RES=$(getent ahosts ${d} 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ' '); MATCH=no; for ip in $RES; do [ "$ip" = "$PUB" ] && MATCH=yes; done; echo "[前置] 域名解析: $RES | 本机公网IP: $PUB | 匹配=$MATCH"`,
      `if [ "$MATCH" != "yes" ]; then echo "[错误] 域名未解析到本机IP，请先在DNS添加A记录指向 $PUB 再试。"; exit 2; fi`,
      `if ss -tlnp 2>/dev/null | grep -qE ':80 '; then echo "[错误] 80端口已被占用(如nginx)，请先停用占用80的程序。"; exit 3; fi; echo "[前置] 80端口可用 ✓"`,
      `if [ ! -f /root/.acme.sh/acme.sh ]; then echo "[1/4] 安装 acme.sh…"; curl -sL https://get.acme.sh -o /tmp/acme.sh || curl -sL https://ghproxy.com/https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh -o /tmp/acme.sh; sh /tmp/acme.sh; fi`,
      `ACME=/root/.acme.sh/acme.sh; echo "[2/4] 申请 Let's Encrypt 证书(域名 ${d})…"`,
      `"$ACME" --issue -d ${d} --standalone --httpport 80 --accountemail ${em} || { echo "[错误] 证书申请失败：DNS未生效 / 80端口未公网放行 / Let's Encrypt限流(同域名每周上限5次)。确认后重试。"; exit 4; }`,
      `echo "[3/4] 安装证书文件…"; mkdir -p /root/cert/${d}; "$ACME" --installcert -d ${d} --fullchainpath /root/cert/${d}/fullchain.pem --keypath /root/cert/${d}/privkey.pem`,
      `echo "[4/4] 配置面板证书并重启…"; ${bin} cert -webCert /root/cert/${d}/fullchain.pem -webCertKey /root/cert/${d}/privkey.pem 2>/dev/null || ${bin} setting -webCert /root/cert/${d}/fullchain.pem -webCertKey /root/cert/${d}/privkey.pem; systemctl restart x-ui || x-ui restart; sleep 2`,
      `PORT=$(${bin} setting -show true 2>/dev/null | grep -iE 'port' | head -1 | grep -oE '[0-9]+' | head -1); echo "[完成] HTTPS 面板地址: https://${d}:$PORT/ (若你有访问路径，请连同路径一起访问)"`,
    ].join('; ');
    const conn = new Client();
    conn.on('ready', () => runCommand(conn, cmd, {
      longRunning: true,
      onOutput: (l) => emit('ssl:log', { level: 'info', text: l }),
      onExit: (code, raw) => {
        try { conn.end(); } catch (_) {}
        if (code === 0) emit('ssl:result', { ok: true, output: raw });
        else emit('ssl:result', { ok: false, output: raw || ('退出码 ' + code) });
      },
    })).on('error', (e) => emit('ssl:result', { ok: false, output: friendlySSHError(e) })).connect(makeConnConfig(server));
  });

  /* ============ 可视化创建节点（针对已部署面板） ============ */
  /* ============ Reality 目标扫描器（本地 TLS 1.3 握手测试，不依赖 VPS） ============ */
  socket.on('reality:scan', (data) => {
    const emit = (t, o) => socket.emit(t, o);
    const raw = String((data && data.targets) || '').replace(/[\r\t]/g, ' ');
    const targets = raw.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 60);
    if (!targets.length) { emit('reality:scan:result', { ok: false, output: '请输入至少一个目标（每行一个，例如 www.cloudflare.com）' }); return; }
    emit('reality:scan:status', { text: `开始扫描 ${targets.length} 个目标（并发 10）…` });
    const results = [];
    let done = 0;
    let active = 0;
    let idx = 0;
    const CONC = 10;
    const scan = (target) => {
      active++;
      const t0 = Date.now();
      const host = target.split(':')[0];
      let settled = false;
      const finish = (r) => {
        if (settled) return; settled = true;
        try { sock.destroy(); } catch (_) {}
        results.push(Object.assign({ target, latency: Date.now() - t0 }, r));
        done++; active--;
        if (done === targets.length) {
          // 按延迟升序排序，可用的排前
          results.sort((a, b) => (b.ok - a.ok) || (a.latency - b.latency));
          emit('reality:scan:result', { ok: true, results });
        } else {
          pump();
        }
      };
      const sock = tls.connect({
        host, port: 443, servername: host, ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: false, timeout: 5000, maxVersion: 'TLSv1.3',
      });
      sock.on('secureConnect', () => {
        const cert = sock.getPeerCertificate(false);
        const proto = sock.getProtocol();
        const alpn = sock.alpnProtocol || '';
        const cipher = (sock.getCipher() || {}).name || '';
        // Reality 兼容：需要 TLS 1.3 + 有证书；密钥交换 X25519 / X25519MLKEM768 都 OK
        const hasCert = cert && (cert.subject || cert.issuer) && Object.keys(cert).length > 1;
        const ok = proto === 'TLSv1.3' && hasCert;
        finish({
          ok,
          tls: proto,
          alpn,
          cipher,
          issuer: (cert && (cert.issuer || {}).O) || '',
          subject: (cert && (cert.subject || {}).CN) || '',
          expiry: (cert && cert.valid_to) || '',
        });
      });
      sock.on('timeout', () => finish({ ok: false, error: '超时' }));
      sock.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    };
    const pump = () => { while (active < CONC && idx < targets.length) scan(targets[idx++]); };
    pump();
  });

  /* ============ 创建节点（只建入站节点，客户端由用户在面板添加） ============ */
  socket.on('node:create', (data) => {
    const emit = (t, o) => socket.emit(t, o);
    const { server, node } = data;
    const protocol = node.protocol === 'vmess-ws-tls' ? 'vmess-ws-tls' : 'vless-reality';
    const port = Number(node.port) || (protocol === 'vless-reality' ? 443 : 8443);
    const remark = String(node.remark || '').replace(/[`'$\\"]/g, '').trim().slice(0, 60);
    const safeRemark = remark || 'my-node';
    const dest = node.dest || 'www.microsoft.com:443';
    // SNI 支持逗号分隔多域名（如 "www.intel.com,intel.com"），拆成 serverNames 数组
    const sniList = String(node.sni || 'www.microsoft.com').split(',').map((s) => s.trim()).filter(Boolean);
    const sni = sniList[0] || 'www.microsoft.com';
    const wsPath = String(node.wsPath || '/vmess').replace(/[`'$\\"]/g, '').trim() || '/vmess';

    emit('node:log', { level: 'info', text: '准备创建「' + (protocol === 'vless-reality' ? 'VLESS + Reality' : 'VMess + WS + TLS') + '」入站节点…' });

    const conn = new Client();
    conn.on('ready', () => {
      emit('node:log', { level: 'success', text: '✓ SSH 连接成功' });
      // Step0：生成 Reality 密钥。优先用服务器 xray 自带 x25519（格式 100% 正确），失败则本地生成并转 URL-safe 无填充
      const step0 = [
        `XRAY=$(ls /usr/local/x-ui/bin/xray-linux-amd64 /usr/local/x-ui/bin/xray /usr/bin/xray /usr/local/bin/xray 2>/dev/null | head -1)`,
        `if [ -n "$XRAY" ]; then OUT=$("$XRAY" x25519 2>/dev/null); echo "K_PRIV=$(echo "$OUT" | grep -i 'private key' | sed 's/.*: //')"; echo "K_PUB=$(echo "$OUT" | grep -i 'public key' | sed 's/.*: //')"; fi`,
        `echo "K_DONE"`,
      ].join('\n');
      execCapture(conn, step0, (err0, raw0) => {
        let priv, pub;
        const toUrlSafe = (b64) => String(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const sPriv = (raw0.match(/K_PRIV=(\S+)/) || [])[1];
        const sPub = (raw0.match(/K_PUB=(\S+)/) || [])[1];
        if (sPriv && sPub && !/^$/.test(sPriv)) {
          priv = sPriv; pub = sPub;
          emit('node:log', { level: 'info', text: '✓ 已用服务器 xray 生成 Reality 密钥' });
        } else {
          const kp = genX25519();
          priv = toUrlSafe(kp.privateKey); pub = toUrlSafe(kp.publicKey);
          emit('node:log', { level: 'info', text: '✓ 已本地生成 Reality 密钥（URL-safe 格式）' });
        }
      // Step1：定位数据库 + (VMess)读取证书路径 + 输出 inbounds 表结构（排除自增主键 id）
      const step1 = [
        `DB=$(find /usr/local/x-ui /etc/x-ui -name 'x-ui.db' 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1); [ -z "$DB" ] && echo "NO_DB"; echo "DB=$DB"`,
        `CERTF=$(sqlite3 "$DB" "select value from settings where key='webCertFile';" 2>/dev/null); KEYF=$(sqlite3 "$DB" "select value from settings where key='webKeyFile';" 2>/dev/null); DOM=$(sqlite3 "$DB" "select value from settings where key='webDomain';" 2>/dev/null); echo "CERTF=$CERTF"; echo "KEYF=$KEYF"; echo "DOM=$DOM"`,
        `echo "===COLS_START==="`,
        `sqlite3 "$DB" "PRAGMA table_info('inbounds');" | awk -F'|' '$2!="id"{print $2"|"$3}'`,
        `echo "===COLS_END==="`,
      ].join('\n');

      execCapture(conn, step1, (err1, raw1) => {
        if (err1) { try { conn.end(); } catch (_) {} emit('node:result', { ok: false, output: '读取面板信息失败：' + err1.message }); return; }
        const g = (k) => { const m = raw1.match(new RegExp(k + '=([^\\n]+)')); return m ? m[1].trim() : ''; };
        const db = g('DB');
        if (!db) { try { conn.end(); } catch (_) {} emit('node:result', { ok: false, output: '未找到面板数据库，请确认 3X-UI 已安装。' }); return; }

        // VMess+WS+TLS 必须有证书
        let certF = '', keyF = '', dom = '';
        if (protocol === 'vmess-ws-tls') {
          certF = g('CERTF'); keyF = g('KEYF'); dom = g('DOM');
          if (!certF || !keyF) {
            try { conn.end(); } catch (_) {}
            emit('node:result', { ok: false, output: '未检测到证书文件。VMess+WS+TLS 需要先开启 HTTPS（之前做过的「一键申请并开启 HTTPS」）。请先去「🌐 域名与 HTTPS」开启，或改用 VLESS + Reality（无需证书）。' });
            return;
          }
        }

        // 在 Node 侧构造 JSON（转义完全可控），再 base64 下发，避免 shell 引号地狱
        // 注意：clients 留空 —— 3.x 面板独立管理客户端，客户端由用户到面板「入站列表」里添加
        let settings, stream;
        if (protocol === 'vless-reality') {
          settings = { clients: [], decryption: 'none', fallbacks: [] };
          stream = { network: 'tcp', security: 'reality', externalProxy: [], realitySettings: { show: false, xver: 0, target: dest, serverNames: sniList, privateKey: priv, minClientVer: '1.0.0', maxClientVer: '', maxTimediff: 0, shortIds: [''], mldsa65Seed: '', settings: { publicKey: pub, fingerprint: 'chrome', serverName: sni, spiderX: '/', mldsa65Verify: '' } }, tcpSettings: {} };
        } else {
          settings = { clients: [], disableInsecureEncryption: false };
          stream = { network: 'ws', security: 'tls', tlsSettings: { certificates: [{ certificateFile: certF, keyFile: keyF }] }, wsSettings: { path: wsPath, headers: {} } };
        }
        const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'], metadataOnly: false, routeOnly: false };
        const allocate = { strategy: 'always', refresh: 5, concurrency: 3 };
        const setJ = JSON.stringify(settings), stJ = JSON.stringify(stream), snJ = JSON.stringify(sniffing), alJ = JSON.stringify(allocate);
        const protoVal = protocol === 'vless-reality' ? 'vless' : 'vmess';

        // 解析 Step1 输出的 inbounds 表结构（排除自增主键 id）
        const colsMatch = raw1.match(/===COLS_START===\n([\s\S]*?)\n?===COLS_END===/);
        const colsRaw = colsMatch ? colsMatch[1] : '';
        const cols = colsRaw.trim().split('\n').map((l) => { const [name, type] = l.split('|'); return { name, type: type || '' }; }).filter((c) => c.name && c.name !== 'id');
        if (!cols.length) { try { conn.end(); } catch (_) {} emit('node:result', { ok: false, output: '无法读取面板 inbounds 表结构（sqlite3 版本过旧或表名不符）。请反馈此问题。' }); return; }

        // 在 Node 侧逐列生成 SQL 值：JSON 内联（不再依赖 readfile）、字符串统一 sqlEsc 转义并加引号
        const sqlVal = (name, type) => {
          switch (name) {
            case 'settings': return "'" + sqlEsc(setJ) + "'";
            case 'stream_settings': return "'" + sqlEsc(stJ) + "'";
            case 'sniffing': return "'" + sqlEsc(snJ) + "'";
            case 'allocate': return "'" + sqlEsc(alJ) + "'";
            case 'remark': case 'tag': return "'" + sqlEsc(safeRemark) + "'";
            case 'protocol': return "'" + sqlEsc(protoVal) + "'";
            case 'listen': return "''";
            case 'client_stats': return "'[]'";
            case 'port': return String(port);
            case 'enable': case 'user_id': return '1';
            case 'up': case 'down': case 'total': return '0';
            case 'traffic_reset': return "'never'";
            case 'sub_sort_index': return '1';
            case 'share_addr_strategy': return "'node'";
            case 'node_id': return 'NULL'; // 本地入站必须为 NULL（0 会被面板当成远程节点 → invalid node id）
            default: return /^(INT|REAL|NUM)/i.test(type || '') ? '0' : "''";
          }
        };
        const insertSql = 'INSERT INTO inbounds (' + cols.map((c) => c.name).join(',') + ') VALUES (' + cols.map((c) => sqlVal(c.name, c.type)).join(',') + ');\nSELECT last_insert_rowid();\n';
        const sqlB = Buffer.from(insertSql, 'utf8').toString('base64');

        // Step2：把完整 INSERT 语句（含取 ID）base64 下发，服务器只负责写入文件并执行，绕开 readfile / shell 引号
        const step2 = [
          `DB=$(find /usr/local/x-ui /etc/x-ui -name 'x-ui.db' 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1); [ -z "$DB" ] && echo "NO_DB"`,
          `sqlite3 "$DB" "DELETE FROM inbounds WHERE port=${port};" 2>/dev/null`,
          `echo '${sqlB}' | base64 -d > /tmp/nb_insert.sql`,
          `NEW_ID=$(sqlite3 "$DB" < /tmp/nb_insert.sql 2>&1 | tr -d '[:space:]')`,
          `case "$NEW_ID" in ''|*[!0-9]*) echo "INSERT_ERR=$NEW_ID" ;; esac`,
          `VERIFY=$(sqlite3 "$DB" "select count(*) from inbounds where id=$NEW_ID;" 2>/dev/null)`,
          `echo "NEW_ID=$NEW_ID"; echo "VERIFY=$VERIFY"`,
          `rm -f /tmp/nb_insert.sql`,
          `systemctl restart x-ui 2>/dev/null || x-ui restart 2>/dev/null; sleep 2; echo "RESTART_DONE"`,
        ].join('\n');

        execCapture(conn, step2, (err2, raw2) => {
          const endConn = () => { try { conn.end(); } catch (_) {} };
          if (err2) { endConn(); emit('node:result', { ok: false, output: '入站创建失败：' + err2.message }); return; }
          if (/NO_DB/.test(raw2)) { endConn(); emit('node:result', { ok: false, output: '数据库丢失，请确认面板运行正常。' }); return; }
          if (/NO_COLS/.test(raw2)) { endConn(); emit('node:result', { ok: false, output: '无法读取面板 inbounds 表结构（sqlite3 版本过旧或表名不符）。请反馈此问题。' }); return; }
          const insErr = (raw2.match(/INSERT_ERR=(.+)/) || [])[1];
          if (insErr) { endConn(); emit('node:result', { ok: false, output: '数据库写入失败（已阻止假成功）：\n' + insErr + '\n\n字段已按你面板实际表结构动态生成，若仍报错请把这段发我。' }); return; }
          const newId = (raw2.match(/NEW_ID=(\d+)/) || [])[1];
          const verify = (raw2.match(/VERIFY=(\d+)/) || [])[1];
          if (verify !== '1') { endConn(); emit('node:result', { ok: false, output: '节点已执行写入但校验未通过（VERIFY=' + (verify || '?') + '），未真正入库。请确认面板数据库文件可写（权限/磁盘）。' }); return; }
          if (!/RESTART_DONE/.test(raw2)) { endConn(); emit('node:result', { ok: false, output: '节点已写入数据库，但面板重启失败，请手动重启 x-ui 后到面板「入站列表」查看：\n' + raw2 }); return; }
          emit('node:log', { level: 'success', text: '✓ 入站节点已写入数据库并重启面板（ID ' + (newId || '?') + '）' });
          endConn();

          // 客户端由用户在面板里添加（3.x 面板独立管理客户端，且添加客户端时会自动把配置应用到 xray，节点随之生效）
          emit('node:result', {
            ok: true,
            remark: safeRemark,
            port,
            protocol: protocol === 'vless-reality' ? 'VLESS + Reality' : 'VMess + WS + TLS',
            message: '入站节点已创建成功。\n\n下一步（必做）：\n1. 打开 3X-UI 面板 → 「入站列表」\n2. 找到「' + safeRemark + '」（端口 ' + port + '）\n3. 点开 → 「添加客户端」→ 保存\n\n添加客户端这一步会让面板把节点配置应用到 xray，节点即刻生效；面板会为你生成可用的客户端链接/二维码。',
          });
        });
      });
    });
  });
    conn.on('error', (e) => { emit('node:result', { ok: false, output: friendlySSHError(e) }); });
    conn.connect(makeConnConfig(server));
  });

  /* ============ 检查面板已有节点（读取 VPS 数据库真实入站列表） ============ */
  socket.on('node:list', (data) => {
    const emit = (t, o) => socket.emit(t, o);
    const { server } = data;
    emit('node:list:status', { text: '正在连接服务器读取入站列表…' });
    const cmd = [
      `DB=$(find /usr/local/x-ui /etc/x-ui -name 'x-ui.db' 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1); [ -z "$DB" ] && { echo "NO_DB"; exit 1; }`,
      `sqlite3 "$DB" "select id||char(31)||coalesce(remark,'')||char(31)||port||char(31)||protocol||char(31)||enable||char(31)||replace(coalesce(settings,''),char(10),' ') from inbounds order by id;"`,
    ].join('\n');
    const conn = new Client();
    conn.on('ready', () => {
      execCapture(conn, cmd, (err, raw) => {
        try { conn.end(); } catch (_) {}
        if (err) { emit('node:list:result', { ok: false, output: friendlySSHError(err) }); return; }
        if (/NO_DB/.test(raw)) { emit('node:list:result', { ok: false, output: '未找到面板数据库，请确认 3X-UI 已安装在本机。' }); return; }
        const rows = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const [id, remark, port, protocol, enable, settingsRaw] = l.split('\x1f');
          // 解析 settings JSON，统计客户端
          let clients = { count: 0, emails: [], ids: [], parseError: false };
          try {
            const s = JSON.parse(settingsRaw || '{}');
            const cl = Array.isArray(s.clients) ? s.clients : [];
            clients = { count: cl.length, emails: cl.map((c) => c.email || '').filter(Boolean), ids: cl.map((c) => c.id || ''), parseError: false };
          } catch (_) { clients = { count: 0, emails: [], ids: [], parseError: true }; }
          return { id, remark, port, protocol, enable, clients };
        });
        emit('node:list:result', { ok: true, rows });
      });
    });
    conn.on('error', (e) => { emit('node:list:result', { ok: false, output: friendlySSHError(e) }); });
    conn.connect(makeConnConfig(server));
  });

  /* ============ 修复 Reality 兼容性：minClientVer 显式设为 1.0.0（放行所有客户端版本） ============ */
  socket.on('node:fixver', (data) => {
    const emit = (t, o) => socket.emit(t, o);
    const { server } = data;
    const sql = `update inbounds set stream_settings = replace(stream_settings, '"minClientVer":""', '"minClientVer":"1.0.0"') where port=443;`;
    const b64 = Buffer.from(sql, 'utf8').toString('base64');
    const cmd = [
      `DB=$(find /usr/local/x-ui /etc/x-ui -name 'x-ui.db' 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1)`,
      `echo '${b64}' | base64 -d > /tmp/fix.sql`,
      `sqlite3 "$DB" < /tmp/fix.sql 2>&1`,
      `rm -f /tmp/fix.sql`,
      `sqlite3 "$DB" "select substr(stream_settings, instr(stream_settings,'minClientVer'), 40) from inbounds where port=443;"`,
      `systemctl restart x-ui 2>/dev/null || x-ui restart 2>/dev/null; sleep 3; echo FIX_DONE`,
    ].join('\n');
    const conn = new Client();
    conn.on('ready', () => {
      execCapture(conn, cmd, (err, raw) => {
        try { conn.end(); } catch (_) {}
        emit('node:fixver:result', { ok: !err, output: raw });
      });
    });
    conn.on('error', (e) => { emit('node:fixver:result', { ok: false, output: friendlySSHError(e) }); });
    conn.connect(makeConnConfig(server));
  });

  /* ============ 重启面板（让面板从数据库重新生成 xray 配置，客户端才会生效） ============ */
  socket.on('node:restart', (data) => {
    const emit = (t, o) => socket.emit(t, o);
    const { server } = data;
    emit('node:restart:status', { text: '正在重启面板与 xray，请稍候…' });
    const conn = new Client();
    conn.on('ready', () => {
      execCapture(conn, `systemctl restart x-ui 2>/dev/null || x-ui restart 2>/dev/null; sleep 4; systemctl is-active x-ui 2>/dev/null || echo "STATUS_UNKNOWN"`, (err, raw) => {
        try { conn.end(); } catch (_) {}
        emit('node:restart:result', { ok: !err, output: (raw || '').trim() });
      });
    });
    conn.on('error', (e) => { emit('node:restart:result', { ok: false, output: friendlySSHError(e) }); });
    conn.connect(makeConnConfig(server));
  });

  /* ============ 开启 xray 访问日志（记录 VLESS 认证拒绝原因，用于定位 EOF） ============
     注意：不能重启面板！面板重启会用数据库重新生成 config.json，覆盖我们 sed 的修改。
     正确做法：改 config.json 后只 kill xray 子进程，面板会自动用新 config 拉起 xray。
     注意2：不能用 pkill -f xray-linux-amd64 —— 命令行含同样字符串，会把自己也杀掉。
     改用 ss 找监听 443 的 PID 再 kill。 */
  socket.on('node:accesslog', (data) => {
    const emit = (t, o) => socket.emit(t, o);
    const { server } = data;
    const cmd = [
      `CFG=/usr/local/x-ui/bin/config.json`,
      `sed -i 's|"access": "none"|"access": "/usr/local/x-ui/bin/access.log"|' "$CFG"`,
      `rm -f /usr/local/x-ui/bin/access.log`,
      `XPID=$(ss -tlnp 2>/dev/null | grep ':443 ' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -1); echo "XRAY_PID=$XPID"; [ -n "$XPID" ] && kill "$XPID" 2>/dev/null`,
      `sleep 4`,
      `echo ACCLOG_DONE`,
      `grep -o '"access": "[^"]*"' "$CFG"`,
      `pgrep -af xray-linux-amd64 | head -2 || echo "XRAY_NOT_UP"`,
      `ls -la /usr/local/x-ui/bin/access.log 2>/dev/null || echo "NO_ACCESS_FILE_YET"`,
    ].join('\n');
    const conn = new Client();
    conn.on('ready', () => {
      execCapture(conn, cmd, (err, raw) => {
        try { conn.end(); } catch (_) {}
        emit('node:accesslog:result', { ok: !err, output: raw });
      });
    });
    conn.on('error', (e) => { emit('node:accesslog:result', { ok: false, output: friendlySSHError(e) }); });
    conn.connect(makeConnConfig(server));
  });

  /* ============ 诊断节点：面板状态 / xray / 端口监听 / 防火墙 / 日志 ============ */
  socket.on('node:diag', (data) => {
    const emit = (t, o) => socket.emit(t, o);
    const { server } = data;
    emit('node:diag:status', { text: '正在连接服务器收集诊断信息…' });
    const cmd = [
      `echo "===== [1] 面板服务状态 ====="`,
      `systemctl is-active x-ui 2>/dev/null; systemctl status x-ui --no-pager -l 2>/dev/null | head -6`,
      `echo ""; echo "===== [2] xray 进程 ====="`,
      `pgrep -af xray | head -3 || echo "未找到 xray 进程"`,
      `echo ""; echo "===== [3] xray 相关监听端口 ====="`,
      `ss -tlnp 2>/dev/null | grep -iE 'xray|:443|:8443|:80' | head -10 || echo "未发现相关监听"`,
      `echo ""; echo "===== [4] 服务器所有监听端口(前25) ====="`,
      `ss -tln 2>/dev/null | awk 'NR==1 || NR<=25'`,
      `echo ""; echo "===== [5] 防火墙 ====="`,
      `command -v ufw >/dev/null && ufw status 2>/dev/null | head -10 || echo "未安装 ufw"`,
      `command -v iptables >/dev/null && iptables -L INPUT -n 2>/dev/null | head -15 || echo "无 iptables 或需 root"`,
      `echo ""; echo "===== [6] xray 最近日志(错误/启动) ====="`,
      `journalctl -u x-ui --no-pager -n 40 2>/dev/null | grep -iE 'error|fail|panic|listen|start' | tail -8 || echo "无相关日志"`,
      `echo ""; echo "===== [7] 数据库与入站(含完整 settings/stream_settings JSON) ====="`,
      `DB=$(find /usr/local/x-ui /etc/x-ui -name 'x-ui.db' 2>/dev/null | while read f; do [ -s "$f" ] && echo "$f"; done | head -1); echo "DB_PATH=$DB"; ls -l "$DB" 2>/dev/null`,
      `echo "--- inbounds 表结构 ---"; sqlite3 "$DB" "PRAGMA table_info('inbounds');"`,
      `echo "--- 完整入站行 ---"; sqlite3 "$DB" "select * from inbounds;"`,
      `echo "--- 各表清单 ---"; sqlite3 "$DB" ".tables"`,
      `echo "--- nodes 表(节点) ---"; sqlite3 "$DB" "select * from nodes;" 2>/dev/null || echo "无 nodes 表"`,
      `echo "--- inbounds 的 node_id 值 ---"; sqlite3 "$DB" "select id||char(31)||port||char(31)||node_id from inbounds;"`,
      `echo "--- settings(客户端) ---"; sqlite3 "$DB" "select settings from inbounds;"`,
      `echo "--- stream_settings(完整) ---"; sqlite3 "$DB" "select stream_settings from inbounds;"`,
      `echo ""; echo "===== [8] xray 实际加载的 config.json(全文) ====="`,
      `CFG=/usr/local/x-ui/bin/config.json; ls -l "$CFG" 2>/dev/null; cat "$CFG"`,
      `echo ""; echo "===== [9] xray 最近30行完整日志(未过滤) ====="`,
      `journalctl -u x-ui --no-pager -n 50 2>/dev/null | tail -30`,
      `echo ""; echo "===== [10] xray access log(认证拒绝记录,最后20行) ====="`,
      `tail -20 /usr/local/x-ui/bin/access.log 2>/dev/null || echo "无 access.log（未开启访问日志）"`,
    ].join('\n');
    const conn = new Client();
    conn.on('ready', () => {
      execCapture(conn, cmd, (err, raw) => {
        try { conn.end(); } catch (_) {}
        emit('node:diag:result', { ok: !err, output: err ? friendlySSHError(err) : raw });
      });
    });
    conn.on('error', (e) => { emit('node:diag:result', { ok: false, output: friendlySSHError(e) }); });
    conn.connect(makeConnConfig(server));
  });

  /** 主安装流程 */
  /* ============ SSH 执行任意命令（诊断/运维用） ============ */
  socket.on('cmd:run', (data, ack) => {
    const { server, command } = data || {};
    if (!server || !command || !String(command).trim()) { ack && ack({ ok: false, output: '请填写服务器信息和要执行的命令' }); return; }
    const cmdText = String(command).trim();
    const conn = new Client();
    conn.on('ready', () => {
      execCapture(conn, cmdText, (err, raw) => {
        try { conn.end(); } catch (_) {}
        ack && ack({ ok: !err, output: err ? (err.message || String(err)) : raw });
      });
    });
    conn.on('error', (e) => {
      ack && ack({ ok: false, output: friendlySSHError(e) });
    });
    conn.connect(makeConnConfig(server));
  });

  socket.on('install:start', (cfg) => {
    const emit = (event, data) => socket.emit(event, data);
    emit('log', { level: 'info', text: '正在连接你的服务器 ' + cfg.host + ':' + (cfg.sshPort || 22) + ' ...' });

    // 域名解析检查：用公共 DNS 绕过本机缓存，识别 Cloudflare 代理，失败/不一致时静默（避免误导）
    if (cfg.domain) {
      const cfPrefixes = ['173.245.48.', '103.21.244.', '103.22.200.', '103.31.4.', '141.101.64.', '108.162.192.', '190.93.240.', '188.114.96.', '197.234.240.', '198.41.128.', '162.158.', '104.16.', '104.24.', '172.64.', '131.0.72.'];
      const isCF = (ip) => cfPrefixes.some((p) => ip.startsWith(p));
      const servers = ['1.1.1.1', '8.8.8.8'];
      Promise.allSettled(servers.map((s) => dns.resolve4(cfg.domain, { server: s })))
        .then((results) => {
          const ips = [...new Set(results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value))];
          if (!ips.length) return; // 本机解析失败 → 静默（用户在 Cloudflare 控制台自查即可）
          const hit = ips.includes(cfg.host);
          const cf = ips.find(isCF);
          if (hit) {
            emit('log', { level: 'success', text: '✓ 域名 DNS 已生效：' + cfg.domain + ' → ' + cfg.host });
          } else if (cf) {
            emit('log', { level: 'success', text: '☁️ 域名通过 Cloudflare 代理（解析到 ' + cf + '），访问时会自动回源到服务器' });
          }
          // 解析到非服务器、非 CF 的 IP → 静默（用户场景多样：可能是 DNS 缓存延迟、部分 A 记录、CDN 厂商等，不强行判断）
        })
        .catch(() => { /* 静默 */ });
    }

    const conn = new Client();
    activeConn.set(socket.id, conn);

    conn.on('ready', () => {
      emit('log', { level: 'success', text: '✓ SSH 连接成功' });
      emit('stage', { stage: 1, text: 'SSH 连接成功，开始检查系统环境' });
      runCommand(conn, 'uname -m && cat /etc/os-release | head -2 && free -m | head -2 && command -v curl >/dev/null && echo CURL_OK || (apt-get update -qq && apt-get install -y -qq curl)', {
        onOutput: (line) => emit('term', line),
        onExit: (code) => {
          if (code !== 0) {
            emit('install:failed', { error: '环境检查失败（退出码 ' + code + '），请确认服务器系统为受支持的 Linux 发行版且可访问 GitHub。' });
            return;
          }
          emit('stage', { stage: 2, text: '环境检查通过，开始下载并安装 3X-UI（约 1-3 分钟，请勿关闭页面）' });
          startInstall(conn, cfg, emit);
        },
      });
    });

    conn.on('error', (e) => {
      emit('install:failed', { error: friendlySSHError(e) });
    });

    conn.on('close', () => {
      activeConn.delete(socket.id);
    });

    conn.connect(makeConnConfig(cfg));
  });

  /** 用户主动中断 */
  socket.on('install:abort', () => {
    const conn = activeConn.get(socket.id);
    if (conn) {
      try { conn.end(); } catch (_) {}
      activeConn.delete(socket.id);
      emitAbort(socket);
    }
  });

  function emitAbort(sock) {
    sock.emit('install:failed', { error: '已手动中止安装。' });
  }

  function startInstall(conn, cfg, emit) {
    const installCmd = buildInstallCommand(cfg);
    emit('cmd', { text: installCmd });
    runCommand(conn, installCmd, {
      longRunning: true,
      onOutput: (line) => emit('term', line),
      onExit: (code, raw) => {
        if (code !== 0) {
          const rcMatch = raw.match(/===XUI_INSTALL_RC_BEGIN===(-?\d+)===XUI_INSTALL_RC_END===/);
          const installRc = rcMatch ? rcMatch[1] : String(code);
          emit('install:failed', { error: '3X-UI 安装失败（官方安装脚本退出码 ' + installRc + '）。请查看上方终端日志最后几十行定位失败步骤。常见原因：① 服务器无法访问 GitHub（被墙/无外网/防火墙）② 系统不受支持（Ubuntu 20.04+/Debian 11+/CentOS 8+）③ 磁盘满 / 内存不足 ④ 填了域名但 80 端口不通或 DNS 未解析到本机，导致 acme 证书申请失败。' });
          return;
        }
        // 账号写入必须验证通过才展示（bcrypt 密码长度 60；不通过说明写错库/写失败，绝不回退显示）
        const accMatch = raw.match(/===XUI_ACCOUNT_BEGIN===([\s\S]*?)===XUI_ACCOUNT_END===/);
        const accSec = accMatch ? accMatch[1] : '';
        const accUser = ((accSec.match(/ACC_USER=(.*)/) || [])[1] || '').trim();
        const accLen = parseInt(((accSec.match(/ACC_LEN=(\d+)/) || [])[1] || '0'), 10);
        const svcMatch = raw.match(/===XUI_SVC_BEGIN===([\s\S]*?)===XUI_SVC_END===/);
        const svcActive = svcMatch ? svcMatch[1].trim() : '';
        if (!accUser || accLen < 50) {
          // 兜底：sqlite3 读不到账号，但面板服务确实在跑 → 视为安装成功（全新 NONINTERACTIVE 安装时管理员账号就是我们传入的 cfg.panelUser）
          if (svcActive === 'active' || svcActive === 'activating') {
            emit('log', { level: 'warn', text: '⚠️ 数据库账号校验未读到（sqlite3 不可用或读取异常），但面板服务正在运行，按你填写的账号放行登录。' });
          } else {
            emit('install:failed', { error: '面板已安装，但管理员账号写入失败（用户名="' + (accUser || '空') + '"，密码长度=' + accLen + '，预期 60）。请勿使用任何提示登录。可用「🩹 面板急救箱」修复账号，或重新安装。' });
            try { conn.end(); } catch (_) {}
            activeConn.delete(socket.id);
            return;
          }
        }
        emit('stage', { stage: 3, text: '安装完成，正在读取最终配置' });
        const settings = parseSettings(raw);
        // 优先用 ss 查到的 xray 真实监听端口（最可靠），回退到 setting -show 配置端口，最后 cfg.panelPort
        const realPort = settings.dbPort || (settings.listenPorts && settings.listenPorts[0]) || settings.port || cfg.panelPort;
        const port = realPort;
        // basePath 优先级：DB 直接读（最可靠）> setting -show 文本解析 > 工具已知的传入路径 > 本地 HTTP 探测实测 > 兜底 '/'
        // DB 读出的是结构化数据，不受 pty 颜色码/格式变化影响，是根治"路径不一致"的关键
        let basePath = settings.dbWebBasePath || settings.webBasePath || cfg.effectiveBasePath || '/';
        const probeHit = pickProbePath(settings.probe, basePath);
        if (probeHit) basePath = probeHit;
        // 绑定了域名则优先用域名生成访问地址；填了域名时官方脚本会签发证书，地址用 https
        const urlHost = cfg.domain || cfg.host;
        const urlScheme = cfg.domain ? 'https' : 'http';
        const url = urlScheme + '://' + urlHost + ':' + port + basePath;
        // 配置端口和实际端口不一致时给明确提示
        const portWarn = (cfg.panelPort && String(cfg.panelPort) !== String(port))
          ? '⚠️ 你设置的端口 <b>' + cfg.panelPort + '</b> 与面板实际监听端口 <b>' + port + '</b> 不一致（setting -port 可能未生效）。请使用 <b>' + port + '</b> 访问。'
          : '';
        // 首页实测探测：若探测了但没有任何路径返回 2xx/3xx，提示用户手动确认（避免"成功但打不开"）
        let probeWarn = '';
        if (settings.probe && settings.probe.length && !probeHit) {
          probeWarn = '⚠️ 安装脚本已成功，但本地实测首页未返回可打开状态码（探测日志见终端）。请确认访问链接<b>必须带路径 ' + basePath + '</b>（例如 ' + url + '）。若仍打不开，登录 VPS 执行 <code>x-ui setting -show</code> 核对 WebBasePath。';
        }
        emit('stage', { stage: 4, text: '全部完成 🎉' });
        emit('install:done', {
          url,
          username: accUser || cfg.panelUser,  // DB 校验通过的真实用户名；兜底时回退到本次安装传入的账号
          password: cfg.panelPass,    // bcrypt 单向，原文只有配置值；仅在验证通过时展示
          port,
          basePath,
          host: cfg.host,
          domain: cfg.domain || '',
          ipUrl: 'http://' + cfg.host + ':' + port + basePath,
          portWarn,
          probeWarn,
        });
        try { conn.end(); } catch (_) {}
        activeConn.delete(socket.id);
      },
    });
  }

  function applySettings(conn, cfg, emit) {
    runCommand(conn, buildPostInstallCommand(cfg), {
      onOutput: (line) => emit('term', line),
      onExit: (code, raw) => {
        if (code !== 0) {
          emit('install:failed', { error: '设置应用失败（退出码 ' + code + '）。面板可能已安装，请登录 VPS 手动执行 x-ui 命令查看。' });
          return;
        }
        const settings = parseSettings(raw);
        const port = settings.dbPort || settings.port || cfg.panelPort;
        // basePath 优先级：DB 直接读（最可靠）> setting -show 文本解析 > 工具已知的传入路径 > 本地 HTTP 探测实测 > 兜底 '/'
        // DB 读出的是结构化数据，不受 pty 颜色码/格式变化影响，是根治"路径不一致"的关键
        let basePath = settings.dbWebBasePath || settings.webBasePath || cfg.effectiveBasePath || '/';
        const probeHit = pickProbePath(settings.probe, basePath);
        if (probeHit) basePath = probeHit;
        // 绑定了域名则优先用域名生成访问地址；填了域名时官方脚本会签发证书，地址用 https
        const urlHost = cfg.domain || cfg.host;
        const urlScheme = cfg.domain ? 'https' : 'http';
        const url = urlScheme + '://' + urlHost + ':' + port + basePath;
        emit('stage', { stage: 4, text: '全部完成 🎉' });
        emit('install:done', {
          url,
          username: settings.username || cfg.panelUser,
          password: settings.password || cfg.panelPass,
          port,
          basePath,
          host: cfg.host,
          domain: cfg.domain || '',
          ipUrl: 'http://' + cfg.host + ':' + port + basePath,
        });
        try { conn.end(); } catch (_) {}
        activeConn.delete(socket.id);
      },
    });
  }
});

/**
 * 构造认证处理器
 *
 * 背景：不少服务器（PAM / KbdInteractiveAuthentication 开启、PasswordAuthentication 关闭）
 * 只把密码认证作为 keyboard-interactive 提供，PuTTY、Xshell 这类客户端能正常登录，
 * 而 ssh2 默认不尝试 keyboard-interactive，于是密码明明正确却报「认证失败」。
 * 这里先探测服务器支持的认证方式，再按配置的凭据依次尝试 password / keyboard-interactive，
 * 同时把服务器允许的方式记录下来，供错误提示使用。
 */
function buildAuthHandler(cfg) {
  const password = cfg.privateKey ? '' : String(cfg.password == null ? '' : cfg.password);
  const detail = { offered: null, partial: false, tried: [], kiPrompts: 0 };
  let stage = 'probe';

  const handler = (authsLeft, partialSuccess, cb) => {
    if (Array.isArray(authsLeft) && authsLeft.length) detail.offered = authsLeft.slice();
    if (partialSuccess) detail.partial = true;

    const offers = (m) => !detail.offered || detail.offered.indexOf(m) !== -1;
    const triedIt = (m) => detail.tried.indexOf(m) !== -1;

    // 第一步用 none 探测服务器允许的认证方式（RFC 4252 规定必答，不计入失败次数）
    if (stage === 'probe') {
      stage = 'auth';
      return 'none';
    }

    if (cfg.privateKey && !triedIt('publickey') && offers('publickey')) {
      detail.tried.push('publickey');
      return 'publickey';
    }

    if (password) {
      if (!triedIt('password') && offers('password')) {
        detail.tried.push('password');
        return 'password';
      }
      if (!triedIt('keyboard-interactive') && offers('keyboard-interactive')) {
        detail.tried.push('keyboard-interactive');
        return {
          type: 'keyboard-interactive',
          username: cfg.sshUser || 'root',
          prompt: (name, instructions, lang, prompts, finish) => {
            const list = Array.isArray(prompts) ? prompts : [];
            detail.kiPrompts = list.length;
            // 第一项按密码作答；动态验证码之类的额外提示没有对应输入，留空
            finish(list.map((p, i) => (i === 0 ? password : '')));
          },
        };
      }
    }

    return false;
  };

  return { handler, detail };
}

/**
 * 凭据自检
 * 拦截「输入层面的问题」，避免被笼统报成认证失败：
 *   ok=false → 根本没法发起连接，直接返回 msg
 *   hint   → 仍然尝试连接，但若认证失败，在提示里带上这条线索
 */
function inspectCreds(cfg) {
  const user = String(cfg.sshUser == null ? '' : cfg.sshUser);
  if (!user.trim()) return { ok: false, msg: '请先填写 SSH 用户名（绝大多数服务器是 root）。' };

  if (cfg.privateKey) {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(cfg.privateKey))) {
      return { ok: false, msg: '私钥内容不完整：需要包含 BEGIN / END 行的 OpenSSH 或 RSA 私钥；PuTTY 的 .ppk 文件要先转换格式。' };
    }
    return /[\uFF01-\uFF5E\u3000]/.test(user)
      ? { ok: true, hint: '用户名里有全角字符（中文输入法打的字符）' }
      : { ok: true };
  }

  const pwd = String(cfg.password == null ? '' : cfg.password);
  if (!pwd) return { ok: false, msg: '没有收到 SSH 密码：请确认「登录方式」是密码登录，并且已经填写密码。' };
  if (!pwd.trim()) return { ok: false, msg: 'SSH 密码里只有空格/换行：请重新输入正确的密码。' };

  const hints = [];
  if (pwd !== pwd.trim()) hints.push('密码首尾有多余的空格或换行');
  if (/[\uFF01-\uFF5E\u3000]/.test(pwd)) hints.push('密码里含全角字符（中文输入法打的字符）');
  if (/[\uFF01-\uFF5E\u3000]/.test(user)) hints.push('用户名里含全角字符');
  return hints.length ? { ok: true, hint: hints.join('，') } : { ok: true };
}

/** 构造 ssh2 连接配置 */
function makeConnConfig(cfg) {
  const auth = buildAuthHandler(cfg);
  const c = {
    host: cfg.host,
    port: Number(cfg.sshPort) || 22,
    username: cfg.sshUser || 'root',
    readyTimeout: 20000,
    keepaliveInterval: 10000,
    tryKeyboard: true,
    authHandler: auth.handler,
    __authDetail: auth.detail,
  };
  if (cfg.privateKey) {
    c.privateKey = cfg.privateKey;
    if (cfg.passphrase) c.passphrase = cfg.passphrase;
  } else {
    c.password = cfg.password;
  }
  return c;
}

/**
 * 在 SSH 连接上执行命令
 * onOutput: 按行回调（终端展示）  onExit: 命令结束回调（附完整原始输出）
 */
function runCommand(conn, command, opts) {
  const raw = [];
  let buffer = '';
  const maxWait = opts.longRunning ? 15 * 60 * 1000 : 5 * 60 * 1000;
  let finished = false;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    opts.onExit && opts.onExit(code, raw.join('\n'));
  };

  // 长时间无输出的保护计时器（安装脚本可能中途卡死）
  let lastData = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - lastData > maxWait) {
      try { stream.close(); } catch (_) {}
      finish(-1);
    }
  }, 30000);

  conn.exec(command, { pty: { mode: 'echo' } , env: { TERM: 'xterm' } }, (err, stream) => {
    if (err) { clearInterval(timer); finish(-1); return; }
    stream.on('close', (code) => { clearInterval(timer); finish(code); })
      .on('data', (data) => {
        lastData = Date.now();
        const text = data.toString('utf8');
        raw.push(text);
        // 按行切分，最后一段留缓冲
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const l of lines) opts.onOutput && opts.onOutput(l + '\n');
      })
      .stderr.on('data', (data) => {
        lastData = Date.now();
        const text = data.toString('utf8');
        raw.push(text);
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const l of lines) opts.onOutput && opts.onOutput(l + '\n');
      });
    // 喂给安装脚本的预设答案
    if (opts.feedStdin) {
      stream.write(opts.feedStdin);
    }
  });
}

/** 在 SSH 连接上执行一条命令并收集完整输出（无 pty，输出干净，适合解析） */
function execCapture(conn, command, cb) {
  let raw = '';
  conn.exec(command, (err, stream) => {
    if (err) { cb(err, ''); return; }
    stream.on('data', (d) => { raw += d.toString('utf8'); });
    stream.stderr.on('data', (d) => { raw += d.toString('utf8'); });
    stream.on('close', () => cb(null, raw.replace(/\r/g, '')));
  });
}

/**
 * 把 ssh2 的原始错误翻译成用户能看懂的提示
 * detail: buildAuthHandler 记录的实际认证过程（服务器允许的方式、是否多因素等），
 *         有它才能区分「密码真的错」和「服务器根本不接受密码认证」
 */
function friendlySSHError(e, detail) {
  const msg = (e && e.message) || String(e);
  const level = (e && e.level) || '';
  const d = detail || {};
  const offered = Array.isArray(d.offered) && d.offered.length ? d.offered : null;
  const tried = Array.isArray(d.tried) ? d.tried : [];

  const isAuthFailure = level === 'client-authentication'
    || /All configured authentication methods failed|Permission denied|Authentication failed|Too many authentication failures/i.test(msg);

  if (isAuthFailure) {
    if (/Too many authentication failures/i.test(msg)) {
      return '认证尝试次数过多：服务器限制了认证失败次数（防爆破 / MaxAuthTries）。请等待几分钟后重试，或改用密钥登录。';
    }
    if (d.partial) {
      return '服务器要求多因素认证：除密码之外还需要其它验证方式，本工具暂不支持。请改用密钥登录，或在服务器上调整认证策略。';
    }
    if (offered && offered.indexOf('publickey') === -1 && tried.indexOf('publickey') !== -1) {
      return '服务器不接受密钥登录（只允许：' + offered.join(' / ') + '）。请把认证方式切换为「密码」后重试。';
    }
    if (offered && offered.indexOf('password') === -1 && offered.indexOf('keyboard-interactive') === -1) {
      return '服务器不接受密码登录（只允许：' + offered.join(' / ') + '）。请把认证方式切换为「私钥」并填写对应私钥。';
    }
    if (tried.indexOf('keyboard-interactive') !== -1 && d.kiPrompts > 1) {
      return '服务器在密码之外还要求额外验证（如动态验证码），本工具暂不支持。请改用密钥登录。';
    }
    let text = 'SSH 认证失败：请检查用户名/密码（或密钥）是否正确。部分云服务商需先在控制台开启 root 密码登录。';
    if (offered) text += '（服务器允许的认证方式：' + offered.join(' / ') + '）';
    if (d.inputHint) {
      text += '（检测到' + d.inputHint + '，请核对后重试）';
    } else if (offered
      && offered.indexOf('password') !== -1
      && offered.indexOf('publickey') !== -1
      && tried.indexOf('password') !== -1) {
      text += '。密码已提交但被服务器拒绝：若确认密码无误，通常是该账号的密码登录被系统策略挡住（如 Ubuntu / Debian 默认锁定 root 密码），或服务器要求「密钥 + 密码」双因素认证。';
    }
    return text;
  }

  if (/Cannot parse privateKey|Unsupported key format|bad passphrase|integrity check failed/i.test(msg)) {
    return '私钥无法读取：请确认粘贴的是完整私钥（含 BEGIN / END 行），若私钥有口令也要一并填写。';
  }
  if (/no matching (key exchange|host key algorithm|cipher|mac)|Key exchange failed|Unable to negotiate/i.test(msg)) {
    return '算法协商失败：服务器的 SSH 服务过旧或禁用了通用算法，无法握手。可先在服务器上升级 OpenSSH 再试。';
  }
  if (/ECONNRESET|EPIPE|Connection lost before handshake/i.test(msg)) {
    return '连接被中断：服务器在握手阶段主动断开了连接，常见于并发连接限制、防爆破策略或网络抖动。请稍等几秒后重试。';
  }
  if (/timed out|ETIMEDOUT/i.test(msg)) return '连接超时：请检查 IP 是否正确、服务器的 22 端口（SSH）是否对公网开放。';
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝：目标端口未开放 SSH 服务，若你改过 SSH 端口请在「SSH 端口」中填写正确端口。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '无法解析主机：请确认填写的是正确的服务器 IP 地址。';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return '网络不可达：请检查本机网络、服务器的防火墙或云安全组设置。';
  return 'SSH 连接错误：' + msg;
}

// 兜底：任何未捕获异常都只记录，不让本地服务进程整体退出（否则界面会一直转圈直到超时）
process.on('uncaughtException', (e) => {
  console.error('[guard] 未捕获异常：', (e && e.stack) || e);
});
process.on('unhandledRejection', (r) => {
  console.error('[guard] 未处理的 Promise 拒绝：', (r && r.stack) || r);
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('[启动失败] 端口 ' + PORT + ' 已被占用，请关闭占用该端口的程序后重新启动。');
  } else {
    console.error('[启动失败] ' + ((e && e.message) || e));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │   3X-UI 小白一键安装器  v1.0   by 村长实验室   │');
  console.log('  ├─────────────────────────────────────────────┤');
  console.log('  │   浏览器打开 →  http://127.0.0.1:' + PORT + '        │');
  console.log('  │   关闭此窗口即退出程序                         │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
});
