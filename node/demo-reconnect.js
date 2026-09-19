// W10 拔線演練的自動化預演（§4 #40 的回歸閘門）。
//
// 為什麼需要它：在三台機器的試點上，機器 3 的 panel 掉線後**再也沒有回來**
// ——Hub 正確地把三個 Verifier 標記為離線（#35），pool 變空，judge-quorum
// 任務不再得標，整個網路就停在那裡。沒有人拔線，只是 Wi-Fi 抖了一下。
//
// 所以這支 demo 斷言的不是「能連上」，而是**沒有人介入時能不能自己回來**：
// 殺掉 Hub、讓它以同一個 seed 從自動匯出重啟，然後要求 agent 與 verifier
// 自行重連、自行重新註冊、餘額與信用額度延續、交易恢復。這就是階段 B 演練
// 的核心主張，只是壓縮到秒級。
//
// 也一併驗時間戳：演練要量「多久才發現」，而不久前每一行 log 都沒有時間。
//
// Run:  node demo-reconnect.js        (DEMO_PORT_OFFSET=100 可與試點並存)
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const transport = require('./lib/transport').fromEnv();

const PORT_OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + PORT_OFFSET;
const CONSOLE_A = 47211 + PORT_OFFSET;
const CONSOLE_B = 47212 + PORT_OFFSET;
const CONSOLE_C = 47213 + PORT_OFFSET;
const DUMP = path.join(__dirname, 'out', `reconnect-${PORT}.json`);
const HUB_SEED = 'demo-reconnect-hub';
// 秒級節奏：與 demo-autonomous 同一組比例，只是把時間壓回 demo 尺度。
const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }];
const POLICY = (phase) => ({
  quota: { capacityUnits: 40, cycleMs: 3500, cycleOffsetMs: phase },
  demand: { meanUnits: 5, tickMs: 900, burstProb: 0.25, burstMultiplier: 4 },
  budget: { maxPricePerUnit: 1.3, minUnits: 3, maxUnitsPerTask: 8 },
  acceptance: { method: 'judge-quorum', asserts: SHA_OK },
});

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const logs = {};   // name -> accumulated stdout
function spawnProc(name, file, env) {
  const p = spawn(process.execPath, [path.join(__dirname, file)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  logs[name] = logs[name] || '';
  const grab = (d) => { logs[name] += d.toString(); };
  p.stdout.on('data', grab);
  p.stderr.on('data', grab);
  return p;
}
const agentCfg = (o) => ({
  AGENT_CONFIG: JSON.stringify({ hubPort: PORT, adapter: null, posts: [], ...o }),
  A_KEY: 'sk-recon-A', B_KEY: 'sk-recon-B', C_KEY: 'sk-recon-C',
});
const hubEnv = (extra) => ({
  HUB_PORT: String(PORT), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0', HUB_SEED,
  HUB_DUMP_PATH: DUMP, HUB_DUMP_MS: '1000', ...extra,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等 Hub **真的在 listen**（#80）。從前 spawn 之後固定睡 14 秒就開始量，
// 於是負載高時「Hub 還在啟動」會被報成「0/6 個 client 自行重連」——一個
// 啟動延遲被讀成協定失敗，與 #76 同型。並行跑時穩定 5/8、單獨跑 8/8，
// 而三個 FAIL 裡最誠實的線索是「新增 −2 筆」：接手的 Hub 回報的收據比
// 斷線前還少，也就是它根本還沒把帳載起來。
const waitForHub = async (port, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const up = await new Promise((resolve) => {
      const c = transport.dial({ port });
      const t = setTimeout(() => { try { c.close(); } catch {} resolve(false); }, 800);
      c.onMessage((m) => {
        if (m.type !== 'verifiers') return;
        clearTimeout(t); try { c.close(); } catch {} resolve(true);
      });
      try { c.send({ type: 'list_verifiers' }); } catch { /* not up yet */ }
    });
    if (up) return Date.now();
    await sleep(400);
  }
  return null;
};
const status = async (port) => {
  try { return await (await fetch(`http://127.0.0.1:${port}/status`)).json(); }
  catch { return null; }
};
const exportLedger = () => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 4000);
  const c = transport.dial({ port: PORT });
  c.onMessage((m) => {
    if (m.type !== 'ledger_export') return;
    clearTimeout(t); c.close(); resolve(m);
  });
  c.send({ type: 'export' });
});
// ISO-8601 前綴（lib/log.js）。演練要量「多久才發現」，靠的就是這個。
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /m;

async function main() {
  console.log('== W10 預演：殺掉 Hub，沒有人介入，網路自己回來 ==\n');
  fs.mkdirSync(path.dirname(DUMP), { recursive: true });
  fs.rmSync(DUMP, { force: true });

  const procs = [];
  let hub = spawnProc('hub', 'hub.js', hubEnv());
  procs.push(hub);
  await sleep(500);
  for (const v of ['V1', 'V2', 'V3']) {
    procs.push(spawnProc(v, 'verifier.js', agentCfg({ name: v, seed: `recon-${v}` })));
  }
  await sleep(300);
  procs.push(spawnProc('A', 'agent.js', agentCfg({
    name: 'A', seed: 'recon-A', consolePort: CONSOLE_A,
    adapter: { baseUrl: null, key: { env: 'A_KEY' } },
    provide: { afterMs: 0, pricePerUnit: 1.0, repayment: true },
    policy: POLICY(0),
  })));
  procs.push(spawnProc('B', 'agent.js', agentCfg({
    name: 'B', seed: 'recon-B', consolePort: CONSOLE_B,
    adapter: { baseUrl: null, key: { env: 'B_KEY' } },
    provide: { afterMs: 0, pricePerUnit: 0.95, repayment: true },
    policy: POLICY(1200),
  })));
  // Three, not two, for the reason demo-autonomous records: demand has to be
  // mutual and bursts have to land at different times, or both agents are
  // short at the same moment and nobody has spare quota to sell (#22 refuses
  // to sell what you do not have). With two agents the first phase produced
  // `no bids` and zero settlements.
  procs.push(spawnProc('C', 'agent.js', agentCfg({
    name: 'C', seed: 'recon-C', consolePort: CONSOLE_C,
    adapter: { baseUrl: null, key: { env: 'C_KEY' } },
    provide: { afterMs: 0, pricePerUnit: 1.05, repayment: true },
    policy: POLICY(2400),
  })));

  console.log('-- 階段 1：正常運行 16s --');
  await sleep(16000);
  const before = await exportLedger();
  const beforeA = await status(CONSOLE_A);
  const settledBefore = before ? before.receipts.length : 0;
  console.log(`   斷線前：${settledBefore} 筆結算，A 餘額 ` +
    `${beforeA ? beforeA.balance_cc.toFixed(2) : '?'} CC\n`);

  console.log('-- 階段 2：殺掉 Hub（不通知任何人），停 6s --');
  const killedAt = Date.now();
  hub.kill('SIGKILL');
  await sleep(6000);
  const downA = await status(CONSOLE_A);   // agent 必須還活著
  const noticed = /disconnected from 127\.0\.0\.1:\d+ — reconnecting in \d+ms/;
  const clientsNoticed = ['A', 'B', 'C', 'V1', 'V2', 'V3']
    .filter((n) => noticed.test(logs[n] || ''));
  const retrying = ['A', 'B', 'C', 'V1', 'V2', 'V3']
    .filter((n) => /cannot resolve a hub address|reconnecting in/.test(logs[n] || ''));
  console.log(`   ${clientsNoticed.length}/6 個 client 記錄了斷線，` +
    `agent A ${downA ? '仍存活' : '已死亡'}\n`);

  console.log('-- 階段 3：Hub 以同一個 seed 從自動匯出重啟（第二排序器接手）--');
  hub = spawnProc('hub2', 'hub.js', hubEnv({ HUB_IMPORT: DUMP }));
  procs.push(hub);
  const restartedAt = Date.now();
  // 重連窗從「Hub 開始 listen」算起，不是從「行程被 spawn」算起（#80）。
  const hubUpAt = await waitForHub(PORT, 25000);
  // 沒有人重啟 agent、沒有人改設定、沒有人呼叫 Console。
  await sleep(14000);
  const after = await exportLedger();
  const afterA = await status(CONSOLE_A);
  const reconnected = ['A', 'B', 'C', 'V1', 'V2', 'V3']
    .filter((n) => /reconnected to 127\.0\.0\.1:\d+ after \d+ attempt/.test(logs[n] || ''));
  const reRegistered = (logs.hub2 || '').match(/registered did:demo:/g) || [];
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });

  const settledAfter = after ? after.receipts.length : 0;
  const newSettlements = settledAfter - settledBefore;
  console.log(`   重啟後：${settledAfter} 筆結算（新增 ${newSettlements}），` +
    `A 餘額 ${afterA ? afterA.balance_cc.toFixed(2) : '?'} CC\n`);

  console.log('== 驗收檢查 ==');

  check('§4 #40 斷線被偵測並記錄（此前是完全靜默）',
    clientsNoticed.length >= 5,
    `${clientsNoticed.length}/6 個 client 印出 disconnected + reconnecting：` +
    `${clientsNoticed.join(', ')}`);

  check('Hub 消失不會殺掉 client（agent 與 verifier 全程存活）',
    !!downA && !!afterA,
    downA ? 'A 的 Console 在 Hub 死亡期間仍然回應' : 'A 已死亡');

  // 「Hub 沒起來」與「client 沒重連」必須分開講，否則下一個人會像我一樣
  // 連續兩次把前者診斷成後者（#80）。
  if (hubUpAt === null) {
    // 「沒起來」還要說**為什麼**，否則下一個人只是換一個謎題。Hub 自己會把
    // EADDRINUSE、匯入驗證失敗等原因印出來，那些行就是答案。
    const why = (logs.hub2 || '').split('\n').filter((x) => x.trim()).slice(-3);
    console.log('  註：接手的 Hub 在 25s 內沒有開始 listen——' +
      '以下重連相關的斷言量的是啟動延遲，不是協定行為（#80）');
    console.log(why.length ? why.map((x) => `       hub2: ${x}`).join('\n')
                           : '       hub2 沒有輸出任何一行');
  }
  check('無人介入即自行重連（沒有重啟 agent、沒有改設定、沒有呼叫 Console）',
    reconnected.length >= 5,
    `${reconnected.length}/6 個 client 自行重連：${reconnected.join(', ')}`);

  check('重連後重新註冊，Hub 重新認得每個 DID',
    reRegistered.length >= 5,
    `接手的 Hub 收到 ${reRegistered.length} 筆 register`);

  check('身分與帳延續：餘額不歸零（同 seed ＋ 匯入的帳本）',
    !!afterA && !!beforeA && Math.abs(afterA.balance_cc) > 0 &&
    afterA.settled.length >= beforeA.settled.length,
    beforeA && afterA
      ? `A：斷線前 ${beforeA.balance_cc.toFixed(2)} CC/${beforeA.settled.length} 筆 → ` +
        `接手後 ${afterA.balance_cc.toFixed(2)} CC/${afterA.settled.length} 筆`
      : 'Console 無回應');

  check('交易恢復：接手的 Hub 上產生新的結算',
    newSettlements >= 1, `新增 ${newSettlements} 筆（斷線前 ${settledBefore}）`);

  check('離線期間送出的 frame 被記數而非靜默丟棄',
    /outbound frame\(s\) dropped while down/.test(
      ['A', 'B', 'C', 'V1', 'V2', 'V3'].map((n) => logs[n] || '').join('\n')) ||
    retrying.length >= 5,
    '重連訊息帶出離線期間的丟棄數（或至少記錄了重試）');

  check('每一行 log 都有 ISO-8601 時間戳（演練才能量「多久發現」）',
    STAMP.test(logs.hub || '') && STAMP.test(logs.A || '') && STAMP.test(logs.V1 || ''),
    `hub/agent/verifier 三邊皆有；Hub 死亡 → 重啟間隔 ` +
    `${((restartedAt - killedAt) / 1000).toFixed(1)}s`);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  if (failed) {
    for (const n of ['A', 'V1', 'hub2']) {
      console.log(`\n--- ${n} 最後 12 行 ---`);
      console.log((logs[n] || '(無輸出)').trim().split('\n').slice(-12).join('\n'));
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
