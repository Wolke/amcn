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
| 3 | 之後替第三方完成任務並回補負餘額 | 同上；`node demo-autonomous.js`「§20-3／UC-02 閉環真正閉合」（無人介入版）| ✅ 自動 |
| 4 | 全部餘額變動可由簽署事件重建且守恆 | `node demo.js`「§20-4 Σ=0 且收據重建 = Hub 帳」；`node demo-rebuild.js`（**另一個進程、另一個埠**從匯出重建並偵測竄改）；`lib/invariants.js` 在每個故障情境中**持續**檢查六項不變式，10 個情境零違反 | ✅ 自動，且已強化為連續檢查 |
| 5 | 官方 Indexer 停止後仍可恢復或轉用其他 Indexer | `node demo-reconnect.js`（殺掉 Hub → 全網自行重連）；`chaos-run.js scenarios/hub-kill-takeover.json`（SIGKILL → 同 seed 從自動匯出重建接手）；`scenarios/hub-moves.json`（**Hub 換位址**，client 憑簽署的 rendezvous 記錄自行跟上，無人改設定）；`demo-transport.js`（三種傳輸實作產生同一本帳）| ✅ 自動，四種角度 |
| 6 | 惡意 Task 無法讀 Provider Key 或掛載私人目錄 | `node demo.js` key 掃描；`node redteam-agents.js` A1（payload 明文要求回傳 API key）、A2（payload 是否經過 Hub）。**掛載私人目錄未測**——原型沒有 sandbox，見盤點 §3 不可達清單 | ⚠️ Key 有證據；sandbox 面**無控制** |
| 7 | 至少一種任務能以 deterministic verification 自動結算 | `node demo.js`「§20-7 DSL 驗收＋真 HTTP 路徑」（assert 集在 TaskSpec 簽章時鎖 hash）| ✅ 自動 |
| 8 | Agent 能在 Owner Policy 內自動完成全程，無逐筆人工 | `node demo-autonomous.js` 12/12：無 `posts` 時間表、無 Console 呼叫，斷言 `manual_posts + scripted_posts == 0` | ✅ 自動 |
| 9 | 測試交易、補貼交易與真實交易可清楚區分 | **沒有證據**：`tx_class` 在 node 原型完全未實作（#1 的修法第 (b) 項仍開著）。金絲雀任務由 Treasury 出資、在帳上與一般交易**無法區分** | ❌ 未實作 |
| 10 | 能輸出成交率、供需深度、違約率、平均還債時間 | 平均還債時間 ✅（`demo.js`「§20-10」與 Console 的 `avg_repayment_ms`）；成交率 ⚠️（情境輸出結算數／任務數，但沒有正式指標定義）；違約率 ⚠️（模擬器有，原型無）；**供需深度 ❌ 完全沒有** | ⚠️ 四項中一項完整 |

---

## 結論

十項裡 **7 項有完整的自動化證據**（1、2、3、4、5、7、8），**2 項部分**（6 的 sandbox 面、10 的四個指標只有一個），**1 項完全沒有**（9）。

兩個缺口的性質不同：

- **§20-9（tx_class）是純粹沒做**。它不難：收據加一個 `tx_class` 欄位（market／test／subsidy／related-party）、Hub 驗證它、金絲雀與 Treasury 補貼標成 subsidy、匯出與指標依它分流。難的是**追溯**——現有帳本沒有這個欄位，所以 W12 的證據包只能從實作之後的交易算起。
- **§20-6 的 sandbox 面是架構上還不存在**（盤點 §3 列為原型不可達）。這一項在 Phase 1 無法補齊，只能誠實標註。

§20-10 的三個缺口（成交率、供需深度、違約率）在原型裡都**可以算**，缺的是指標定義與輸出——而 FR-083／§20-9 要求「模擬與生產共用指標定義」，所以它與 tx_class 是同一件工作的兩半。

## 建議順序

1. `tx_class`（§20-9）＋依它分流的指標輸出（§20-10）——一起做，因為指標定義要靠 tx_class 才能把補貼與測試量剔除
2. 供需深度的定義與輸出
3. §20-6 sandbox 面：Phase 2 範圍，本階段只標註
