// 「裝完就能收發任務」的閘門（#92）。
//
// 在 lib/bootstrap.js 之前，`node agent.js` 不帶設定檔會死在
// `JSON.parse(undefined)`——也就是安裝完**什麼都不會發生**，而要加入別人的網路
// 只能手貼位址與 pin。這支守的是修好之後的四件事：
//
//   1. 沒有預設網路時，說出三條可以走的路，而不是丟一個例外堆疊。
//   2. 有預設網路時，**不帶任何參數**就加入：解析簽署過的位址記錄 → 撥出去
//      → 註冊 → 開始收發任務。位址不在設定裡，因為位址會變。
//   3. 身分跨重啟不變（否則舊 DID 的餘額沒人能花、負債沒人會還，#17／#84）。
//   4. pin 不符時**不連**——預設網路是一個「別人給的網址」，而信任錨是 pin，
//      不是那個網址。
//
// Run:  node demo-bootstrap.js      (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { identityFromSeed } = require('./lib/wire');
const { didOf } = require('./lib/discovery');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + 900 + OFFSET;
const DIR = path.join(__dirname, 'out', `demo-bootstrap-${process.pid}`);
const RV = path.join(DIR, 'rendezvous.json');
const IDS = path.join(DIR, 'ids');
const SEED = 'demo-bootstrap-hub';
const HUB_DID = didOf(identityFromSeed(SEED).pub);

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

// 以「不帶設定檔」的方式起一個客戶端，收集它說的話。
function startClient(script, env, args = []) {
  const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
    env: { ...process.env, AMCN_CONFIG_DIR: IDS, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '', child };
  const grab = (b) => { out.text += b.toString(); };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  return out;
}

async function main() {
  fs.mkdirSync(IDS, { recursive: true });

  // (1) 沒有預設網路：一個**同步**的執行就夠，因為它應該立刻結束。
  const bare = spawnSync(process.execPath, [path.join(__dirname, 'agent.js')], {
    env: { ...process.env, AMCN_CONFIG_DIR: IDS,
           AMCN_BOOTSTRAP: '', AMCN_HUB_PIN: '' },
    encoding: 'utf8', timeout: 20000,
  });
  const bareSaid = (bare.stdout || '') + (bare.stderr || '');

  const hub = spawn(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env,
      HUB_PORT: String(PORT), HUB_BIND: '127.0.0.1', HUB_SEED: SEED,
      HUB_BEACON: '0', HUB_AGE_RAMP_MS: '1',
      HUB_RENDEZVOUS: RV, HUB_RENDEZVOUS_MS: '1000',
      HUB_DUMP_PATH: path.join(DIR, 'ledger.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let hubLog = '';
  hub.stdout.on('data', (d) => { hubLog += d.toString(); process.stdout.write(`  ${d}`); });
  await waitFor(() => fs.existsSync(RV));

  // (2) 預設網路存在：不帶任何參數的 agent。
  const a1 = startClient('agent.js', { AMCN_BOOTSTRAP: RV, AMCN_HUB_PIN: HUB_DID });
  const a1Reg = await waitFor(() => /registered, dynamic credit line/.test(a1.text));
  const did1 = (a1.text.match(/DID \S+ (did:demo:[0-9a-f]+)/) || [])[1] || null;
  a1.child.kill();
  await sleep(600);

  // (3) 同一台機器再起一次：身分要是同一個。
  const a2 = startClient('agent.js', { AMCN_BOOTSTRAP: RV, AMCN_HUB_PIN: HUB_DID });
  await waitFor(() => /registered, dynamic credit line/.test(a2.text));
  const did2 = (a2.text.match(/DID \S+ (did:demo:[0-9a-f]+)/) || [])[1] || null;
  a2.child.kill();

  // (4) pin 不符：記錄是真的、簽章是有效的，但簽的人不是被釘住的那一個。
  const bad = startClient('agent.js',
    { AMCN_BOOTSTRAP: RV, AMCN_HUB_PIN: 'did:demo:0000000000000000' });
  const badSaid = await waitFor(() => /not the pinned hub/.test(bad.text), 12000);
  const badRegistered = /registered, dynamic credit line/.test(bad.text);
  bad.child.kill();

  // (5) verifier 走同一條路——門檻最低的角色最需要「一行就好」。
  const v = startClient('verifier.js', { AMCN_BOOTSTRAP: RV, AMCN_HUB_PIN: HUB_DID });
  const vReg = await waitFor(() => /registered as verifier/.test(v.text));
  v.child.kill();

  console.log('\n== #92 裝完就加入預設網路 驗收檢查 ==');

  check('沒有預設網路時說出可以走的三條路（而不是 JSON.parse 的例外）',
    bare.status === 1 && /沒有預設網路/.test(bareSaid) &&
    /quickstart|--standalone/.test(bareSaid) && !/JSON\.parse|undefined\s*\^/.test(bareSaid),
    `exit=${bare.status}｜${(bareSaid.split('\n').find((l) => /沒有預設網路/.test(l)) || '').slice(0, 40)}`);

  check('不帶任何參數就加入預設網路（位址不在設定裡）', !!a1Reg,
    a1Reg ? (a1.text.match(/registered, dynamic credit line [\d.]+ CC/) || [''])[0]
      : a1.text.trim().split('\n').slice(-2).join(' / '));

  check('記錄解析成功且比對過 pin', /rendezvous → 127\.0\.0\.1:/.test(a1.text) &&
    /matches pinned did/.test(a1.text),
    (a1.text.match(/rendezvous → .*/) || [''])[0].slice(0, 70));

  check('身分跨重啟不變（第二次是同一個 DID）',
    !!did1 && did1 === did2, `${did1} ／ ${did2}`);

  check('身分存成 0600 的檔（等同私鑰）', (() => {
    try {
      const f = path.join(IDS, '.agent-seed');
      return (fs.statSync(f).mode & 0o777) === 0o600;
    } catch { return false; }
  })(), path.join(IDS, '.agent-seed'));

  check('負對照：pin 不符就不連（預設網路是別人給的網址，信任錨是 pin）',
    !!badSaid && !badRegistered,
    badSaid ? (bad.text.match(/unusable: .*/) || [''])[0].slice(0, 80) : '沒有指名的理由');

  check('verifier 同一條路（不需要 key、不需要模型、一行就好）', !!vReg,
    vReg ? 'registered as verifier' : v.text.trim().split('\n').slice(-2).join(' / '));

  check('Hub 這一側真的看到兩種角色註冊', /\(agent,/.test(hubLog) && /\(verifier,/.test(hubLog),
    (hubLog.match(/registered \S+ \((agent|verifier),[^)]*\)/g) || []).length + ' 筆註冊');

  hub.kill();
  await sleep(300);
  fs.rmSync(DIR, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
