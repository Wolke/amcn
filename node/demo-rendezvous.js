// #91／#86 的閘門：常駐的入口，以及一份會跟著入口走的位址記錄。
//
// 要守的是三件在「把網路常駐起來」時才會出現的事，而它們都不是密碼學問題：
//
//   1. **入口比 Hub 晚起來**。onion service 是另一個服務（`com.amcn.onion`），
//      位址要等 tor 把目錄建好才存在，而排序器不會等它。原本 Hub 在 listen
//      那一刻把要發布的主機名解析一次就定住，所以記錄會永遠帶著回送位址
//      ——而它帶著**正確的簽章**，於是客戶端老實地去連一個連不上的地方。
//      這支閘門在修好之前，第 5、6 條是紅的（#91）。
//   2. **位址會換**。換 onion 位址、排序器搬家都是設計內的事（§2.1 的退場
//      三件套第一件），所以記錄不是發一次而是持續跟上。
//   3. **綁定位址不能悄悄跑回 0.0.0.0**。onion 模式的整個意義是對外零入向埠；
//      一個「模式是 onion 但 Hub 綁在 0.0.0.0」的服務看起來完全正常，而它把
//      一個沒有 TLS、沒有 DoS 防護的排序器直接掛在區網上。所以這裡讀的是
//      `run-hub.sh --print-env` **算出來的值**，不是原始碼裡的字串。
//
// 不需要 tor、不啟動任何 onion service、也不會碰你的 launchd 服務：`.onion`
// 位址在這支裡只是一個「後來才出現、而且會變」的字串。真的接上 tor 要量的
// 是延遲與長連線穩定度（#86 的現場實驗），不在這支的範圍。
//
// Run:  node demo-rendezvous.js     (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const rv = require('./lib/rendezvous');
const { identityFromSeed } = require('./lib/wire');
const { didOf } = require('./lib/discovery');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + 800 + OFFSET;
const DIR = path.join(__dirname, 'out', `demo-rv-${process.pid}`);
const RV = path.join(DIR, 'rendezvous.json');
const HOSTFILE = path.join(DIR, 'onion-hostname');
const SEED = 'demo-rendezvous';
const HUB_DID = didOf(identityFromSeed(SEED).pub);
const ONION_A = 'amcnfirstaddressnotarealonionservice.onion';
const ONION_B = 'amcnsecondaddressnotarealonionservice.onion';

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readRec = () => { try { return JSON.parse(fs.readFileSync(RV, 'utf8')); } catch { return null; } };

// 等一個條件成立而不是睡固定秒數（#80 的教訓：固定的等待窗會把「還沒到」
// 報成「不會到」）。
async function waitFor(fn, ms = 8000, step = 200) {
  const until = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

function printEnv(mode) {
  const out = execFileSync('/bin/bash',
    [path.join(__dirname, 'service', 'run-hub.sh'), '--print-env'],
    { env: { ...process.env, AMCN_HOME_MODE: mode }, encoding: 'utf8' });
  return Object.fromEntries(out.trim().split('\n').map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
  }));
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  const lan = printEnv('lan');
  const onion = printEnv('onion');

  const hub = spawn(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env,
      HUB_PORT: String(PORT), HUB_BIND: '127.0.0.1', HUB_SEED: SEED,
      HUB_BEACON: '0', HUB_AGE_RAMP_MS: '1',
      HUB_RENDEZVOUS: RV, HUB_RENDEZVOUS_MS: '700',
      HUB_ADVERTISE_HOST_FILE: HOSTFILE,   // 這個檔現在還不存在——入口比 Hub 晚
      HUB_DUMP_PATH: path.join(DIR, 'ledger.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  hub.stdout.on('data', (d) => process.stdout.write(`  ${d}`));

  const first = await waitFor(readRec);

  // 區網位址探測：不要用 0.0.0.0——macOS 的 connect(2) 把它當回送位址，所以
  // 那條斷言會永遠是綠的（#89 的閘門自己犯過一次）。
  const lanAddr = Object.values(require('node:os').networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  const boundPublic = lanAddr ? await new Promise((resolve) => {
    const probe = net.connect(PORT, lanAddr.address);
    probe.on('connect', () => { probe.destroy(); resolve(true); });
    probe.on('error', () => resolve(false));
    setTimeout(() => { probe.destroy(); resolve(false); }, 1500);
  }) : false;

  // 只知道「記錄在哪」與「要釘住誰」的參與者，能不能真的進到網路裡。
  // 這是遠端 verifier 唯一該需要的兩樣東西（位址不是其中之一）。
  const panel = spawn(process.execPath, [path.join(__dirname, 'panel.js'), `rv:${RV}`, String(PORT), '1'], {
    env: { ...process.env, AMCN_HUB_PIN: HUB_DID, AMCN_PANEL_SEED: 'demo-rv-panel' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let panelOut = '';
  const grab = (b) => { panelOut += b.toString(); };
  panel.stdout.on('data', grab);
  panel.stderr.on('data', grab);
  const registered = await waitFor(() => /registered as verifier/.test(panelOut), 20000);
  const followedRecord = /rendezvous → 127\.0\.0\.1:/.test(panelOut);
  panel.kill();

  // 入口起來了：位址第一次出現。
  fs.writeFileSync(HOSTFILE, `${ONION_A}\n`);
  const appeared = await waitFor(() => {
    const r = readRec(); return r && r.host === ONION_A ? r : null;
  }, 8000);

  // 入口換了位址（或排序器搬了家）。
  fs.writeFileSync(HOSTFILE, `${ONION_B}\n`);
  const rotated = await waitFor(() => {
    const r = readRec(); return r && r.host === ONION_B ? r : null;
  }, 8000);

  console.log('\n== #91／#86 常駐入口與位址記錄驗收檢查 ==');

  check('區網模式的綁定位址沒有被改掉（run-hub.sh 算出來的值）',
    lan.HUB_BIND === '0.0.0.0' && !!lan.HUB_RENDEZVOUS,
    `HUB_BIND=${lan.HUB_BIND}、記錄 ${lan.HUB_RENDEZVOUS}`);

  check('onion 模式：Hub 只綁回送位址，且位址由檔案提供而不是啟動時定住',
    onion.HUB_BIND === '127.0.0.1' &&
    onion.HUB_ADVERTISE_HOST_FILE === 'var/onion/hostname',
    `HUB_BIND=${onion.HUB_BIND}、HUB_ADVERTISE_HOST_FILE=${onion.HUB_ADVERTISE_HOST_FILE}`);

  check('入口是一個服務而不是一個前景腳本（源碼層：install.sh 會多裝一個）',
    /com\.amcn\.onion/.test(fs.readFileSync(path.join(__dirname, 'service', 'install.sh'), 'utf8')) &&
    /--service/.test(fs.readFileSync(path.join(__dirname, 'service', 'install.sh'), 'utf8')) &&
    /--service/.test(fs.readFileSync(path.join(__dirname, 'service', 'run-onion.sh'), 'utf8')),
    'com.amcn.onion + run-onion.sh --service');

  check('入口還沒起來時記錄照樣發得出去（先發自己聽的位址，不是空的）',
    !!first && first.host === '127.0.0.1' && first.port === PORT,
    first ? `${first.host}:${first.port}` : '沒有記錄');

  check('入口後來才出現：記錄跟著換過去（#91 修好前這條是紅的）',
    !!appeared, appeared ? `host → ${appeared.host}` : `記錄仍是 ${readRec()?.host}`);

  check('入口換位址：記錄再跟一次（不是只讀一次檔）',
    !!rotated, rotated ? `host → ${rotated.host}` : `記錄仍是 ${readRec()?.host}`);

  // 簽章那三條要測的是**記錄本身**，所以用當下這一份而不是輪替那一份：
  // 綁在 rotated 上的話，位址跟不上就會連著把三條無關的斷言一起弄紅，
  // 而「五條紅的」比「兩條紅的」更難看出是哪裡壞了（#76 的教訓）。
  const now = rotated || readRec();
  const pinned = now ? rv.check(now, { pin: HUB_DID }) : { ok: false, why: '沒有記錄' };
  check('記錄的簽章驗得過，而且就是被釘住的那個 Hub 簽的',
    pinned.ok && pinned.did === HUB_DID, pinned.ok ? pinned.did : pinned.why);

  const wrongPin = now
    ? rv.check(now, { pin: 'did:demo:0000000000000000' }) : { ok: true };
  check('負對照一：別人簽的記錄不會被跟隨（釘住的意義）',
    wrongPin.ok === false && /not the pinned hub/.test(wrongPin.why || ''),
    wrongPin.why || '竟然接受了');

  const stale = now ? rv.check(now, { pin: HUB_DID, maxAgeMs: 1 }) : { ok: true };
  check('負對照二：過期的記錄被指名拒絕（入口停了發不出新的，不是位址錯）',
    stale.ok === false && /stale by/.test(stale.why || ''),
    stale.why || '竟然接受了');

  check('只知道記錄與 pin 的參與者真的進到網路裡（位址不必給他）',
    !!registered && followedRecord,
    registered ? '1 個 verifier 經記錄解析後註冊成功' : panelOut.trim().split('\n').slice(-2).join(' / '));

  check('onion 模式下對外沒有開任何埠（區網位址連不上）', !boundPublic,
    boundPublic ? `${lanAddr.address}:${PORT} 從區網連得上` :
      `${lanAddr ? lanAddr.address : '(無區網位址)'}:${PORT} 連不上，只有回送位址`);

  hub.kill();
  await sleep(300);
  fs.rmSync(DIR, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
