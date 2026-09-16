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
c.onMessage((m) => {
  if (m.type !== 'ledger_export') return;
  fs.mkdirSync(require('node:path').dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(m, null, 2));
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`匯出 ${m.receipts.length} 筆收據、${(m.events || []).length} 個帳務事件、` +
    `${(m.checkpoints || []).length} 個 checkpoint → ${out} (${kb} KB)`);
  console.log(`hub 身分：${m.hub_pub ? require('./lib/rebuild').didOf(m.hub_pub) : '(無)'}`);
  process.exit(0);
});
c.send({ type: 'export' });
setTimeout(() => {
  console.error(`沒有從 ${host}:${port} 收到匯出——Hub 在跑嗎？`);
  process.exit(1);
}, 10000);
