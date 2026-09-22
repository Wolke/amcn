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

## 使用者文件（推廣用，2026-09-22 新增）

- `README.md` — 入口：五分鐘單機起步（`node/quickstart.sh`）、三條路徑的分流、三十秒版的機制。
- `node/JOIN.md` — **可直接轉給參與者**：三種角色的門檻（verifier／provider／requester）、
  押注的四條規則（#38 的沒收與退還）、CC 是什麼／不是什麼、義務、跨網段 `secure`、自檢與查帳。
- `node/INSTALL.md` — 營運方：多機安裝、備份還原（快照＋尾檔）、金絲雀、回流、招人要講的三件事。
- 對外說法的界線：`related-party`（#63）與「零個外部參與者」必須誠實標註，不得用關聯方數字宣稱市場。

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

# 逆週期收購（#83，Owner 的「AI 會頭」）：造出需求枯竭再看它能不能撐住
#   drought_day=42 讓全網需求砍到 20%；counter_cyclical_cap_cc 是治理上限。
#   實測貼上限 15.0%→2.1%、首位佔比 5.3%→2.8%，需求在約 4,392 CC 飽和
cd sim && python3 -c "from amcn_sim.simulation import run; \
  r=run(300,84,42,'baseline',drought_day=42,counter_cyclical_cap_cc=3000, \
        starter_cc=50.0,deadbeat_frac=0.0,n_verifiers=6); \
  print('首位佔比', round(r.top_holder_share*100,1), '| Treasury', round(r.treasury_cc,1))"

# GATE-0 八判準（500 agents × 84 天 × 4 情境 × 3 種子，約 15 分鐘）
#   一個種子過不算過；「不適用」不計入通過。預設組 6/8；**候選組 8/8**
#   （starter 50、風險費 6%/2%、LTV 0.5、G8 改成 verifier 留存 ≤95%），
#   詳見 docs/evaluation/phase0-results.md 的 v3 回合
cd sim && python3 -u -m amcn_sim.gate0

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

# #89 零入向埠的傳輸（約 20 秒，7 項斷言）：Hub 只聽回送位址，經 SOCKS5 進來的
#   帳與直連 tcp 完全相同。自帶 SOCKS5 代理，**不需要安裝 tor**
cd node && node demo-tor.js

# 單機起一個真的網路（推廣用的第一步，約 30 秒；留著讓人操作，不是回歸閘門）
cd node && ./quickstart.sh          # ./quickstart.sh status / stop

# 讓這台機器常駐跑（macOS launchd：開機起、崩潰重起）。Hub＋3 verifier＋只賣不買的供給端
cd node/service && ./install.sh     # status / invite / ../service/uninstall.sh
#   invite 會印出可以直接貼給人的邀請（hub did 與區網位址都填好）

# 自己驗一本帳（不必相信 Hub）：逐筆驗簽、餘額由事件重放、checkpoint 比對鏈頭
cd node && node ledger-dump.js out/mine.json 127.0.0.1 47180
cd node && node verify-ledger.js out/mine.json --pin did:demo:<hub did>

# #38 押注沒收／退還 demo（約 70 秒，14 項斷言，測的是一個 2×2：
#   離線×未被測夠 → 全額沒收；在線×被測夠 → 可取回並退出 pool；
#   離線×被測夠 → 押注不動；在線×未被測夠 → 取回被拒）
cd node && node demo-forfeit.js

# W10 拔線預演（約 40 秒，8 項斷言：殺掉 Hub 後全網自行重連、帳延續）
cd node && node demo-reconnect.js

# demo 並行是支持的（#80 已修：重連窗從「Hub 真的在 listen」算起，
# 起不來時會印出 hub 自己的 log）。仍建議逐支跑以免時序噪音。
#
# 每支 demo 都可用 DEMO_PORT_OFFSET=100 與跑中的試點並存；
# AMCN_TRANSPORT=http 可把整個 stack 換到第二個傳輸實作（預設 tcp）

# 回流對照（#71，各 40 分鐘，可並行）：同一個長跑開/關 protocol 帳戶回流
cd node && node chaos-run.js scenarios/soak-rebate.json
cd node && node chaos-run.js scenarios/soak-norebate.json

# 規模第三點（#61／#62，40 分鐘）：與 soak-rebate（N=3）、soak-n6（N=6）同種子同時間軸，
#   只把交易者換成 20 個——W12 封閉試點的下緣。目前 5/6：唯一的 FAIL 是 #77
#   （Hub 重啟後成交率 >1，指標本身未修；閘門刻意讓它紅）
cd node && node chaos-run.js scenarios/soak-n20.json

# 四小時耐久（單機，#74／#41／#62；約 4 小時，會佔住機器）：匯出長到 ~51MB、
#   快照間隔被預算拉到 ~523s、分頁成為常態；同時量 #62 的終點（verifier 佔
#   全部正餘額 100%）。這**不是** W10 的拔線演練，那需要多台真實機器
cd node && node chaos-run.js scenarios/soak-4h.json

# #62 階段 4（約 4 小時）：雙角色 vs 純 verifier，與 soak-4h 同種子同時間軸，
#   唯一變數是驗證是不是一個獨立物種。結論：吸收端沒消失，只是換人
cd node && node chaos-run.js scenarios/soak-4h-dual.json

# 分頁匯出 × 排序器重啟（#41／#81，約 3 分鐘）：兩個單獨都乾淨，只有合起來
#   才抓得到「凍結的快照其實是淺拷貝」
cd node && node chaos-run.js scenarios/page-kill.json

# 取樣的第二條路（#76）：強制不走 wire、改讀 Hub 的磁碟快照。任何情境都可加。
#   這條路只有在匯出超過 16MB 時才會自己跑到，所以得有辦法主動測它
AMCN_SAMPLE_DISK=1 node chaos-run.js scenarios/baseline.json

# 快照＋尾檔恢復（#74）：歷史只存在尾檔時殺掉 Hub，驗證重播完整
cd node && node chaos-run.js scenarios/tail-recover.json

# 大尾檔（#74／#78）：把快照預算調緊使間隔拉到 ~400s，測大尾檔重播（約 20 分鐘）
cd node && node chaos-run.js scenarios/tail-large.json

# 恢復的負向對照（#78）：尾檔不帶鏈分錄＝舊行為，Hub 必須拒絕啟動
#   （tail-recover 會從 4/4 掉到 2/4，且紅在「恢復後無成交」與「重啟後讀不到帳」）
HUB_TAIL_CHAINS=0 node chaos-run.js scenarios/tail-recover.json

# 說謊的排序器（#69c／#72）：Hub 對一半節點供應分叉 checkpoint，看誰說出來
cd node && node chaos-run.js scenarios/hub-equivocates.json
cd node && node chaos-run.js scenarios/hub-equivocates-panel.json

# 故障注入情境（10 個，約 35 分鐘；單跑一個約 3 分鐘）
cd node && node chaos-run.js scenarios/panel-blackhole.json
cd node && node chaos-run.js scenarios/*.json

# W11 紅隊第一批（約 55 秒，45 案：協議層攻擊＋串謀結算、排序器 equivocation、
#   偽章 checkpoint、押注退還的角色與連線綁定）
#   目前 block 45、known-open 0
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

# 淨流入費掃描（#66 流量側；費率 × 去向 × N，七種子，約 6 分鐘）
#   對「當期餘額長了多少」收費，而非對持有量。抽取效果單調成立；
#   回流效果方向對但落在種子離散內。注意：模擬器裡只有存量型吸收端
cd sim && python3 -u -m amcn_sim.sweep_inflow
#   加 --dual-role 讓驗證由交易者兼任（#62 階段 3 的形狀）。兩種人口都給出
#   同一個機械關係：首位持有者留存率 = (1 − 費率)，半幅近乎為零
cd sim && python3 -u -m amcn_sim.sweep_inflow --dual-role

# 保管費掃描（費率 × 收取模式 × N，三種子，約 8 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_demurrage

# 最小可行網路規模掃描（N × 費率 → 觸底時間，約 3 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_size

# 驗證市場掃描（費率 × 金絲雀率 × 偷懶比例，約 5 分鐘）
cd sim && python3 -u -m amcn_sim.sweep_verifier
```

# 上線前的濫用預算（#87）與流量記錄（#88）的預設值——改動前先讀 INSTALL §12
#   未註冊連線：frame 64KB、20 則、200 則/秒；連線 200／每 IP 10；
#   新身分註冊 10/分/IP；帳戶上限 500；起始匯出 30/分/IP（跟游標的分頁不計數）
#   raw_log 預設不隨匯出出去，掃流量的閘門自己設 HUB_EXPORT_RAWLOG=1

注意：大規模模擬（>1,000 agents 或 --all-scenarios 全量）耗時較長，先與 Owner 確認再跑。

## 給外部架構/評審 Agent 的標準提示模式

- 產出新提案：投餵 `docs/AMCN-SDD-v0.1.md` 全文＋SDD §23 風格的角色設定，要求交付 §22 全部 18 項＋§24 自評。
- 對抗評審：投餵單一提案＋`docs/evaluation/reviews/` 任一份作為格式模板，要求「逐頁找矛盾、重算成本表」，至少找 3 個實質問題。
