// 「安裝完就能收發任務」需要的唯一一樣東西：**預設要連去哪**。
//
// 在這個檔案存在之前，`node agent.js` 不帶設定檔會死在 `JSON.parse(undefined)`，
// 而 `resolveHubTarget` 的預設是 `127.0.0.1:47180`——也就是「連你自己」。於是
// 每一次安裝都是**開一個新的空網路**，要加入別人的網路只能手貼位址與 pin。
// 那不是傳輸層的問題（#89 已經把可達性解決了），是**沒有預設值**。
//
// 兩個值就夠：一份簽署過的位址記錄放在哪（`rendezvous`），以及要釘住誰
// （`hubPin`）。位址本身刻意**不是**其中之一——位址會變，記錄才是常數，而
// 承載記錄的主機不受信任（它能扣住或給舊的，無法冒充，因為記錄帶著簽章而
// 客戶端拿 pin 核對）。
//
// 解析順序：環境變數 → `node/network.json`（隨 repo 發布的那一份）→ 沒有。
// 「沒有」是一個**說得出話的**結果，不是一個例外堆疊：它會告訴你可以設什麼、
// 或者怎麼自己開一座島。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const NETWORK_FILE = path.join(ROOT, 'network.json');
// 身分檔放哪。可覆蓋的理由有兩個：閘門不該碰到這台機器真正的身分，而同一台
// 機器要跑第二個 agent 時也需要第二組身分。
const CONFIG_DIR = process.env.AMCN_CONFIG_DIR || path.join(ROOT, 'configs');

// 身分要跨重啟不變，否則舊 DID 的餘額沒人能花、負債沒人會還（#17／#84）。
// 檔名沿用 `configs/.*-seed`，那個樣式已經在 .gitignore 裡——它等同私鑰。
function seedFor(role) {
  const file = path.join(CONFIG_DIR, `.${role}-seed`);
  try {
    const kept = fs.readFileSync(file, 'utf8').trim();
    if (kept) return { seed: kept, from: 'file', file };
  } catch { /* 第一次 */ }
  const seed = `${role}-${crypto.randomBytes(12).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, seed + '\n', { mode: 0o600 });
    return { seed, from: 'new', file };
  } catch (e) {
    return { seed, from: `unwritable: ${e.message}`, file };
  }
}

// 隨 repo 發布的預設網路。值是空的就是「還沒有公開的網路」——這比塞一個
// 猜出來的位址誠實，也比死在 JSON.parse 上有用。
function network() {
  const env = process.env.AMCN_BOOTSTRAP;
  if (env) {
    return { rendezvous: env, hubPin: process.env.AMCN_HUB_PIN || null,
             name: 'env', from: 'AMCN_BOOTSTRAP' };
  }
  try {
    const rec = JSON.parse(fs.readFileSync(NETWORK_FILE, 'utf8'));
    if (rec && rec.rendezvous) {
      return { rendezvous: rec.rendezvous,
               hubPin: process.env.AMCN_HUB_PIN || rec.hubPin || null,
               name: rec.name || 'network.json', from: 'network.json' };
    }
  } catch { /* 沒有檔或壞了，都算「沒有預設網路」 */ }
  return null;
}

const HELP = `沒有預設網路可以加入，所以這個行程不知道要連去哪。三條路，選一條：

  1. 加入別人的網路（對方會給你一個位址記錄的網址與一個 hub did）：
       AMCN_BOOTSTRAP=<記錄的網址> AMCN_HUB_PIN=did:demo:… node agent.js
  2. 自己在這台機器上開一個（五分鐘、不需要別人）：
       ./quickstart.sh
  3. 只連本機已經在跑的 Hub：
       node agent.js --standalone

要把某個網路變成這份 repo 的預設，填 node/network.json 的 rendezvous 與 hubPin
（那是「發布一個網路」這件事的全部內容，見 node/INSTALL.md §12）。`;

// role: 'agent' | 'verifier'。standalone 時不需要網路記錄（連本機）。
function defaultConfig(role, { standalone = false, log = console.log } = {}) {
  const { seed, from, file } = seedFor(role);
  if (from === 'new') {
    log(`[amcn] 已產生這台機器的 ${role} 身分並存在 ${file}（0600）。` +
      '餘額、信用紀錄與押注都綁在它上面，請備份、也不要外流。');
  } else if (String(from).startsWith('unwritable')) {
    log(`[amcn] 警告：身分存不下來（${from}）——這次是臨時身分，` +
      '重啟之後餘額與信用紀錄都會留在舊 DID 上。');
  }
  const base = { name: `${role}-${seed.slice(-6)}`, seed };
  if (standalone) {
    return { ...base, hubHost: process.env.AMCN_HUB_HOST || '127.0.0.1',
             hubPort: Number(process.env.AMCN_HUB_PORT || 47180) };
  }
  const net = network();
  if (!net) { console.error(HELP); process.exit(1); }
  log(`[amcn] 預設網路 ${net.name}（來源 ${net.from}）：記錄 ${net.rendezvous}` +
    (net.hubPin ? `，釘住 ${net.hubPin}` : '，**沒有 pin**——任何簽得出記錄的人都會被跟隨'));
  return { ...base, rendezvous: net.rendezvous, hubPin: net.hubPin };
}

module.exports = { network, defaultConfig, seedFor, NETWORK_FILE, CONFIG_DIR, HELP };
