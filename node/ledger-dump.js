#!/usr/bin/env node
// Disaster export: write the hub's full ledger to a file so a second
// sequencer can rebuild from it (W10, and #10's drill acceptance condition
// is exactly "災難匯出 → 第二排序器重建").
//
// Run:  node ledger-dump.js [out.json] [hubHost] [hubPort]
'use strict';
const fs = require('node:fs');
const transport = require('./lib/transport').fromEnv();

const out = process.argv[2] || 'out/ledger.json';
const host = process.argv[3] || '127.0.0.1';
const port = Number(process.argv[4] || 47180);

const c = transport.dial({ host, port });
// 走 `lib/ledgerfetch`：這是災難恢復用的工具，而它從前在匯出超過 16MB 時
// 會**什麼都拿不到**（靜默斷線，#76）——偏偏那正是最需要它的時候。
require('./lib/ledgerfetch').fetchLedger(c, { timeoutMs: 120000,
  onNote: (n) => console.log(`  ${n}`) })
  .then((m) => {
    fs.mkdirSync(require('node:path').dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(m, null, 2));
    const kb = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`匯出 ${m.receipts.length} 筆收據、${(m.events || []).length} 個帳務事件、` +
      `${(m.checkpoints || []).length} 個 checkpoint → ${out} (${kb} KB)`);
    console.log(`hub 身分：${m.hub_pub ? require('./lib/rebuild').didOf(m.hub_pub) : '(無)'}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`沒有從 ${host}:${port} 取得完整匯出：${err.message}`);
    process.exit(1);
  });
