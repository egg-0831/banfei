/* ============================================================================
   连小理 · 班费透明工作流 —— 后台逻辑（生活委员）
   ----------------------------------------------------------------------------
   三条设计原则，写在这里免得后来改乱：
     1) 台账「只增不改」：记错用「更正」新增一条 adjust，原记录永远保留。
        所以这个后台【故意没有删除按钮】。
     2) 所有汇总由明细重算：summary 只给工作流对照用，不作为数据源。
     3) 发布前必须过「校验」：账目错一笔就是信任问题，这一步不能跳。
   ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
     0. 工具
     ========================================================================== */

  var fileMode = location.protocol === 'file:';
  /* 注意：后台页面挂在 /admin/ 下，API 必须用【绝对路径】——
     写成相对路径 'api/health' 会被解析成 /admin/api/health，直接 404。 */
  var API = fileMode ? {
    health: 'http://localhost:3300/api/health',
    store:  'http://localhost:3300/api/store',
    chat:   'http://localhost:3300/api/chat'
  } : {
    health: '/api/health',
    store:  '/api/store',
    chat:   '/api/chat'
  };

  /* 前台 data.js 的位置：服务模式下在站点根目录，file:// 下在隔壁「网页」目录 */
  var FRONT_DATA_URL = fileMode ? '../网页/data.js' : '/data.js';

  var TYPE_TEXT   = { in: '收入', out: '支出', adjust: '更正' };
  var STATUS_TEXT = { paid: '已缴清', partial: '部分缴纳', unpaid: '未缴' };
  var KNOWN_CATS  = ['团建活动费', '学习资料费', '班级公共支出', '其他'];
  var LS_TOKEN = 'lxs.admin.token';
  var LS_DRAFT = 'lxs.admin.draft';

  function $(id) { return document.getElementById(id); }
  /* 写回输入框的值：若用户此刻正敲这个框就跳过。
     否则每次按键后的重渲染都会把 value 重置 —— 光标被顶到末尾，且 "0" 会被 `0 || ''` 冲成空值。 */
  function setVal(id, v) {
    var el = $(id);
    if (el && el !== document.activeElement) el.value = v;
  }
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function fmt(n) {
    var neg = n < 0, s = Math.abs(n).toFixed(2), p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + p.join('.');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, s = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(s, a); }, ms);
    };
  }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, ms || 2600);
  }

  /* ==========================================================================
     1. 状态
     ========================================================================== */

  var state = {
    token: '',
    data: null,
    dirty: false,
    serverOk: false,
    llmOk: false,
    llmModel: '',
    parsed: null
  };

  function emptyData() {
    return {
      meta: {
        projectName: '连小理 · 班费透明工作流',
        className: '',
        term: '',
        updatedAt: stamp(),
        notice: '本页只展示账目与班费收缴情况，不经手资金、不执行支付、不代收代付。除班费收缴外，不展示任何个人消费信息。'
      },
      summary: { balance: 0, incomeTotal: 0, expenseTotal: 0 },
      budget: { total: 0, warnBelow: 0 },
      members: { visible: true, standard: 0, list: [] },
      ledger: []
    };
  }

  function normalize(d) {
    var out = emptyData();
    if (!d || typeof d !== 'object') return out;

    Object.assign(out.meta, d.meta || {});
    Object.assign(out.budget, d.budget || {});
    out.budget.total = num(out.budget.total);
    out.budget.warnBelow = num(out.budget.warnBelow);

    if (d.members) {
      out.members.visible = d.members.visible !== false;
      out.members.standard = num(d.members.standard);
      out.members.list = Array.isArray(d.members.list) ? d.members.list.map(function (m) {
        return {
          name: String((m && m.name) || ''),
          paid: num(m && m.paid),
          status: (m && m.status) || '',
          masked: !!(m && m.masked)
        };
      }) : [];
    }

    out.ledger = Array.isArray(d.ledger) ? d.ledger.map(function (it) {
      return {
        id: String((it && it.id) || ''),
        date: String((it && it.date) || ''),
        type: (it && (it.type === 'in' || it.type === 'adjust')) ? it.type : 'out',
        category: String((it && it.category) || ''),
        amount: num(it && it.amount),
        receipt: String((it && it.receipt) || '—'),
        note: String((it && it.note) || ''),
        corrects: String((it && it.corrects) || '')
      };
    }) : [];

    if (d.summary) Object.assign(out.summary, d.summary);
    return out;
  }

  /** 汇总与缴费状态一律重算 —— 让「汇总和明细对不上」从根上不存在 */
  function recount() {
    var d = state.data;
    var inc = 0, exp = 0;
    d.ledger.forEach(function (it) {
      if (it.type === 'in') inc += it.amount;
      else exp += it.amount;
    });
    d.summary.incomeTotal  = Math.round(inc * 100) / 100;
    d.summary.expenseTotal = Math.round(exp * 100) / 100;
    d.summary.balance      = Math.round((inc - exp) * 100) / 100;

    var std = num(d.members.standard);
    d.members.list.forEach(function (m) {
      m.paid = Math.round(num(m.paid) * 100) / 100;
      if (std > 0) m.status = m.paid >= std - 0.005 ? 'paid' : (m.paid > 0 ? 'partial' : 'unpaid');
      else m.status = m.paid > 0 ? 'paid' : 'unpaid';
    });
  }

  function markDirty() {
    state.dirty = true;
    recount();
    try { localStorage.setItem(LS_DRAFT, JSON.stringify(state.data)); } catch (e) {}
    renderAll();
  }

  /* ==========================================================================
     2. 服务端通信
     ========================================================================== */

  function fetchJSON(url, opt) {
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || ('HTTP ' + r.status));
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  function probe() {
    return fetchJSON(API.health, { cache: 'no-store' })
      .then(function (j) {
        state.serverOk = !!j.ok;
        state.llmOk = !!j.llm;
        state.llmModel = j.model || '';
      })
      .catch(function () { state.serverOk = false; state.llmOk = false; })
      .then(renderConn);
  }

  function renderConn() {
    var p = $('connPill'), t = $('connText');
    if (p && t) {
      p.classList.toggle('is-off', !state.serverOk);
      t.textContent = state.serverOk ? '本地服务已连接' : '本地服务未运行';
    }
    var lp = $('llmPill'), lt = $('llmText');
    if (lp && lt) {
      lp.classList.toggle('is-off', !state.llmOk);
      lt.textContent = state.llmOk ? ('模型在线 · ' + state.llmModel) : '模型未配置 · 走本地规则';
    }
    var hint = $('assistModeHint');
    if (hint) {
      hint.textContent = state.llmOk
        ? '在线：由服务端模型作答'
        : '离线：模型体检与撰文不可用，「本地规则体检」照常可用';
    }
  }

  /* ==========================================================================
     3. 渲染
     ========================================================================== */

  function renderAll() {
    renderStats();
    renderLedgerTable();
    renderMembers();
    renderBudget();
    renderMetaForm();
    renderBadges();
    var f = $('dirtyFlag');
    if (f) f.hidden = !state.dirty;
  }

  function renderStats() {
    var d = state.data;
    $('stBalance').textContent = '¥' + fmt(d.summary.balance);
    $('stIncome').textContent  = '¥' + fmt(d.summary.incomeTotal);
    $('stExpense').textContent = '¥' + fmt(d.summary.expenseTotal);
    $('stCount').textContent   = d.ledger.length + ' 条';
  }

  function renderBadges() {
    $('badgeLedger').textContent = state.data.ledger.length;
    $('badgeMembers').textContent = state.data.members.list.length;
    var bad = runChecks().filter(function (c) { return c.level === 'bad'; }).length;
    $('badgeCheck').textContent = bad ? (bad + ' 项') : '通过';
  }

  function renderLedgerTable() {
    var d = state.data;
    var q = ($('ledgerSearch').value || '').trim().toLowerCase();
    var tf = $('ledgerTypeFilter').value;

    var rows = d.ledger.slice().sort(function (a, b) {
      return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
    }).filter(function (it) {
      if (tf && it.type !== tf) return false;
      if (q) {
        var hay = (it.note + ' ' + it.category + ' ' + it.receipt + ' ' + it.id + ' ' + it.date).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    var body = $('ledgerBody'), empty = $('ledgerEmpty');
    if (!rows.length) {
      body.innerHTML = '';
      empty.hidden = false;
      empty.textContent = d.ledger.length ? '没有符合筛选条件的记录' : '还没有账目记录';
      return;
    }
    empty.hidden = true;

    body.innerHTML = rows.map(function (it) {
      var cls = it.type === 'in' ? 'is-in' : (it.type === 'adjust' ? 'is-adjust' : '');
      var sign = it.type === 'in' ? '+' : (it.type === 'adjust' ? (it.amount < 0 ? '-' : '+') : '−');
      var tag = it.type === 'in' ? '<span class="tag tag-in">收入</span>'
              : it.type === 'adjust' ? '<span class="tag tag-adjust">更正</span>'
              : '<span class="tag">支出</span>';
      return '<tr>' +
        '<td class="mono">' + esc(it.date) + '</td>' +
        '<td>' + tag + '</td>' +
        '<td>' + esc(it.category) + '</td>' +
        '<td>' + (esc(it.note) || '—') +
          (it.corrects ? ' <span class="tag tag-adjust">→ ' + esc(it.corrects) + '</span>' : '') + '</td>' +
        '<td class="mono">' + esc(it.receipt) + '</td>' +
        '<td class="num ' + cls + '">' + sign + '¥' + fmt(Math.abs(it.amount)) + '</td>' +
        '<td class="act">' +
          (it.type === 'adjust' ? '' :
            '<button class="btn btn-sm" type="button" data-fix="' + esc(it.id) + '">更正</button>') +
        '</td>' +
      '</tr>';
    }).join('');

    var dl = $('catList');
    if (dl) {
      var set = {};
      /* 建议类别同时收录支出与收入用过的类别（收入已细分出「班费收缴 / 其他收入」） */
      d.ledger.forEach(function (it) { if (it.type !== 'adjust') set[it.category] = 1; });
      dl.innerHTML = Object.keys(set).map(function (n) {
        return '<option value="' + esc(n) + '"></option>';
      }).join('');
    }
  }

  function renderMembers() {
    var m = state.data.members;
    setVal('mStandard', m.standard || '');
    $('mVisible').checked = m.visible !== false;

    var paidTotal = m.list.reduce(function (s, x) { return s + x.paid; }, 0);
    var paid = m.list.filter(function (x) { return x.status === 'paid'; }).length;
    var partial = m.list.filter(function (x) { return x.status === 'partial'; }).length;
    var unpaid = m.list.filter(function (x) { return x.status === 'unpaid'; }).length;
    var due = num(m.standard) * m.list.length;
    $('mSummary').textContent = m.list.length
      ? ('共 ' + m.list.length + ' 人　已到账 ¥' + fmt(paidTotal) + ' / 应缴 ¥' + fmt(due) +
         '（' + Math.round(paidTotal / (due || 1) * 100) + '%）\n已缴清 ' + paid + ' 人' +
         (partial ? '　部分缴纳 ' + partial + ' 人' : '') + '　未缴 ' + unpaid + ' 人')
      : '还没有添加名单';

    var body = $('memberBody');

    /* 录入保护：焦点还在名单表格里时，绝不能重建 tbody。
       重建会把用户正在打字的 <input> 连同焦点一起换成新节点 —— 表现就是「打第一个字就被踢出输入框」。
       此时只就地更新派生内容（该行的状态标签），表格结构等焦点离开后再由后续渲染补齐。 */
    var ae = document.activeElement;
    if (ae && ae.getAttribute && ae.getAttribute('data-mfield') &&
        ae.closest && ae.closest('#memberBody')) {
      var fi = parseInt(ae.getAttribute('data-i'), 10);
      var frow = ae.closest('tr');
      var ftag = frow && frow.querySelector('.tag');
      var fx = m.list[fi];
      if (ftag && fx) {
        ftag.textContent = STATUS_TEXT[fx.status] || '未缴';
        ftag.className = 'tag ' + (fx.status === 'paid' ? 'tag-in' : (fx.status === 'partial' ? 'tag-adjust' : ''));
      }
      return;
    }

    if (!m.list.length) {
      body.innerHTML = '<tr><td colspan="5"><p class="empty">还没有同学。点右上角「添加一位」开始。</p></td></tr>';
      return;
    }
    body.innerHTML = m.list.map(function (x, i) {
      var tagCls = x.status === 'paid' ? 'tag-in' : (x.status === 'partial' ? 'tag-adjust' : '');
      return '<tr>' +
        '<td><input type="text" data-mfield="name" data-i="' + i + '" value="' + esc(x.name) + '" placeholder="姓名"></td>' +
        '<td><input type="number" data-mfield="paid" data-i="' + i + '" step="0.01" min="0" value="' + (x.paid || '') + '" placeholder="0.00"></td>' +
        '<td><span class="tag ' + tagCls + '">' + STATUS_TEXT[x.status] + '</span></td>' +
        '<td style="text-align:center"><input type="checkbox" data-mfield="masked" data-i="' + i + '" style="width:auto"' +
          (x.masked ? ' checked' : '') + '></td>' +
        '<td class="act"><button class="btn btn-sm btn-danger" type="button" data-mdel="' + i + '">移除</button></td>' +
      '</tr>';
    }).join('');
  }

  function renderBudget() {
    var d = state.data;
    setVal('bTotal', d.budget.total || '');
    setVal('bWarn', d.budget.warnBelow || '');
    var t = num(d.budget.total), used = d.summary.expenseTotal, warn = num(d.budget.warnBelow);
    $('bShowTotal').textContent = t ? '¥' + fmt(t) : '未设置';
    $('bShowUsed').textContent  = '¥' + fmt(used);
    $('bShowLeft').textContent  = t ? '¥' + fmt(t - used) : '—';
    $('bShowPct').textContent   = t ? Math.round(used / t * 100) + '%' : '—';

    /* 预算进度条 + 低余额提醒线：阈值取自 budget.warnBelow，与前台同一套逻辑 */
    var bar = $('budgetBarBlock');
    if (bar) {
      if (t > 0) {
        bar.hidden = false;
        var pct = Math.max(0, Math.min(100, Math.round(used / t * 100)));
        var fill = $('bFill');
        if (fill) {
          fill.style.width = pct + '%';
          fill.classList.toggle('is-over', used > t);
        }
        var mark = $('bWarnMark'), low = $('bLow');
        if (warn > 0 && warn <= t) {
          if (mark) {
            mark.hidden = false;
            mark.style.left = Math.max(0, Math.min(100, (t - warn) / t * 100)) + '%';
          }
          var isLow = (t - used) < warn;
          bar.classList.toggle('is-low', isLow);
          if (low) {
            low.hidden = !isLow;
            low.textContent = '当前剩余 ¥' + fmt(t - used) + '，已低于提醒线 ¥' + fmt(warn) + '，请留意后续支出';
          }
        } else {
          if (mark) mark.hidden = true;
          if (low) low.hidden = true;
          bar.classList.remove('is-low');
        }
        var track = $('bTrack');
        if (track) track.setAttribute('aria-label', '学期预算使用 ' + pct + '%，剩余 ¥' + fmt(t - used));
      } else {
        bar.hidden = true;
      }
    }
  }

  function renderMetaForm() {
    var m = state.data.meta;
    setVal('metaClass', m.className || '');
    setVal('metaTerm', m.term || '');
    setVal('metaNotice', m.notice || '');
    $('topClass').textContent = m.className ? (m.className + ' · 后台') : '班费透明工作流 · 后台';
  }

  /* ==========================================================================
     4. 数据契约自检
     ========================================================================== */

  function runChecks() {
    var d = state.data;
    var out = [];
    function add(level, title, why) { out.push({ level: level, title: title, why: why || '' }); }

    /* 1 必填字段 */
    var missing = d.ledger.filter(function (it) {
      return !it.id || !it.date || !it.category || !it.receipt || !it.note;
    });
    if (missing.length) add('bad', missing.length + ' 条账目缺少必填字段',
      '每条必须有 条目编号 / 日期 / 类别 / 票据编号 / 备注。没有票据就填「—」，但字段要在。');
    else add('ok', '每条账目的必填字段都完整');

    /* 2 编号重复 */
    var seen = {}, dup = [];
    d.ledger.forEach(function (it) { if (seen[it.id]) dup.push(it.id); seen[it.id] = 1; });
    if (dup.length) add('bad', '存在重复的条目编号：' + dup.slice(0, 3).join('、'),
      '编号重复会让「回溯到原始票据」失效。');
    else add('ok', '条目编号没有重复');

    /* 3 日期格式 */
    var badDate = d.ledger.filter(function (it) { return !/^\d{4}-\d{2}-\d{2}$/.test(it.date); });
    if (badDate.length) add('bad', badDate.length + ' 条日期格式不对', '必须是 YYYY-MM-DD。');
    else add('ok', '日期格式统一为 YYYY-MM-DD');

    /* 4 金额符号 */
    var badSign = d.ledger.filter(function (it) {
      return it.type === 'adjust' ? it.amount === 0 : it.amount <= 0;
    });
    if (badSign.length) add('bad', badSign.length + ' 条金额符号不对',
      '收入 / 支出用正数；「更正」用带符号差值（多记了就是负数），且不能为 0。');
    else add('ok', '金额符号全部符合契约');

    /* 5 类别口径
       —— 只管「支出」。收入与更正的类别来源不同（班费收缴、奖学金返还…），
          拿支出口径去卡它们会误报。 */
    var odd = d.ledger.filter(function (it) {
      return it.type === 'out' && KNOWN_CATS.indexOf(it.category) === -1;
    });
    if (odd.length) add('warn', odd.length + ' 条支出使用了知识库口径外的类别',
      '支出口径是：' + KNOWN_CATS.join(' / ') + '。自定义类别会让汇总口径漂移。');
    else add('ok', '支出类别都在知识库口径内');

    /* 6 更正链路 */
    var idSet = {};
    d.ledger.forEach(function (it) { idSet[it.id] = 1; });
    var badAdj = d.ledger.filter(function (it) {
      return it.type === 'adjust' && (!it.corrects || !idSet[it.corrects]);
    });
    if (badAdj.length) add('bad', badAdj.length + ' 条更正没有指向有效的原条目',
      '更正条目的 corrects 字段必须填被更正条目的编号。');
    else add('ok', '更正链路完整，每条更正都能回溯到原记录');

    /* 7 汇总口径一致 —— 总余额 / 余额走势 / 更正净额三者必须同口径 */
    var inc = 0, exp = 0;
    d.ledger.forEach(function (it) { if (it.type === 'in') inc += it.amount; else exp += it.amount; });
    var diff = Math.abs(num(d.summary.balance) - (inc - exp));

    // 更正净额：净额 = 原条目金额 + 差值（数据契约规定 adjust 用带符号差值）。
    // 净额为负 = 差值的正负方向或数值填反了 —— 它会同时污染总余额与余额走势，
    // 属于「不走完流程就发现不了」的那类错误，所以放在发布前的关口上拦。
    var adjs = d.ledger.filter(function (it) { return it.type === 'adjust'; });
    var badNet = [], zeroNet = [];
    adjs.forEach(function (a) {
      var src = d.ledger.filter(function (x) { return x.id === a.corrects; })[0];
      if (!src || src.type === 'adjust') return;   // 链路本身的问题由上一项负责报出
      var net = Math.round((num(src.amount) + num(a.amount)) * 100) / 100;
      var desc = a.id + ' 更正 ' + src.id + '：¥' + fmt(num(src.amount)) +
                 (num(a.amount) < 0 ? ' − ' : ' + ') + '¥' + fmt(Math.abs(num(a.amount))) +
                 ' = ¥' + fmt(net);
      if (net < -0.005) badNet.push(desc);
      else if (Math.abs(net) < 0.005) zeroNet.push(desc);
    });

    if (badNet.length) {
      add('bad', badNet.length + ' 条更正把原条目改成了负数',
        '净额 = 原金额 + 差值，出现负数说明差值的正负方向或数值填反了；' +
        '这会同时污染总余额与前台余额走势。逐条核对：' + badNet.join('；'));
    } else if (diff > 0.005) {
      add('warn', 'summary 与明细重算结果不一致（差 ¥' + fmt(diff) + '）',
        '前台一律以明细重算为准，所以不影响展示；但这说明导出环节有漂移，建议重新导出。');
    } else if (zeroNet.length) {
      add('warn', zeroNet.length + ' 条更正把原条目全额冲销为 0',
        '若确属「这笔不该记」，保留即可；若是笔误，请再追加一条更正改回来。：' + zeroNet.join('；'));
    } else if (adjs.length) {
      add('ok', '总余额与明细重算一致；' + adjs.length + ' 条更正净额自洽（无负数、无全额冲销）');
    } else {
      add('ok', '总余额与明细重算一致');
    }

    /* 8 收缴名单 */
    if (!d.members.list.length) add('bad', '收缴名单是空的', '名单要覆盖全班每一个人，不能只列已缴的。');
    else if (!num(d.members.standard)) add('warn', '没有填写「每人应缴标准」',
      '不填标准，前台就没法判断谁「缴清」、也就没法算收缴进度。');
    else add('ok', '收缴名单 ' + d.members.list.length + ' 人，应缴标准已填写');

    /* 9 收缴合计 vs 台账的「班费收缴」收入
       —— 只比对班费这一支。台账里还可能有奖学金返还等非班费收入，
          它们本来就不在收缴名单里，混进来比对会永远对不上而误报警。 */
    var paidSum = d.members.list.reduce(function (s, x) { return s + x.paid; }, 0);
    var feeIn = 0, otherIn = 0;
    d.ledger.forEach(function (it) {
      if (it.category === '班费收缴' && (it.type === 'in' || it.type === 'adjust')) feeIn += it.amount;
      else if (it.type === 'in') otherIn += it.amount;
    });
    if (d.members.list.length) {
      if (Math.abs(paidSum - feeIn) > 0.005) {
        add('warn', '收缴合计 ¥' + fmt(paidSum) + ' 与台账班费收入 ¥' + fmt(feeIn) + ' 不一致',
          '可能是记录时点不同，也可能有一边漏记。这是最值得先核对的一项。');
      } else {
        add('ok', '收缴合计与台账班费收入一致' +
          (otherIn > 0.005 ? '（另有其他收入 ¥' + fmt(otherIn) + '，不参与这项核对）' : ''));
      }
    }

    /* 10 隐私扫描 */
    var priv = /1[3-9]\d{9}|\b\d{8,}\b|@[a-zA-Z0-9.-]+\.[a-z]{2,}/;
    var leak = d.ledger.filter(function (it) { return priv.test(it.note) || priv.test(it.receipt); });
    if (leak.length) add('bad', leak.length + ' 条备注或票据编号里出现疑似手机号 / 长数字 / 邮箱',
      '前台对全班公开，这类信息一律不能出现。');
    else add('ok', '账目里没有手机号、学号、邮箱等个人信息');

    /* 11 姓名越区 */
    var names = d.members.list.map(function (x) { return x.name; }).filter(function (n) { return n && n.length >= 2; });
    var nameLeak = d.ledger.filter(function (it) {
      return names.some(function (n) { return it.note.indexOf(n) !== -1; });
    });
    if (nameLeak.length) add('bad', nameLeak.length + ' 条备注里出现了同学姓名',
      '姓名只允许出现在「班费收缴明细」区。账目备注里出现姓名，等于把个人消费公开了。');
    else add('ok', '姓名只出现在收缴区，账目备注里没有姓名');

    /* 12 数据新鲜度 */
    if (d.meta.updatedAt) add('ok', '数据更新时间：' + d.meta.updatedAt);
    else add('warn', '缺少「更新时间」', '前台会把更新时间显示给全班看，应当填写。');

    return out;
  }

  function renderChecks() {
    var list = $('checkList');
    if (!list) return;
    var res = runChecks();
    list.innerHTML = res.map(function (c) {
      var mark = c.level === 'ok' ? '✓' : (c.level === 'warn' ? '!' : '×');
      return '<div class="check ' + (c.level === 'ok' ? '' : ('is-' + c.level)) + '">' +
        '<span class="mark" aria-hidden="true">' + mark + '</span>' +
        '<span>' + esc(c.title) + (c.why ? '<span class="why">' + esc(c.why) + '</span>' : '') + '</span>' +
      '</div>';
    }).join('');

    var bad = res.filter(function (c) { return c.level === 'bad'; }).length;
    var warn = res.filter(function (c) { return c.level === 'warn'; }).length;
    var bar = $('barStatus');
    bar.className = 'status ' + (bad ? 'bad' : (warn ? '' : 'ok'));
    bar.textContent = bad ? (bad + ' 项必须修掉才能发布') : (warn ? (warn + ' 项提醒，可对照检查') : '全部校验通过');
  }

  /* ==========================================================================
     5. 本地规则体检（不需要模型，断网也能用）
     ========================================================================== */

  function localAudit() {
    var d = state.data;
    var lines = [];

    if (d.summary.balance < 0) {
      lines.push('[高] 总余额为负（¥' + fmt(d.summary.balance) + '）→ 核对是否有支出未对应到收入');
    }

    var outs = d.ledger.filter(function (x) { return x.type === 'out'; });
    if (outs.length >= 3) {
      var avg = outs.reduce(function (s, x) { return s + Math.abs(x.amount); }, 0) / outs.length;
      outs.forEach(function (x) {
        if (Math.abs(x.amount) > avg * 3 && Math.abs(x.amount) > 100) {
          lines.push('[中] ' + x.date + '「' + x.category + '」¥' + fmt(Math.abs(x.amount)) +
                     '，是平均单笔（¥' + fmt(avg) + '）的 ' + (Math.abs(x.amount) / avg).toFixed(1) +
                     ' 倍 → 确认金额没多打一位');
        }
      });
    }

    var rmap = {};
    d.ledger.forEach(function (x) {
      if (!x.receipt || x.receipt === '—') return;
      /* 更正条目本来就该沿用被更正那笔的票据号 —— 不算重复记账 */
      if (x.type === 'adjust') return;
      rmap[x.receipt] = (rmap[x.receipt] || 0) + 1;
    });
    Object.keys(rmap).forEach(function (k) {
      if (rmap[k] > 1) {
        lines.push('[高] 票据编号 ' + k + ' 被 ' + rmap[k] + ' 条记录引用 → 可能重复记账');
      }
    });

    var std = num(d.members.standard);
    if (std > 0) {
      var un = d.members.list.filter(function (x) { return x.status !== 'paid'; });
      if (un.length) {
        lines.push('[低] 还有 ' + un.length + ' 位同学未缴清 → 按约定只私聊本人，不在群里点名');
      }
    }

    if (d.budget.warnBelow && d.summary.balance < d.budget.warnBelow) {
      lines.push('[中] 余额 ¥' + fmt(d.summary.balance) + ' 已低于提醒阈值 ¥' +
                 fmt(d.budget.warnBelow) + ' → 由连小理定时任务私聊提醒你');
    }

    return lines.length ? lines.join('\n') : '本地规则未发现明显疑点。';
  }

  /* ==========================================================================
     6. 助手（在线时走服务端模型）
     ========================================================================== */

  function contextPayload() {
    var d = state.data;
    return {
      meta: d.meta,
      totals: { balance: d.summary.balance, income: d.summary.incomeTotal, expense: d.summary.expenseTotal },
      budget: d.budget,
      categories: (function () {
        var m = {};
        d.ledger.forEach(function (it) {
          if (it.type === 'out') m[it.category] = (m[it.category] || 0) + it.amount;
        });
        return Object.keys(m).map(function (k) { return { name: k, amount: m[k] }; })
          .sort(function (a, b) { return b.amount - a.amount; });
      })(),
      members: {
        standard: d.members.standard,
        total: d.members.list.length,
        paidTotal: d.members.list.reduce(function (s, x) { return s + x.paid; }, 0),
        dueTotal: num(d.members.standard) * d.members.list.length,
        list: d.members.list.map(function (x) {
          return { name: x.masked ? '不公示' : x.name, paid: x.paid, status: x.status };
        })
      },
      ledger: d.ledger
    };
  }

  function askServer(task, question) {
    return fetchJSON(API.chat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: task, question: question, context: contextPayload() })
    }).then(function (j) {
      if (!j.reply) throw new Error('模型返回为空');
      return j.reply;
    });
  }

  function showOut(id, text, meta) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = esc(text).replace(/\n/g, '<br>') +
      (meta ? '<span class="meta">' + esc(meta) + '</span>' : '');
  }

  /* ==========================================================================
     7. 发布 / 导出
     ========================================================================== */

  function buildDataJs(data) {
    var header =
'/* ============================================================================\n' +
'   连小理 · 班费透明工作流 —— 数据文件\n' +
'   ----------------------------------------------------------------------------\n' +
'   本文件由「生活委员后台」导出。\n' +
'   要改账目请打开后台，或改 server/data/store.json 后点「发布到前台」。\n' +
'   导出时间：' + stamp() + '\n' +
'   ========================================================================== */\n\n';
    return header + 'window.__LEDGER__ = ' + JSON.stringify(data, null, 2) + ';\n';
  }

  function publish() {
    var bad = runChecks().filter(function (c) { return c.level === 'bad'; });
    if (bad.length) {
      toast('有 ' + bad.length + ' 项必填校验没过，先到「校验」里修掉', 3400);
      switchTab('check');
      renderChecks();
      return;
    }
    if (!state.serverOk) {
      toast('本地服务没有运行，无法发布。可以改用「导出 data.js」手动替换', 4200);
      return;
    }

    state.data.meta.updatedAt = stamp();
    var btn = $('publishBtn');
    btn.disabled = true;
    btn.textContent = '发布中…';

    fetchJSON(API.store, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token, data: state.data })
    }).then(function (j) {
      state.dirty = false;
      try { localStorage.removeItem(LS_DRAFT); } catch (e) {}
      $('dirtyFlag').hidden = true;
      renderAll();
      toast('已发布 v' + j.version + ' —— 前台刷新即可看到', 3200);
    }).catch(function (err) {
      if (err.status === 401) {
        toast('口令不正确', 2600);
        localStorage.removeItem(LS_TOKEN);
        $('app').hidden = true;
        $('gate').hidden = false;
      } else {
        toast('发布失败：' + err.message, 3600);
      }
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '发布到前台';
    });
  }

  function exportDataJs() {
    var content = buildDataJs(state.data);
    var blob = new Blob([content], { type: 'text/javascript;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'data.js';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('已导出 data.js，覆盖到「网页」目录即可', 3200);
  }

  /* ==========================================================================
     8. 导入：解析连小理工作流的导出内容
     ========================================================================== */

  function parseImport(text) {
    var s = String(text || '').trim();
    if (!s) return { ok: false, error: '内容为空' };

    var jsonText = s;
    var m = s.match(/window\.__LEDGER__\s*=\s*([\s\S]*?);?\s*$/);
    if (m) jsonText = m[1];

    if (!/^\s*[{[]/.test(jsonText)) {
      var a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a === -1 || b <= a) return { ok: false, error: '没找到 JSON 对象。请把导出节点输出的整段内容粘进来。' };
      jsonText = s.slice(a, b + 1);
    }
    // 容忍尾随逗号
    jsonText = jsonText.replace(/,\s*([}\]])/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

    var obj;
    try {
      obj = JSON.parse(jsonText);
    } catch (e) {
      return { ok: false, error: 'JSON 解析失败：' + e.message };
    }
    if (!obj || !Array.isArray(obj.ledger)) {
      return { ok: false, error: '解析成功，但没有找到 ledger 数组 —— 不是本项目的导出格式。' };
    }
    return { ok: true, data: normalize(obj) };
  }

  function previewImport() {
    var res = parseImport($('importText').value);
    var out = $('importOut');
    var apply = $('applyImportBtn');

    if (!res.ok) {
      state.parsed = null;
      apply.disabled = true;
      out.innerHTML = '<b>解析失败</b><br>' + esc(res.error);
      return;
    }

    var incoming = res.data;
    var have = {};
    state.data.ledger.forEach(function (it) { have[it.id] = 1; });

    var fresh = incoming.ledger.filter(function (it) { return !have[it.id]; });
    var dup = incoming.ledger.filter(function (it) { return have[it.id]; });

    state.parsed = res.data;
    apply.disabled = fresh.length === 0;

    out.innerHTML =
      '<b>解析成功</b><br>' +
      '收到 ' + incoming.ledger.length + ' 条账目：<br>' +
      '· 新增 ' + fresh.length + ' 条' +
      (fresh.length ? '（' + fresh.slice(0, 4).map(function (x) { return esc(x.date + ' ' + x.category); }).join('、') +
        (fresh.length > 4 ? ' …' : '') + '）' : '') + '<br>' +
      '· 已存在、将被跳过 ' + dup.length + ' 条（<b>历史条目一律不改动</b>）<br>' +
      (incoming.members.list.length ? '· 附带收缴名单 ' + incoming.members.list.length + ' 人<br>' : '');
  }

  function applyImport() {
    var inc = state.parsed;
    if (!inc) return;

    var have = {};
    state.data.ledger.forEach(function (it) { have[it.id] = 1; });
    var added = 0;
    inc.ledger.forEach(function (it) {
      if (!have[it.id]) { state.data.ledger.push(it); have[it.id] = 1; added++; }
    });

    if (!state.data.members.list.length && inc.members.list.length) {
      state.data.members = inc.members;
    }
    if (!state.data.meta.className && inc.meta.className) {
      state.data.meta.className = inc.meta.className;
      state.data.meta.term = inc.meta.term || state.data.meta.term;
    }
    if (inc.budget && inc.budget.total && !state.data.budget.total) {
      state.data.budget = inc.budget;
    }

    markDirty();
    $('applyImportBtn').disabled = true;
    state.parsed = null;
    showOut('importOut', '已合并 ' + added + ' 条新账目。记得点右下角「发布到前台」。');
    toast('合并了 ' + added + ' 条新账目', 2600);
  }

  function loadFrontData() {
    fetch(FRONT_DATA_URL, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) {
        var res = parseImport(t);
        if (!res.ok) throw new Error(res.error);
        state.data = res.data;
        markDirty();
        toast('已载入前台当前数据作为工作副本', 3000);
      })
      .catch(function (e) { toast('载入失败：' + e.message, 3200); });
  }

  /* ==========================================================================
     9. 对话框（更正 / 添加成员）
     ========================================================================== */

  /* 与前台同一套逻辑：打开对话框时锁滚动（补等宽 padding 防跳），关闭时归还焦点 */
  var lastFocusAdm = null;
  function lockScrollAdm(on) {
    var b = document.body;
    if (on) {
      var sw = window.innerWidth - document.documentElement.clientWidth;
      if (sw > 0) b.style.paddingRight = sw + 'px';
      b.style.overflow = 'hidden';
    } else {
      b.style.overflow = '';
      b.style.paddingRight = '';
    }
  }

  function openModal(opt) {
    var scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(opt.title) + '">' +
        '<h2>' + esc(opt.title) + '</h2>' +
        '<p class="m-sub">' + (opt.sub || '') + '</p>' +
        '<div class="m-body"></div>' +
        '<div class="m-foot">' +
          '<button class="btn" type="button" data-cancel>取消</button>' +
          '<button class="btn ' + (opt.danger ? 'btn-danger' : 'btn-primary') + '" type="button" data-ok>' +
            esc(opt.okText || '确定') + '</button>' +
        '</div>' +
      '</div>';

    var body = scrim.querySelector('.m-body');
    var fields = opt.fields || [];   /* 允许无输入项的确认框（点一下即可确认） */
    body.innerHTML = fields.map(function (f) {
      return '<div class="field">' +
        '<label for="mf-' + f.key + '">' + esc(f.label) + '</label>' +
        '<input type="' + (f.type || 'text') + '" id="mf-' + f.key + '" ' +
          (f.step ? 'step="' + f.step + '" ' : '') +
          (f.min != null ? 'min="' + f.min + '" ' : '') +
          'value="' + esc(f.value == null ? '' : f.value) + '" ' +
          (f.placeholder ? 'placeholder="' + esc(f.placeholder) + '"' : '') + '>' +
        (f.note ? '<p class="note">' + esc(f.note) + '</p>' : '') +
      '</div>';
    }).join('');

    /* 锁滚动 + 记住焦点；关闭时先播退场动画再移除 —— 与前台同一套逻辑 */
    lastFocusAdm = document.activeElement;
    lockScrollAdm(true);
    function close() {
      if (scrim.classList.contains('is-closing')) return;
      scrim.classList.add('is-closing');
      document.removeEventListener('keydown', onKey);
      lockScrollAdm(false);
      if (lastFocusAdm && lastFocusAdm.focus) lastFocusAdm.focus();
      setTimeout(function () { scrim.remove(); }, 200);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    scrim.querySelector('[data-cancel]').addEventListener('click', close);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    scrim.querySelector('[data-ok]').addEventListener('click', function () {
      var vals = {};
      fields.forEach(function (f) { vals[f.key] = scrim.querySelector('#mf-' + f.key).value; });
      if (opt.onOk(vals) !== false) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    var first = scrim.querySelector('input');
    if (first) setTimeout(function () { first.focus(); first.select(); }, 40);
    /* 没有输入项时把焦点落在「取消」，避免直接回车就执行危险动作 */
    else setTimeout(function () { var c = scrim.querySelector('[data-cancel]'); if (c) c.focus(); }, 40);
  }

  /* ==========================================================================
     10. 台账操作
     ========================================================================== */

  function nextId(date, type) {
    var prefix = date.replace(/-/g, '');
    var code = type === 'in' ? 'IN' : (type === 'adjust' ? 'ADJ' : 'OUT');
    var max = 0;
    var re = new RegExp('^' + prefix + '-' + code + '-(\\d+)$');
    state.data.ledger.forEach(function (it) {
      var m = re.exec(it.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + '-' + code + '-' + pad(max + 1);
  }

  function addEntry(e) {
    e.preventDefault();
    /* 类型下拉里「收入」已细分为两个子项：
         in        → 班费收缴
         in-other  → 其他收入
       落库时一律还原成契约里的 type='in'，区分子项靠 category。 */
    var tv = $('eType').value;
    var type = (tv === 'in-other' || tv === 'in') ? 'in' : tv;
    var date = $('eDate').value;
    var category = $('eCategory').value.trim();
    var amount = num($('eAmount').value);
    if (!category) category = (tv === 'in') ? '班费收缴' : (tv === 'in-other' ? '其他收入' : '');
    var receipt = $('eReceipt').value.trim() || '—';
    var note = $('eNote').value.trim();

    if (!date || !category || !amount) { toast('日期、类别、金额都要填', 2600); return; }
    if (amount <= 0) { toast('金额要填正数', 2400); return; }

    var id = nextId(date, type);
    state.data.ledger.push({
      id: id, date: date, type: type, category: category,
      amount: amount, receipt: receipt, note: note, corrects: ''
    });
    markDirty();
    $('eCategory').value = '';
    $('eAmount').value = '';
    $('eNote').value = '';
    $('eReceipt').value = '';
    $('eCategory').focus();
    toast('已追加 ' + id + '（未发布）', 2400);
  }

  function openCorrect(id) {
    var it = null;
    state.data.ledger.forEach(function (x) { if (x.id === id) it = x; });
    if (!it) return;

    openModal({
      title: '更正一条账目',
      sub: '原记录会完整保留，这里只是追加一条带差值的「更正」条目 —— 改一笔账不留痕，公信力就没了。',
      okText: '追加更正条目',
      danger: true,
      fields: [
        { key: 'orig', label: '原记录', value: it.date + '　' + it.category + '　¥' + fmt(it.amount), type: 'text' },
        { key: 'amount', label: '更正后的金额（元）', type: 'number', step: '0.01', min: '0', value: Math.abs(it.amount),
          note: '填「正确的金额」，系统会自动算出差值，不用你算。' },
        { key: 'reason', label: '更正原因', type: 'text', placeholder: '如：原记录金额有误（多记 18 元）',
          note: '这条原因会写进备注，前台可见。' }
      ],
      onOk: function (v) {
        var newAmt = num(v.amount);
        var reason = String(v.reason || '').trim();
        if (!reason) { toast('请填写更正原因', 2400); return false; }

        var delta = Math.round((newAmt - it.amount) * 100) / 100;
        if (Math.abs(delta) < 0.005) { toast('金额没变，不需要更正', 2400); return false; }

        var cid = nextId(today(), 'adjust');
        state.data.ledger.push({
          id: cid,
          date: today(),
          type: 'adjust',
          category: it.category,
          amount: delta,
          receipt: it.receipt,
          note: reason,
          corrects: it.id
        });
        markDirty();
        toast('已追加更正 ' + cid + '（差值 ' + (delta > 0 ? '+' : '') + '¥' + fmt(delta) + '）', 3400);
        return true;
      }
    });
  }

  /* ==========================================================================
     11. Tab
     ========================================================================== */

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === name);
    });
    var reduceMotionAdm = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* View Transitions 接管交叉淡入时就不再叠自己的淡入动画（两层叠起来会发糊） */
    if (document.startViewTransition && !reduceMotionAdm) {
      document.startViewTransition(function () {
        ['ledger', 'members', 'budget', 'check', 'import', 'assist'].forEach(function (n) {
          var pane = $('pane-' + n);
          if (pane) pane.hidden = (n !== name);
        });
      });
    } else {
      ['ledger', 'members', 'budget', 'check', 'import', 'assist'].forEach(function (n) {
        var pane = $('pane-' + n);
        if (!pane) return;
        pane.hidden = (n !== name);
        /* 切到哪一页就轻淡入一次（重放要靠先摘类 + 强制回流） */
        if (n === name) {
          pane.classList.remove('is-in');
          void pane.offsetWidth;
          pane.classList.add('is-in');
        }
      });
    }
    if (name === 'check') renderChecks();
  }

  /* 「/」聚焦台账搜索（与前台同一套快捷键习惯：输入中不抢键） */
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    e.preventDefault();
    switchTab('ledger');
    var si = $('ledgerSearch');
    if (si) setTimeout(function () { si.focus(); si.select(); }, 60);
  });

  /* ==========================================================================
     12. 事件绑定
     ========================================================================== */

  function bind() {
    /* Tab */
    $('tabsInner').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (b) switchTab(b.getAttribute('data-tab'));
    });

    /* 台账新增 */
    $('entryForm').addEventListener('submit', addEntry);
    $('eDate').value = today();
    /* 切到某个收入子项时自动带出类别；若用户已手填过别的类别则不覆盖 */
    $('eType').addEventListener('change', function () {
      var v = this.value, c = $('eCategory');
      if (!c) return;
      var cur = c.value.trim();
      if (v === 'in' && (!cur || cur === '其他收入')) c.value = '班费收缴';
      else if (v === 'in-other' && (!cur || cur === '班费收缴')) c.value = '其他收入';
    });

    $('ledgerSearch').addEventListener('input', debounce(renderLedgerTable, 160));
    $('ledgerTypeFilter').addEventListener('change', renderLedgerTable);

    $('ledgerBody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-fix]');
      if (b) openCorrect(b.getAttribute('data-fix'));
    });

    /* 收缴 */
    $('mStandard').addEventListener('change', function () {
      state.data.members.standard = num(this.value);
      markDirty();
    });
    $('mVisible').addEventListener('change', function () {
      state.data.members.visible = this.checked;
      markDirty();
    });
    $('memberBody').addEventListener('input', function (e) {
      var el = e.target.closest('[data-mfield]');
      if (!el) return;
      var i = parseInt(el.getAttribute('data-i'), 10);
      var f = el.getAttribute('data-mfield');
      if (!state.data.members.list[i]) return;
      state.data.members.list[i][f] = (f === 'masked') ? el.checked : el.value;
      markDirty();
    });
    /* 焦点彻底离开名单表后再重建一次，把录入时的原始文本规范成正式值（如 12.345 → 12.35）。
       用 setTimeout 延后判断，避免 Tab 到下一个输入框时把焦点抢走。 */
    $('memberBody').addEventListener('focusout', function () {
      setTimeout(function () {
        var ae = document.activeElement;
        if (ae && ae.closest && ae.closest('#memberBody')) return;
        renderMembers();
      }, 0);
    });
    $('memberBody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mdel]');
      if (!b) return;
      var i = parseInt(b.getAttribute('data-mdel'), 10);
      var m = state.data.members.list[i];
      openModal({
        title: '移除一位同学',
        sub: '将从收缴名单里移除：' + ((m && m.name) || '（未填姓名）') +
             '。移除后名单就不再覆盖全班，前台也查不到这位同学。',
        okText: '确认移除',
        danger: true,
        onOk: function () {
          state.data.members.list.splice(i, 1);
          markDirty();
          toast('已移除', 2000);
          return true;
        }
      });
    });
    $('addMemberBtn').addEventListener('click', function () {
      state.data.members.list.push({ name: '', paid: 0, status: 'unpaid', masked: false });
      markDirty();
      var inputs = $('memberBody').querySelectorAll('[data-mfield="name"]');
      var last = inputs[inputs.length - 1];
      if (last) last.focus();
    });
    $('fillAllBtn').addEventListener('click', function () {
      var std = num(state.data.members.standard);
      if (!std) { toast('先填「每人应缴标准」', 2600); return; }
      openModal({
        title: '全部标记为已缴清',
        sub: '会把名单里每个人的已缴金额都设成应缴标准 ¥' + fmt(std) + '。这是一次批量改写，请确认名单已经完整。',
        okText: '确认批量设置',
        danger: true,
        onOk: function () {
          state.data.members.list.forEach(function (x) { x.paid = std; });
          markDirty();
          toast('已批量设置为已缴清', 2400);
          return true;
        }
      });
    });

    /* 预算 */
    $('bTotal').addEventListener('change', function () {
      state.data.budget.total = num(this.value); markDirty();
    });
    $('bWarn').addEventListener('change', function () {
      state.data.budget.warnBelow = num(this.value); markDirty();
    });

    /* 基本设置 */
    var metaSync = function () {
      state.data.meta.className = $('metaClass').value;
      state.data.meta.term = $('metaTerm').value;
      state.data.meta.notice = $('metaNotice').value;
      markDirty();
    };
    $('metaClass').addEventListener('change', metaSync);
    $('metaTerm').addEventListener('change', metaSync);
    $('metaNotice').addEventListener('change', metaSync);

    /* 校验 */
    $('runCheckBtn').addEventListener('click', function () { renderChecks(); toast('已重新校验', 1800); });

    /* 导入 */
    $('parseImportBtn').addEventListener('click', previewImport);
    $('applyImportBtn').addEventListener('click', applyImport);
    $('loadFrontBtn').addEventListener('click', function () {
      openModal({
        title: '载入前台当前数据',
        sub: '会用「网页/data.js」里的内容覆盖你正在编辑的这份工作副本。未发布的修改会丢失。',
        okText: '确认载入',
        danger: true,
        onOk: function () {
          loadFrontData();
          return true;
        }
      });
    });

    /* 助手 */
    document.querySelectorAll('[data-assist]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-assist');

        if (kind === 'rules') {
          showOut('assistOut', localAudit(), '本地规则体检 · 不联网 · 只提示疑点，不改数据');
          return;
        }
        if (!state.llmOk) {
          showOut('assistOut',
            '服务端没有配置模型，这一项暂时不可用。\n' +
            '两个选择：\n' +
            '1) 在 server/.env 里填 LLM_API_KEY 与 LLM_BASE_URL，重启服务即可开启；\n' +
            '2) 先用「本地规则体检」，它不需要联网，覆盖了最常见的几类疑点。',
            '未配置模型');
          return;
        }

        showOut('assistOut', '正在请求模型…', '任务：' + (kind === 'audit' ? '账目体检' : '生成公示说明'));
        askServer(kind, kind === 'audit' ? '请对这份班费账目做一次体检。' : '请写出这次的班费公示说明。')
          .then(function (reply) {
            showOut('assistOut', reply, '任务：' + (kind === 'audit' ? '账目体检' : '生成公示说明') +
              ' · 模型 ' + state.llmModel + ' · 仅供参考，改动仍由你决定');
          })
          .catch(function (err) { showOut('assistOut', '请求失败：' + err.message, '可改用「本地规则体检」'); });
      });
    });

    $('assistAskForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('assistAskInput').value.trim();
      if (!q) return;
      if (!state.llmOk) {
        // 没有模型时，用本地规则做一个最小兜底
        var d = state.data;
        showOut('assistAskOut',
          '未配置模型，无法自由回答。这里给出账目现状：\n' +
          '总余额 ¥' + fmt(d.summary.balance) + '，累计收入 ¥' + fmt(d.summary.incomeTotal) +
          '，累计支出 ¥' + fmt(d.summary.expenseTotal) + '，共 ' + d.ledger.length + ' 条记录。',
          '本地兜底');
        return;
      }
      showOut('assistAskOut', '正在请求模型…', '');
      askServer('qa', q)
        .then(function (r) { showOut('assistAskOut', r, '模型 ' + state.llmModel + ' · 仅供核对参考'); })
        .catch(function (err) { showOut('assistAskOut', '请求失败：' + err.message, ''); });
    });

    /* 底部 */
    $('publishBtn').addEventListener('click', publish);
    $('exportBtn').addEventListener('click', exportDataJs);
    $('resetBtn').addEventListener('click', function () {
      openModal({
        title: '放弃本地修改',
        sub: '会丢掉你在这个后台里还没发布的改动，重新从服务端/前台读一份数据。',
        okText: '确认放弃',
        danger: true,
        onOk: function () {
          try { localStorage.removeItem(LS_DRAFT); } catch (e) {}
          state.dirty = false;
          boot();
          return true;
        }
      });
    });

    $('logoutBtn').addEventListener('click', function () {
      try { localStorage.removeItem(LS_TOKEN); } catch (e) {}
      state.token = '';
      $('app').hidden = true;
      $('gate').hidden = false;
      $('tokenInput').value = '';
    });

    window.addEventListener('beforeunload', function (e) {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ==========================================================================
     13. 启动
     ========================================================================== */

  function enter(token) {
    state.token = token;
    try { localStorage.setItem(LS_TOKEN, token); } catch (e) {}
    $('gate').hidden = true;
    $('app').hidden = false;
    bind();
    probe();
    boot();
  }

  function boot() {
    var draft = null;
    try { draft = localStorage.getItem(LS_DRAFT); } catch (e) {}

    function use(data, fromDraft) {
      state.data = normalize(data);
      state.dirty = !!fromDraft;
      recount();
      renderAll();
      renderChecks();
      if (fromDraft) toast('已恢复上次未发布的修改，记得点「发布到前台」', 3600);
    }

    if (draft) {
      try { use(JSON.parse(draft), true); return; } catch (e) {}
    }

    fetchJSON(API.store, { cache: 'no-store' })
      .then(function (j) { use(j.data, false); })
      .catch(function () {
        // 服务端还没有发布过数据 → 试着从前台 data.js 起步
        return fetch(FRONT_DATA_URL, { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(function (t) {
            var res = parseImport(t);
            if (res.ok) { use(res.data, false); toast('已从「网页/data.js」载入现有账目作为起点', 3400); }
            else { use(emptyData(), false); }
          })
          .catch(function () { use(emptyData(), false); });
      });
  }

  /* ---- 门禁 ---- */
  $('gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('tokenInput').value.trim();
    if (!v) { $('gateErr').textContent = '请输入口令'; return; }
    $('gateErr').textContent = '';
    enter(v);
  });

  // 之前进过后台就直接进，省得每次输口令
  try {
    var saved = localStorage.getItem(LS_TOKEN);
    if (saved) enter(saved);
  } catch (e) {}

})();
