// 取一份完整帳本，不管它有多大（#41／#76）。
//
// 直接送 `{type:'export'}` 在匯出超過 `MAX_LINE`（16MB）時會**靜默斷線**：
// 那正是 #76 讓取樣端瞎掉 590 秒的原因。Hub 現在對過大的請求回一個指名的
// 拒絕，而這個 helper 收到拒絕就改走分頁，所以呼叫端只要換一行。
//
// 分頁由 Hub 從一份**凍結的快照**供應（見 hub.js 的 `pagedExports`），
// 所以重組出來的是某一個真的存在過的狀態，而不是好幾頁不同時刻的拼貼。
'use strict';

// chan 需要 `send` 與 `onMessage`（後者是可疊加的）。
function fetchLedger(chan, { timeoutMs = 15000, onNote = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let acc = null;
    let pages = 0;
    let restarted = false;
    const timer = setTimeout(
      () => reject(new Error(`ledger fetch timed out after ${timeoutMs}ms ` +
        `(${pages} pages)`)), timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };

    chan.onMessage((m) => {
      if (m.type === 'ledger_export') { done(m); return; }

      if (m.type === 'ledger_export_too_large') {
        onNote(`export ${(m.bytes / 1048576).toFixed(1)}MB > ` +
          `${(m.max / 1048576).toFixed(1)}MB — 改走分頁`);
        chan.send({ type: 'export', paged: true });
        return;
      }

      if (m.type === 'ledger_export_expired') {
        // Hub 丟掉了那份凍結快照（TTL）。從頭再來一次，但只一次——
        // 無限重試會把「拿不到」變成「永遠在拿」。
        if (restarted) {
          clearTimeout(timer);
          reject(new Error('paged export expired twice; giving up'));
          return;
        }
        restarted = true; acc = null; pages = 0;
        chan.send({ type: 'export', paged: true });
        return;
      }

      if (m.type !== 'ledger_export_page') return;
      pages += 1;
      if (!acc) {
        // 第一頁帶純量欄位（balances／credit_lines／metrics／hub_pub…）。
        acc = { ...m };
        delete acc.cursor; delete acc.type;
        acc.receipts = [...(m.receipts || [])];
        acc.events = [...(m.events || [])];
        acc.checkpoints = [...(m.checkpoints || [])];
        acc.chains = { ...(m.chains || {}) };
      } else {
        acc.receipts.push(...(m.receipts || []));
        acc.events.push(...(m.events || []));
        acc.checkpoints.push(...(m.checkpoints || []));
        Object.assign(acc.chains, m.chains || {});
      }
      if (m.cursor) { chan.send({ type: 'export', cursor: m.cursor }); return; }
      onNote(`分頁完成：${pages} 頁、${acc.receipts.length} 筆收據`);
      done(acc);
    });

    chan.send({ type: 'export' });
  });
}

module.exports = { fetchLedger };
