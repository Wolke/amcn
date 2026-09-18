# §20 十項驗收：證據對照

| 欄位 | 內容 |
|---|---|
| 文件 | SDD §20 MVP 驗收標準與目前可重現證據的逐項對照 |
| 日期 | 2026-09-17 |
| 用途 | W12 證據包的骨架；同時誠實標出哪幾項**還沒有**證據 |
| 原則 | 每一項都要指向**一個可以重跑的指令**，不接受「文件說有」 |

---

## 對照表

| # | 驗收標準 | 證據 | 狀態 |
|---|---|---|---|
| 1 | 三個獨立節點在不知道彼此 API Key 下完成任務 | `node demo.js` 斷言「§20-1/6 Key 隔離＋NFR-005」（掃描 Hub 全量流量，三個 payload 明文與 key 皆不出現）；**真實三台機器**試點完成 14 筆跨機結算，帳本存於 `node/out/pilot-final-*.json` | ✅ 自動＋真機 |
| 2 | Requester 從 0 CC 開始、在信用額度內完成借用 | `node demo.js`「§20-2/3 閉環」：A 由 0 → −40 → +2.14 CC | ✅ 自動 |
| 3 | 之後替第三方完成任務並回補負餘額 | 同上；`node demo-autonomous.js`「§20-3／UC-02 閉環真正閉合」（無人介入版）；**40 分鐘長跑 `scenarios/soak-rebate.json` 509 筆結算、最長空窗 183s**——短 demo 證明閉環會閉合一次，長跑才證明它**持續**閉合（對照組 `soak-norebate.json` 在 T+1462 之後停了 969s，見 #71）| ✅ 自動，且已有長跑證據 |
| 4 | 全部餘額變動可由簽署事件重建且守恆 | `node demo.js`「§20-4 Σ=0 且收據重建 = Hub 帳」；`node demo-rebuild.js`（**另一個進程、另一個埠**從匯出重建並偵測竄改）；`lib/invariants.js` 在每個故障情境中**持續**檢查七項不變式，10 個情境零違反 | ✅ 自動，且已強化為連續檢查 |
| 5 | 官方 Indexer 停止後仍可恢復或轉用其他 Indexer | `node demo-reconnect.js`（殺掉 Hub → 全網自行重連）；`chaos-run.js scenarios/hub-kill-takeover.json`（SIGKILL → 同 seed 從自動匯出重建接手）；`scenarios/hub-moves.json`（**Hub 換位址**，client 憑簽署的 rendezvous 記錄自行跟上，無人改設定）；`demo-transport.js`（三種傳輸實作產生同一本帳）| ✅ 自動，四種角度 |
| 6 | 惡意 Task 無法讀 Provider Key 或掛載私人目錄 | `node demo.js` key 掃描；`node redteam-agents.js` A1（payload 明文要求回傳 API key）、A2（payload 是否經過 Hub）。**掛載私人目錄未測**——原型沒有 sandbox，見盤點 §3 不可達清單 | ⚠️ Key 有證據；sandbox 面**無控制** |
| 7 | 至少一種任務能以 deterministic verification 自動結算 | `node demo.js`「§20-7 DSL 驗收＋真 HTTP 路徑」（assert 集在 TaskSpec 簽章時鎖 hash）| ✅ 自動 |
| 8 | Agent 能在 Owner Policy 內自動完成全程，無逐筆人工 | `node demo-autonomous.js` 12/12：無 `posts` 時間表、無 Console 呼叫，斷言 `manual_posts + scripted_posts == 0` | ✅ 自動 |
| 9 | 測試交易、補貼交易與真實交易可清楚區分 | `node demo.js`「§20-9 tx_class」：每筆結算都必須標明 `market`／`test`／`subsidy`／`related-party`，**未標示或自創值一律拒絕**（`node redteam.js` S10／S11 實測）。Hub 的內部分錄（押注託管、沒收）標為 `protocol`、金絲雀付款標為 `subsidy`，所以市場數字不會混入它們 | ✅ 自動 |
| 10 | 能輸出成交率、供需深度、違約率、平均還債時間 | `node demo.js`「§20-10 四項市場指標」：全部由 Hub 的 `buildMetrics()` 從**簽署狀態**導出並隨匯出提供，第三方可自行重算（FR-083 要求模擬與生產共用定義，所以不讀任何 Console）。成交率＝已結算/已得標；供需深度＝平均每任務出價數；還債時間＝從雜湊鏈的餘額穿越零點算出；違約率**已於 2026-09-18 變成真值**：原型補上違約偵測與壞帳瀑布（抵押→保險→`protocol:loss`），`default_rate` ＝ 已沖銷 ÷ 結算量，與模擬器的 `bad_debt_rate` 同定義；代理欄位 `default_proxy_rate` 保留作為對照。情境 `default-writeoff` 實測 0.089 | ✅ 四項齊備 |

---

## 結論

**2026-09-17 更新**：§20-9 與 §20-10 已交付，十項裡 **9 項有完整的自動化證據**，剩下 **1 項部分**（6 的 sandbox 面——原型沒有 sandbox，Phase 1 無法補齊）。

原記錄（供對照）：十項裡 7 項有完整證據，2 項部分，1 項完全沒有。

兩個缺口的性質不同：

- ~~**§20-9（tx_class）是純粹沒做**~~ **已交付**。如當初所料，難的不是實作而是**追溯**：既有帳本沒有這個欄位，所以 W12 的證據包只能從 2026-09-17 之後的交易算起。另外有一個誠實限制要寫進報告：`related-party` 是**自行申報**的，Hub 無從查核兩個 DID 是否同一個 Owner——見登記簿 #63。
- **§20-6 的 sandbox 面是架構上還不存在**（盤點 §3 列為原型不可達）。這一項在 Phase 1 無法補齊，只能誠實標註。

**2026-09-18 補充**：§20-2/3 的證據從「一次閉環」升級為「持續閉環」。原本只有 15 秒的 demo，而一個閉環會閉合一次不代表它撐得住 40 分鐘——#71 的對照組正是在第 24 分鐘之後停了 16 分鐘，且**每一項既有期望都通過**。長跑期望（`tradingContinues`）是唯一會紅的那一個，這也是為什麼它值得存在。

§20-10 的三個缺口（成交率、供需深度、違約率）在原型裡都**可以算**，缺的是指標定義與輸出——而 FR-083／§20-9 要求「模擬與生產共用指標定義」，所以它與 tx_class 是同一件工作的兩半。

## 建議順序

1. `tx_class`（§20-9）＋依它分流的指標輸出（§20-10）——一起做，因為指標定義要靠 tx_class 才能把補貼與測試量剔除
2. 供需深度的定義與輸出
3. §20-6 sandbox 面：Phase 2 範圍，本階段只標註
