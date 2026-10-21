/* ============================================================================
   连小理 · 班费透明工作流 —— 本地小后端（零依赖，单文件）
   ----------------------------------------------------------------------------
   为什么需要它：
     1) 大模型的 API Key 绝不能放进网页（浏览器里谁都能看到）→ 由它代理 /api/chat
     2) 前台和后台需要共用同一份账目 → 由它统一读写 server/data/store.json
     3) 想让"换一台设备也能看到同一条" → 监听 0.0.0.0，同一局域网内直接用内网 IP 访问
        （这与项目红线一致：数据不出本地网络，不发布到公网）

   启动：
     node server/server.js
     然后浏览器打开 http://localhost:3300          前台（全班只读）
                  http://localhost:3300/admin      后台（生活委员）

   配置：复制 server/.env.example 为 server/.env，填 LLM_API_KEY 即可开启在线问答。
        没有填也不会崩——前后台会自动降级为「本地离线规则引擎」。
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ==========================================================================
   1. 配置
   ========================================================================== */

const ROOT      = path.resolve(__dirname, '..');
const FRONT_DIR = path.join(ROOT, '网页');
const ADMIN_DIR = path.join(ROOT, '后台');
const DATA_DIR  = path.join(__dirname, 'data');
const STORE     = path.join(DATA_DIR, 'store.json');
const FRONT_DATA = path.join(FRONT_DIR, 'data.js');

/** 极简 .env 解析：KEY=VALUE，支持 # 注释与引号 */
function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const i = s.indexOf('=');
    if (i < 1) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  });
}
loadEnv();

const CFG = {
  port:       Number(process.env.PORT || 3300),
  host:       process.env.HOST || '0.0.0.0',
  // 安全：不内置任何默认口令（默认口令等于没设）。未配置时启动即生成随机口令并打印。
  adminToken: process.env.ADMIN_TOKEN || '',
  llmBase:    (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  llmKey:     process.env.LLM_API_KEY || '',
  llmModel:   process.env.LLM_MODEL || 'deepseek-chat',
  llmTimeout: Number(process.env.LLM_TIMEOUT_MS || 45000)
};

/* 安全兜底：不配置 ADMIN_TOKEN 时，不再回落到任何公开默认口令（默认口令等于没设），
   改为本次启动生成一个随机口令，并在控制台打印 —— 想固定下来就写进 server/.env 的 ADMIN_TOKEN。 */
if (!CFG.adminToken) {
  CFG.adminToken = 'banfei-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
  CFG.adminTokenGenerated = true;
}

const LLM_READY = Boolean(CFG.llmBase && CFG.llmKey);

/* ==========================================================================
   2. 小工具
   ========================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt':  'text/plain; charset=utf-8'
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > (limit || 2 * 1024 * 1024)) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore() {
  try {
    if (!fs.existsSync(STORE)) return null;
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return (j && j.data) ? j : null;
  } catch (e) {
    console.error('[store] 读取失败：', e.message);
    return null;
  }
}

/** 把 store 里的账目写成前台可直接双击打开的 data.js */
function writeFrontData(data) {
  const header =
'/* ============================================================================\n' +
'   连小理 · 班费透明工作流 —— 数据文件\n' +
'   ----------------------------------------------------------------------------\n' +
'   ⚠️ 本文件由「生活委员后台」自动生成，请勿手改。\n' +
'   要改账目请打开后台：  http://localhost:' + CFG.port + '/admin\n' +
'   要手改请改 server/data/store.json，然后点后台的「发布到前台」。\n' +
'   生成时间：' + new Date().toLocaleString('zh-CN') + '\n' +
'   ========================================================================== */\n\n';
  fs.writeFileSync(FRONT_DATA, header + 'window.__LEDGER__ = ' + JSON.stringify(data, null, 2) + ';\n', 'utf8');
}

/* ==========================================================================
   3. 静态文件
   ========================================================================== */

function serveStatic(req, res, pathname) {
  /* /admin 必须带尾斜杠：否则页面里的相对路径 admin.css / admin.js
     会被解析成 /admin.css（根目录），一律 404，页面会变成"裸 HTML" */
  if (pathname === '/admin') {
    res.writeHead(302, { Location: '/admin/' });
    return res.end();
  }

  let root, rel;

  if (pathname === '/' || pathname === '') {
    root = FRONT_DIR; rel = 'index.html';
  } else if (pathname === '/admin/') {
    root = ADMIN_DIR; rel = 'admin.html';
  } else if (pathname.startsWith('/admin/')) {
    root = ADMIN_DIR; rel = pathname.slice('/admin/'.length);
  } else {
    root = FRONT_DIR; rel = pathname.replace(/^\/+/, '');
  }

  const file = path.resolve(root, decodeURIComponent(rel));

  // 目录穿越防护
  if (file !== root && !file.startsWith(root + path.sep)) {
    return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found: ' + rel, 'text/plain; charset=utf-8');
  }

  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
}

/* ==========================================================================
   4. 大模型代理
   ========================================================================== */

/** 三个任务共用一套「不许编造」的底线，但输出形态不同 */
const COMMON_RULES = [
  '共同底线（必须逐条遵守，任何情况下不得突破）：',
  '1. 只依据用户消息里 <账目数据> 标签内的内容作答。数据里没有的，直接说明"这份账目里没有这项数据"，绝不推测、绝不编造数字。',
  '2. 涉及金额时给出准确数字与币种符号 ¥，保留两位小数。',
  '3. 不生成任何"发群里催缴"的文案；不对未缴同学作评价、排序或施压。这是硬性边界。',
  '4. 只处理"班费收缴"（谁缴了多少班费）；个人在活动里花了多少钱属于个人行为，不回答、不推测、不公示。',
  '5. 本工具不经手资金：不提供支付、收款、转账、代收代付的任何操作建议。',
  '6. 不出现学号、手机号、订单号、住址等个人信息。'
].join('\n');

const TASK_PROMPTS = {
  /* 前台/后台：自然语言问账 */
  qa: [
    '你是「连小理 · 班费透明工作流」里的账目问答助手，服务对象是大连理工大学一个班级的学生。',
    '',
    COMMON_RULES,
    '',
    '回答形态：',
    '7. 语气克制、平实、口语化，像班里的生活委员说话，不夸张、不吹捧、不堆排比。',
    '8. 答案控制在 120 字以内；能一句话说清就别写三句。需要罗列时最多 5 条。',
    '9. 不要复述规则、不要说"根据提供的数据"，直接给答案。'
  ].join('\n'),

  /* 后台：生成对外说明 / 公示文案 */
  compose: [
    '你是班级账务公示文本的撰写助手，服务于大连理工大学一个班级的生活委员。',
    '',
    COMMON_RULES,
    '',
    '撰写要求：',
    '7. 输出一段可直接贴到班群的公示说明，80 字以内，一段话，不要标题、不要 markdown、不要表情符号。',
    '8. 只陈述客观事实：时间范围、总余额、主要支出类别、收缴进度。不做价值评价，不用"透明高效"这类自夸词。',
    '9. 不要呼吁缴费，不要提任何具体同学的名字。'
  ].join('\n'),

  /* 后台：账目体检（只找疑点，不改数据） */
  audit: [
    '你是账目核对助手。你的唯一职责是找出这份班费账目里的疑点，供生活委员人工判断。',
    '',
    COMMON_RULES,
    '',
    '输出形态：',
    '7. 以列表输出，每条一行，最多 6 条。格式：`[严重程度] 问题描述 → 建议核对的动作`。严重程度只用「高」「中」「低」三个词。',
    '8. 只指出疑点，绝不自行修改、绝不给出"应该改成多少"的具体数值。',
    '9. 如果确实没有发现疑点，就回一句"未发现明显疑点"，不要凑数。'
  ].join('\n')
};

function buildUserMessage(task, question, context) {
  const head = (task === 'qa')
    ? '学生的问题：'
    : (task === 'compose' ? '请写出公示说明，面向全班同学：' : '请对这份账目做一次体检：');
  return [
    '<账目数据>',
    JSON.stringify(context, null, 1),
    '</账目数据>',
    '',
    head + question
  ].join('\n');
}

async function callLLM(task, question, history, context) {
  const messages = [{ role: 'system', content: TASK_PROMPTS[task] || TASK_PROMPTS.qa }];

  if (Array.isArray(history)) {
    history.slice(-6).forEach(function (h) {
      if (h && h.role && h.content && h.role !== 'system') {
        messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 2000) });
      }
    });
  }
  messages.push({ role: 'user', content: buildUserMessage(task, question, context) });

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, CFG.llmTimeout);

  try {
    const r = await fetch(CFG.llmBase + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CFG.llmKey
      },
      body: JSON.stringify({
        model: CFG.llmModel,
        messages: messages,
        temperature: 0.2,
        max_tokens: 600,
        stream: false
      }),
      signal: ctrl.signal
    });

    if (!r.ok) {
      const t = await r.text().catch(function () { return ''; });
      throw new Error('模型返回 HTTP ' + r.status + ' ' + t.slice(0, 200));
    }
    const j = await r.json();
    const reply = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!reply) throw new Error('模型返回内容为空');
    return String(reply).trim();
  } finally {
    clearTimeout(timer);
  }
}

/* ==========================================================================
   5. 路由
   ========================================================================== */

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  try {
    /* ---- 健康检查：前台据此决定走在线还是离线 ---- */
    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        llm: LLM_READY,
        model: LLM_READY ? CFG.llmModel : '',
        store: fs.existsSync(STORE)
      });
    }

    /* ---- 读账目 ---- */
    if (p === '/api/store' && req.method === 'GET') {
      const s = readStore();
      if (!s) return sendJson(res, 404, { ok: false, error: '后台还没有发布过数据' });
      return sendJson(res, 200, { ok: true, updatedAt: s.updatedAt || '', data: s.data });
    }

    /* ---- 写账目（需口令）---- */
    if (p === '/api/store' && req.method === 'POST') {
      const raw = await readBody(req, 8 * 1024 * 1024);
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

      if (!CFG.adminToken || !body || body.token !== CFG.adminToken) {
        return sendJson(res, 401, { ok: false, error: '口令不正确' });
      }
      if (!body.data || typeof body.data !== 'object' || !Array.isArray(body.data.ledger)) {
        return sendJson(res, 400, { ok: false, error: '数据结构不符合契约：缺少 ledger 数组' });
      }

      ensureDataDir();
      const prev = readStore();
      const snapshot = {
        updatedAt: new Date().toISOString(),
        version: (prev && prev.version ? prev.version : 0) + 1,
        data: body.data
      };
      fs.writeFileSync(STORE, JSON.stringify(snapshot, null, 2), 'utf8');
      writeFrontData(body.data);

      console.log('[store] 已发布 v' + snapshot.version + '（' + body.data.ledger.length + ' 条账目）');
      return sendJson(res, 200, { ok: true, version: snapshot.version, updatedAt: snapshot.updatedAt });
    }

    /* ---- 模型对话 ---- */
    if (p === '/api/chat' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

      if (!LLM_READY) {
        return sendJson(res, 503, { ok: false, error: '服务端没有配置模型（LLM_API_KEY / LLM_BASE_URL 未设置），请使用离线模式' });
      }
      const q = String((body && body.question) || '').slice(0, 500).trim();
      if (!q) return sendJson(res, 400, { ok: false, error: '问题为空' });

      const task = ['qa', 'compose', 'audit'].indexOf(body && body.task) !== -1 ? body.task : 'qa';
      const reply = await callLLM(task, q, body.history, body.context || {});
      return sendJson(res, 200, { ok: true, reply: reply, model: CFG.llmModel, task: task });
    }

    /* ---- 静态资源 ---- */
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, p);
    }

    return sendJson(res, 405, { ok: false, error: '不支持的请求方法' });

  } catch (err) {
    console.error('[error]', err && err.message ? err.message : err);
    return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

server.listen(CFG.port, CFG.host, function () {
  const nets = require('os').networkInterfaces();
  const lan = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    });
  });

  console.log('');
  console.log('  连小理 · 班费透明工作流 —— 本地服务已启动');
  console.log('  ────────────────────────────────────────────');
  console.log('  前台（全班只读）   http://localhost:' + CFG.port + '/');
  console.log('  后台（生活委员）   http://localhost:' + CFG.port + '/admin');
  if (lan.length) {
    console.log('');
    console.log('  同一 WiFi 下，用手机打开这个地址也能看到同一条账目：');
    lan.forEach(function (ip) { console.log('    http://' + ip + ':' + CFG.port + '/'); });
  }
  console.log('');
  console.log('  问答模式：' + (LLM_READY
    ? '在线（模型 ' + CFG.llmModel + '）'
    : '离线（未配置 LLM_API_KEY，将使用本地规则引擎）'));
  console.log('  管理口令：' + CFG.adminToken
    + (CFG.adminTokenGenerated
        ? '  （本次启动随机生成 —— 要固定下来请写进 server/.env 的 ADMIN_TOKEN）'
        : '  （来自 server/.env 的 ADMIN_TOKEN）'));
  console.log('');
});
