#!/usr/bin/env node
// 自己驗一本帳（§20-4／#20-4 的使用者版本）。
//
// 為什麼這支該存在：整個設計的核心宣稱是「第一個排序器不是信任根」
// （final-architecture §2.2）——Hub 只中繼簽署過的訊息，全部狀態可由公開
// 簽署事件重建。但在這之前，能做這件事的只有 `demo-rebuild.js`（一支
// 自帶拓撲的回歸閘門）與 `lib/rebuild.js`（一個函式）。一個參與者想問
// 「Hub 給我的這本帳是真的嗎」時，沒有一個指令可以問。
//
// 它驗的東西與第二個排序器啟動時驗的完全相同（同一份 lib/rebuild.js）：
// 每筆收據逐一驗簽、pubkey 必須自證 DID、餘額由事件重放、雜湊鏈重算、
// 信用額度由收據重放、checkpoint 驗 Hub 簽章並比對重建出的鏈頭。
// 任何一項不符就是拒絕——不是警告。
//
// Run:
//   node verify-ledger.js out/ledger.json
//   node verify-ledger.js out/ledger.json --pin did:demo:cf61d8b35e5ce55e
//   node ledger-dump.js out/mine.json 192.168.1.10 47180 && \
//     node verify-ledger.js out/mine.json --pin did:demo:…
'use strict';
const fs = require('node:fs');
const { rebuild } = require('./lib/rebuild');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const pinIdx = args.indexOf('--pin');
const pin = pinIdx >= 0 ? args[pinIdx + 1] : (process.env.AMCN_HUB_PIN || null);

if (!file) {
  console.error('用法：node verify-ledger.js <帳本匯出.json> [--pin did:demo:…]');
  console.error('  匯出可以用 node ledger-dump.js out/mine.json <hub host> <hub port> 取得，');
  console.error('  或直接拿 Hub 自己寫的 HUB_DUMP_PATH 檔案。');
  process.exit(2);
}

let ex;
try {
  ex = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`讀不到或不是合法 JSON：${file}（${e.message}）`);
  process.exit(2);
}

// 尾檔（#74）：Hub 的快照是週期性的，每一筆變動另外即時附加到 <path>.tail。
// 只讀快照會少掉最近那一段，而那一段正是崩潰時最想要的——所以這裡跟 Hub
// 自己匯入時走同一條路，把尾檔併進來再驗。
const tail = `${file}.tail`;
if (fs.existsSync(tail)) {
  const tailLib = require('./lib/tail');
  const behind = tailLib.pending(ex, tail);
  // merge() 就地改寫這份匯出，並回報套用了多少筆——合併發生在驗證**之前**，
  // 所以尾檔裡的東西一樣要過下面每一項檢查。
  const applied = tailLib.merge(ex, tail);
  console.log(`併入尾檔 ${tail}：收據 +${behind.receipts}、事件 +${behind.events}、` +
    `checkpoint +${behind.checkpoints}` +
    (behind.torn ? `、殘行 ${behind.torn}（崩潰時寫一半的最後一行，會被跳過）` : '') +
    `（實際套用 ${applied.applied ?? '?'} 筆）`);
}

const r = rebuild(ex, { expectHubDid: pin });

const balances = r.balances || new Map(Object.entries(ex.balances || {}));
const sum = [...balances.values()].reduce((t, v) => t + v, 0);
console.log(`\n== 驗證 ${file} ==`);
console.log(`  收據        ${ex.receipts.length} 筆（每一筆的簽章都重新驗過）`);
console.log(`  帳務事件    ${(ex.events || []).length} 個（託管、罰沒、退還、沖銷、回流）`);
console.log(`  帳戶        ${balances.size} 個`);
console.log(`  checkpoint  ${(ex.checkpoints || []).length} 個（Hub 簽章 + 與重建出的鏈頭比對）`);
console.log(`  Σ 餘額      ${sum.toFixed(10)}${Math.abs(sum) < 1e-9 ? '（守恆）' : ' ← 不為零'}` +
  (r.ok ? '' : '（這是匯出自己的數字，重建已經拒絕）'));
console.log(`  排序器身分  ${ex.hub_pub ? 'did:demo:' + require('./lib/wire').sha256(ex.hub_pub).slice(0, 16) : '(匯出沒帶 hub_pub)'}` +
  (pin ? `（要求 ${pin}）` : '（沒有 --pin，就沒有在驗「是誰簽的」）'));

if (r.warnings && r.warnings.length) {
  console.log(`\n無從檢查的項目 ${r.warnings.length} 項（不是不通過，是這份匯出裡沒有可比對的東西）：`);
  for (const w of r.warnings.slice(0, 5)) console.log(`  - ${w}`);
}

if (!r.ok) {
  console.log(`\n結果：**拒絕** — ${r.errors.length} 項不符`);
  for (const e of r.errors.slice(0, 20)) console.log(`  - ${e}`);
  if (r.errors.length > 20) console.log(`  … 另外 ${r.errors.length - 20} 項`);
  console.log('\n一個排序器若從這份匯出啟動，會拒絕啟動而不是帶著錯的帳開始服務。');
  process.exit(1);
}

console.log('\n結果：通過 — 這本帳的每一塊 CC 都能追到一筆有兩個簽章的收據或一個守恆的事件。');
if (!pin) {
  console.log('提示：加 --pin did:demo:… 才會檢查「這是不是你認識的那個排序器簽的」。');
}
