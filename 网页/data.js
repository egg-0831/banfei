/* ============================================================================
   连小理 · 班费透明工作流 ——【示例数据 Demo】数据文件
   ----------------------------------------------------------------------------
   ⚠️ 本文件是**虚构的演示数据**，不是任何真实班级的班费记录。
      班号、姓名、金额、票据编号全部为演示而编，请勿当作真实账目引用。

   用途：给比赛演示 / 作品说明配图 / 功能走查提供一份"有多个月、有更正、有收缴差异"的数据。
   结构：与《数据契约》一致 —— meta / summary / budget / members / ledger 五个顶层字段。
   口径：所有汇总由 ledger 明细重算；summary 只作对照（对不上时以前台重算为准）。

   这里的数据刻意覆盖这些分支，以便一次演示看全：
     · 时间跨 9/10/11 三个月 → 月度收支对照柱、走势的月度刻度都出得来
     · 两条更正条目（一条减、一条增）→ 详情抽屉里的「更正链路」两种方向都能看
     · 30 人收缴：24 已缴清 / 4 部分缴纳 / 2 未缴 + 1 人「不公示」→ 漏斗、四格统计、不公示态
     · 预算 3000、提醒线 900 → 余额已进预警区，「低余额提醒线」会点亮
   ========================================================================== */

window.__LEDGER__ = {
  "meta": {
    "projectName": "连小理 · 班费透明工作流",
    "className": "2026 级 3 班（示例数据）",
    "term": "2026—2027 学年 第一学期",
    "updatedAt": "2026-11-10 20:15",
    "isSample": true,
    "notice": "【示例数据】本页是功能演示，班号、姓名、金额、票据编号均为虚构，不是任何真实班级的班费记录。真实使用时，本页只展示账目与班费收缴情况，不经手资金、不执行支付、不代收代付；除班费收缴外，不展示任何个人消费信息。"
  },

  /* 口径（与《数据契约》一致，也是前端的重算口径）：
       支出 = Σ|out| + Σ(adjust 带符号值)      余额 = 收入 − 支出
     adjust 的符号含义：**负数＝支出减少（余额增加）**，正数＝支出增加。
     本数据集：Σ|out| = 2246，Σ(adjust) = −18 − 45 = −63 → 支出 2183、余额 = 2600 − 2183 = 417。 */
  "summary": {
    "balance": 417,
    "incomeTotal": 2600,
    "expenseTotal": 2183
  },

  "budget": {
    "total": 3000,
    "warnBelow": 900
  },

  "members": {
    "visible": true,
    "standard": 100,
    "list": [
      { "name": "王子航", "paid": 100, "status": "paid", "masked": false },
      { "name": "李思远", "paid": 100, "status": "paid", "masked": false },
      { "name": "张若曦", "paid": 100, "status": "paid", "masked": false },
      { "name": "刘一鸣", "paid": 100, "status": "paid", "masked": false },
      { "name": "陈嘉禾", "paid": 100, "status": "paid", "masked": false },
      { "name": "杨博文", "paid": 100, "status": "paid", "masked": false },
      { "name": "赵欣怡", "paid": 100, "status": "paid", "masked": false },
      { "name": "黄梓涵", "paid": 100, "status": "paid", "masked": false },
      { "name": "周天佑", "paid": 100, "status": "paid", "masked": false },
      { "name": "吴梦琪", "paid": 100, "status": "paid", "masked": false },
      { "name": "徐子墨", "paid": 100, "status": "paid", "masked": false },
      { "name": "孙雨桐", "paid": 100, "status": "paid", "masked": false },
      { "name": "马浩宇", "paid": 100, "status": "paid", "masked": false },
      { "name": "朱婉清", "paid": 100, "status": "paid", "masked": false },
      { "name": "胡明轩", "paid": 100, "status": "paid", "masked": false },
      { "name": "郭静怡", "paid": 100, "status": "paid", "masked": false },
      { "name": "何俊杰", "paid": 100, "status": "paid", "masked": false },
      { "name": "高语彤", "paid": 100, "status": "paid", "masked": false },
      { "name": "林泽楷", "paid": 100, "status": "paid", "masked": false },
      { "name": "罗一凡", "paid": 100, "status": "paid", "masked": false },
      { "name": "郑清和", "paid": 100, "status": "paid", "masked": false },
      { "name": "谢文轩", "paid": 100, "status": "paid", "masked": true },
      { "name": "韩雨萱", "paid": 100, "status": "paid", "masked": false },
      { "name": "唐启航", "paid": 100, "status": "paid", "masked": false },
      { "name": "曹思彤", "paid": 50, "status": "partial", "masked": false },
      { "name": "邓宇航", "paid": 50, "status": "partial", "masked": false },
      { "name": "冯佳宁", "paid": 50, "status": "partial", "masked": false },
      { "name": "蒋昊然", "paid": 50, "status": "partial", "masked": false },
      { "name": "沈书言", "paid": 0, "status": "unpaid", "masked": false },
      { "name": "卢星辰", "paid": 0, "status": "unpaid", "masked": false }
    ]
  },

  "ledger": [
    /* ---------- 9 月 ---------- */
    {
      "id": "20260905-IN-01",
      "date": "2026-09-05",
      "type": "in",
      "category": "班费收缴",
      "amount": 2600,
      "receipt": "—",
      "note": "秋季学期班费收缴（已到账部分，含 4 位同学部分缴纳）",
      "corrects": ""
    },
    {
      "id": "20260910-OUT-01",
      "date": "2026-09-10",
      "type": "out",
      "category": "团建活动费",
      "amount": 168,
      "receipt": "P-2026-0910-01",
      "note": "班级破冰活动买饮料",
      "corrects": ""
    },
    {
      "id": "20260911-ADJ-01",
      "date": "2026-09-11",
      "type": "adjust",
      "category": "团建活动费",
      "amount": -18,
      "receipt": "P-2026-0910-01",
      "note": "原记录金额有误（多记 18 元），此处更正",
      "corrects": "20260910-OUT-01"
    },
    {
      "id": "20260912-OUT-01",
      "date": "2026-09-12",
      "type": "out",
      "category": "团建活动费",
      "amount": 186,
      "receipt": "P-2026-0912-03",
      "note": "班级团建买零食",
      "corrects": ""
    },
    {
      "id": "20260915-OUT-01",
      "date": "2026-09-15",
      "type": "out",
      "category": "学习资料费",
      "amount": 202.5,
      "receipt": "P-2026-0915-02",
      "note": "班级统一打印复习资料",
      "corrects": ""
    },
    {
      "id": "20260918-OUT-01",
      "date": "2026-09-18",
      "type": "out",
      "category": "班级公共支出",
      "amount": 120,
      "receipt": "P-2026-0918-01",
      "note": "班级公共用品（纸巾、垃圾袋等）",
      "corrects": ""
    },
    {
      "id": "20260921-OUT-01",
      "date": "2026-09-21",
      "type": "out",
      "category": "团建活动费",
      "amount": 150,
      "receipt": "P-2026-0921-04",
      "note": "班级破冰活动场地费",
      "corrects": ""
    },
    {
      "id": "20260923-OUT-01",
      "date": "2026-09-23",
      "type": "out",
      "category": "学习资料费",
      "amount": 150,
      "receipt": "P-2026-0923-01",
      "note": "实验报告册统一购买",
      "corrects": ""
    },
    {
      "id": "20260925-OUT-01",
      "date": "2026-09-25",
      "type": "out",
      "category": "班级公共支出",
      "amount": 95,
      "receipt": "P-2026-0925-02",
      "note": "班级绿植与花盆",
      "corrects": ""
    },
    {
      "id": "20260927-OUT-01",
      "date": "2026-09-27",
      "type": "out",
      "category": "班级公共支出",
      "amount": 110,
      "receipt": "P-2026-0927-01",
      "note": "班会活动物料",
      "corrects": ""
    },

    /* ---------- 10 月 ---------- */
    {
      "id": "20261008-OUT-01",
      "date": "2026-10-08",
      "type": "out",
      "category": "学习资料费",
      "amount": 128.5,
      "receipt": "P-2026-1008-01",
      "note": "专业导论课参考书统一购买（走班费的部分）",
      "corrects": ""
    },
    {
      "id": "20261014-OUT-01",
      "date": "2026-10-14",
      "type": "out",
      "category": "团建活动费",
      "amount": 320,
      "receipt": "P-2026-1014-02",
      "note": "国庆后班级聚餐（AA 之后由班费补的差额）",
      "corrects": ""
    },
    {
      "id": "20261017-ADJ-01",
      "date": "2026-10-17",
      "type": "adjust",
      "category": "团建活动费",
      "amount": -45,
      "receipt": "P-2026-1014-02",
      "note": "实际结算比预付少 45 元，差额退回班费，此处更正",
      "corrects": "20261014-OUT-01"
    },
    {
      "id": "20261020-OUT-01",
      "date": "2026-10-20",
      "type": "out",
      "category": "班级公共支出",
      "amount": 88,
      "receipt": "P-2026-1020-01",
      "note": "班级医药箱与消毒用品",
      "corrects": ""
    },
    {
      "id": "20261023-OUT-01",
      "date": "2026-10-23",
      "type": "out",
      "category": "学习资料费",
      "amount": 96,
      "receipt": "P-2026-1023-03",
      "note": "期中复习资料打印",
      "corrects": ""
    },

    /* ---------- 11 月 ---------- */
    {
      "id": "20261103-OUT-01",
      "date": "2026-11-03",
      "type": "out",
      "category": "班级公共支出",
      "amount": 62,
      "receipt": "P-2026-1103-01",
      "note": "班级水杯与茶包补充",
      "corrects": ""
    },
    {
      "id": "20261106-OUT-01",
      "date": "2026-11-06",
      "type": "out",
      "category": "团建活动费",
      "amount": 240,
      "receipt": "P-2026-1106-02",
      "note": "秋游包车定金",
      "corrects": ""
    },
    {
      "id": "20261110-OUT-01",
      "date": "2026-11-10",
      "type": "out",
      "category": "学习资料费",
      "amount": 130,
      "receipt": "P-2026-1110-02",
      "note": "四六级模拟卷统一订",
      "corrects": ""
    }
  ]
};
