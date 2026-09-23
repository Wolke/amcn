// #98 的閘門：常駐服務**組合起來**是不是你以為的那一組。
//
// 單支程式各自有閘門（#90 的入門採購 10/10、#94 的花費上限 10/10、#95 的接手
// 11/11），但「這台機器實際上跑的是什麼」是由 `service/` 那幾個腳本決定的，而
// 它們從來沒有被守過。這裡守三件會安靜出錯的事：
//
//   1. **新人的第一筆額度是多少**。白拿 ≈ starter × 0.87（#90／credit-regime-ab），
//      所以這個值就是對 Sybil 的曝險上界。它是一個環境變數，而環境變數最容易
//      在某次重構裡回到預設值——那種回歸不會讓任何 demo 變紅。
//   2. **入門採購的發樁者有沒有被授權**，以及順序對不對：Hub 讀
//      `configs/.onboard-seed` 算出 DID 並授權它，所以那個檔必須**先**存在。
//      反了的話發樁者的每一筆都被拒絕，而那種失敗很安靜——只會看起來像
//      「新人沒有工作可做」。
//   3. **`install.sh` 真的會裝那個服務**（源碼層），否則上面兩件都只是設定。
//
// Run:  node demo-service.js      (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const rebuildLib = require('./lib/rebuild');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + 1300 + OFFSET;
const DIR = path.join(__dirname, 'out', `demo-service-${process.pid}`);

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 200) {
  const until = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}
const sh = (script, args = [], env = {}) => {
  const r = spawnSync('/bin/bash', [path.join(__dirname, 'service', script), ...args],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000, cwd: __dirname });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const kv = (out) => Object.fromEntries(out.trim().split('\n')
  .filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

// 起一個 Hub，回報「一個全新身分第一天拿到多少額度」——那是這個閘門真正
// 在量的數字，而不是環境變數的字面值。
async function dayOneCreditLine(starter) {
  const dir = path.join(DIR, `starter-${starter}`);
  fs.mkdirSync(dir, { recursive: true });
  const hub = spawn(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env, HUB_PORT: String(PORT), HUB_BIND: '127.0.0.1',
      HUB_BEACON: '0', DEMO_STARTER_CC: String(starter),
      HUB_SEED: `demo-service-${starter}`,
      HUB_DUMP_PATH: path.join(dir, 'ledger.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let log = '';
  let died = null;
  hub.stdout.on('data', (d) => { log += d.toString(); });
  // 埠被佔用時要立刻說，而不是等一個永遠不會到的斷言（#93 的同一條教訓，
  // 而這支自己先踩了一次：上一個手動測試留下的行程佔著 48480）。
  hub.on('exit', (code) => { if (code) died = code; });
  await waitFor(() => died || /listening on/.test(log));
  if (died) {
    console.error(`  [demo] hub.js 以 ${died} 退出——埠 ${PORT} 可能已經有人在聽，` +
      '用 DEMO_PORT_OFFSET=100 換一組埠');
    return null;
  }
  const v = spawn(process.execPath, [path.join(__dirname, 'verifier.js')], {
    env: { ...process.env,
      AGENT_CONFIG: JSON.stringify({ name: 'newcomer', hubPort: PORT,
        seed: `demo-service-newcomer-${starter}-${process.pid}` }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = await waitFor(() => (log.match(/registered \S+ \(verifier, CL ([\d.]+)\)/) || [])[1]);
  v.kill(); hub.kill();
  await sleep(300);
  return line ? Number(line) : null;
}

// #99：改了 starter 之後，這台機器**還起不起得來**。
// 這是實測撞到的：live 節點把 starter 從 50 調成 10 之後，Hub 拒絕啟動
// （`credit line mismatch … rebuilt 5.160 vs export 25.798`），整個網路停在那裡
// ——而它拒絕得對，因為那本帳裡存的額度是用舊政策算的。修法是把 starter 當成
// **那本帳的政策**（跟著匯出走），而不是重建方的環境變數。
async function starterChangeSurvivesRestart() {
  const dir = path.join(DIR, 'policy-change');
  fs.mkdirSync(dir, { recursive: true });
  const dump = path.join(dir, 'ledger.json');
  const port = PORT + 20;
  const spawnHub = (starter, extra = {}) => {
    const h = spawn(process.execPath, [path.join(__dirname, 'hub.js')], {
      env: { ...process.env, HUB_PORT: String(port), HUB_BIND: '127.0.0.1',
        HUB_BEACON: '0', DEMO_STARTER_CC: String(starter),
        HUB_SEED: 'demo-service-policy', HUB_DUMP_PATH: dump,
        HUB_DUMP_MS: '600', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const box = { text: '', child: h };
    h.stdout.on('data', (d) => { box.text += d.toString(); });
    h.stderr.on('data', (d) => { box.text += d.toString(); });
    return box;
  };

  // (a) 用 starter 50 跑出**一筆真的成交**，再讓它寫出帶著舊政策的匯出。
  //     為什麼要成交：額度比對只比對得出 stats 的帳戶，而 stats 是由收據與
  //     事件重播出來的——一個只註冊過、沒有任何紀錄的帳戶根本不會被比到，
  //     於是這條負對照會**空過**（第一版就是這樣綠的）。
  const fakePort = port + 10;
  const key = 'sk-demo-service-SECRET';
  const kids = [];
  const a = spawnHub(50);
  await waitFor(() => /listening on/.test(a.text));
  const side = (file, cfg, extraEnv = {}) => {
    const c = spawn(process.execPath, [path.join(__dirname, file)],
      { env: { ...process.env, AGENT_CONFIG: JSON.stringify(cfg), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(c);
    return c;
  };
  kids.push(spawn(process.execPath, [path.join(__dirname, 'fake-provider.js')],
    { env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_KEY: key },
      stdio: ['ignore', 'pipe', 'pipe'] }));
  await sleep(500);
  for (const n of ['V1', 'V2', 'V3']) side('verifier.js', { name: n, hubPort: port });
  await sleep(400);
  side('agent.js', {
    name: 'seller', hubPort: port,
    adapter: { baseUrl: `http://127.0.0.1:${fakePort}`,
               key: { env: 'SERVICE_KEY', service: 'amcn-demo-service' },
               terms: { attested: true, note: 'demo upstream is fake-provider.js' } },
    provide: { afterMs: 0, pricePerUnit: 1.0, repayment: true },
  }, { SERVICE_KEY: key });
  side('agent.js', {
    name: 'buyer', hubPort: port, adapter: null, provide: null,
    posts: [{ atMs: 1200, units: 5, maxPriceCC: 8, payload: 'policy change task',
              acceptance: 'dsl-local',
              asserts: [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }] }],
  });
  await waitFor(() => /SETTLED/.test(a.text), 25000);
  const wrote = await waitFor(() => {
    try {
      const ex = JSON.parse(fs.readFileSync(dump, 'utf8'));
      return Object.keys(ex.credit_lines || {}).length && ex.receipts.length ? ex : null;
    } catch { return null; }
  }, 12000);
  kids.forEach((c) => { try { c.kill(); } catch { /* gone */ } });
  a.child.kill();
  await sleep(600);

  // (b) 同一本帳，改成 starter 10 再啟動：必須起得來，而且要說出政策不同
  const b = spawnHub(10, { HUB_IMPORT: dump, HUB_TAIL: '0' });
  const up = await waitFor(() => /listening on/.test(b.text), 15000);
  const said = /這本帳的 starter 是 50/.test(b.text);
  b.child.kill();
  await sleep(400);

  // (c) 負對照：謊報那本帳的政策（starter 改成 999），額度重算就對不上。
  //     這一條直接呼叫 `rebuild()` 而不是再起一個 Hub——Hub 的拒絕路徑已經由
  //     (b) 與 live 事故覆蓋，而「起一個會成功啟動的行程再等它逾時」會把
  //     「接受了」與「逾時」混成同一個結果（第一版就是這樣讀錯的）。
  const tampered = wrote ? JSON.parse(JSON.stringify(wrote)) : null;
  let refusedTampered = false, tamperedWhy = '沒有匯出可以改';
  if (tampered) {
    tampered.starter_cc = 999;
    const rr = rebuildLib.rebuild(tampered);
    refusedTampered = !rr.ok && rr.errors.some((e) => /credit line mismatch/.test(e));
    tamperedWhy = rr.ok ? '重建竟然通過了' : (rr.errors[0] || '').slice(0, 90);
  }
  return { wrote: !!wrote, starterInExport: wrote ? wrote.starter_cc : null,
           up: !!up, said, refusedTampered, tamperedWhy };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  // 順序：發樁者的身分要先存在（install.sh 就是這個順序）
  const did = sh('run-onboard.sh', ['--did']);
  const onboardCheck = sh('run-onboard.sh', ['--check']);
  const hubEnv = kv(sh('run-hub.sh', ['--print-env']).out);
  const onboardDid = (did.out || '').trim();

  const cl10 = await dayOneCreditLine(10);
  const cl50 = await dayOneCreditLine(50);

  const installSrc = fs.readFileSync(path.join(__dirname, 'service', 'install.sh'), 'utf8');
  const policy = await starterChangeSurvivesRestart();

  console.log('\n== #98 常駐服務的組合 驗收檢查 ==');

  check('新人的第一筆額度是 starter 10（白拿 ≈ starter × 0.87，就是 Sybil 曝險上界）',
    hubEnv.DEMO_STARTER_CC === '10',
    `run-hub.sh 算出 DEMO_STARTER_CC=${hubEnv.DEMO_STARTER_CC}`);

  check('而那個值**真的**改變了一個全新身分第一天拿到的額度',
    cl10 !== null && cl50 !== null && cl10 < cl50 / 2 && cl10 <= 5,
    `starter 10 → CL ${cl10} CC；starter 50 → CL ${cl50} CC（第一天，年齡斜坡未走完）`);

  check('入門採購的發樁者已被授權，而且順序對（Hub 讀得到那個身分）',
    !!onboardDid && onboardDid.startsWith('did:demo:') &&
    hubEnv.HUB_ONBOARD_DID === onboardDid,
    `${onboardDid} = HUB_ONBOARD_DID`);

  // 全網上限刻意小於 hub.js 的內建預設（#103：題目是算 sha256，對誰都免費，
  // 所以它現在是一個有上限的水龍頭而不是已證明的反 Sybil 機制）。斷言只要求
  // 「有上限、而且比內建預設嚴」，不要求某個特定數字——數字是治理決定。
  check('兩個治理上限與「連續 3 次才付」都在，而全網上限比內建預設更嚴（#103）',
    hubEnv.HUB_ONBOARD_CAP_CC === '20' &&
    Number(hubEnv.HUB_ONBOARD_TOTAL_CC) > 0 &&
    Number(hubEnv.HUB_ONBOARD_TOTAL_CC) <= 2000 &&
    hubEnv.HUB_ONBOARD_STREAK === '3',
    `每身分 ${hubEnv.HUB_ONBOARD_CAP_CC}、全網 ${hubEnv.HUB_ONBOARD_TOTAL_CC}、連續 ${hubEnv.HUB_ONBOARD_STREAK} 次`);

  check('run-onboard.sh --check 只印設定、不啟動任何東西',
    onboardCheck.status === 0 && onboardCheck.out.includes(onboardDid) &&
    /ONBOARD_EVERY_MS=/.test(onboardCheck.out),
    onboardCheck.out.trim().split('\n')[1]);

  check('install.sh 會把發樁者裝成一個服務（源碼層）',
    /com\.amcn\.onboard/.test(installSrc) && /run-onboard\.sh/.test(installSrc) &&
    /launchctl load "\$LA\/com\.amcn\.onboard\.plist"/.test(installSrc) &&
    /run-onboard\.sh" --did/.test(installSrc),
    '5 個服務，且安裝時先產生發樁者身分再起 Hub');

  check('匯出記下了那本帳的 starter（政策跟著帳走，不是跟著環境變數，#99）',
    policy.wrote && policy.starterInExport === 50,
    `匯出裡 starter_cc=${policy.starterInExport}`);

  check('改了 starter 之後這台機器**還起得來**，而且會說出政策換過',
    policy.up && policy.said,
    policy.up ? (policy.said ? '起來了，並指出帳本的 starter 是 50' : '起來了但沒說')
      : '起不來——這正是 live 節點撞到的那個狀態');

  check('負對照：匯出裡的 starter 被改掉時，額度重算對不上而拒絕啟動',
    policy.refusedTampered,
    policy.refusedTampered ? policy.tamperedWhy.slice(0, 80) : `沒有拒絕：${policy.tamperedWhy}`);

  fs.rmSync(DIR, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
