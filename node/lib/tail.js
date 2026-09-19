// 尾檔的**讀取**端（#74 的格式，#76 的第二個呼叫者）。
//
// 寫入端留在 `hub.js`，因為它需要 Hub 的狀態；但「一行長什麼樣、索引怎麼
// 判斷」只能有一個定義。原本 `mergeTail` 只存在於 `hub.js`，而 `chaos-run`
// 的取樣需要同一個格式來知道快照落後多少——照抄一份就是 #60 的形狀
// （一條規則兩個實作，而它們會分岔）。
//
// 每一行是 `{<索引欄>: n, <內容欄>: …}`，索引是**目標陣列的位置**。
// 快照 rename 與清空尾檔之間的崩潰會留下快照裡已有的記錄，所以只在「剛好
// 是下一筆」時套用——重播因此是幂等的，而落後量可以只靠索引算出來。
'use strict';
const fs = require('node:fs');

// 寫到一半被截斷的最後一行代表崩潰發生在 append 中途，那一筆本來就還沒
// 落盤：跳過而不是中止。
function* records(tailFile) {
  if (!fs.existsSync(tailFile)) return;
  for (const line of fs.readFileSync(tailFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { yield { torn: true }; }
  }
}

// 合併進一份匯出（Hub 匯入時用）。合併發生在**驗證之前**，所以尾檔裡的
// 東西一樣要過 rebuild 的簽章、鏈、checkpoint 與 #69 的檢查——附加檔案
// 不是信任邊界的破口。
function merge(ex, tailFile) {
  let applied = 0, skipped = 0, torn = 0, chainEntries = 0;
  // 會動到帳（因而會長出鏈分錄）的記錄數。公鑰與得標記錄不算——它們不改
  // 任何一條鏈，所以「套用了它們卻沒有鏈分錄」是完全正常的。
  let ledgerRecords = 0;
  for (const rec of records(tailFile)) {
    if (rec.torn) { torn += 1; continue; }
    if (rec.ev !== undefined && rec.e === ex.events.length) {
      ex.events.push(rec.ev); applied += 1; ledgerRecords += 1;
    } else if (rec.rc !== undefined && rec.r === ex.receipts.length) {
      ex.receipts.push(rec.rc); applied += 1; ledgerRecords += 1;
    } else if (rec.cp !== undefined && rec.c === (ex.checkpoints || []).length) {
      (ex.checkpoints = ex.checkpoints || []).push(rec.cp); applied += 1;
    } else if (rec.aw !== undefined && rec.w === (ex.awarded || []).length) {
      // 得標的合約 id（#77）。同一個索引幂等規則。
      (ex.awarded = ex.awarded || []).push(rec.aw); applied += 1;
    } else if (rec.ce !== undefined && typeof rec.a === 'string') {
      // 鏈分錄（#78）。幂等條件用分錄自己的 `seq`，它就是該帳戶鏈上的位置。
      ex.chains = ex.chains || {};
      const chain = ex.chains[rec.a] || [];
      if (rec.ce.seq === chain.length) {
        chain.push(rec.ce); ex.chains[rec.a] = chain;
        applied += 1; chainEntries += 1;
      } else { skipped += 1; }
    } else if (rec.pub !== undefined && rec.k === Object.keys(ex.pubkeys || {}).length) {
      ex.pubkeys = ex.pubkeys || {};
      ex.pubkeys[rec.did] = rec.pub;
      if (rec.joined) { (ex.joined_at = ex.joined_at || {})[rec.did] = rec.joined; }
      applied += 1;
    } else {
      skipped += 1;
    }
  }
  if (applied) {
    // 快照裡的**衍生**欄位過期了。刪掉它們讓 rebuild 從事件重算——留著
    // collateral 會直接讓驗證失敗（rebuild 會拿它跟重播結果對照），留著
    // balances 只是把過期的數字帶進來。
    delete ex.balances; delete ex.collateral;
    delete ex.credit_lines; delete ex.metrics; delete ex.checkpoint_seq;
    // **`chains` 是例外，而這一點就是 #78**：`at` 只存在於鏈分錄裡，events
    // 沒有時間欄位，所以丟掉 chains 之後 rebuild 只能把 `at` 填成 0——
    // 全部雜湊改變，重算出的 root 對不上任何一個被簽過的 checkpoint。
    // 尾檔現在帶鏈分錄，所以帶了就留著；**只有在該帶而沒帶時才丟**。
    //
    // 第一版寫成 `if (!chainEntries)`，而那是錯的：只套用了公鑰或得標記錄
    // 的尾檔（例如恢復前最後發生的是一次註冊）一筆鏈分錄也不會有，鏈根本
    // 沒動，快照裡的 chains 仍然正確——丟掉它等於讓 rebuild 把 `at` 全部
    // 填成 0，於是**一個健康的恢復被 #78 自己的 root 閘門擋下來**，Hub 拒絕
    // 啟動。實測就是這樣：`tail replay: 2 applied` 之後 REFUSING to start。
    // 條件因此是「有事件或收據被套用，卻一筆鏈分錄都沒有」＝舊格式尾檔。
    if (ledgerRecords > 0 && chainEntries === 0) delete ex.chains;
  }
  return { applied, skipped, torn, chainEntries };
}

// 快照之後還有多少筆沒被收進去（取樣端用）。**不動 `ex`**：取樣要的是一份
// 衍生欄位彼此一致的快照去餵不變式，外加一個「它落後多少」的數字——把尾檔
// 併進去會把 balances/chains 刪掉，於是不變式檢查會變成空的。
function pending(ex, tailFile) {
  const out = { receipts: 0, events: 0, checkpoints: 0, torn: 0 };
  const len = { receipts: (ex.receipts || []).length,
                events: (ex.events || []).length,
                checkpoints: (ex.checkpoints || []).length };
  for (const rec of records(tailFile)) {
    if (rec.torn) { out.torn += 1; continue; }
    if (rec.ce !== undefined) continue;   // 鏈分錄不計入「落後幾筆」
    if (rec.rc !== undefined && rec.r >= len.receipts) out.receipts += 1;
    else if (rec.ev !== undefined && rec.e >= len.events) out.events += 1;
    else if (rec.cp !== undefined && rec.c >= len.checkpoints) out.checkpoints += 1;
  }
  return out;
}

module.exports = { merge, pending, records };
