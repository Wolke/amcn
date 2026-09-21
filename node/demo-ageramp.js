#!/usr/bin/env node
// #82 的回歸閘門：在**真實的年齡斜坡**下，重建出來的信用額度必須與匯出一致。
//
// 為什麼需要一支專門的 demo：這個缺陷能活下來，正是因為**每一支** harness 都
// 設 `HUB_AGE_RAMP_MS=1`（demo、demo-rebuild、chaos-run、redteam 全部）。斜坡
// 在一毫秒內走完，兩邊都得到 age=1，於是 `rebuild` 漏傳 ageFactor 這件事在
// harness 裡**結構上不可能出現**。它是三台真機試點用生產預設跑時才現形的：
// 重建 55.0 對匯出 30.1，每個帳戶都差整整 25 CC（`STARTER*(0.5+0.5*age)` 在
// age 0 與 1 之間差一倍），接手因此被拒——也就是說在生產設定下，
// 排序器接手**永遠不可能成功**。
//
// 所以這支刻意**不設** HUB_AGE_RAMP_MS。任何人想用「加快一點」讓它變穩定，
// 就是把這個閘門變回原樣。
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const transport = require('./lib/transport').get('tcp');
const { fetchLedger } = require('./lib/ledgerfetch');
const { rebuild } = require('./lib/rebuild');

const PORT = 47196 + Number(process.env.DEMO_PORT_OFFSET || 0);
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d) => {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
};
const spawnProc = (f, env) => {
  const p = spawn(process.execPath, [path.join(__dirname, f)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p); return p;
};

async function main() {
  console.log('== #82：真實年齡斜坡下的重建（刻意不壓縮 HUB_AGE_RAMP_MS）==\n');
  // 要在 spawn **之前**設：子行程繼承的是當下的環境，之後再改沒有用。
  process.env.AR_KEY = 'ar-key';
  // 沒有 HUB_AGE_RAMP_MS ⇒ 預設 30 天 ⇒ 剛註冊的帳戶 age≈0 ⇒ starter 項是一半。
  spawnProc('hub.js', { HUB_PORT: String(PORT), HUB_BEACON: '0', HUB_SEED: 'ageramp' });
  await sleep(1200);
  const cfg = (n, extra) => ({
    AGENT_CONFIG: JSON.stringify({ name: n, seed: `ar-${n}`, hubPort: PORT, ...extra }),
  });
  for (const v of ['V1', 'V2', 'V3']) spawnProc('verifier.js', cfg(v));
  await sleep(600);
  // 角色分工而不是對稱人口：賣方要有 `quota.remaining >= units` 才准出價
  // （#22），而兩個都有需求時各自把額度吃光，結果是互相 `no bids`、零成交。
  // 這支閘門要的是「有成交 ＋ 真實斜坡」，不是模擬市場，所以 R 只買、P 只賣。
  spawnProc('agent.js', cfg('R', {              // 只買
    adapter: { baseUrl: null, key: { env: 'AR_KEY' } }, posts: [],
    policy: {
      quota: { capacityUnits: 0.0001, cycleMs: 4000 },
      demand: { meanUnits: 5, tickMs: 1200, burstProb: 0, burstMultiplier: 1 },
      budget: { maxPricePerUnit: 1.5, minUnits: 3, maxUnitsPerTask: 5 },
      acceptance: { method: 'judge-quorum', asserts: [{ op: 'sha256_eq' }] },
    },
  }));
  spawnProc('agent.js', cfg('P', {              // 只賣
    adapter: { baseUrl: null, key: { env: 'AR_KEY' } }, posts: [],
    provide: { afterMs: 0, pricePerUnit: 1.0, repayment: true },
    policy: {
      quota: { capacityUnits: 400, cycleMs: 4000 },
      demand: { meanUnits: 0, tickMs: 60000, burstProb: 0, burstMultiplier: 1 },
      budget: { maxPricePerUnit: 1.5, minUnits: 3, maxUnitsPerTask: 5 },
      acceptance: { method: 'judge-quorum', asserts: [{ op: 'sha256_eq' }] },
    },
  }));
  await sleep(24000);

  const c = transport.dial({ port: PORT });
  const ex = await fetchLedger(c, { timeoutMs: 12000 }).catch(() => null);
  try { c.close(); } catch { /* gone */ }
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });

  if (!ex) { check('取得匯出', false, '拿不到'); return done(); }
  check('有成交（否則額度只有 starter 項，測不到 E_eff）',
    ex.receipts.length > 0, `${ex.receipts.length} 筆收據`);
  check('匯出帶 exported_at（年齡要以匯出當下為準，#82）', !!ex.exported_at,
    ex.exported_at ? new Date(ex.exported_at).toISOString() : '缺');
  const lines = Object.values(ex.credit_lines || {});
  check('額度確實處在斜坡上（不是已成熟的 50）',
    lines.length > 0 && lines.every((v) => v > 20 && v < 45),
    lines.map((v) => v.toFixed(2)).join(' '));
  const r = rebuild(JSON.parse(JSON.stringify(ex)));
  check('rebuild 接受這份匯出（修 #82 之前每個帳戶差約 25 CC）', r.ok,
    r.ok ? '逐筆驗簽、鏈重算、額度比對全過'
         : r.errors.slice(0, 2).join('；'));
  check('沒有因為缺欄位而跳過額度比對', (r.warnings || []).length === 0,
    (r.warnings || []).join('；') || '零警告');
  done();
}
function done() {
  console.log(`\n結果：${pass}/${pass + fail} PASS`);
  process.exit(fail ? 1 : 0);
}
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
main().catch((e) => { console.error(e); process.exit(1); });
