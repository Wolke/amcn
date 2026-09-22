#!/usr/bin/env node
// 階段 A 的定時記錄器（three-machine-pilot.md §4）。
//
// 為什麼要有它：§4 要的六項每 15 分鐘記一次，而人手抄會漏、會停、會在
// 最需要的那一格漏掉。更重要的是 #76 的教訓——量測失敗必須大聲：拿不到
// 匯出時要寫「未測到」，不能沿用上一筆讓曲線看起來連續。
//
// 只讀不寫：走 `lib/ledgerfetch`（超過一個 frame 會自動分頁，#41），
// Console 用 HTTP GET。不改 Hub、不影響試點。
//
// Run:  node pilot-watch.js [間隔秒，預設 900] > logs/watch.log 2>&1 &
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const transport = require('./lib/transport').get('tcp');
const { fetchLedger } = require('./lib/ledgerfetch');

const EVERY_S = Number(process.argv[2] || 900);
// 位址可由參數覆寫：拔線演練之後排序器會搬到別台，而觀測必須跟著搬。
// 另外**不要用 loopback**——在跑著試點的機器上，任何綁 127.0.0.1 的東西
// 都會優先接走你的查詢（實測：demo 的 hub 綁上 127.0.0.1:47180，於是本機
// 查詢全部查到它，一度看起來像試點掉了 207 筆帳）。
// 預設本機（公開前的清理）：試點當時的位址留在 docs 的紀錄裡，不該當程式預設。
const HUB = { host: process.env.PB_HUB || process.argv[3] || '127.0.0.1',
              port: Number(process.env.PB_HUB_PORT || 47180) };
const DUMP = path.join(__dirname, 'out', 'pilot-ledger.json');
const CONSOLES = [47201, 47203];        // 本機 m1 / m1b

const iso = () => new Date().toISOString();
const ask = () => new Promise((resolve) => {
  const c = transport.dial(HUB);
  const bail = setTimeout(() => { try { c.close(); } catch {} resolve(null); }, 20000);
  fetchLedger(c, { timeoutMs: 18000 })
    .then((m) => { clearTimeout(bail); try { c.close(); } catch {} resolve(m); })
    .catch(() => { clearTimeout(bail); try { c.close(); } catch {} resolve(null); });
});
const consoleOf = async (p) => {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/status`, { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch { return null; }
};
const hubRss = () => {
  // `pgrep -f 'node hub.js'` 也會命中包著它的 bash wrapper 與 pgrep 自己
  // （實測三個 PID，第一個是 /bin/bash、304KB → 報成 0MB）。所以直接從
  // ps 的完整命令列篩，且明確排除 shell 與這支程式自己。
  try {
    const out = execSync(
      "ps -axo pid=,rss=,command= | awk '/node hub\\.js/ && " +
      "!/bash|pgrep|awk|pilot-watch/ {print $1\" \"$2; exit}'",
      { encoding: 'utf8' }).trim();
    if (!out) return null;
    return Math.round(Number(out.split(/\s+/)[1]) / 1024);
  } catch { return null; }
};

async function sample() {
  const ex = await ask();
  const rss = hubRss();
  let dumpKb = null;
  try { dumpKb = Math.round(fs.statSync(DUMP).size / 1024); } catch { /* 還沒寫 */ }

  if (!ex) {
    // #76：讀不到就說讀不到。沿用上一筆會讓一段空白看起來像正常運作。
    console.log(`${iso()}  **匯出讀不到，本輪未測到**  hub ${rss}MB  dump ${dumpKb}KB`);
    return;
  }
  const m = ex.metrics || {};
  const sum = Object.values(ex.balances || {}).reduce((t, v) => t + v, 0);
  // 同價決勝是否偏袒（#23）：收據裡 provider 的分佈。
  const byProvider = {};
  for (const r of ex.receipts || []) {
    const p = r.receipt.provider;
    byProvider[p] = (byProvider[p] || 0) + 1;
  }
  const dist = Object.entries(byProvider).sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d.slice(10, 17)}:${n}`).join(' ');
  console.log(
    `${iso()}  結算 ${(ex.receipts || []).length}  Σ ${sum.toFixed(9)}  ` +
    `成交率 ${m.fill_rate}  深度 ${m.avg_bids_per_task}  ` +
    `還債 ${m.avg_repayment_ms ?? '—'}ms/${m.repayment_episodes ?? 0}次  ` +
    `hub ${rss}MB  dump ${dumpKb}KB  cp ${(ex.checkpoints || []).length}`);
  console.log(`    provider 分佈: ${dist || '（尚無）'}`);
  // 四個 agent 的餘額／額度一律從**匯出**取，不從 Console——M2 那兩個的
  // Console 綁在 M2 的 127.0.0.1，從 M1 看不到。匯出是 Hub 的簽署狀態，
  // 四個都在裡面，所以這一行才是完整的；Console 只多給 mode 與還債次數。
  const cls = ex.credit_lines || {};
  const line = Object.entries(cls).map(([did, cl]) => {
    const b = (ex.balances || {})[did] || 0;
    return `${did.slice(10, 17)} ${b >= 0 ? '+' : ''}${b.toFixed(2)}/${cl.toFixed(0)}`;
  }).join('  ');
  console.log(`    帳戶（匯出）: ${line}`);
  for (const p of CONSOLES) {
    const c = await consoleOf(p);
    if (!c) { console.log(`    :${p} 無回應`); continue; }
    const s = c.strategy || {};
    console.log(`    ${c.name}: 餘額 ${c.balance_cc.toFixed(2)} / 額度 ` +
      `${c.credit_line_cc.toFixed(1)} mode ${s.mode} 還債 ${s.repay_episodes}次 ` +
      `開啟合約 ${(c.contracts || {}).open}`);
  }
}

console.log(`# 階段 A 記錄器：每 ${EVERY_S}s 一筆（§4）。Σ 必須為 0。`);
sample();
setInterval(sample, EVERY_S * 1000);
