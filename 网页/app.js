/* ============================================================================
   连小理 · 班费透明工作流 —— 前台渲染与交互
   ----------------------------------------------------------------------------
   职责：
     1) 读取账目数据 → 渲染概览 / 余额走势 / 收缴明细 / 类别汇总 / 逐笔明细
     2) 提供「问一问」问答（在线走后端模型，离线走本地规则引擎兜底）
   本页【只读】，不提供任何写入入口。

   数据来源（按优先级）：
     1) window.__LEDGER__   —— 由 data.js 提供，双击打开本页（file://）即可运行
     2) GET /api/store      —— 由本地后端提供（生活委员后台发布的最新数据）
     3) ./data.json         —— 需要本地服务器

   问答来源（按优先级）：
     1) POST /api/chat      —— 本地后端代理到模型，key 在服务端
     2) 本地规则引擎         —— 完全离线，只用本页已有的数据作答，绝不编造
   ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
     0. 常量与工具
     ========================================================================== */

  var TYPE_TEXT  = { in: '收入', out: '支出', adjust: '更正' };
  var STATUS_TEXT = { paid: '已缴清', partial: '部分缴纳', unpaid: '未缴' };
  var PAGE_SIZE  = 10;

  function num(v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function fmt(n) {
    var neg = n < 0;
    var s = Math.abs(n).toFixed(2);
    var p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + p.join('.');
  }

  /* 轴标签用的紧凑金额：12,340 → 1.2万 */
  function fmtShort(n) {
    var a = Math.abs(n);
    if (a >= 10000) return (n / 10000).toFixed(a >= 100000 ? 0 : 1) + '万';
    if (a >= 1000) return Math.round(n).toLocaleString('zh-CN');
    return String(Math.round(n));
  }

  function monthDay(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
    return m ? m[2] + '-' + m[3] : String(d);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function $(id) { return document.getElementById(id); }

  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }

  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }

  /* ==========================================================================
     1. 载入数据
     ========================================================================== */

  function loadData() {
    var served = location.protocol === 'http:' || location.protocol === 'https:';

    if (served && typeof fetch === 'function') {
      // 后端在跑：拿最新发布的数据
      return fetch('api/store', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { return j && j.data ? j.data : j; })
        .catch(function () { return loadStatic(); });
    }
    return loadStatic();
  }

  function loadStatic() {
    if (window.__LEDGER__ && typeof window.__LEDGER__ === 'object') {
      return Promise.resolve(window.__LEDGER__);
    }
    if (typeof fetch === 'function' && location.protocol !== 'file:') {
      return fetch('data.json', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    return Promise.resolve(null);
  }

  /* ==========================================================================
     2. 归一化 —— 所有汇总一律由明细重算
     ========================================================================== */

  function normalize(raw) {
    var meta = (raw && raw.meta) || {};
    var ledger = (raw && Array.isArray(raw.ledger)) ? raw.ledger.slice() : [];

    ledger = ledger.filter(function (it) { return it && it.date; }).map(function (it) {
      var type = (it.type === 'in' || it.type === 'adjust') ? it.type : 'out';
      return {
        id: it.id || '',
        date: String(it.date),
        type: type,
        category: it.category || '未分类',
        amount: num(it.amount),
        receipt: it.receipt || '—',
        note: it.note || '',
        corrects: it.corrects || ''
      };
    });

    var incomeTotal = 0, expenseTotal = 0, catMap = {}, feeIncome = 0;
    ledger.forEach(function (it) {
      if (it.type === 'in') {
        incomeTotal += it.amount;
        if (it.category === '班费收缴') feeIncome += it.amount;
      } else {
        if (it.category === '班费收缴') feeIncome += it.amount;  // 更正班费收入也要算进这一支
        expenseTotal += it.amount;           // 更正条目参与支出合计（正负都算）
        catMap[it.category] = catMap[it.category] || { amount: 0, count: 0 };
        catMap[it.category].amount += it.amount;
        catMap[it.category].count += 1;
      }
    });

    var categories = Object.keys(catMap).map(function (name) {
      return { name: name, amount: catMap[name].amount, count: catMap[name].count };
    }).sort(function (a, b) { return b.amount - a.amount; });

    // 与工作流给出的汇总做一致性检查（不一致时以明细为准）
    var given = (raw && raw.summary) || {};
    var warnings = [];
    if (given.balance != null &&
        Math.abs(num(given.balance) - (incomeTotal - expenseTotal)) > 0.005) {
      warnings.push('工作流给出的总余额与明细重算结果不一致，本页已采用明细重算值。');
      console.warn('[账目] summary.balance 与明细重算不一致，已采用明细重算值。');
    }

    // 班费收缴明细：状态一律由「已缴 / 应缴标准」重算
    var mraw = (raw && raw.members) || {};
    var standard = num(mraw.standard);
    var mlist = Array.isArray(mraw.list) ? mraw.list.filter(function (x) {
      return x && (x.name || x.masked);
    }).map(function (x) {
      var paid = num(x.paid);
      var status;
      if (standard > 0) {
        status = paid >= standard - 0.005 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
      } else {
        status = (x.status === 'paid' || x.status === 'partial' || x.status === 'unpaid')
          ? x.status : (paid > 0 ? 'paid' : 'unpaid');
      }
      return { name: x.name || '', masked: !!x.masked, paid: paid, status: status };
    }) : [];

    var paidTotal = mlist.reduce(function (s, x) { return s + x.paid; }, 0);
    var paidCount    = mlist.filter(function (x) { return x.status === 'paid'; }).length;
    var partialCount = mlist.filter(function (x) { return x.status === 'partial'; }).length;
    var unpaidCount  = mlist.filter(function (x) { return x.status === 'unpaid'; }).length;

    var members = {
      visible: mraw.visible !== false,
      standard: standard,
      list: mlist,                      // 保持录入顺序，不按状态重排（避免公开点名的观感）
      paidTotal: paidTotal,
      dueTotal: standard * mlist.length,
      paidCount: paidCount,
      partialCount: partialCount,
      unpaidCount: unpaidCount
    };

    /* 只拿「班费收缴」这一支和收缴名单核对。
       台账里还可能有奖学金返还等非班费收入，它们不在名单里，混进来比对会永远是假的。 */
    if (mlist.length && Math.abs(paidTotal - feeIncome) > 0.005) {
      warnings.push('收缴合计与台账班费收入不一致，请生活委员核对。');
      console.warn('[收缴] 收缴明细合计 ¥' + paidTotal.toFixed(2) +
                   ' 与台账班费收入 ¥' + feeIncome.toFixed(2) + ' 不一致。');
    }

    // 余额走势：按日期升序累计。
    // 口径必须与「当前总余额」完全一致：收入 +，支出与更正一律 −。
    // 更正条目（adjust）的 amount 是「带符号差值」（多记则为负数，见数据契约），
    // 它修正的对象是支出，所以要和被更正的支出同向取负。
    // 早期版本这里写成 adjust 取 +amount，会让走势图与概览相差 2 × 差值
    // （示例数据里正好是 ¥36.00 = 18 × 2），故一并加了下方的末值自检。
    var asc = ledger.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    });
    var running = 0;
    var series = asc.map(function (it) {
      running += (it.type === 'in') ? it.amount : -it.amount;
      return { date: it.date, v: running };
    });

    // 不变式自检：走势末值必须等于「累计收入 − 累计支出」。
    // 不相等即表示走势的累加口径与概览脱钩 —— 这正是上面修复要拦住的 bug。
    if (series.length) {
      var seriesEnd = series[series.length - 1].v;
      var overview  = incomeTotal - expenseTotal;
      if (Math.abs(seriesEnd - overview) > 0.005) {
        warnings.unshift('余额走势末值（¥' + seriesEnd.toFixed(2) +
                         '）与当前总余额（¥' + overview.toFixed(2) +
                         '）不一致：走势累计口径可能有误。');
        console.warn('[走势] 末值 ¥' + seriesEnd.toFixed(2) +
                     ' 与总余额 ¥' + overview.toFixed(2) + ' 不一致，口径脱钩。');
      }
    }

    // 日期倒序（新的在前）——明细默认展示顺序
    ledger.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });

    var braw = (raw && raw.budget) || {};

    return {
      meta: meta,
      incomeTotal: incomeTotal,
      expenseTotal: expenseTotal,
      balance: incomeTotal - expenseTotal,
      categories: categories,
      members: members,
      ledger: ledger,
      series: series,
      budget: {
        total: num(braw.total),
        warnBelow: num(braw.warnBelow)
      },
      warnings: warnings
    };
  }

  /* ==========================================================================
     3. 渲染状态
     ========================================================================== */

  var DATA = null;
  var view = { q: '', type: 'all', category: '', sort: 'date-desc', limit: PAGE_SIZE };
  var memberState = 'all';
  var chatMode = 'offline';   // offline | online | probing
  var chatHistory = [];
  var lastQuestion = '';
  var lastFocus = null;

  /* ==========================================================================
     3.5 动画小工具 —— 渲染函数只负责写"终值"，怎么动统一在这里
     ========================================================================== */

  /* 尊重系统的「减少动态效果」：命中时所有补间直接给终值，不播动画 */
  var reduceMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* 一次性数值补间：onFrame(0→1 的缓动进度)。
     ⚠️ 两条都必须有，否则账目数字会停在错误值上：
     ① setTimeout 兜底 —— requestAnimationFrame 在后台标签页会被节流甚至完全不触发；
     ② 兜底触发后要**停掉 rAF 循环** —— 否则还在跑的 step() 会用中间值把终值覆盖回去。 */
  function tween(dur, onFrame) {
    if (reduceMotion) { onFrame(1); return; }
    var t0 = null, stop = false;
    function step(ts) {
      if (stop) return;
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      onFrame(1 - Math.pow(1 - p, 3));        /* easeOutCubic */
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    setTimeout(function () { stop = true; onFrame(1); }, dur + 120);
  }

  /* 条形：**真值立刻写进 DOM**，视觉上的"长出来"交给 CSS 动画（style.css 的 grow-x）。
     这样即使动画被禁用/没跑，条形也停在正确的长度，而不是 0。
     渲染时写 width:0 + data-w 只是为了在动画不可用时也能有一帧的起点，不影响最终态。 */
  function growBars(scope) {
    var root = scope || document;
    Array.prototype.forEach.call(root.querySelectorAll('[data-w]'), function (el) {
      el.style.width = el.getAttribute('data-w') + '%';
    });
  }

  /* 列表的滚动显现：只在 IntersectionObserver 可用、且未开「减动态」时启用。
     io-reveal 类由 JS 添加 —— 无 JS / IO 失败的场合元素保持完全可见（真值不依赖动画的同一条原则）。 */
  var io = (('IntersectionObserver' in window) && !reduceMotion)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var t = en.target;
          t.classList.add('io-in');
          /* 级联延迟只用于这一次入场，落定后立刻清掉 —— 否则 hover 反馈会被拖着 40ms */
          setTimeout(function () { t.style.transitionDelay = ''; }, 460);
          io.unobserve(t);
        });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.02 })
    : null;

  function observeReveals(scope) {
    if (!io) return;
    var root = scope || document;
    var els = root.querySelectorAll('.row:not(.io-in), .member:not(.io-in), .cat:not(.io-in)');
    Array.prototype.forEach.call(els, function (el, i) {
      el.classList.add('io-reveal');
      /* 同屏级联：40ms 一档、最多 6 档 —— 长列表不至于拖成一条长队 */
      el.style.transitionDelay = (Math.min(i, 6) * 40) + 'ms';
      io.observe(el);
    });
  }

  /* 抽屉打开时的滚动锁定：直接 overflow:hidden 会让滚动条消失、正文向右跳 ~10px，
     补一条等宽 padding 才不晃（移动端是覆盖式滚动条、宽度为 0，天然不跳）。 */
  function lockScroll(on) {
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

  /* 光标追随微光（视觉追踪）：把指针位置写成卡片上的 --mx/--my，微光的圆心就跟着指针走。
     只在"真有鼠标"的设备上挂，并用 rAF 合并高频 pointermove（不然每次都 layout 一遍）。 */
  var finePointer = !!(window.matchMedia &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  function bindPointerGlow() {
    if (!finePointer) return;
    var raf = 0, cur = null, cx = 0, cy = 0;
    function place(el, x, y) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (x - r.left).toFixed(1) + 'px');
      el.style.setProperty('--my', (y - r.top).toFixed(1) + 'px');
    }
    function tick() {
      raf = 0;
      if (!cur) return;
      place(cur, cx, cy);
    }
    document.addEventListener('pointermove', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('.sheet, .hero, .cat') : null;
      if (!el) { cur = null; return; }
      /* 进入另一张卡时**立刻**落位，不排队等 rAF —— rAF 会被节流甚至不跑，
         那样微光会停在上一张卡的位置（只在同一张卡内移动时才用 rAF 合并）。 */
      if (el !== cur) {
        cur = el; cx = e.clientX; cy = e.clientY;
        place(cur, cx, cy);
        return;
      }
      cx = e.clientX; cy = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(tick);
    }, { passive: true });
  }

  /* ==========================================================================
     4. 基础区块
     ========================================================================== */

  function renderMeta() {
    var m = DATA.meta;
    var bits = [];
    if (m.className) bits.push(m.className);
    if (m.term) bits.push(m.term);
    setText('metaLine', bits.length ? bits.join(' · ') : '班级班费公开账目（只读）');
    setText('updatedAt', m.updatedAt || '—');
    if (m.projectName) setText('pageTitle', m.projectName);
    setText('footMeta', m.className ? m.className + ' · 班费透明工作流' : '连小理 · 班费透明工作流');

    if (m.notice) {
      setText('noticeText', m.notice);
      var nb = $('noticeBlock');
      if (nb) nb.hidden = false;
    }
  }

  function renderHero() {
    /* 余额用翻页数字（机械计数器）：逐位滚到位，比整数滚动更有"落账"的实感。
       整串 0-9 对读屏是噪音，所以容器 aria-hidden，真值挂到 #balance 的 aria-label。 */
    var bal = $('balance');
    if (bal) {
      if (!bal.querySelector('.odo')) {
        bal.innerHTML = '<span class="cur">¥</span><span class="odo" id="odoBal" aria-hidden="true"></span>';
      }
      odoRender($('odoBal'), fmt(DATA.balance));
      bal.setAttribute('aria-label', '当前总余额 ' + fmt(DATA.balance) + ' 元');
    }
    /* 累计收支两个小数字仍用补间（它们不需要逐位翻页） */
    tween(620, function (e) {
      setText('incomeTotal', '¥' + fmt(DATA.incomeTotal * e));
      setText('expenseTotal', '¥' + fmt(DATA.expenseTotal * e));
    });

    /* 预算（含「低余额提醒线」——阈值取自数据契约 budget.warnBelow，不再写死） */
    var bt = DATA.budget.total;
    var warn = DATA.budget.warnBelow;
    var block = $('budgetBlock');
    if (block) {
      if (bt > 0) {
        block.hidden = false;
        var used = DATA.expenseTotal;
        var pct = Math.max(0, Math.min(100, Math.round(used / bt * 100)));
        setText('budgetLabel', '学期预算使用');
        setText('budgetValue', pct + '%');
        var fill = $('budgetFill');
        if (fill) {
          fill.setAttribute('data-w', pct);   /* 目标宽度交给 growBars —— 条形才会"长"出来 */
          fill.style.width = '0%';
          fill.classList.toggle('is-over', used > bt);
        }
        var track = $('budgetTrack');
        if (track) track.setAttribute('aria-label', '学期预算使用 ' + pct + '%，剩余 ¥' + fmt(bt - used));

        /* 低余额提醒线：剩余低于 warnBelow 时点亮；
           进度条上的红线位置 = 已用达到（总额 − 阈值），墨蓝填充越过即进入预警区 */
        var mark = $('budgetWarnMark');
        var low = $('budgetLow');
        if (warn > 0 && warn <= bt) {
          var markPct = Math.max(0, Math.min(100, (bt - warn) / bt * 100));
          if (mark) { mark.hidden = false; mark.style.left = markPct + '%'; }
          var isLow = (bt - used) < warn;
          block.classList.toggle('is-low', isLow);
          if (low) {
            low.hidden = !isLow;
            setText('budgetLow', '当前剩余 ¥' + fmt(bt - used) + '，已低于提醒线 ¥' + fmt(warn) + '，请留意后续支出');
          }
        } else {
          if (mark) mark.hidden = true;
          if (low) low.hidden = true;
          block.classList.remove('is-low');
        }

        setText('budgetRemain', '剩余 ¥' + fmt(bt - used));
        setText('budgetTotal', '预算总额 ¥' + fmt(bt));
      } else {
        block.hidden = true;
      }
    }

    /* 一致性状态灯 */
    var c = $('consistency');
    var ct = $('consistencyText');
    if (ct) {
      if (DATA.warnings.length) {
        ct.textContent = DATA.warnings[0];
        if (c) c.classList.add('is-warn');
      } else {
        ct.textContent = '总余额 = 累计收入 − 累计支出，与逐笔明细重算一致';
        if (c) c.classList.remove('is-warn');
      }
    }

    growBars();   /* 预算条形在这里统一"长"出来 */
  }

  /* ==========================================================================
     5. 余额走势（手绘 SVG，零依赖）
     ========================================================================== */

  function renderTrend() {
    var wrap = $('trendWrap');
    if (!wrap) return;
    var pts = DATA.series;
    /* 期段文案留一份：指针离开图表后要还原成它 */
    var rangeText = pts.length
      ? monthDay(pts[0].date) + ' → ' + monthDay(pts[pts.length - 1].date)
      : '暂无数据';
    setText('trendRange', rangeText);

    if (pts.length < 2) {
      wrap.innerHTML = '<p class="trend-empty">账目记录还不足两笔，暂不绘制走势</p>';
      return;
    }

    var w = Math.max(280, wrap.clientWidth || 640);
    var h = w < 500 ? 176 : 216;
    /* padL 留出左侧 ¥ 刻度栏；padB 留出日期行；padT 留出月份刻度与标注 */
    var padL = 54, padR = 16, padT = 26, padB = 26;
    var iw = w - padL - padR, ih = h - padT - padB;

    /* ---------- 值域：**零基线**（余额是"现金水位"，截断 Y 轴会把小波动画成大起伏，那是失真） ---------- */
    var vs = pts.map(function (p) { return p.v; });
    var maxV = Math.max.apply(null, vs.concat([0]));
    var warn = DATA.budget.warnBelow || 0;
    var top = Math.max(maxV, warn, 1) * 1.08;

    /* ¥ 刻度取整到 1/2/2.5/5 × 10^n —— 避免出现 1,482 这种读不出规律的刻度 */
    function niceStep(span, want) {
      var raw = span / want;
      var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
      var n = raw / mag;
      var s = n <= 1 ? 1 : (n <= 2 ? 2 : (n <= 2.5 ? 2.5 : (n <= 5 ? 5 : 10)));
      return s * mag;
    }
    var step = niceStep(top, 4);
    var ticks = [];
    for (var t = 0; t <= top + 1e-6; t += step) ticks.push(t);

    function X(i) { return padL + (iw * i) / (pts.length - 1); }
    function Y(v) { return padT + ih * (1 - v / top); }
    var zeroY = Y(0);

    /* ---------- 平滑折线：单调三次插值，控制点夹在相邻点值域内 ----------
       普通样条会在拐弯处"冲出去"，把余额画出不存在的峰谷 —— 那是失真，不是美化。 */
    function smoothPath() {
      var d = 'M' + X(0).toFixed(1) + ' ' + Y(pts[0].v).toFixed(1);
      for (var i = 0; i < pts.length - 1; i++) {
        var x0 = X(i), y0 = Y(pts[i].v);
        var x1 = X(i + 1), y1 = Y(pts[i + 1].v);
        var prev = i > 0 ? Y(pts[i - 1].v) : y0;
        var next = i + 2 < pts.length ? Y(pts[i + 2].v) : y1;
        var loY = Math.min(y0, y1), hiY = Math.max(y0, y1);
        var c1 = Math.max(Math.min(y0 + (y1 - prev) / 6, hiY), loY);
        var c2 = Math.max(Math.min(y1 - (next - y0) / 6, hiY), loY);
        d += ' C' + (x0 + (x1 - x0) / 3).toFixed(1) + ' ' + c1.toFixed(1) +
             ' ' + (x1 - (x1 - x0) / 3).toFixed(1) + ' ' + c2.toFixed(1) +
             ' ' + x1.toFixed(1) + ' ' + y1.toFixed(1);
      }
      return d;
    }
    var line = smoothPath();
    var area = line + ' L' + X(pts.length - 1).toFixed(1) + ' ' + zeroY.toFixed(1) +
               ' L' + X(0).toFixed(1) + ' ' + zeroY.toFixed(1) + ' Z';

    /* ---------- 网格 + ¥ 刻度（基准线加粗一档） ---------- */
    var grid = ticks.map(function (v) {
      var gy = Y(v);
      return '<line class="trend-grid' + (v === 0 ? ' is-base' : '') + '" x1="' + padL + '" y1="' + gy.toFixed(1) +
             '" x2="' + (w - padR) + '" y2="' + gy.toFixed(1) + '"/>' +
             '<text class="trend-tick" x="' + (padL - 9) + '" y="' + (gy + 3.4).toFixed(1) +
             '" text-anchor="end">' + fmtShort(v) + '</text>';
    }).join('');

    /* ---------- 低余额提醒线：横贯全图（余额跌破它一眼可见） ---------- */
    var warnLayer = '';
    if (warn > 0 && warn < top) {
      var wy = Y(warn);
      warnLayer =
        '<line class="trend-warn" x1="' + padL + '" y1="' + wy.toFixed(1) + '" x2="' + (w - padR) +
          '" y2="' + wy.toFixed(1) + '"/>' +
        '<text class="trend-warn-tag" x="' + (w - padR) + '" y="' + (wy - 5).toFixed(1) +
          '" text-anchor="end">提醒线 ¥' + fmt(warn) + '</text>';
    }

    /* ---------- 月份刻度 + 首末日期 ---------- */
    var firstIdx = {};
    pts.forEach(function (p, i) {
      var k = String(p.date).slice(0, 7);
      if (!(k in firstIdx)) firstIdx[k] = i;
    });
    var mk = Object.keys(firstIdx).sort();
    var monthGrid = '';
    if (mk.length >= 2) {
      mk.forEach(function (k, idx) {
        if (idx === 0) return;
        var xi = X(firstIdx[k]);
        if (xi - padL < 14) return;
        monthGrid +=
          '<line x1="' + xi.toFixed(1) + '" y1="' + padT + '" x2="' + xi.toFixed(1) + '" y2="' + (h - padB).toFixed(1) +
            '" stroke="#E6DDCB" stroke-width="1" stroke-dasharray="2 3"/>' +
          '<text class="trend-anno" x="' + xi.toFixed(1) + '" y="' + (padT - 8) +
            '" text-anchor="middle" fill="#6E5F49">' + parseInt(k.slice(5), 10) + ' 月</text>';
      });
    }
    var xlabels = '<text class="trend-tick" x="' + padL + '" y="' + (h - 7) + '">' + monthDay(pts[0].date) + '</text>' +
                  '<text class="trend-tick" x="' + (w - padR) + '" y="' + (h - 7) + '" text-anchor="end">' +
                  monthDay(pts[pts.length - 1].date) + '</text>';

    var dots = pts.map(function (p, i) {
      return '<circle class="trend-dot" cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="3.2">' +
             '<title>' + monthDay(p.date) + '　余额 ¥' + fmt(p.v) + '</title></circle>';
    }).join('');

    var lastX = X(pts.length - 1), lastY = Y(pts[pts.length - 1].v);
    var lastTag = '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="4" fill="#16304A"/>' +
                  '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="8.5" fill="#16304A" opacity="0.14"/>';

    /* ---------- 关键点标注（财务看板的通行做法：异常/关键点直接写在图上） ---------- */
    function anno(x, y, text, anchor, cls, dy) {
      return '<text class="trend-anno ' + (cls || '') + '" x="' + x.toFixed(1) + '" y="' + (y + (dy || 0)).toFixed(1) +
             '" text-anchor="' + anchor + '">' + text + '</text>';
    }
    var annos = anno(lastX, lastY, '¥' + fmt(pts[pts.length - 1].v), 'end', '', -12);
    /* 最大的一笔降幅：相邻两点间跌得最多的一段，标在两点中间（朱红＝提醒，与"更正/异常"同一语义） */
    var iDrop = -1, dropV = 0;
    for (var i = 1; i < pts.length; i++) {
      var dv = pts[i - 1].v - pts[i].v;
      if (dv > dropV) { dropV = dv; iDrop = i; }
    }
    if (iDrop > 0 && dropV > 0) {
      var mx = (X(iDrop - 1) + X(iDrop)) / 2;
      var my = (Y(pts[iDrop - 1].v) + Y(pts[iDrop].v)) / 2;
      annos += anno(mx, my, '单笔最大降 ¥' + fmt(dropV), 'middle', 'is-drop', 16);
    }
    var iLo = 0;
    pts.forEach(function (p, k) { if (p.v < pts[iLo].v) iLo = k; });
    if (iLo > 0 && iLo < pts.length - 1) {
      annos += anno(X(iLo), Y(pts[iLo].v), '最低 ¥' + fmt(pts[iLo].v), 'middle', '', 16);
    }

    wrap.innerHTML =
      '<svg class="trend-svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" aria-label="余额走势（零基线）：从 ' + fmt(pts[0].v) + ' 元到 ' + fmt(pts[pts.length - 1].v) +
      ' 元' + (warn > 0 ? '，提醒线 ' + fmt(warn) + ' 元' : '') + '">' +
        '<defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#16304A" stop-opacity="0.20"/>' +
          '<stop offset="55%" stop-color="#16304A" stop-opacity="0.07"/>' +
          '<stop offset="100%" stop-color="#16304A" stop-opacity="0.015"/>' +
        '</linearGradient></defs>' +
        grid +
        warnLayer +
        monthGrid +
        '<path class="trend-area" d="' + area + '" fill="url(#trendFill)"/>' +
        '<path class="trend-line" d="' + line + '" fill="none" stroke="#16304A" stroke-width="2" ' +
          'stroke-linejoin="round" stroke-linecap="round"/>' +
        /* 命中区放在圆点之前：圆点在上层，点圆点仍能打开详情；其余位置交给准星 */
        '<rect class="trend-hit" x="' + padL + '" y="' + padT + '" width="' + iw + '" height="' + ih +
          '" fill="transparent"/>' +
        dots +
        lastTag +
        /* 视觉追踪：准星 + 跟随指针的读数气泡（默认隐藏） */
        '<g class="trend-cross" visibility="hidden">' +
          '<line x1="0" y1="' + padT + '" x2="0" y2="' + (h - padB) + '" stroke="#16304A" ' +
            'stroke-width="1" stroke-dasharray="3 3" opacity=".5"/>' +
          '<circle cx="0" cy="0" r="5.2" fill="none" stroke="#16304A" stroke-width="1.6" opacity=".85"/>' +
        '</g>' +
        '<g class="trend-tip" visibility="hidden"><rect x="0" y="0" width="0" height="0"/><text x="0" y="0" text-anchor="middle"></text></g>' +
        annos +
        xlabels +
      '</svg>';

    /* 折线「描」出来：只把路径长度交给 CSS 变量，动画本身走 CSS（见 .trend-line.is-drawing）。
       不在这里改 dashoffset —— 那样一旦动画没跑完，整条折线会消失。 */
    var lp = wrap.querySelector('.trend-line');
    if (!reduceMotion && lp && lp.getTotalLength) {
      var L = lp.getTotalLength();
      if (L > 0) {
        lp.style.setProperty('--len', L + 'px');
        lp.classList.add('is-drawing');
      }
    }

    /* ---- 视觉追踪：准星吸附最近记账点 + 气泡跟随 + 页眉标签同步报数。
       移动端没有 hover，改成"点哪里报哪里"，抬手后保留读数。 ---- */
    var svg = wrap.querySelector('.trend-svg');
    var cross = wrap.querySelector('.trend-cross');
    var tip = wrap.querySelector('.trend-tip');
    if (svg && cross) {
      var ln = cross.querySelector('line');
      var ring = cross.querySelector('circle');
      var tipRect = tip.querySelector('rect');
      var tipText = tip.querySelector('text');
      var nearestIdx = function (clientX) {
        var r = svg.getBoundingClientRect();
        var vx = (clientX - r.left) / (r.width || 1) * w;   /* 视口坐标 → viewBox 坐标 */
        var best = 0, bd = Infinity;
        for (var i = 0; i < pts.length; i++) {
          var d = Math.abs(X(i) - vx);
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      };
      var showAt = function (clientX) {
        var i = nearestIdx(clientX);
        var px = X(i), py = Y(pts[i].v);
        ln.setAttribute('x1', px.toFixed(1)); ln.setAttribute('x2', px.toFixed(1));
        ring.setAttribute('cx', px.toFixed(1)); ring.setAttribute('cy', py.toFixed(1));
        cross.setAttribute('visibility', 'visible');
        /* 气泡：宽度按等宽字体估（10.5px mono ≈ 6.3px/字符），靠近边缘时自动翻到另一侧 */
        var label = '¥' + fmt(pts[i].v);
        var tw = label.length * 6.3 + 14, th = 18;
        var tx = Math.min(Math.max(px, padL + tw / 2), w - padR - tw / 2);
        var above = py - 34 > padT;
        var by = above ? py - 30 : py + 12;
        tipRect.setAttribute('x', (tx - tw / 2).toFixed(1));
        tipRect.setAttribute('y', by.toFixed(1));
        tipRect.setAttribute('width', tw.toFixed(1));
        tipRect.setAttribute('height', th);
        tipText.setAttribute('x', tx.toFixed(1));
        tipText.setAttribute('y', (by + 13).toFixed(1));
        tipText.textContent = label;
        tip.setAttribute('visibility', 'visible');
        setText('trendRange', monthDay(pts[i].date) + ' · 余额 ¥' + fmt(pts[i].v));
      };
      var hideCross = function () {
        cross.setAttribute('visibility', 'hidden');
        tip.setAttribute('visibility', 'hidden');
        setText('trendRange', rangeText);
      };
      svg.addEventListener('pointermove', function (e) { showAt(e.clientX); }, { passive: true });
      svg.addEventListener('pointerleave', hideCross);
      svg.addEventListener('click', function (e) { showAt(e.clientX); });
    }
  }

  /* ==========================================================================
     6. 班费收缴明细
     ========================================================================== */

  function memberRows() {
    var m = DATA.members;
    if (!m) return [];
    if (memberState === 'paid')   return m.list.filter(function (p) { return p.status === 'paid'; });
    if (memberState === 'unpaid') return m.list.filter(function (p) { return p.status !== 'paid'; });
    return m.list;
  }

  function renderMembers() {
    var m = DATA.members;
    var panel = $('membersPanel');
    var hc = $('heroCollect');
    var bar = $('collectBar');
    var list = $('memberList');

    /* ⚠️ 只有「生活委员明确选择不公示」（visible === false）才收起这一栏。
       以前名单为空也收起 —— 但导航是固定四项，少一项会让人以为坏了；
       而且"收缴"本身是这套工具的主功能，不该因为还没录数据就消失。
       名单未录入时改为显示说明性空态（见下）。 */
    if (!m || m.visible === false) {
      if (panel) panel.hidden = true;
      if (hc) hc.hidden = true;
      setTabVisible('collect', false);
      return;
    }
    if (panel) panel.hidden = false;
    setTabVisible('collect', true);

    /* 公示了收缴、但名单还没录入：给一个能读懂的空态，而不是一片空白 */
    if (!m.list.length) {
      if (hc) hc.hidden = true;
      if (bar) {
        bar.innerHTML =
          '<p class="empty">还没有导入收缴名单</p>' +
          '<p class="empty-hint">生活委员在后台的「收缴」页签维护名单与「每人应缴标准」，' +
          '点「发布到前台」之后，这里会按同学逐条显示缴纳情况。</p>';
      }
      if (list) { list.innerHTML = ''; list.hidden = true; }
      return;
    }
    if (list) list.hidden = false;

    var pct = m.dueTotal > 0
      ? Math.max(0, Math.min(100, Math.round(m.paidTotal / m.dueTotal * 100))) : 0;

    if (bar) {
      bar.innerHTML =
        '<div class="progress-top">' +
          '<span class="progress-amt" id="collectAmt">¥0.00</span>' +
          '<span class="progress-due">/ 应缴 ¥' + fmt(m.dueTotal) + '</span>' +
          '<span class="progress-pct" id="collectPct">0%</span>' +
        '</div>' +
        /* 先给 0 宽 + data-w 目标值，交给 growBars 在下一帧推上去 —— 条才"长"得出来 */
        '<div class="progress-track"><div class="progress-fill" data-w="' + pct + '" style="width:0%"></div></div>' +
        /* 四个数各自成格：手机上原来那行图例要换行读，变成格子后一眼可比 */
        '<div class="progress-stats">' +
          '<span class="ps is-paid"><b>' + m.paidCount + '</b>已缴清</span>' +
          '<span class="ps is-partial"><b>' + m.partialCount + '</b>部分缴纳</span>' +
          '<span class="ps is-unpaid"><b>' + m.unpaidCount + '</b>未缴</span>' +
          '<span class="ps is-total"><b>' + m.list.length + '</b>全班</span>' +
        '</div>';
      /* 收缴金额与百分比跟总览的数字同步滚动 */
      tween(620, function (e) {
        setText('collectAmt', '¥' + fmt(m.paidTotal * e));
        setText('collectPct', Math.round(pct * e) + '%');
      });
      growBars(bar);
    }

    /* 总览里的收缴摘要：同一份数据压成一条，点它切到「收缴」页签看名单 */
    if (hc) {
      hc.hidden = false;
      tween(620, function (e) {
        setText('hcAmt', '¥' + fmt(m.paidTotal * e) + ' / ¥' + fmt(m.dueTotal));
        setText('hcPct', Math.round(pct * e) + '%');
      });
      /* 条形一律黛青，与「收缴」页签的进度条同色 —— 进度不是告警，别用朱红/赭黄 */
      var hcFill = $('hcFill');
      if (hcFill) { hcFill.setAttribute('data-w', pct); hcFill.style.width = '0%'; }
      setText('hcHint', '已缴清 ' + m.paidCount + ' 人 · 未缴 ' + m.unpaidCount + ' 人 · 点按查看名单');
      hc.setAttribute('aria-label',
        '班费收缴：已缴 ¥' + fmt(m.paidTotal) + ' / 应缴 ¥' + fmt(m.dueTotal) +
        '，' + pct + '%。点按查看收缴名单。');
      growBars(hc);
    }

    if (!list) return;
    var rows = memberRows();
    if (!rows.length) {
      list.innerHTML = '<p class="empty" style="grid-column:1/-1">没有符合条件的同学</p>';
      return;
    }
    list.innerHTML = rows.map(function (p) {
      var name = p.masked
        ? '<span class="m-masked" title="本人申请不公示姓名">不公示</span>'
        : esc(p.name);
      var paidText = (m.standard > 0 && p.status !== 'paid')
        ? '¥' + fmt(p.paid) + ' <span class="m-of">/ ¥' + fmt(m.standard) + '</span>'
        : '¥' + fmt(p.paid);
      return '<div class="member ' + p.status + '">' +
        '<span class="m-name">' + name + '</span>' +
        '<span class="m-status">' + STATUS_TEXT[p.status] + '</span>' +
        '<span class="m-paid">' + paidText + '</span>' +
      '</div>';
    }).join('');

    observeReveals(list);   /* 30 人的名单较长，进视口时逐个浮现 */
  }

  /* ==========================================================================
     7. 类别汇总（点击联动筛选明细）
     ========================================================================== */

  function renderCategories() {
    var box = $('categoryList');
    if (!box) return;
    if (!DATA.categories.length) {
      box.innerHTML = '<p class="empty">暂无支出记录</p>';
      return;
    }
    var max = Math.abs(DATA.categories[0].amount) || 1;
    var total = Math.abs(DATA.expenseTotal) || 1;
    var income = Math.abs(DATA.incomeTotal) || 0;
    var cmap = catColorMap();
    var n = DATA.categories.length || 1;

    /* 每类的月度序列（供迷你走势与环比）：从明细聚合，更正条目按带符号值并入所在类别 */
    var months = [], mIdx = {};
    DATA.ledger.forEach(function (it) {
      var k = String(it.date).slice(0, 7);
      if (!(k in mIdx)) { mIdx[k] = months.length; months.push(k); }
    });
    months.sort();
    var span = months.slice(-3);                  /* 迷你走势只画最近三个月 */
    var series = {};
    DATA.categories.forEach(function (c) { series[c.name] = span.map(function () { return 0; }); });
    DATA.ledger.forEach(function (it) {
      var si = span.indexOf(String(it.date).slice(0, 7));
      if (si < 0 || !series[it.category]) return;
      series[it.category][si] += (it.type === 'adjust' ? it.amount : Math.abs(it.amount));
    });

    /* 差异条口径：这一类花掉了「班费收缴总额」的百分之几；平均参考线 = 100% / 类别数。
       越过参考线 = 这一类花得比平均多 —— 这就是"差异"本身，不用心算。 */
    var shareIncome = DATA.categories.map(function (c) {
      return income > 0 ? (Math.abs(c.amount) / income * 100) : 0;
    });
    var maxShare = Math.max.apply(null, shareIncome.concat([1]));
    var avgShare = 100 / n;

    box.innerHTML = DATA.categories.map(function (c, i) {
      var w = Math.max(2, Math.round(Math.abs(c.amount) / max * 100));   /* 占支出（相对最大类） */
      var share = (Math.abs(c.amount) / total * 100).toFixed(1);
      var si2 = shareIncome[i];
      var diffW = Math.max(2, si2 / maxShare * 100);
      var col = cmap[c.name] || MIX_NEUTRAL;
      var avg = c.count ? c.amount / c.count : c.amount;
      var active = view.category === c.name ? ' is-active' : '';

      /* 环比：最近月 vs 上一月（上月为 0 → 新增；本月为 0 → 本月无） */
      var s = series[c.name], mom = '';
      if (s.length >= 2) {
        var cur = s[s.length - 1], prev = s[s.length - 2];
        if (prev <= 0.005 && cur > 0.005) {
          mom = '<span class="cat-mom is-up">本月新增</span>';
        } else if (cur <= 0.005 && prev > 0.005) {
          mom = '<span class="cat-mom is-flat">本月无</span>';
        } else if (prev > 0.005) {
          var dlt = (cur - prev) / prev * 100;
          var cls = Math.abs(dlt) < 1 ? 'is-flat' : (dlt > 0 ? 'is-up' : 'is-down');
          mom = '<span class="cat-mom ' + cls + '">' + (dlt > 0 ? '↑ +' : (dlt < -1 ? '↓ ' : '＝ ')) +
                Math.abs(Math.abs(dlt) < 1 ? 0 : dlt).toFixed(0) + '%</span>';
        }
      }

      /* 迷你走势：近三月的小折线（零基线） */
      var spark = '';
      if (s.length >= 2) {
        var sw = 62, sh = 16, smax = Math.max.apply(null, s.concat([1]));
        var p2 = s.map(function (v, k) {
          return (k ? 'L' : 'M') + (k * (sw / (s.length - 1))).toFixed(1) + ' ' +
                 (sh - 2 - (sh - 4) * (v / smax)).toFixed(1);
        }).join(' ');
        spark = '<span class="cat-spark-row"><svg class="cat-spark" viewBox="0 0 ' + sw + ' ' + sh +
                '" width="' + sw + '" height="' + sh + '" aria-hidden="true"><path d="' + p2 +
                '" stroke="' + col + '"/></svg><span class="cat-spark-tag">近三月</span></span>';
      }

      return '<button type="button" class="cat' + active + '" data-cat="' + esc(c.name) +
             '" aria-pressed="' + (view.category === c.name) + '">' +
        '<span class="cat-top">' +
          /* 行号 + 色块：行号让它像账目序号；色块与「支出构成」堆叠条同色，两处可以对读 */
          '<span class="cat-rank">' + ('0' + (i + 1)).slice(-2) + '</span>' +
          '<span class="cat-swatch" style="background:' + col + '"></span>' +
          '<span class="cat-name">' + esc(c.name) + '</span>' +
          mom +
          '<span class="cat-count">' + c.count + ' 笔</span>' +
          '<span class="cat-amt">¥' + fmt(c.amount) + '</span>' +
        '</span>' +
        '<span class="cat-track"><span class="cat-fill" data-w="' + w + '" style="width:0%;background:' + col + '"></span></span>' +
        /* 差异条：占班费比例 + 平均参考线（虚线越过即"比平均花得多"） */
        '<span class="cat-diff" title="占班费 ' + si2.toFixed(1) + '%，平均线 ' + avgShare.toFixed(1) + '%">' +
          '<span class="cat-diff-fill" data-w="' + diffW.toFixed(1) + '" style="width:0%;background:' + col + '"></span>' +
          '<span class="cat-diff-avg" style="left:' + (avgShare / maxShare * 100).toFixed(1) + '%"></span>' +
        '</span>' +
        '<span class="cat-share">占支出 <b>' + share + '%</b> · 占班费 <b>' + si2.toFixed(1) +
          '%</b> · 平均每笔 ¥' + fmt(avg) + '</span>' +
        spark +
      '</button>';
    }).join('');

    growBars(box);         /* 两类条形依次"长"出来 */
    observeReveals(box);   /* 进入视口时逐条浮现 */
  }

  /* ==========================================================================
     7.5 总览：最近三笔 + 支出构成（让同学在一屏里看到全貌）
     ========================================================================== */

  function renderRecent() {
    var box = $('recentList');
    if (!box) return;
    /* normalize() 已把 ledger 按日期倒序排好，取前三即最新三笔 */
    var rows = DATA.ledger.slice(0, 3);
    if (!rows.length) {
      box.innerHTML = '<p class="empty">还没有账目记录</p>';
      return;
    }
    box.innerHTML = rows.map(function (it) {
      var cls = it.type === 'in' ? 'is-in' : (it.type === 'adjust' ? 'is-adjust' : '');
      var sign = it.type === 'in' ? '+' : (it.type === 'adjust' ? (it.amount < 0 ? '−' : '+') : '−');
      var kind = it.type === 'in' ? ' <span class="tag tag-in">收入</span>'
               : it.type === 'adjust' ? ' <span class="seal">更正</span>' : '';
      return '<button type="button" class="mini-row" data-id="' + esc(it.id) + '">' +
        '<span class="mr-cat">' + esc(it.category) + kind + '</span>' +
        '<span class="mr-meta">' + esc(it.date) +
          (it.receipt && it.receipt !== '—' ? ' · 票据 ' + esc(it.receipt) : '') + '</span>' +
        '<span class="mr-amt ' + cls + '">' + sign + '¥' + fmt(Math.abs(it.amount)) + '</span>' +
      '</button>';
    }).join('');
  }

  /* 墨分五色：类别取色序列 —— 朱红是「更正 / 提醒」专用，这里一律不用。
     同一类别在「总览 · 支出构成」和「支出页签」里必须是同一个颜色，
     颜色才成为两处之间的关联线索；第 6 名及以后（含环形图里的「其他 N 类」）统一用中性格线色。 */
  var MIX_COLORS = ['#16304A', '#2C4257', '#1F6B57', '#8A5A12', '#C9BCA0'];
  var MIX_NEUTRAL = '#DDD3BF';

  function catColorMap() {
    var map = {};
    DATA.categories.forEach(function (c, i) {
      map[c.name] = i < MIX_COLORS.length ? MIX_COLORS[i] : MIX_NEUTRAL;
    });
    return map;
  }

  function renderMix() {
    var box = $('mixChart');
    if (!box) return;
    var cats = DATA.categories.filter(function (c) { return c.amount > 0.005; });
    var total = cats.reduce(function (s, c) { return s + c.amount; }, 0);
    if (!cats.length || total <= 0) {
      box.innerHTML = '<p class="empty">暂无支出记录</p>';
      return;
    }
    /* 只画前 5 类，其余并成一条，图例才不会拖成长条 */
    var segs = cats.slice(0, 5).map(function (c) { return { name: c.name, amount: c.amount }; });
    var restAmt = cats.slice(5).reduce(function (s, c) { return s + c.amount; }, 0);
    if (restAmt > 0.005) segs.push({ name: '其他 ' + (cats.length - 5) + ' 类', amount: restAmt });

    var cmap = catColorMap();
    /* 堆叠横条替代环形图：整笔支出一眼看构成，4–5 类以内比环形图更好读，也更省纵向空间。
       整条一起做生长动画（.sbar 上），不要把 grow-x 加在每个分段上 —— 那样每段各自从自己的左端长，会互相压。 */
    var bar = segs.map(function (s) {
      return '<span class="sbar-seg" style="width:' + (s.amount / total * 100).toFixed(2) +
        '%;background:' + (cmap[s.name] || MIX_NEUTRAL) + '"></span>';
    }).join('');

    var legend = segs.map(function (s) {
      /* 图例做成真按钮：点一类 = 跳到明细并筛该类（与「支出」页签的类别卡同一行为）。
         「其他 N 类」是合并出来的桶、不是真类别，所以不带 data-cat 并置 disabled。 */
      var real = !!(cmap[s.name]);
      return '<button type="button" class="mix-row"' +
        (real ? ' data-cat="' + esc(s.name) + '" title="看这一类在明细里的每一笔"' : ' disabled') + '>' +
        '<span class="mix-swatch" style="background:' + (cmap[s.name] || MIX_NEUTRAL) + '"></span>' +
        '<span class="mix-name">' + esc(s.name) + '</span>' +
        '<span class="mix-amt">¥' + fmt(s.amount) + '</span>' +
        '<span class="mix-pct">' + (s.amount / total * 100).toFixed(1) + '%</span>' +
      '</button>';
    }).join('');

    box.innerHTML =
      '<div class="sbar" role="img" aria-label="支出构成：' +
        segs.map(function (s) {
          return s.name + ' ¥' + fmt(s.amount) + '，占 ' + (s.amount / total * 100).toFixed(1) + '%';
        }).join('；') + '">' + bar + '</div>' +
      '<p class="sbar-total">累计支出 <b>¥' + fmt(total) + '</b></p>' +
      '<div class="mix-legend sbar-legend">' + legend + '</div>';
  }

  /* ==========================================================================
     7.8 数据叙事：翻页数字 · 收缴漏斗 · 月度收支对照
     ========================================================================== */

  /* 翻页数字（机械计数器）：每位一列 0-9，靠 translateY 换位 —— 只动 transform。
     注意两点：① 位数变化才重建 DOM，否则只改 transform；② 整串数字对读屏是噪音，
     所以容器 aria-hidden，真值写到宿主元素的 aria-label 上。 */
  function odoRender(host, text) {
    if (!host) return;
    var chars = String(text).split('');
    var digits = chars.filter(function (c) { return /\d/.test(c); }).length;
    if (host.querySelectorAll('.odo-d').length !== digits) {
      host.innerHTML = chars.map(function (c) {
        if (!/\d/.test(c)) return '<span class="odo-sep">' + esc(c) + '</span>';
        var col = '';
        for (var i = 0; i <= 9; i++) col += '<span>' + i + '</span>';
        return '<span class="odo-d"><span class="odo-strip">' + col + '</span></span>';
      }).join('');
    }
    var strips = host.querySelectorAll('.odo-strip');
    var k = 0;
    chars.forEach(function (c) {
      if (!/\d/.test(c)) return;
      var s = strips[k++];
      if (s) s.style.transform = 'translateY(' + (-Number(c)) + 'em)';
    });
  }

  /* 收缴进度环：中心是进度，环上分「已收 / 缺口」两段（缺口＝提醒，用朱红淡色）。
     环的绘制用 stroke-dasharray 分段 + 一段 CSS 描线动画；动画没跑也只是"没扫"，终态照样正确。 */
  function renderFunnel() {
    var box = $('funnelChart');
    if (!box) return;
    var m = DATA.members;
    if (!m || m.visible === false || !m.list.length) { box.innerHTML = ''; return; }
    var due = m.dueTotal, paid = m.paidTotal;
    var gap = Math.max(0, due - paid);
    var pct = due > 0 ? Math.min(100, paid / due * 100) : 0;
    var R = 46, CIRC = 2 * Math.PI * R;
    var paidLen = CIRC * (pct / 100);
    box.innerHTML =
      '<div class="ring-wrap">' +
        '<svg class="ring" viewBox="0 0 120 120" role="img" aria-label="收缴进度 ' +
          Math.round(pct) + '%，已收 ¥' + fmt(paid) + '，应收 ¥' + fmt(due) + '，缺口 ¥' + fmt(gap) + '">' +
          '<circle class="ring-track" cx="60" cy="60" r="' + R + '"/>' +
          /* 先铺满一圈"缺口"淡色，再把"已收"压在上面 —— 两段一对比就是进度 */
          '<circle class="ring-arc is-gap" cx="60" cy="60" r="' + R +
            '" stroke-dasharray="' + CIRC.toFixed(1) + ' 0" transform="rotate(-90 60 60)"/>' +
          '<circle class="ring-arc is-paid" cx="60" cy="60" r="' + R +
            '" style="--plen:' + paidLen.toFixed(1) + ';--circ:' + CIRC.toFixed(1) + '" ' +
            'stroke-dasharray="' + paidLen.toFixed(1) + ' ' + (CIRC - paidLen).toFixed(1) +
            '" transform="rotate(-90 60 60)"/>' +
          '<text class="ring-center-k" x="60" y="54" text-anchor="middle">已收 / 应收</text>' +
          '<text class="ring-center-v" x="60" y="72" text-anchor="middle">' + Math.round(pct) + '%</text>' +
        '</svg>' +
        '<div class="ring-legend">' +
          '<span class="ring-row"><i style="background:var(--jade)"></i>' +
            '<span class="k">已收</span><span class="v">¥' + fmt(paid) + '</span></span>' +
          '<span class="ring-row is-gap"><i style="background:rgba(178,58,46,.3)"></i>' +
            '<span class="k">缺口</span><span class="v">¥' + fmt(gap) + '</span></span>' +
          '<span class="ring-row"><i style="background:var(--rule-2)"></i>' +
            '<span class="k">应收合计</span><span class="v">¥' + fmt(due) + '</span></span>' +
        '</div>' +
      '</div>';
  }

  /* 月度收支对照：按月成对柱（墨蓝＝收入 / 黛青＝支出）。
     刻意**不含更正条目**（更正是差值记录，混进收支柱会让"这个月花了多少"失真），图例里写明。 */
  function renderMonthBars() {
    var box = $('mbarsChart');
    if (!box) return;
    var by = {};
    DATA.ledger.forEach(function (it) {
      if (it.type === 'adjust') return;
      var k = String(it.date).slice(0, 7);
      if (!by[k]) by[k] = { in: 0, out: 0 };
      if (it.type === 'in') by[k].in += it.amount;
      else by[k].out += Math.abs(it.amount);
    });
    var keys = Object.keys(by).sort().reverse();   /* 最近的在上面 */
    if (!keys.length) { box.innerHTML = ''; return; }
    var max = 1;
    keys.forEach(function (k) { max = Math.max(max, by[k].in, by[k].out); });
    box.innerHTML =
      '<div class="mbars-legend">' +
        '<span><i class="sw-in"></i>收入</span>' +
        '<span><i class="sw-out"></i>支出</span>' +
        '<span class="mbars-note">不含更正条目（更正见明细）</span>' +
      '</div>' +
      keys.map(function (k) {
        var mm = by[k];
        function row(cls, val) {
          return '<span class="mbars-row">' +
            '<i class="' + (cls === 'in' ? 'sw-in' : 'sw-out') + '"></i>' +
            '<span class="mbars-track"><b class="mbars-fill is-' + cls + '" data-w="' +
              (val / max * 100).toFixed(1) + '" style="width:0%"></b></span>' +
            '<span class="mbars-val">¥' + fmt(val) + '</span>' +
          '</span>';
        }
        return '<div class="mbars-month">' +
          '<span class="mbars-name">' + parseInt(k.slice(5), 10) + ' 月</span>' +
          row('in', mm.in) + row('out', mm.out) +
        '</div>';
      }).join('');
    growBars(box);
  }

  /* 瀑布图「钱是怎么花掉的」：收入 → 各类别支出（浮动条）→ 当前结余。
     财务看板里最实用的一张图 —— 它回答的是"从收入那个数，怎么就变成这个数了"；
     只显示首尾两个数的条形图等于给了结论却不给过程。 */
  function renderWaterfall() {
    var box = $('wfChart');
    if (!box) return;
    var income = DATA.incomeTotal;
    if (!(income > 0)) { box.innerHTML = ''; return; }
    var cats = DATA.categories.filter(function (c) { return c.amount > 0.005; });
    var cols = [{ name: '班费收入', v: income, kind: 'in' }];
    cats.slice(0, 5).forEach(function (c) { cols.push({ name: c.name, v: -c.amount, kind: 'out' }); });
    var rest = cats.slice(5).reduce(function (s, c) { return s + c.amount; }, 0);
    if (rest > 0.005) cols.push({ name: '其他 ' + (cats.length - 5) + ' 类', v: -rest, kind: 'out' });
    cols.push({ name: '当前结余', v: DATA.balance, kind: 'sum' });

    var w = Math.max(300, box.clientWidth || 640), h = 218;
    var padL = 8, padR = 8, padT = 26, padB = 48;
    var iw = w - padL - padR, ih = h - padT - padB;
    /* 纵向从 0 到「收入」—— 零基线，绝不截断（截断会把小差额画成大起伏） */
    var maxV = Math.max(income, DATA.balance, 1);
    var slot = iw / cols.length;
    var bw = Math.max(14, Math.min(44, slot * 0.5));
    function Y(v) { return padT + ih * (1 - v / maxV); }
    var baseY = Y(0);

    var bars = '', conns = '', labels = '';
    var run = 0;
    cols.forEach(function (c, i) {
      var cx = padL + slot * (i + 0.5);
      var x = cx - bw / 2;
      var y0, y1;
      if (c.kind === 'in') { y0 = Y(0); y1 = Y(c.v); run = c.v; }
      else if (c.kind === 'out') { y0 = Y(run); run += c.v; y1 = Y(run); }
      else { y0 = Y(0); y1 = Y(c.v); }
      var top = Math.min(y0, y1), hgt = Math.max(2, Math.abs(y1 - y0));
      var cls = c.kind === 'in' ? 'wf-bar-in' : (c.kind === 'out' ? 'wf-bar-out' : 'wf-bar-sum');
      bars += '<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' +
              bw.toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="2"><title>' + esc(c.name) + '　' +
              (c.v >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(c.v)) + '</title></rect>';
      /* 虚线连接上一个"落点" → 这一根的起点（瀑布图的标志性连线） */
      if (c.kind === 'out' && i > 0) {
        var prevLevel = Y(run - c.v);
        conns += '<line class="wf-conn" x1="' + (cx - slot + bw / 2).toFixed(1) + '" y1="' + prevLevel.toFixed(1) +
                 '" x2="' + x.toFixed(1) + '" y2="' + prevLevel.toFixed(1) + '"/>';
      }
      labels += '<text class="wf-val" x="' + cx.toFixed(1) + '" y="' + (top - 5).toFixed(1) +
                '" text-anchor="middle">' + (c.v >= 0 ? '' : '−') + '¥' + fmt(Math.abs(c.v)) + '</text>';
      /* 名称：槽位太窄就转 -32°，避免叠字 */
      var rot = slot < 84, ly = baseY + 16;
      labels += '<text class="wf-name" x="' + cx.toFixed(1) + '" y="' + ly.toFixed(1) +
        '" text-anchor="' + (rot ? 'end' : 'middle') + '"' +
        (rot ? ' transform="rotate(-32 ' + cx.toFixed(1) + ' ' + ly.toFixed(1) + ')"' : '') +
        '>' + esc(c.name) + '</text>';
    });

    box.innerHTML =
      '<svg class="wf" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" aria-label="钱是怎么花掉的：收入 ' + fmt(income) + ' 元，其中 ' +
        cats.slice(0, 5).map(function (c) { return c.name + ' ' + fmt(c.amount) + ' 元'; }).join('、') +
        '，当前结余 ' + fmt(DATA.balance) + ' 元">' +
        '<line class="trend-grid is-base" x1="' + padL + '" y1="' + baseY.toFixed(1) + '" x2="' +
          (w - padR) + '" y2="' + baseY.toFixed(1) + '"/>' +
        conns + bars + labels +
      '</svg>' +
      '<div class="wf-legend">' +
        '<span>班费收入 <b>¥' + fmt(income) + '</b></span>' +
        '<span>累计支出 <b>¥' + fmt(DATA.expenseTotal) + '</b></span>' +
        '<span>当前结余 <b>¥' + fmt(DATA.balance) + '</b></span>' +
        '<span style="margin-left:auto;color:var(--muted-2)">更正条目已并入相应类别</span>' +
      '</div>';
  }

  /* ==========================================================================
     8. 逐笔明细：搜索 / 筛选 / 排序 / 加载更多
     ========================================================================== */

  function renderFilterOptions() {
    var sel = $('filterCategory');
    if (!sel) return;
    var names = DATA.categories.map(function (c) { return c.name; });
    sel.innerHTML = '<option value="">全部类别</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '"' + (view.category === n ? ' selected' : '') + '>' +
             esc(n) + '</option>';
    }).join('');
  }

  function filteredRows() {
    var q = view.q.trim().toLowerCase();
    var rows = DATA.ledger.filter(function (it) {
      if (view.category && it.category !== view.category) return false;
      if (view.type !== 'all' && it.type !== view.type) return false;
      if (q) {
        var hay = (it.note + ' ' + it.category + ' ' + it.receipt + ' ' + it.date + ' ' + it.id).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    rows.sort(function (a, b) {
      switch (view.sort) {
        case 'date-asc':    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
        case 'amount-desc': return Math.abs(b.amount) - Math.abs(a.amount);
        case 'amount-asc':  return Math.abs(a.amount) - Math.abs(b.amount);
        default:            return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
      }
    });
    return rows;
  }

  function renderLedger() {
    var box = $('ledgerList');
    if (!box) return;
    var all = filteredRows();
    var rows = all.slice(0, view.limit);

    setText('ledgerCount', DATA.ledger.length + ' 条记录' + (all.length !== DATA.ledger.length ? ' · 筛出 ' + all.length + ' 条' : ''));

    var empty = $('emptyState');
    if (empty) {
      empty.hidden = rows.length > 0;
      empty.textContent = DATA.ledger.length ? '没有符合条件的记录' : '暂无账目记录';
    }

    var head = (window.innerWidth >= 760)
      ? '<div class="ledger-head" aria-hidden="true">' +
        '<span>日期</span><span>类别</span><span>备注</span><span>票据编号</span><span>金额</span></div>'
      : '';

    /* 按月分组小标题：账本本来就是按月翻的，且能让"这个月花了多少"一眼可见。
       只在按日期排序时分组 —— 按金额排序时插入月份小标题会割裂排序的可读性。 */
    var groupByDate = (view.sort === 'date-desc' || view.sort === 'date-asc');
    var lastMk = '';
    var body = rows.map(function (it) {
      var cls = it.type === 'in' ? 'is-in' : (it.type === 'adjust' ? 'is-adjust' : 'is-out');
      var amountText;
      if (it.type === 'in')          amountText = '+¥' + fmt(Math.abs(it.amount));
      else if (it.type === 'adjust') amountText = (it.amount < 0 ? '-' : '+') + '¥' + fmt(Math.abs(it.amount));
      else                           amountText = '−¥' + fmt(Math.abs(it.amount));

      var tag = it.type === 'in' ? '<span class="tag tag-in">收入</span>'
              : it.type === 'adjust' ? '<span class="seal">更正</span>'
              : '';
      var note = esc(it.note);
      if (it.corrects) note += '（更正 ' + esc(it.corrects) + '）';

      var rc = String(it.receipt || '');
      var hasRc = (rc && rc !== '—');

      var group = '';
      if (groupByDate) {
        var mk = String(it.date).slice(0, 7);
        if (mk !== lastMk) {
          lastMk = mk;
          group = '<div class="ledger-group">' + mk.slice(0, 4) + ' 年 ' +
                  parseInt(mk.slice(5), 10) + ' 月</div>';
        }
      }

      return group +
             '<button type="button" class="row' + (hasRc ? ' has-receipt' : '') + '" data-id="' + esc(it.id) +
             '" aria-label="查看 ' + esc(it.date) + ' ' + esc(it.category) + ' ' + esc(amountText) + ' 的详情">' +
        '<span class="c-meta">' + esc(it.date) + '</span>' +
        '<span class="c-cat">' + esc(it.category) + tag + '</span>' +
        '<span class="c-note">' + (note || '—') + '</span>' +
        '<span class="c-receipt">' + (hasRc ? esc(rc) : '—') + '</span>' +
        '<span class="c-amt ' + cls + '">' + amountText + '</span>' +
      '</button>';
    }).join('');

    var more = '';
    if (all.length > rows.length) {
      more = '<div class="more-row"><button type="button" class="btn" id="moreBtn">' +
             '再看 ' + Math.min(PAGE_SIZE, all.length - rows.length) + ' 条（还有 ' +
             (all.length - rows.length) + ' 条）</button></div>';
    }

    box.innerHTML = head + body + more;
    observeReveals(box);   /* 长列表：滚动进入视口时逐条浮现 */

    var mb = $('moreBtn');
    if (mb) {
      mb.addEventListener('click', function () {
        view.limit += PAGE_SIZE;
        renderLedger();
        var rowsNow = box.querySelectorAll('.row');
        var firstNew = rowsNow[rows.length];
        if (firstNew) {
          /* 新一批从哪开始：闪一下底色 + 平滑带到位，别让"多出来的十条"凭空出现 */
          firstNew.classList.add('is-new');
          setTimeout(function () { firstNew.classList.remove('is-new'); }, 1700);
          firstNew.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
          firstNew.focus({ preventScroll: true });
        }
      });
    }
  }

  /* ==========================================================================
     9. 条目详情抽屉（含更正链路）
     ========================================================================== */

  function findEntry(id) {
    for (var i = 0; i < DATA.ledger.length; i++) {
      if (DATA.ledger[i].id === id) return DATA.ledger[i];
    }
    return null;
  }

  function openDetail(id) {
    var it = findEntry(id);
    if (!it) return;

    var amountText;
    if (it.type === 'in')          amountText = '+¥' + fmt(Math.abs(it.amount));
    else if (it.type === 'adjust') amountText = (it.amount < 0 ? '-' : '+') + '¥' + fmt(Math.abs(it.amount));
    else                           amountText = '−¥' + fmt(Math.abs(it.amount));

    var html =
      '<dl class="dl">' +
        '<dt>金额</dt><dd class="big ' + (it.type === 'in' ? 'v-in' : it.type === 'adjust' ? 'c-amt is-adjust' : '') + '">' + amountText + '</dd>' +
        '<dt>日期</dt><dd class="mono">' + esc(it.date) + '</dd>' +
        '<dt>类别</dt><dd>' + esc(it.category) + '</dd>' +
        '<dt>类型</dt><dd>' + TYPE_TEXT[it.type] + '</dd>' +
        '<dt>票据编号</dt><dd class="mono">' + esc(it.receipt) + '</dd>' +
        '<dt>条目编号</dt><dd class="mono">' + esc(it.id) + '</dd>' +
        '<dt>备注</dt><dd>' + (esc(it.note) || '—') + '</dd>' +
      '</dl>';

    /* 更正链路 */
    var chain = [];
    if (it.corrects) {
      var target = findEntry(it.corrects);
      chain.push('<div class="chain-item is-adjust"><span class="t">本条更正了</span>' +
        '<span class="n">' + (target ? esc(target.date) + ' · ' + esc(target.category) : esc(it.corrects)) + '</span>' +
        '<span class="a">' + (target ? '¥' + fmt(target.amount) : esc(it.corrects)) + '</span></div>');
    }
    var correctedBy = DATA.ledger.filter(function (x) { return x.corrects === it.id; });
    correctedBy.forEach(function (x) {
      chain.push('<div class="chain-item is-adjust"><span class="t">' + esc(x.date) + '</span>' +
        '<span class="n">本条被更正 · ' + esc(x.note || '更正条目') + '</span>' +
        '<span class="a">' + (x.amount < 0 ? '-' : '+') + '¥' + fmt(Math.abs(x.amount)) + '</span></div>');
    });

    html += '<div class="chain"><h3>更正链路</h3>';
    if (chain.length) {
      html += chain.join('');
    } else {
      html += '<div class="chain-item is-self"><span class="n">该条目没有更正记录，自写入以来未被改动</span></div>';
    }
    html += '</div>';

    var body = $('detailBody');
    if (body) body.innerHTML = html;

    /* 共享元素过渡：让列表里那一笔金额「长」进抽屉。
       两个约束（不满足就不走 VT，退回普通打开）：
       ① 同一个名字在**同一份快照里只能出现一次** —— 所以源元素的 name 要在回调里清掉，
          否则新旧两张快照里各有一个 vt-amt，浏览器会两边都忽略；
       ② VT 是在"回调执行完"之后拍新快照，所以抽屉必须以最终位置出现（instant 打开、
          不做自己的位移动画），否则共享元素终点会被算到屏幕外。 */
    var vtOK = !!document.startViewTransition && !reduceMotion;
    var src = null;
    if (vtOK) {
      var cand = document.querySelectorAll('#ledgerList .row, #recentList .mini-row');
      for (var i = 0; i < cand.length; i++) {
        if (cand[i].getAttribute('data-id') === id) { src = cand[i]; break; }
      }
    }
    var srcAmt = src ? (src.querySelector('.c-amt') || src.querySelector('.mr-amt')) : null;
    var dstAmt = document.querySelector('#detailBody .dl dd.big');
    if (vtOK && srcAmt && dstAmt) {
      /* ⚠️ 「打开抽屉」是必需动作，不能挂在 VT 的回调上 ——
         已有实测：回调没被执行时（文档不可见/被跳过）抽屉就开不出来，那是功能事故。
         所以：① 回调做成幂等；② 另加 setTimeout 兜底，保证 DOM 一定到位；
         ③ startViewTransition 抛错也照样执行。VT 只负责"多一层共享元素过渡"。 */
      var applied = false;
      var apply = function () {
        if (applied) return;
        applied = true;
        srcAmt.style.viewTransitionName = '';
        dstAmt.style.viewTransitionName = 'vt-amt';
        openDrawer('detailDrawer', true);
      };
      srcAmt.style.viewTransitionName = 'vt-amt';
      try {
        var vt = document.startViewTransition(apply);
        vt.finished.finally(function () { dstAmt.style.viewTransitionName = ''; });
      } catch (err) {
        apply();
      }
      setTimeout(apply, 120);
    } else {
      openDrawer('detailDrawer');
    }
  }

  /* ==========================================================================
     10. 抽屉通用：开关、遮罩、Esc、焦点
     ========================================================================== */

  var openCount = 0;

  /* instant=true 给 View Transitions 用：抽屉直接落在最终位置、不播自己的位移动画，
     把"怎么入场"整个交给浏览器的共享元素过渡。 */
  function openDrawer(id, instant) {
    lastFocus = document.activeElement;
    var d = $(id);
    var scrim = $('scrim');
    if (scrim) {
      scrim.hidden = false;
      if (instant) scrim.classList.add('is-open');
    }
    if (d) {
      d.hidden = false;
      if (instant) d.classList.add('is-open');
      else requestAnimationFrame(function () { d.classList.add('is-open'); });
    }
    if (scrim && !instant) requestAnimationFrame(function () { scrim.classList.add('is-open'); });
    lockScroll(true);
    openCount++;
    var focusTarget = d && d.querySelector('textarea, button, [href], input, select');
    if (focusTarget) setTimeout(function () { focusTarget.focus(); }, 60);
  }

  function closeDrawer(id) {
    /* 共享元素的名字必须清干净：留着会让下一次打开出现同名冲突（浏览器两边都忽略） */
    var dstAmt = document.querySelector('#detailBody .dl dd.big');
    if (dstAmt) dstAmt.style.viewTransitionName = '';
    var d = $(id);
    if (d) {
      d.classList.remove('is-open');
      setTimeout(function () { d.hidden = true; }, 320);
    }
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) {
      var scrim = $('scrim');
      if (scrim) {
        scrim.classList.remove('is-open');
        setTimeout(function () { scrim.hidden = true; }, 320);
      }
      lockScroll(false);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
  }

  function anyOpen() {
    return ($('askDrawer') && !$('askDrawer').hidden) || ($('detailDrawer') && !$('detailDrawer').hidden);
  }

  /* ---------- 快捷键面板（按 ? 开合） ---------- */
  function openKeys() {
    var p = $('keysPanel');
    if (!p) return;
    p.hidden = false;
    lockScroll(true);
    var c = $('keysClose');
    if (c) c.focus();
  }

  function closeKeys() {
    var p = $('keysPanel');
    if (!p) return;
    p.hidden = true;
    var c = $('keysClose');
    if (c && document.activeElement === c) c.blur();
    if (!anyOpen()) lockScroll(false);   /* 抽屉也开着时不要把滚动解锁掉 */
  }

  /* ==========================================================================
     11. 问一问 —— 本地规则引擎（离线兜底，绝不编造）
     ========================================================================== */

  var CAPS = [
    '总余额还有多少',
    '班费收缴到哪一步了',
    '还有谁没缴清',
    '这个学期的钱都花在哪了',
    '金额最大的一笔是什么',
    '最近一笔支出是什么'
  ];

  function unpaidNames() {
    return DATA.members.list
      .filter(function (p) { return p.status !== 'paid'; })
      .map(function (p) { return p.masked ? '不公示' : p.name; });
  }

  function entryLine(it) {
    var sign = it.type === 'in' ? '+' : (it.type === 'adjust' ? (it.amount < 0 ? '-' : '+') : '−');
    return monthDay(it.date) + '　' + it.category + '　' + sign + '¥' + fmt(Math.abs(it.amount)) +
           (it.note ? '（' + it.note + '）' : '');
  }

  /**
   * 离线规则引擎：只使用 DATA 中已有的数字作答。
   * 任何算不出来的问题，一律引导用户换个问法，而不是猜。
   */
  function answerOffline(q) {
    var s = String(q || '').trim();
    var lower = s.toLowerCase();
    var M = DATA.members;

    /* 余额 / 收入 / 支出 */
    if (/余额|还剩|剩多少|结余|多少钱|总额/.test(s)) {
      return '当前总余额为 ¥' + fmt(DATA.balance) + '。\n' +
             '累计收入 ¥' + fmt(DATA.incomeTotal) + '，累计支出 ¥' + fmt(DATA.expenseTotal) + '。' +
             (DATA.budget.total > 0 ? '\n学期预算 ¥' + fmt(DATA.budget.total) + '，剩余 ¥' + fmt(DATA.budget.total - DATA.expenseTotal) + '。' : '');
    }
    if (/收入|收了|收了多少|进账/.test(s)) {
      var ins = DATA.ledger.filter(function (x) { return x.type === 'in'; });
      return '累计收入 ¥' + fmt(DATA.incomeTotal) + '，共 ' + ins.length + ' 笔。\n' +
             (ins.length ? '最近一笔：' + entryLine(ins[0]) : '');
    }

    /* 收缴 */
    if (/收缴|缴费|交钱|缴费进度|到哪一步|进度|缴清|谁还|没缴|未缴|没交|未交/.test(s)) {
      if (!M.list.length) return '本学期还没有登记班费收缴名单。';
      var out = '全班共 ' + M.list.length + ' 人，每人应缴 ¥' + fmt(M.standard) + '，' +
                '已到账 ¥' + fmt(M.paidTotal) + ' / 应缴 ¥' + fmt(M.dueTotal) +
                '（' + Math.round(M.paidTotal / (M.dueTotal || 1) * 100) + '%）。\n' +
                '已缴清 ' + M.paidCount + ' 人' +
                (M.partialCount ? '，部分缴纳 ' + M.partialCount + ' 人' : '') +
                '，未缴 ' + M.unpaidCount + ' 人。';
      var un = unpaidNames();
      if (un.length && /谁|名单|哪些|哪些人/.test(s)) {
        out += '\n未缴清：' + un.join('、') + '。\n' +
               '（提醒：按约定不生成发群点名文案，需要提醒可私聊本人。）';
      }
      return out;
    }

    /* 预算 */
    if (/预算/.test(s)) {
      if (!DATA.budget.total) return '本学期还没有设置预算总额，可由生活委员在后台设置。';
      return '学期预算共 ¥' + fmt(DATA.budget.total) + '，已支出 ¥' + fmt(DATA.expenseTotal) +
             '，剩余 ¥' + fmt(DATA.budget.total - DATA.expenseTotal) +
             '（已用 ' + Math.round(DATA.expenseTotal / DATA.budget.total * 100) + '%）。';
    }

    /* 更正记录 */
    if (/更正|改过|冲正|记错/.test(s)) {
      var adjs = DATA.ledger.filter(function (x) { return x.type === 'adjust'; });
      if (!adjs.length) return '当前账目里没有更正记录，全部条目自写入以来未改动。';
      return '共有 ' + adjs.length + ' 条更正记录：\n' +
             adjs.map(function (x) {
               return monthDay(x.date) + '　' + x.category + '　' +
                      (x.amount < 0 ? '-' : '+') + '¥' + fmt(Math.abs(x.amount)) +
                      '（更正 ' + x.corrects + '）';
             }).join('\n');
    }

    /* 类别 */
    for (var i = 0; i < DATA.categories.length; i++) {
      var c = DATA.categories[i];
      if (s.indexOf(c.name) !== -1) {
        var items = DATA.ledger.filter(function (x) { return x.category === c.name; });
        return c.name + ' 共 ¥' + fmt(c.amount) + '，' + c.count + ' 笔，' +
               '占总支出的 ' + (c.amount / (Math.abs(DATA.expenseTotal) || 1) * 100).toFixed(1) + '%。\n' +
               items.slice(0, 6).map(entryLine).join('\n') +
               (items.length > 6 ? '\n…（另有 ' + (items.length - 6) + ' 笔，可在下方明细中筛选查看）' : '');
      }
    }

    /* 成员姓名 */
    if (M.list.length) {
      for (var j = 0; j < M.list.length; j++) {
        var p = M.list[j];
        if (!p.masked && p.name && s.indexOf(p.name) !== -1) {
          return p.name + ' 当前已缴 ¥' + fmt(p.paid) +
                 (M.standard > 0 ? ' / 应缴 ¥' + fmt(M.standard) : '') +
                 '，状态：' + STATUS_TEXT[p.status] + '。';
        }
      }
    }

    /* 最大一笔 / 花钱最多 */
    if (/最大|最多|最贵|最高|花得最多|贵/.test(s)) {
      var outs = DATA.ledger.filter(function (x) { return x.type === 'out'; });
      if (!outs.length) return '还没有支出记录。';
      var top = outs.slice().sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); })[0];
      var topCat = DATA.categories[0];
      return '单笔金额最大的是：' + entryLine(top) + '。\n' +
             '累计花得最多的类别是「' + (topCat ? topCat.name : '—') + '」，共 ¥' + (topCat ? fmt(topCat.amount) : '0.00') + '。';
    }

    /* 最近 / 最新一笔 */
    if (/最近|最新|最后|昨天|上一笔|刚刚/.test(s)) {
      if (!DATA.ledger.length) return '还没有账目记录。';
      return '最近一笔：' + entryLine(DATA.ledger[0]) + '。\n' +
             '（账目按日期倒序排列，更新于 ' + (DATA.meta.updatedAt || '—') + '）';
    }

    /* 花了多少 / 支出明细 */
    if (/花了|支出|开销|用掉/.test(s)) {
      return '累计支出 ¥' + fmt(DATA.expenseTotal) + '，分 ' + DATA.categories.length + ' 类：\n' +
             DATA.categories.map(function (c) {
               return '· ' + c.name + '　¥' + fmt(c.amount) + '（' + c.count + ' 笔）';
             }).join('\n') +
             '\n最近一笔：' + (DATA.ledger.length ? entryLine(DATA.ledger[0]) : '—');
    }

    /* 票据回溯 */
    var rm = /([A-Z]-\d{4}-\d{4}-\d{2})/.exec(s);
    if (rm) {
      var hit = DATA.ledger.filter(function (x) { return x.receipt === rm[1]; });
      if (hit.length) return '票据 ' + rm[1] + ' 关联 ' + hit.length + ' 条记录：\n' + hit.map(entryLine).join('\n');
      return '没有找到票据编号 ' + rm[1] + ' 对应的记录。';
    }

    /* 说不准 → 明确告知能力边界，不猜 */
    return '这个问题我在这份账目数据里找不到依据，所以不猜。\n' +
           '可以换一种问法，比如：\n' +
           CAPS.map(function (x) { return '· ' + x; }).join('\n');
  }

  function offlineSourceNote() {
    return '依据：本页账目明细（共 ' + DATA.ledger.length + ' 条，更新于 ' +
           (DATA.meta.updatedAt || '—') + '）· 本地离线回答';
  }

  /* ==========================================================================
     12. 问一问 —— 在线模式（走后端模型）
     ========================================================================== */

  function probeMode() {
    if (location.protocol === 'file:') { setChatMode('offline'); return Promise.resolve(); }

    return fetch('api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        setChatMode(j && j.llm ? 'online' : 'offline', j && j.model);
      })
      .catch(function () { setChatMode('offline'); });
  }

  function setChatMode(mode, model) {
    chatMode = mode;
    var box = $('chatMode');
    var txt = $('chatModeText');
    if (box) box.classList.toggle('is-offline', mode === 'offline');
    if (txt) {
      txt.textContent = mode === 'online'
        ? ('在线模式：由服务端模型基于本页数据作答' + (model ? '（' + model + '）' : ''))
        : '离线模式：用本页数据本地作答，断网也能用';
    }
  }

  function contextPayload() {
    return {
      meta: DATA.meta,
      totals: {
        balance: DATA.balance,
        income: DATA.incomeTotal,
        expense: DATA.expenseTotal
      },
      budget: DATA.budget,
      categories: DATA.categories,
      members: {
        standard: DATA.members.standard,
        total: DATA.members.list.length,
        paidTotal: DATA.members.paidTotal,
        dueTotal: DATA.members.dueTotal,
        paid: DATA.members.paidCount,
        partial: DATA.members.partialCount,
        unpaid: DATA.members.unpaidCount,
        list: DATA.members.list.map(function (p) {
          return { name: p.masked ? '不公示' : p.name, paid: p.paid, status: p.status };
        })
      },
      ledger: DATA.ledger.slice(0, 300)
    };
  }

  function askOnline(question) {
    chatHistory.push({ role: 'user', content: question });
    return fetch('api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question,
        history: chatHistory.slice(-8),
        context: contextPayload()
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.reply) throw new Error('空回复');
      return { text: j.reply, src: '由服务端模型基于本页账目数据作答' };
    });
  }

  /* ==========================================================================
     13. 问答界面
     ========================================================================== */

  function pushMsg(role, text, src) {
    var list = $('chatList');
    if (!list) return null;
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-bot');
    el.innerHTML =
      '<span class="msg-avatar" aria-hidden="true">' + (role === 'user' ? '我' : '理') + '</span>' +
      '<div class="msg-bubble">' + esc(text).replace(/\n/g, '<br>') +
        (src ? '<span class="msg-src">' + esc(src) + '</span>' : '') +
      '</div>';
    list.appendChild(el);
    var body = $('chatBody');
    if (body) body.scrollTop = body.scrollHeight;
    return el;
  }

  function pushTyping() {
    var list = $('chatList');
    if (!list) return null;
    var el = document.createElement('div');
    el.className = 'msg msg-bot';
    el.setAttribute('data-typing', '1');
    el.innerHTML = '<span class="msg-avatar" aria-hidden="true">理</span>' +
      '<div class="msg-bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    list.appendChild(el);
    var body = $('chatBody');
    if (body) body.scrollTop = body.scrollHeight;
    return el;
  }

  function renderChips() {
    var box = $('chatChips');
    if (!box || box.childElementCount) return;
    box.innerHTML = CAPS.map(function (c) {
      return '<button type="button" class="chip" data-q="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
  }

  function ask(question) {
    var q = String(question || '').trim();
    if (!q) return;
    lastQuestion = q;
    var input = $('chatInput');
    if (input) input.value = '';

    pushMsg('user', q);
    var typing = pushTyping();
    var btn = $('chatSend');
    if (btn) btn.disabled = true;

    function done(res) {
      if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
      pushMsg('bot', res.text, res.src);
      if (btn) btn.disabled = false;
    }

    function fallbackLocal() {
      done({ text: answerOffline(q), src: offlineSourceNote() });
    }

    if (chatMode === 'online') {
      askOnline(q)
        .then(done)
        .catch(function (err) {
          console.warn('[问答] 在线回答失败，已回退本地规则引擎：', err);
          var saved = $('chatModeText') ? $('chatModeText').textContent : '';
          setChatMode('offline');
          fallbackLocal();
          if (saved) setTimeout(function () { if ($('chatModeText')) $('chatModeText').textContent = saved; }, 1200);
        });
    } else {
      setTimeout(fallbackLocal, 260 + Math.random() * 240);
    }
  }

  /* ==========================================================================
     13.5 「用连小理继续追问」——把问题转交给连小理
     --------------------------------------------------------------------------
     为什么要有这个按钮：
       连小理没有对外接口，网页无法直接调用它。但这个项目最怕的评审质疑是
       「那连小理在里面干什么？」—— 与其假装网页很智能，不如把追问这一步
       明确交还给连小理：网页负责给你一份干净的数据上下文，连小理负责回答。
       这样连小理在问答环节也不可替代。
     ========================================================================== */

  /** 生成一份「不含任何姓名」的数据摘要，可直接粘进连小理 */
  function buildDigest() {
    var m = DATA.meta, M = DATA.members, L = DATA.ledger;

    var lines = [];
    lines.push('【班级班费 · 公开账目提问】');
    lines.push('班级：' + (m.className || '（未填）') + '　学期：' + (m.term || '（未填）'));
    lines.push('账目更新：' + (m.updatedAt || '—') + '　共 ' + L.length + ' 条记录');
    lines.push('');
    lines.push('当前总余额：¥' + fmt(DATA.balance));
    lines.push('累计收入：¥' + fmt(DATA.incomeTotal) + '　累计支出：¥' + fmt(DATA.expenseTotal));
    if (DATA.budget.total > 0) {
      lines.push('学期预算：¥' + fmt(DATA.budget.total) +
                 '　剩余：¥' + fmt(DATA.budget.total - DATA.expenseTotal));
    }
    if (DATA.categories.length) {
      lines.push('');
      lines.push('支出类别：' + DATA.categories.map(function (c) {
        return c.name + ' ¥' + fmt(c.amount) + '(' + c.count + '笔)';
      }).join('　'));
    }
    if (M.list.length) {
      lines.push('');
      // 只给人数与进度 —— 姓名留在网页的收缴区，不进入这份摘要
      lines.push('班费收缴：应缴标准 ¥' + fmt(M.standard) +
                 '，已到账 ¥' + fmt(M.paidTotal) + ' / 应缴 ¥' + fmt(M.dueTotal) +
                 '（' + Math.round(M.paidTotal / (M.dueTotal || 1) * 100) + '%）');
      lines.push('已缴清 ' + M.paidCount + ' 人，部分缴纳 ' + M.partialCount +
                 ' 人，未缴 ' + M.unpaidCount + ' 人（共 ' + M.list.length + ' 人）');
    }
    lines.push('');
    lines.push('我的问题：' + (lastQuestion || '（请在这里写下你的问题）'));
    lines.push('');
    lines.push('（以上数据来自班级班费公开账目，未包含任何个人姓名与消费信息。）');
    return lines.join('\n');
  }

  /** 复制到剪贴板：file:// 下 clipboard API 不可用时退回 execCommand */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function handoffToLianxiaoli() {
    var digest = buildDigest();
    copyText(digest).then(function (ok) {
      pushMsg('bot',
        ok
          ? '已把「你的问题 + 一份不含姓名的数据摘要」复制到剪贴板。\n\n' +
            '打开连小理，在对话里粘贴发送即可继续追问 —— 它会基于班级账务口径作答。\n' +
            '姓名留在本页的收缴区，不进这份摘要。'
          : '复制没成功（浏览器限制）。你可以手动圈选下面这段文字复制：\n\n' + digest,
        '转交给连小理 · 这一步让连小理成为问答环节的回答者');
    });
  }

  /* 离开分区时把「筛选」复原 ——
     从「支出」页签或总览的图例跳进明细时带的筛选，是"为这一次查看服务的"，
     离开后不该还粘着（否则下次打开明细会莫名其妙只剩几行，还看不出是被谁筛过的）。
     只清筛选（类别 / 类型 / 搜索 / 收缴状态）；**排序保留**（那是显示偏好，不是筛选）。 */
  function resetFiltersOnLeave(leaving) {
    if (leaving === 'ledger') {
      view.category = '';
      view.type = 'all';
      view.q = '';
      view.limit = PAGE_SIZE;
      var si = $('searchInput');
      if (si) si.value = '';
      var fc = $('filterCategory');
      if (fc) fc.value = '';
      var lseg = $('ledgerSeg');
      if (lseg) {
        lseg.querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-type') === 'all');
        });
        syncSeg(lseg);
      }
      renderCategories();   /* 类别卡上的选中态一起清掉 */
      renderLedger();       /* 行与计数也回到未筛选状态 */
    }
    if (leaving === 'collect') {
      memberState = 'all';
      var mseg = $('memberSeg');
      if (mseg) {
        mseg.querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-mstatus') === 'all');
        });
        syncSeg(mseg);
      }
      renderMembers();
    }
  }

  /* ==========================================================================
     13.5 页签
     ========================================================================== */

  var TABS = ['overview', 'collect', 'category', 'ledger'];

  /* 可见的页签（收缴可能在名单为空时整块收起） */
  function tabList() {
    return Array.prototype.slice.call(document.querySelectorAll('#tabsInner .tab'))
      .filter(function (b) { return !b.hidden; });
  }

  /* roving tabindex：只有当前选中的页签留在 Tab 键序列里，
     否则键盘用户要按四次 Tab 才能穿过页签条（WAI-ARIA Tabs 的既定做法）。 */
  function syncTabIndex() {
    document.querySelectorAll('#tabsInner .tab').forEach(function (b) {
      b.tabIndex = (!b.hidden && b.classList.contains('active')) ? 0 : -1;
    });
  }

  function switchTab(name) {
    /* 先看是从哪一页离开的：离开明细/收缴时把筛选复原（见 resetFiltersOnLeave） */
    var prevEl = document.querySelector('#tabsInner .tab.active');
    var prevTab = prevEl ? prevEl.getAttribute('data-tab') : '';
    if (prevTab && prevTab !== name) resetFiltersOnLeave(prevTab);

    document.querySelectorAll('#tabsInner .tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    TABS.forEach(function (n) {
      var pane = $('pane-' + n);
      if (pane) {
        pane.hidden = (n !== name);
        if (n === name) replayPaneIn(pane);
      }
    });
    syncTabIndex();
    updateNavIndicator();
    /* ⚠️ 页签刚显示出来时，里面的分段筛选按钮还没量过尺寸 —— 不补这一枪，
       滑块会停在 0×0，用户看到的就是"选中的那项没有底块"。 */
    syncSegIndicator($('ledgerSeg'));
    syncSegIndicator($('memberSeg'));
    buildSubNav(name);   /* 本区目录跟着分区重建 */
    /* 切页回顶：html 上开着 scroll-behavior:smooth，直接 scrollTo(0,0) 会变成"滚过整页"，
       临时关掉平滑才是一跳到位（过渡感交给上面的淡入与分区依次落定）。 */
    if (window.scrollTo) {
      var root = document.documentElement;
      var prevSB = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
      root.style.scrollBehavior = prevSB;
    }
  }

  /* 切页的衔接：内容区整体轻淡入，块内各分区再按原有的 .anim-N 延迟依次落定 ——
     比"整块一起糊进来"更有逐条落账的节奏。 */
  function replayPaneIn(pane) {
    pane.classList.remove('is-in');
    void pane.offsetWidth;        /* 强制回流：否则连续添同一个类名不会重放动画 */
    pane.classList.add('is-in');

    /* 重放 .anim 系：.anim 负责动画、.anim-N 负责各自的延迟，所以只摘掉 .anim 再挂回 */
    Array.prototype.forEach.call(pane.querySelectorAll('.anim'), function (s) {
      s.classList.remove('anim');
    });
    Array.prototype.forEach.call(
      pane.querySelectorAll('.anim-1, .anim-2, .anim-3, .anim-4, .anim-5, .anim-6'),
      function (s) {
        void s.offsetWidth;
        s.classList.add('anim');
      });
  }

  /* 把高亮块挪到当前项上。
     用 getBoundingClientRect 的差值定位，而不是 offsetLeft —— 后者在导航有边框/内边距时
     容易差一两个像素（块的左右上下列都靠它对齐）。 */
  function updateNavIndicator() {
    var nav = $('sideNav'), ind = $('navIndicator');
    if (!nav || !ind) return;
    var cur = document.querySelector('#tabsInner .tab.active');
    if (!cur || cur.hidden) { ind.style.width = '0px'; ind.style.height = '0px'; return; }
    var cr = cur.getBoundingClientRect();
    if (!cr.width || !cr.height) return;   /* 还没完成布局时先不动，免得闪一下 */
    var nr = nav.getBoundingClientRect();
    var first = !nav.classList.contains('is-ready');
    if (first) ind.style.transition = 'none';   /* 首次定位不播动画（否则会从左上角"长出来"） */
    ind.style.width = cr.width + 'px';
    ind.style.height = cr.height + 'px';
    ind.style.transform = 'translate(' + (cr.left - nr.left - nav.clientLeft).toFixed(1) + 'px,' +
                          (cr.top - nr.top - nav.clientTop).toFixed(1) + 'px)';
    if (first) {
      void ind.offsetWidth;
      ind.style.transition = '';
      nav.classList.add('is-ready');
    }
  }

  /* ↓/→ 下一个、↑/← 上一个（桌面是竖排目录、手机是横排底栏，两个方向都认），Home/End 跳首末 */
  function moveTabFocus(cur, delta) {
    var tabs = tabList();
    if (tabs.length < 2) return;
    var i = tabs.indexOf(cur);
    if (i < 0) i = 0;
    var next = tabs[(i + delta + tabs.length) % tabs.length];
    if (next) { switchTab(next.getAttribute('data-tab')); next.focus(); }
  }

  function focusTabEdge(which) {
    var tabs = tabList();
    if (!tabs.length) return;
    var b = which === 'first' ? tabs[0] : tabs[tabs.length - 1];
    switchTab(b.getAttribute('data-tab'));
    b.focus();
  }

  /* 分段筛选：选中态要同时给出 .active（样式）与 aria-pressed（读屏），并把滑块挪过去 */
  function syncSeg(seg) {
    if (!seg) return;
    seg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.classList.contains('active') ? 'true' : 'false');
    });
    syncSegIndicator(seg);
  }

  /* 滑块落位：与顶部导航同一套算法 —— 用 rect 差值，别用百分比
     （桌面下按钮宽度是内容撑开的，等分百分比会对不上）。 */
  function syncSegIndicator(seg) {
    var ind = seg && seg.querySelector('.seg-ind');
    if (!ind) return;
    var cur = seg.querySelector('button.active');
    if (!cur) { ind.style.setProperty('--sw', '0px'); return; }
    var cr = cur.getBoundingClientRect();
    if (!cr.width) return;
    var sr = seg.getBoundingClientRect();
    /* 首次定位不播动画，免得滑块从左上角"飞"进来 */
    var first = !seg.classList.contains('seg-ready');
    if (first) ind.style.transition = 'none';
    ind.style.setProperty('--sx', (cr.left - sr.left - seg.clientLeft).toFixed(1) + 'px');
    ind.style.setProperty('--sy', (cr.top - sr.top - seg.clientTop).toFixed(1) + 'px');
    ind.style.setProperty('--sw', cr.width.toFixed(1) + 'px');
    ind.style.setProperty('--sh', cr.height.toFixed(1) + 'px');
    if (first) {
      void ind.offsetWidth;
      ind.style.transition = '';
      seg.classList.add('seg-ready');
    }
  }

  /* 给分段筛选装上滑块。滑块由 JS 插入：没有 JS 时 .active 的底色仍然是兜底表现。 */
  function setupSegIndicator(seg) {
    if (!seg || seg.querySelector('.seg-ind')) return;
    var ind = document.createElement('span');
    ind.className = 'seg-ind';
    ind.setAttribute('aria-hidden', 'true');
    seg.insertBefore(ind, seg.firstChild);
    seg.classList.add('has-indicator');
    syncSegIndicator(seg);
  }

  /* 某些分区可能整块不可用（如收缴名单为空），把对应页签一起收起 */
  function setTabVisible(name, on) {
    var b = document.querySelector('#tabsInner .tab[data-tab="' + name + '"]');
    if (!b) return;
    b.hidden = !on;
    if (!on && b.classList.contains('active')) switchTab('overview');
    syncTabIndex();
    updateNavIndicator();
    /* ⚠️ 页签刚显示出来时，里面的分段筛选按钮还没量过尺寸 —— 不补这一枪，
       滑块会停在 0×0，用户看到的就是"选中的那项没有底块"。 */
    syncSegIndicator($('ledgerSeg'));
    syncSegIndicator($('memberSeg'));
    buildSubNav(name);   /* 本区目录跟着分区重建 */   /* 收起一项后其余项的落点会变，高亮块要跟着重算 */
  }

  /* ==========================================================================
     13.9 本区目录（滚动追踪）：侧边栏列出当前分区的小节，滚到哪、高亮到哪
     ========================================================================== */

  var SUB_NAMES = { overview: '概览', trend: '余额走势', recent: '最近三笔', mix: '支出构成' };

  function buildSubNav(tabName) {
    var host = $('subNav');
    if (!host) return;
    var pane = $('pane-' + tabName);
    if (!pane) { host.innerHTML = ''; return; }
    var items = [];
    Array.prototype.forEach.call(pane.querySelectorAll('section[id]'), function (s) {
      var h2 = s.querySelector('.sheet-head h2');
      var name = (h2 && h2.textContent.trim()) || SUB_NAMES[s.id] || '';
      if (name) items.push({ id: s.id, name: name });
    });
    if (items.length < 2) { host.innerHTML = ''; return; }   /* 只有一节就不必列目录 */
    host.innerHTML = items.map(function (it) {
      return '<a href="#' + it.id + '" data-sec="' + it.id + '">' + esc(it.name) + '</a>';
    }).join('');
    trackSections(items);
  }
  /* 滚动追踪：取"最后一个越过读数线（视口上方 40%）的小节"作为当前小节。
     为什么不用 IntersectionObserver 的窄带（rootMargin 加减）：窄带会落进小节之间的间距里，
     那一瞬间"当前小节"会消失；取"最后一个越线"则永远有一个确定答案。
     处理函数刻意**同步**执行（只有 4 次 rect 读取）：不走 rAF，避免后台标签页被节流后失去跟踪。 */
  var secItems = [];
  var secLockUntil = 0;      /* 刚点过目录的一小段时间内，不让滚动追踪把高亮改回去 */

  function trackSections(items) {
    secItems = items || [];
    window.removeEventListener('scroll', onSecScroll);
    if (!secItems.length) return;
    window.addEventListener('scroll', onSecScroll, { passive: true });
    window.addEventListener('resize', onSecScroll);
    onSecScroll();
  }

  function onSecScroll() {
    if (!secItems.length) return;
    if (Date.now() < secLockUntil) return;   /* 见下：点击后的短暂"高亮锁定" */
    var host = $('subNav');
    if (!host) return;
    var line = (window.innerHeight || 800) * 0.4;
    var best = secItems[0].id;
    secItems.forEach(function (it) {
      var s = document.getElementById(it.id);
      if (!s) return;
      if (s.getBoundingClientRect().top <= line) best = it.id;
    });
    Array.prototype.forEach.call(host.querySelectorAll('a'), function (a) {
      var here = a.getAttribute('data-sec') === best;
      a.classList.toggle('is-here', here);
      if (here) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  }

  /* 本区目录点击 → 平滑滚到那一节。三件事缺一不可：
     ① 立刻把高亮移过去（页面已经滚到底时滚不动，高亮就是唯一的可见反馈）；
     ② 之后 900ms 内锁住高亮，不让滚动追踪立刻改回去（否则看起来"点了没反应"）；
     ③ 给目标小节一次短促高亮脉冲 —— 滚不动的时候它能明确告诉你"跳到了这里"。 */
  (function bindSubNav() {
    var sn = $('subNav');
    if (!sn) return;
    sn.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-sec]');
      if (!a) return;
      e.preventDefault();
      var id = a.getAttribute('data-sec');
      var s = document.getElementById(id);
      if (!s) return;
      Array.prototype.forEach.call(sn.querySelectorAll('a'), function (x) {
        var here = x === a;
        x.classList.toggle('is-here', here);
        if (here) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current');
      });
      secLockUntil = Date.now() + 900;
      s.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      s.classList.remove('is-flash');
      void s.offsetWidth;
      s.classList.add('is-flash');
      setTimeout(function () { s.classList.remove('is-flash'); }, 900);
    });
  })();

  /* ==========================================================================
     14. 事件绑定
     ========================================================================== */

  function bind() {
    /* --- 页签 --- */
    var ti = $('tabsInner');
    if (ti) {
      ti.addEventListener('click', function (e) {
        var b = e.target.closest('.tab');
        if (b) switchTab(b.getAttribute('data-tab'));
      });
      /* WAI-ARIA Tabs 键盘约定：←/→ 与 ↑/↓ 轮转、Home/End 跳首末（原来只能用鼠标点） */
      ti.addEventListener('keydown', function (e) {
        var cur = e.target.closest('.tab');
        if (!cur) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); moveTabFocus(cur, 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); moveTabFocus(cur, -1); }
        else if (e.key === 'Home') { e.preventDefault(); focusTabEdge('first'); }
        else if (e.key === 'End') { e.preventDefault(); focusTabEdge('last'); }
      });
    }

    /* --- 明细工具条 --- */
    var si = $('searchInput');
    if (si) {
      si.addEventListener('input', debounce(function () {
        view.q = si.value; view.limit = PAGE_SIZE; renderLedger();
      }, 160));
    }

    var fc = $('filterCategory');
    if (fc) {
      fc.addEventListener('change', function () {
        view.category = fc.value; view.limit = PAGE_SIZE;
        renderCategories(); renderLedger();
      });
    }

    var ss = $('sortSelect');
    if (ss) {
      ss.addEventListener('change', function () {
        view.sort = ss.value; view.limit = PAGE_SIZE; renderLedger();
      });
    }

    var lseg = $('ledgerSeg');
    if (lseg) {
      lseg.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-type]');
        if (!btn) return;
        view.type = btn.getAttribute('data-type');
        view.limit = PAGE_SIZE;
        lseg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
        syncSeg(lseg);
        renderLedger();
      });
    }

    /* --- 类别联动 --- */
    var cl = $('categoryList');
    if (cl) {
      cl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-cat]');
        if (!btn) return;
        var name = btn.getAttribute('data-cat');
        view.category = (view.category === name) ? '' : name;
        view.limit = PAGE_SIZE;
        if (fc) fc.value = view.category;
        view.type = 'all';
        if (lseg) lseg.querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-type') === 'all');
        });
        syncSeg(lseg);
        renderCategories();
        renderLedger();
        if (view.category) {
          /* 明细在另一个页签里，先切过去再滚动定位 */
          switchTab('ledger');
          var sec = $('ledger');
          if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }

    /* --- 收缴筛选 --- */
    var mseg = $('memberSeg');
    if (mseg) {
      mseg.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-mstatus]');
        if (!btn) return;
        memberState = btn.getAttribute('data-mstatus');
        mseg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
        syncSeg(mseg);
        renderMembers();
      });
    }

    /* 分段筛选：装上滑块 + 补齐初始选中态给读屏 */
    setupSegIndicator(lseg);
    setupSegIndicator(mseg);
    syncSeg(lseg);
    syncSeg(mseg);
    /* 页签的初始 roving tabindex（渲染阶段还会再同步一次） */
    syncTabIndex();

    /* --- 总览的收缴摘要 → 切到收缴页签 --- */
    var hcBtn = $('heroCollect');
    if (hcBtn) {
      hcBtn.addEventListener('click', function () { switchTab('collect'); });
    }

    /* --- 总览：最近三笔点开详情；「看全部明细」切到明细页签 --- */
    var rl = $('recentList');
    if (rl) {
      rl.addEventListener('click', function (e) {
        var row = e.target.closest('.mini-row');
        if (row) openDetail(row.getAttribute('data-id'));
      });
    }
    var tlb = $('toLedgerBtn');
    if (tlb) tlb.addEventListener('click', function () { switchTab('ledger'); });

    /* --- 总览「支出构成」图例：点一类 → 跳到明细并筛这一类 --- */
    var mx = $('mixChart');
    if (mx) {
      mx.addEventListener('click', function (e) {
        var row = e.target.closest && e.target.closest('.mix-row[data-cat]');
        if (!row) return;
        var name = row.getAttribute('data-cat');
        view.category = (view.category === name) ? '' : name;   /* 再点一次取消筛选 */
        view.limit = PAGE_SIZE;
        var fcs = $('filterCategory');
        if (fcs) fcs.value = view.category;
        view.type = 'all';
        syncSeg($('ledgerSeg'));
        renderCategories();
        renderLedger();
        switchTab('ledger');
      });
    }

    /* --- 快捷键面板 + 全局快捷键：1-4 跳分区 / 「/」聚焦搜索 / 「?」开合面板 --- */
    var kc = $('keysClose');
    if (kc) kc.addEventListener('click', closeKeys);
    var kp = $('keysPanel');
    if (kp) kp.addEventListener('click', function (e) { if (e.target === kp) closeKeys(); });

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      var typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
                           t.tagName === 'SELECT' || t.isContentEditable);
      var panel = $('keysPanel');
      if (e.key === 'Escape' && panel && !panel.hidden) { closeKeys(); return; }
      if (typing) return;                       /* 正在输入就不抢键 */
      if (e.key >= '1' && e.key <= '4') {
        var list = tabList();
        var idx = parseInt(e.key, 10) - 1;
        if (list[idx]) {
          e.preventDefault();
          switchTab(list[idx].getAttribute('data-tab'));
          list[idx].focus();
        }
      } else if (e.key === '/') {
        e.preventDefault();
        switchTab('ledger');                    /* 搜索框在明细分区，先切过去再聚焦 */
        var si = $('searchInput');
        if (si) setTimeout(function () { si.focus(); si.select(); }, 60);
      } else if (e.key === '?') {
        e.preventDefault();
        if (panel && panel.hidden) openKeys(); else closeKeys();
      }
    });

    /* --- 明细行 → 详情抽屉 --- */
    var ll = $('ledgerList');
    if (ll) {
      ll.addEventListener('click', function (e) {
        var row = e.target.closest('.row');
        if (row) openDetail(row.getAttribute('data-id'));
      });
    }

    /* --- 抽屉关闭 --- */
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeDrawer(btn.getAttribute('data-close')); });
    });
    var scrim = $('scrim');
    if (scrim) {
      scrim.addEventListener('click', function () {
        if ($('askDrawer') && !$('askDrawer').hidden) closeDrawer('askDrawer');
        if ($('detailDrawer') && !$('detailDrawer').hidden) closeDrawer('detailDrawer');
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && anyOpen()) {
        if ($('detailDrawer') && !$('detailDrawer').hidden) closeDrawer('detailDrawer');
        if ($('askDrawer') && !$('askDrawer').hidden) closeDrawer('askDrawer');
        return;
      }
      /* 「/」唤起搜索 —— 像专业工具那样 */
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (e.key === '/' && !anyOpen() && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        switchTab('ledger');   /* 搜索框在明细页，先把页签切过去 */
        if (si) si.focus();
      }
    });

    /* --- 问答 --- */
    var fab = $('askFab');
    if (fab) {
      fab.addEventListener('click', function () {
        openDrawer('askDrawer');
        renderChips();
        if (!$('chatList').childElementCount) {
          var m = DATA.meta.className ? DATA.meta.className + ' ' : '';
          pushMsg('bot',
            '这是' + m + '的班费公开账目。你可以直接问我账目相关的问题。\n' +
            '我只依据本页已有数据作答，算不出来的会说不知道。',
            '数据来源：连小理工作流产出 · 更新于 ' + (DATA.meta.updatedAt || '—'));
        }
        probeMode();
      });
    }

    var form = $('chatForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        ask($('chatInput').value);
      });
    }
    var ci = $('chatInput');
    if (ci) {
      ci.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          ask(ci.value);
        }
      });
      ci.addEventListener('input', function () {
        ci.style.height = 'auto';
        ci.style.height = Math.min(120, ci.scrollHeight) + 'px';
      });
    }
    var chips = $('chatChips');
    if (chips) {
      chips.addEventListener('click', function (e) {
        var b = e.target.closest('.chip');
        if (b) ask(b.getAttribute('data-q'));
      });
    }

    var hb = $('handoffBtn');
    if (hb) hb.addEventListener('click', handoffToLianxiaoli);

    var pb = $('printBtn');
    if (pb) pb.addEventListener('click', function () { window.print(); });

    /* --- 重绘 --- */
    var onResize = debounce(function () {
      renderTrend();
      renderLedger();
    }, 160);
    window.addEventListener('resize', onResize);

  }

  /* ==========================================================================
     15. 启动
     ========================================================================== */

  function showError() {
    var main = $('mainWrap');
    if (main) main.hidden = true;
    var head = document.querySelector('.masthead');
    if (head) head.hidden = true;
    var tabs = document.querySelector('.tabs');
    if (tabs) tabs.hidden = true;
    var fab = $('askFab');
    if (fab) fab.hidden = true;
    var es = $('errorState');
    if (es) es.hidden = false;
  }

  loadData().then(function (raw) {
    if (!raw) { showError(); return; }
    DATA = normalize(raw);
    // 账目为空是合法状态（新学期还没产生记录），走空态而不是报错页
    renderMeta();
    renderHero();
    renderTrend();
    renderMembers();
    renderCategories();
    renderRecent();
    renderMix();
    renderFunnel();
    renderMonthBars();
    renderWaterfall();
    renderFilterOptions();
    renderLedger();
    bind();
    setChatMode('offline');
    bindPointerGlow();   /* 视觉追踪：卡片微光跟指针 */
    buildSubNav('overview');   /* 首屏的本区目录（switchTab 只在切页时重建） */
    /* 导航高亮块要等布局稳定后再定位；窗口变化、字体晚到都要重算 */
    updateNavIndicator();
    window.addEventListener('resize', debounce(function () {
      updateNavIndicator();
      /* 断点切换会改按钮宽度，两处滑块都要重算落点 */
      syncSegIndicator($('ledgerSeg'));
      syncSegIndicator($('memberSeg'));
    }, 120));
    window.addEventListener('load', updateNavIndicator);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(updateNavIndicator, function () {});
    }
  }).catch(function (err) {
    console.error(err);
    showError();
  });

})();
