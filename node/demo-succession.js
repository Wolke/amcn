// #95 的閘門：排序器離線時，網路自己換人接手——而**沒有任何私鑰被複製**。
//
// 修之前的接手長這樣：`standby-hub.sh` 用**同一個 `HUB_SEED`** 在第二台機器上
// 起來（所以是同一個 DID，client 才會跟上），升格由人手動執行，防分叉靠 runbook
// 的一句話。這支守的是換掉那三件之後的行為：
//
//   1. 後繼者是**自己的 DID**，而 client 仍然只釘前任——它靠一份**事先簽好**
//      的授權跟過來（`lib/succession.js`）。「事先」是關鍵：簽它的人可以在之後
//      離線，憑證仍然驗得過。
//   2. 升格是**自動**的：沒有人下指令，沒有人改設定。
//   3. 帳**延續**：後繼者從自己驗過的匯出接手（逐筆驗簽、重算鏈、比對
//      checkpoint root），所以它不需要信任任何人；Σ 仍然為 0。
//
// 四條負對照比正向那一條重要：沒有授權的人接不了、沒有驗過的帳本不准升格、
// 舊排序器不能趁機搶回排序權、憑證不能自己簽給自己。
//
// Run:  node demo-succession.js     (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { identityFromSeed } = require('./lib/wire');
const rv = require('./lib/rendezvous');
const su = require('./lib/succession');
const rebuildLib = require('./lib/rebuild');
const transport = require('./lib/transport').fromEnv();
const { fetchLedger } = require('./lib/ledgerfetch');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const P_PORT = 47180 + 1100 + OFFSET;
const S_PORT = P_PORT + 1;
const FAKE_PORT = P_PORT + 2;
const DEAD_PORT = P_PORT + 3;          // 沒有人在聽，負對照二用
const FAKE_KEY = 'sk-demo-succ-SECRET';
const DIR = path.join(__dirname, 'out', `demo-succ-${process.pid}`);
const RV = path.join(DIR, 'rendezvous.json');
const P = identityFromSeed(`demo-succ-primary-${process.pid}`);
const S = identityFromSeed(`demo-succ-standby-${process.pid}`);
const X = identityFromSeed(`demo-succ-outsider-${process.pid}`);

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 25000, step = 250) {
  const until = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}
const procs = [];
function spawnProc(file, env, args = []) {
  const p = spawn(process.execPath, [path.join(__dirname, file), ...args],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const box = { text: '', child: p, file };
  const grab = (d) => { box.text += d.toString(); };
  p.stdout.on('data', grab);
  p.stderr.on('data', grab);
  procs.push(box);
  return box;
}
const clientCfg = (o) => ({
  AGENT_CONFIG: JSON.stringify({ rendezvous: RV, hubPin: P.did, ...o }),
});
const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }];

async function exportFrom(port) {
  const chan = transport.dial({ host: '127.0.0.1', port });
  try { return await fetchLedger(chan, { timeoutMs: 20000 }); }
  catch { return null; }
  finally { try { chan.close(); } catch { /* closed */ } }
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  // --- 現任排序器，並且**趁自己還活著**簽好授權 ---
  const hubP = spawnProc('hub.js', {
    HUB_PORT: String(P_PORT), HUB_BIND: '127.0.0.1',
    HUB_SEED: `demo-succ-primary-${process.pid}`,
    HUB_BEACON: '0', HUB_AGE_RAMP_MS: '1',
    HUB_RENDEZVOUS: RV, HUB_RENDEZVOUS_MS: '800',
    HUB_SUCCESSORS: S.did,
    HUB_DUMP_PATH: path.join(DIR, 'p-ledger.json'),
  });
  await waitFor(() => fs.existsSync(RV));
  // 賣方要**能執行**才准出價（#21），所以它需要一個上游。第一版把 adapter
  // 設成 null，於是整場沒有任何出價、也就沒有結算——閘門因此在測「接手之後
  // 市場有沒有繼續」時，量到的其實是「市場從來沒有開始」。
  spawnProc('fake-provider.js', { FAKE_PORT: String(FAKE_PORT), FAKE_KEY });

  // --- client：只知道記錄位置與**前任**的 DID ---
  for (const v of ['V1', 'V2', 'V3']) spawnProc('verifier.js', clientCfg({ name: v }));
  await sleep(600);
  spawnProc('agent.js', { ...clientCfg({
    name: 'seller',
    adapter: { baseUrl: `http://127.0.0.1:${FAKE_PORT}`,
               key: { env: 'SUCC_KEY', service: 'amcn-demo-succ' },
               terms: { attested: true, note: 'demo upstream is fake-provider.js' } },
    provide: { afterMs: 0, pricePerUnit: 1.0, repayment: true },
  }), SUCC_KEY: FAKE_KEY });
  const buyer = spawnProc('agent.js', clientCfg({
    name: 'buyer', adapter: null, provide: null,
    posts: [
      { atMs: 1500, units: 5, maxPriceCC: 8, payload: 'before failover',
        acceptance: 'dsl-local', asserts: SHA_OK },
      // 接手之後才發的那一筆——市場有沒有繼續，看的是這一筆
      { atMs: 26000, units: 5, maxPriceCC: 8, payload: 'after failover',
        acceptance: 'dsl-local', asserts: SHA_OK },
    ],
  }));
  const settledBefore = await waitFor(() => /SETTLED/.test(hubP.text), 25000);
  const exBefore = await exportFrom(P_PORT);

  // --- 待命機：自己拉帳、自己驗 ---
  const sb = spawnProc('standby.js', {
    HUB_SEED: `demo-succ-standby-${process.pid}`,
    STANDBY_DIR: path.join(DIR, 'standby'),
    STANDBY_PULL_MS: '1500', HUB_PROMOTE_AFTER_MS: '3000',
    STANDBY_STAGGER_MS: '1000', HUB_ADVERTISE_HOST: '127.0.0.1',
  }, [RV, '--pin', P.did, '--port', String(S_PORT)]);
  const pulled = await waitFor(() => /已驗過並留下一份/.test(sb.text), 25000);

  // --- 拔掉現任。從這裡開始沒有人下任何指令 ---
  hubP.child.kill('SIGKILL');
  const promoted = await waitFor(() => /升格為排序器/.test(sb.text), 30000);
  const listening = await waitFor(() => /listening on 127\.0\.0\.1:/.test(sb.text), 20000);
  // client 跟過來（記錄已經換成後繼者簽的）
  const followed = await waitFor(() => procs.some((p) =>
    /rendezvous → .*— 接手/.test(p.text)), 30000);
  const reRegistered = await waitFor(() => /registered .*\(agent,/.test(sb.text) &&
    /registered .*\(verifier,/.test(sb.text), 30000);
  const settledAfter = await waitFor(() => /SETTLED/.test(sb.text), 45000);
  const exAfter = await exportFrom(S_PORT);

  // --- 負對照一：沒有被授權的人發布記錄，client 不跟 ---
  const rvX = path.join(DIR, 'rendezvous-x.json');
  fs.writeFileSync(rvX, JSON.stringify(
    rv.record(X, { host: '127.0.0.1', port: S_PORT },
      // 連「自己簽給自己」的憑證一起附上——一張有效簽章不等於一條從 pin
      // 出發的鏈，而那正是最容易寫錯的地方（#75／S20 的同一個教訓）。
      [su.cert(X, { successor: X.did, priority: 1 })]), null, 2));
  const vX = spawnProc('verifier.js', {
    AGENT_CONFIG: JSON.stringify({ name: 'VX', rendezvous: rvX, hubPin: P.did }),
  });
  const refusedX = await waitFor(() => /not the pinned hub/.test(vX.text), 12000);
  const vXRegistered = /registered as verifier/.test(vX.text);

  // --- 負對照二：沒有任何驗過的帳本，不准升格 ---
  // 不能重用 RV：它已經被後繼者覆蓋成「我自己簽的」，而待命機看到自己就會
  // 說「我就是現任」——那樣這條負對照量到的是別的東西（第一版就是這樣空過的）。
  // 合成一份：前任簽的記錄指向一個**沒有人在聽**的埠，外加前任簽給我的憑證。
  const rvDead = path.join(DIR, 'rendezvous-dead.json');
  fs.writeFileSync(rvDead, JSON.stringify(
    rv.record(P, { host: '127.0.0.1', port: DEAD_PORT },
      [su.cert(P, { successor: S.did, priority: 1 })]), null, 2));
  const sb2 = spawnSync(process.execPath, [path.join(__dirname, 'standby.js'),
    rvDead, '--pin', P.did, '--port', String(S_PORT + 5)], {
    env: { ...process.env,
      HUB_SEED: `demo-succ-standby-${process.pid}`,       // 同一個身分＝有授權
      STANDBY_DIR: path.join(DIR, 'standby-empty'),       // 但是沒有帳
      STANDBY_PULL_MS: '600', HUB_PROMOTE_AFTER_MS: '1',
      STANDBY_STAGGER_MS: '0' },
    encoding: 'utf8', timeout: 25000,
  });
  const sb2Said = (sb2.stdout || '') + (sb2.stderr || '');

  // --- 負對照三：舊排序器帶著舊帳回來，不准直接搶回排序權 ---
  const back = spawnSync(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env,
      HUB_PORT: String(P_PORT), HUB_BIND: '127.0.0.1',
      HUB_SEED: `demo-succ-primary-${process.pid}`,
      HUB_BEACON: '0', HUB_RENDEZVOUS: RV,
      HUB_IMPORT: path.join(DIR, 'p-ledger.json'),
      HUB_DUMP_PATH: path.join(DIR, 'p-ledger.json') },
    encoding: 'utf8', timeout: 25000,
  });
  const backSaid = (back.stdout || '') + (back.stderr || '');

  // --- 參與者那一側的工具：釘住**前任**去驗後繼者的帳 ---
  const exFile = path.join(DIR, 'after.json');
  let verifyPinned = { status: 1, out: '' }, verifyWrong = { status: 0, out: '' };
  if (exAfter) {
    fs.writeFileSync(exFile, JSON.stringify(exAfter, null, 2));
    const run = (pin) => {
      const r = spawnSync(process.execPath,
        [path.join(__dirname, 'verify-ledger.js'), exFile, '--pin', pin],
        { encoding: 'utf8', timeout: 30000 });
      return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };
    verifyPinned = run(P.did);                       // 釘前任：應該過
    verifyWrong = run('did:demo:0000000000000000');  // 釘一個沒關係的人：應該拒絕
  }

  console.log('\n== #95 排序器接手（不複製私鑰） 驗收檢查 ==');

  check('現任趁活著時簽好授權，而 client 只知道前任的 DID',
    /已簽接手憑證給 1 個待命排序器/.test(hubP.text) && S.did !== P.did,
    `前任 ${P.did.slice(0, 20)}… → 後繼者 ${S.did.slice(0, 20)}…（不同身分）`);

  check('待命機先拉帳並**驗過才留**（接手的人不必信任任何人）', !!pulled,
    (sb.text.match(/已驗過並留下一份：[^\n]*/) || [''])[0].slice(0, 60));

  check('現任被 SIGKILL 之後，升格是**自動**的（沒有人下指令）', !!promoted && !!listening,
    (sb.text.match(/升格為排序器[^\n]*/) || [''])[0].slice(0, 70));

  check('client 跟過來，而且它接受的是一個**不同的 DID**（憑事先的授權）',
    !!followed && !!reRegistered,
    (procs.map((p) => (p.text.match(/rendezvous → .*— 接手[^\n]*/) || [''])[0])
      .find(Boolean) || '').slice(0, 90));

  check('接手之後市場繼續（有新的結算）', !!settledAfter,
    settledAfter ? (sb.text.match(/SETTLED[^\n]*/) || [''])[0].slice(0, 60) : '沒有新結算');

  const sum = exAfter ? Object.values(exAfter.balances).reduce((a, b) => a + b, 0) : NaN;
  const rebuilt = exAfter ? rebuildLib.rebuild(exAfter) : { ok: false, errors: ['沒有匯出'] };
  check('帳延續且仍然守恆（Σ=0、逐筆驗簽重建通過、筆數沒有退回去）',
    !!exAfter && Math.abs(sum) < 1e-9 && rebuilt.ok &&
    exAfter.receipts.length >= (exBefore ? exBefore.receipts.length : 0),
    exAfter ? `Σ=${sum.toFixed(9)}，收據 ${exBefore ? exBefore.receipts.length : '?'} → ${exAfter.receipts.length}，rebuild ${rebuilt.ok ? 'ok' : rebuilt.errors[0]}` : '取不到帳');

  check('釘住**前任**的參與者仍然驗得過這本帳，而且工具會說出「接手」',
    verifyPinned.status === 0 && /接手：這本帳的排序器/.test(verifyPinned.out),
    (verifyPinned.out.match(/接手：[^\n]*/) || [''])[0].slice(0, 80) ||
      (verifyPinned.out.match(/結果：[^\n]*/) || [''])[0]);

  check('負對照四：釘一個沒有授權關係的 DID，同一本帳被拒絕',
    verifyWrong.status !== 0 && /沒有一條從它出發的鏈|expected/.test(verifyWrong.out),
    (verifyWrong.out.match(/export is from hub[^\n]*/) || [''])[0].slice(0, 90));

  check('負對照一：沒有被授權的人發布記錄，client 不跟（自己簽給自己不算）',
    !!refusedX && !vXRegistered,
    (vX.text.match(/unusable: [^\n]*/) || [''])[0].slice(0, 90));

  check('負對照二：沒有驗過的帳本就**不升格**（空白排序器會把餘額歸零）',
    /不升格/.test(sb2Said) && sb2.status === 1,
    `exit=${sb2.status}｜${(sb2Said.match(/沒有任何驗過的帳本[^\n]*/) || [''])[0].slice(0, 50)}`);

  check('負對照三：舊排序器不能趁機搶回排序權（後繼者的記錄還是新的）',
    back.status === 1 && /REFUSING to start/.test(backSaid) &&
    backSaid.includes(S.did),
    `exit=${back.status}｜${(backSaid.match(/REFUSING to start: [^\n]*/) || [''])[0].slice(0, 80)}`);

  const failed = results.filter(([, ok]) => !ok).length;
  // 有紅的就把待命機自己的 log 印出來（#80 的教訓：不要讓人去猜子行程發生
  // 什麼事，尤其這支的一半劇情都在那個行程裡）。
  if (failed) {
    console.log('\n-- 待命機／升格後的排序器 log（最後 40 行）--');
    console.log(sb.text.trim().split('\n').slice(-40).map((l) => '  ' + l).join('\n'));
  }
  procs.forEach((p) => { try { p.child.kill(); } catch { /* gone */ } });
  await sleep(500);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  procs.forEach((p) => { try { p.child.kill(); } catch { /* gone */ } });
  process.exit(1);
});
