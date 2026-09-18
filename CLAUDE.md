# AMCN — 給 AI Agent 的專案導覽

本專案是 AMCN（Agent Mutual Compute Network）：AI Agent 點對點算力互惠信用清算網路的設計與 Phase 0 模擬。文件語言為繁體中文（zh-TW）。

## 閱讀順序與文件權威層級

1. `docs/AMCN-SDD-v0.1.md` — **需求真相來源**。問題定義、設計原則 P-01～P-10、功能需求 FR-xxx、非功能需求 NFR-xxx、威脅模型 §16、MVP 驗收標準 §20。
2. `docs/evaluation/final-architecture.md` — **已裁決的架構**。分層決策表（§2.2）、必修缺陷登記簿（§4，P0/P1 編號）、12 週整合計畫（§5）。
3. `docs/proposals/proposal-{A,B,C}-*.md` — 三份競爭提案，**歷史輸入**。與 final-architecture 衝突時，一律以 final-architecture 為準。
4. `docs/evaluation/reviews/review-{A,B,C}.md` — 獨立評審報告；提案中被評審實證推翻的數字（幣值錨定、成本表、分錄範例）不得直接引用。

## 引用規則

- 引用需求用穩定編號：`FR-050`、`NFR-006`、`P-05`、`§16 威脅 7`、缺陷登記簿 `P0-3`——不要用頁碼或行號。
- 設計討論必須對照 SDD §27 閉環判準與 §5.2 MVP 非目標；任何方案若破壞「Key 不離機」（P-02）或引入投機幣（P-04）即不合格。
- 提案內的數值參數（信用額度、費率、押金）尚未定案，最終以 Phase 0 模擬 GATE-0 結果為準（final-architecture §5 W3）。

## 程式碼

- `sim/amcn_sim/` — Phase 0 經濟模擬器，純 Python stdlib（3.10+），無第三方相依。
- 模擬器的帳本不變式（每組 posting Σ=0、餘額可由事件重建）是**協議級規則**，改動 `ledger.py` 前先讀 SDD §14.1 與 FR-050/051。
- 修改任何經濟公式（`agents.py` 的 `credit_limit`、`market.py` 的定價）後，必須重跑測試與 baseline 情境比較指標變化——經濟參數調整以模擬為回歸閘門（final-architecture §2.2）。

## 常用指令

```bash
# 測試（21 tests：帳本守恆、信用額度性質、端到端情境）
python3 -m unittest discover -s sim/tests

# 單一情境模擬（--trace auto 可看單一 Agent 的日記）
cd sim && python3 -m amcn_sim --agents 500 --days 84 --scenario baseline

# 全情境比較（baseline / expiry_cliff / high_default / wash_heavy）
cd sim && python3 -m amcn_sim --all-scenarios

# 參數掃描（starter × 風險費 × 違約率，輸出 out/sweep.csv）
cd sim && python3 -m amcn_sim.sweep

# Phase 1 閉環 demo（約 15 秒，16 項 §20 驗收自動斷言）
cd node && node demo.js

# W8 無人閉環 demo（約 20 秒，12 項斷言：無時間表、無 Console 呼叫）
cd node && node demo-autonomous.js

# W9 金絲雀稽核 demo（約 30 秒，6 項斷言：偷懶 verifier 被沒收押注）
cd node && node demo-canary.js

# W10 帳本重建演練（約 25 秒，7 項斷言：第二排序器從匯出重建、竄改被拒）
cd node && node demo-rebuild.js

# W10 第二個 ITransport（約 35 秒，7 項斷言：tcp 與 http 產生同一本帳）
cd node && node demo-transport.js

# W10 拔線預演（約 40 秒，8 項斷言：殺掉 Hub 後全網自行重連、帳延續）
cd node && node demo-reconnect.js

# 每支 demo 都可用 DEMO_PORT_OFFSET=100 與跑中的試點並存；
# AMCN_TRANSPORT=http 可把整個 stack 換到第二個傳輸實作（預設 tcp）

# 回流對照（#71，各 40 分鐘，可並行）：同一個長跑開/關 protocol 帳戶回流
cd node && node chaos-run.js scenarios/soak-rebate.json
cd node && node chaos-run.js scenarios/soak-norebate.json

# 快照＋尾檔恢復（#74）：歷史只存在尾檔時殺掉 Hub，驗證重播完整
cd node && node chaos-run.js scenarios/tail-recover.json

# 大尾檔（#74）：把快照預算調緊使間隔拉到 ~394s，測大尾檔重播（約 20 分鐘）
cd node && node chaos-run.js scenarios/tail-large.json

# 說謊的排序器（#69c／#72）：Hub 對一半節點供應分叉 checkpoint，看誰說出來
cd node && node chaos-run.js scenarios/hub-equivocates.json
cd node && node chaos-run.js scenarios/hub-equivocates-panel.json

# 故障注入情境（10 個，約 35 分鐘；單跑一個約 3 分鐘）
cd node && node chaos-run.js scenarios/panel-blackhole.json
cd node && node chaos-run.js scenarios/*.json

# W11 紅隊第一批（約 40 秒，41 案：協議層攻擊＋串謀結算、排序器 equivocation）
#   目前 block 41、known-open 0
cd node && node redteam.js

# W11 紅隊第二批（約 40 秒，13 案：惡意參與者——不交付的 provider、沉默/改票的 verifier、超賣額度、未聲明上游條款者）
cd node && node redteam-agents.js

# 信用額度跨語言對照（模擬器 vs 原型，逐步比對同一組流水）
cd node && node cl-compare.js

# 洗量拓撲對額度的效果（E3：環狀／團狀／星狀 × N，即時，無需起進程）
cd node && node wash-sweep.js

# 還債政策參數掃描（折價 × band 定義 × 情境，約 10 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_repay

# 保證金掃描（推廣額度 × 保證金 × 折扣率，三種子，約 5 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_deposit

# 保管費掃描（費率 × 收取模式 × N，三種子，約 8 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_demurrage

# 最小可行網路規模掃描（N × 費率 → 觸底時間，約 3 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_size

# 驗證市場掃描（費率 × 金絲雀率 × 偷懶比例，約 5 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_verifier
```

注意：大規模模擬（>1,000 agents 或 --all-scenarios 全量）耗時較長，先與 Owner 確認再跑。

## 給外部架構/評審 Agent 的標準提示模式

- 產出新提案：投餵 `docs/AMCN-SDD-v0.1.md` 全文＋SDD §23 風格的角色設定，要求交付 §22 全部 18 項＋§24 自評。
- 對抗評審：投餵單一提案＋`docs/evaluation/reviews/` 任一份作為格式模板，要求「逐頁找矛盾、重算成本表」，至少找 3 個實質問題。
