#!/usr/bin/env node
// 待命排序器：自己拉帳、自己驗、現任消失時自己升格（#95）。
//
// 這支取代 `standby-hub.sh`＋`pull-loop.sh` 那一對人工流程，而差別不只是自動：
// **它不需要現任的私鑰**。舊做法是把同一個 `HUB_SEED` 複製到第二台機器上，
// 所以接手的是「同一個 DID」，client 才會跟上——那個腳本自己老實寫著代價
// （「排序器的私鑰從此存在兩台機器上」）。於是「任何人都可以接手」在字面上
// 等於「任何人都有那把私鑰」，而那不是可以推廣的形狀。
//
// 這裡的接手靠一份**事先簽好**的授權（`lib/succession.js`）：現任趁自己還活著
// 時簽 `{successor, priority}`，憑證隨位址記錄一起發布。client 釘的仍然是原本
// 那個 DID，但它接受「能從被釘住的 DID 走到你」的後繼者。沒有任何私鑰移動過。
//
// 三件事按順序做，而順序本身是判斷：
//   1. **先拉帳、先驗**。接手的人不需要信任任何人：`lib/rebuild.js` 逐筆驗簽、
//      重算鏈、比對 checkpoint root，對不上就不留下那一份。一個沒驗過的帳本
//      比一個起不來的排序器更糟。
//   2. **再判斷現任是不是真的不在**。連不上要連續成立一段時間（預設 60s），
//      而且按 priority 錯開——兩個待命機同時升格就是分叉。
//   3. **最後才升格**：把驗過的最後一份當 `HUB_IMPORT` 起 hub.js，並把授權我
//      的那條鏈交給它一起發布。
//
// 用法：
//   node standby.js <rendezvous 位置> [--pin did:demo:…] [--port 47180]
//   HUB_SEED=<我自己的種子> node standby.js var/rendezvous.json
//
// env: HUB_PROMOTE_AFTER_MS（預設 60000）、STANDBY_PULL_MS（預設 30000）、
//      STANDBY_STAGGER_MS（預設 20000，按 priority 乘）、STANDBY_DIR、
//      HUB_ADVERTISE_HOST（升格後要對外宣告的位址）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { identityFromSeed } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();
const rv = require('./lib/rendezvous');
const su = require('./lib/succession');
const rebuildLib = require('./lib/rebuild');
const { fetchLedger } = require('./lib/ledgerfetch');
require('./lib/log').install();

const args = process.argv.slice(2);
const WHERE = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
if (!WHERE) {
  console.error('用法：node standby.js <rendezvous 位置> [--pin did:demo:…] [--port 47180]');
  console.error('  位置可以是檔案路徑或 https:// 網址——就是現任 Hub 發布位址記錄的地方。');
  process.exit(1);
}
const PORT = Number(flag('port', process.env.HUB_PORT || 47180));
const DIR = process.env.STANDBY_DIR || path.join(__dirname, 'out', 'standby');
const PULL_MS = Number(process.env.STANDBY_PULL_MS || 30000);
const PROMOTE_AFTER_MS = Number(process.env.HUB_PROMOTE_AFTER_MS || 60000);
const STAGGER_MS = Number(process.env.STANDBY_STAGGER_MS || 20000);

// 我的身分：待命機有自己的 DID，這正是這支存在的理由。
const SEED_FILE = path.join(__dirname, 'configs', '.standby-seed');
function mySeed() {
  if (process.env.HUB_SEED) return process.env.HUB_SEED;
  try {
    const kept = fs.readFileSync(SEED_FILE, 'utf8').trim();
    if (kept) return kept;
  } catch { /* 第一次 */ }
  const seed = `standby-${require('node:crypto').randomBytes(12).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
    fs.writeFileSync(SEED_FILE, seed + '\n', { mode: 0o600 });
    console.log(`已產生待命身分並存在 ${SEED_FILE}（0600）。` +
      '現任要授權的就是這個 DID，所以這個檔案要留著。');
  } catch (e) {
    console.error(`警告：待命身分存不下來（${e.message}）——重啟後 DID 會變，` +
      '而現任簽給舊 DID 的授權就作廢了');
  }
  return seed;
}
const me = identityFromSeed(mySeed());
// 要為誰待命。給了 --pin 就是它；沒給就用第一次讀到的記錄裡那個簽署者——
// 而那句話要說出來，因為「跟第一個看到的人」與「釘住一個人」不是同一件事。
let PIN = flag('pin', process.env.AMCN_HUB_PIN);

fs.mkdirSync(DIR, { recursive: true });
const LATEST = path.join(DIR, 'latest.json');
const CERTS = path.join(DIR, 'succession.json');

let hubChild = null;            // 升格之後我帶著的那個排序器行程
let unreachableSince = null;
let lastRecord = null;
let verifiedAt = null;
let promoted = false;

async function pullOnce(host, port) {
  const chan = transport.dial({ host, port });
  try {
    const ex = await fetchLedger(chan, { timeoutMs: 120000 });
    // **驗過才留**。這是「接手的人不必信任任何人」那句話的實作。
    const r = rebuildLib.rebuild(ex);
    if (!r.ok) {
      console.error(`拉到的帳本驗不過（${r.errors.length} 個問題），不留下這一份：` +
        r.errors.slice(0, 3).join('；'));
      return null;
    }
    fs.writeFileSync(LATEST, JSON.stringify(ex, null, 2));
    verifiedAt = Date.now();
    console.log(`已驗過並留下一份：${ex.receipts.length} 筆收據、` +
      `${(ex.checkpoints || []).length} 個 checkpoint → ${LATEST}`);
    return ex;
  } catch (err) {
    console.error(`取帳失敗（${host}:${port}）：${err.message}`);
    return null;
  } finally {
    try { chan.close(); } catch { /* 已經關了 */ }
  }
}

function promote(record) {
  promoted = true;
  const certs = Array.isArray(record.succession) ? record.succession : [];
  fs.writeFileSync(CERTS, JSON.stringify(certs, null, 2));
  if (!fs.existsSync(LATEST)) {
    console.error('沒有任何驗過的帳本可以接手——**不升格**。' +
      '一個從空白開始的排序器會把所有人的餘額歸零，那比沒有排序器更糟。');
    process.exit(1);
  }
  console.log(`升格為排序器：我是 ${me.did}，帳本從 ${LATEST} 匯入（` +
    `${Math.round((Date.now() - verifiedAt) / 1000)}s 前驗過的那一份）`);
  console.log('釘住前任的 client 會憑接手憑證跟過來——沒有任何私鑰移動過。');
  // 這個 child 是**真的在服務的排序器**，所以它的生命週期必須綁在我身上：
  // 待命機被停掉而排序器活下來＝一個沒有人管的孤兒排序器繼續發布位址記錄，
  // 而那正是分叉。閘門自己先被這件事咬了一口（上一輪留下的孤兒佔著埠，讓
  // 下一輪的升格 EADDRINUSE，而報表把它讀成「升格失敗」）。
  const child = spawn(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env,
      HUB_SEED: mySeed(),
      HUB_PORT: String(PORT),
      HUB_IMPORT: LATEST,
      HUB_TAIL: '0',                    // 這份是從線上取的，沒有尾檔
      HUB_RENDEZVOUS: WHERE,
      HUB_SUCCESSION_CERTS: CERTS,
      // 我自己已經做過可達性檢查（連續 unreachable 才會走到這裡），所以那道
      // 給**人**用的守門不該再擋我一次。它擋的是「拔線演練之後把舊機器插回
      // 同一個網段」那種情況。
      HUB_RESUME_AFTER_SUCCESSION: '1' },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.error(`排序器行程結束（code ${code}）。` +
      '這台機器現在沒有在服務——由 launchd／systemd 把它拉回來，或手動重跑。');
    process.exit(code || 1);
  });
  hubChild = child;
}

async function tick() {
  if (promoted) return;
  let rec = null;
  try {
    rec = await require('./lib/rendezvous').read(WHERE);
  } catch (err) {
    console.error(`讀不到位址記錄 ${WHERE}：${err.message}`);
    return;
  }
  const seen = rv.check(rec, { pin: null });
  if (!seen.ok) { console.error(`位址記錄不可用：${seen.why}`); return; }
  if (!PIN) {
    PIN = seen.did;
    console.log(`沒有給 --pin，所以我為**第一次讀到的那個**排序器待命：${PIN}。` +
      '要確定是誰，下次用 --pin。');
  }
  lastRecord = rec;

  if (seen.did === me.did) {
    console.log('位址記錄已經是我自己簽的——我就是現任，不需要待命。');
    return;
  }

  const auth = su.authorityFor(rec.succession || [], { pin: PIN, me: me.did });
  const alive = await transport.probe({ host: seen.host, port: seen.port, timeoutMs: 5000 });
  if (alive) {
    if (unreachableSince) console.log('現任回來了——取消升格倒數。');
    unreachableSince = null;
    await pullOnce(seen.host, seen.port);
    return;
  }

  if (!unreachableSince) {
    unreachableSince = Date.now();
    console.log(`現任 ${seen.did} 連不上（${seen.host}:${seen.port}）——開始倒數。`);
  }
  if (!auth) {
    console.error('我沒有被授權接手（位址記錄裡沒有一條從 ' + PIN + ' 走到我的鏈），' +
      `所以只能繼續等。要授權我，現任那一側加上 HUB_SUCCESSORS=${me.did} 並重啟。`);
    return;
  }
  // priority 錯開：優先序 1 先升格，2 晚 STAGGER_MS，以此類推。兩個待命機
  // 同時升格＝分叉，而這是唯一不需要彼此通訊就能錯開的辦法。
  const wait = PROMOTE_AFTER_MS + (auth.priority - 1) * STAGGER_MS;
  const down = Date.now() - unreachableSince;
  if (down < wait) {
    console.log(`倒數中：已離線 ${Math.round(down / 1000)}s，我的門檻是 ` +
      `${Math.round(wait / 1000)}s（優先序 ${auth.priority}）`);
    return;
  }
  promote(rec);
}

console.log(`AMCN 待命排序器：我是 ${me.did}，盯著 ${WHERE}`);
console.log(`  升格門檻 ${PROMOTE_AFTER_MS / 1000}s 連不上、每 ${PULL_MS / 1000}s 拉一次帳、` +
  `升格後服務於 :${PORT}`);
console.log('  接手不需要現任的私鑰（#95）：靠一份事先簽好的授權，client 釘的仍然是前任。');
tick();
const timer = setInterval(tick, PULL_MS);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    // 先收排序器再走。留一個還在服務、還在發布位址記錄的孤兒，比整台停掉糟。
    if (hubChild) { try { hubChild.kill('SIGTERM'); } catch { /* 已經走了 */ } }
    setTimeout(() => process.exit(0), 200);
  });
}
// 我自己非正常結束時也一樣（例外、被 kill -9 以外的方式帶走）。
process.on('exit', () => {
  if (hubChild) { try { hubChild.kill('SIGKILL'); } catch { /* 已經走了 */ } }
});
