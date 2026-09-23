# AMCN — 給 AI Agent 的專案導覽

本專案是 AMCN（Agent Mutual Compute Network）：AI Agent 點對點算力互惠信用清算網路的設計與 Phase 0 模擬。文件語言為繁體中文（zh-TW）。

## 閱讀順序與文件權威層級

1. `docs/AMCN-SDD-v0.1.md` — **需求真相來源**。問題定義、設計原則 P-01～P-10、功能需求 FR-xxx、非功能需求 NFR-xxx、威脅模型 §16、MVP 驗收標準 §20。
2. `docs/evaluation/final-architecture.md` — **已裁決的架構**。分層決策表（§2.2）、必修缺陷登記簿（§4，P0/P1 編號）、12 週整合計畫（§5）。
3. `docs/proposals/proposal-{A,B,C}-*.md` — 三份競爭提案，**歷史輸入**。與 final-architecture 衝突時，一律以 final-architecture 為準。
4. `docs/evaluation/reviews/review-{A,B,C}.md` — 獨立評審報告；提案中被評審實證推翻的數字（幣值錨定、成本表、分錄範例）不得直接引用。
5. `docs/evaluation/second-machine.md` — 第二台機器的 runbook（三階段、每段一個要量的數字、以及這一趟之後**不能**宣稱什麼）。
6. `docs/evaluation/credit-regime-ab.md` — #90 的裁決用對照（新人的第一筆額度要送還是買）。**尚未裁決**：常駐節點目前跑的是「送 50」，而建議是先走「小額 10＋入門採購」。

## 引用規則

- 引用需求用穩定編號：`FR-050`、`NFR-006`、`P-05`、`§16 威脅 7`、缺陷登記簿 `P0-3`——不要用頁碼或行號。
- 設計討論必須對照 SDD §27 閉環判準與 §5.2 MVP 非目標；任何方案若破壞「Key 不離機」（P-02）或引入投機幣（P-04）即不合格。
- 提案內的數值參數（信用額度、費率、押金）尚未定案，最終以 Phase 0 模擬 GATE-0 結果為準（final-architecture §5 W3）；新人額度那一格另見 `credit-regime-ab.md`，而**寫報表時「成交量」不等於需求**（洗量與 `related-party` 要分開列，#63／#90 條件 ii）。

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
#   #90 的候選組（額度只能賺＋Treasury 買新人的第一份工作）：8/8，但 G2 是空過
#   （零額度體制下沒有可比的誠實基準），而洗量佔成交量 40.3% → 66.3%
cd sim && python3 -u -m amcn_sim.gate0 --starter 0 --onboarding 20 \
  --onboarding-total 40000 --risk-thin 0.06 --risk-base 0.02 --dual-role

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

# #95 排序器接手（約 70 秒，11 項斷言）：現任被 SIGKILL 之後待命機**自動**升格，
#   client 憑事先簽好的授權跟到一個**不同的 DID**（沒有任何私鑰被複製），帳延續
#   且第三方仍驗得過（前任簽的 checkpoint 靠委派鏈）。三條負對照：沒授權的人
#   跟不到、沒驗過的帳本不准升格、舊排序器不能搶回排序權
cd node && node demo-succession.js
#   營運方那一側：現任加 HUB_SUCCESSORS=<待命機 DID>，待命機跑
#   node standby.js var/rendezvous.json --pin did:demo:<現任> --port 47180

# #94／#101／#102 token 計量、上限與回報（約 60 秒，15 項斷言）：替別人做事花掉的是自己的
#   token。計量（有 usage 用真值、沒有就估並標成估計值）、上限（token／美金，
#   跨重啟不歸零，用完就**停止出價**）、回報（每筆一行 log ＋ 一行 JSON 到
#   out/owner-notices.jsonl）。最重要的是那組正／負對照。另外三條是第二種上游
#   形狀（Anthropic 原生：/v1/messages、content[]、input_tokens→prompt_tokens、
#   metadata.user_id），以及兩條**定位**斷言（#102）：成本不離開這台機器
#   （掃整本匯出含 raw_log，美金／token 數／模型名零命中）、收據買的是一份
#   通過驗收的交付而不是用量
cd node && node demo-spend.js

# #92 裝完就加入預設網路（約 20 秒，8 項斷言）：`node agent.js` 不帶任何參數即
#   解析簽署過的位址記錄 → 撥出去 → 註冊。沒有預設網路時要說出三條路而不是
#   丟例外；pin 不符就不連。預設網路填在 node/network.json（目前是空的）
cd node && node demo-bootstrap.js

# #91 常駐入口與位址記錄（約 25 秒，11 項斷言）：入口比 Hub 晚起來、入口換位址，
#   簽署過的 rendezvous 記錄都要跟上；讀的是 run-hub.sh --print-env **算出來的值**，
#   所以「模式是 onion 卻又綁回 0.0.0.0」抓得到。不需要 tor、不碰你的 launchd
cd node && node demo-rendezvous.js

# #98／#99 常駐服務的組合（約 60 秒，9 項斷言）：新人第一天的額度、發樁者有沒有被
#   授權（順序對不對）、治理上限、install.sh 會不會裝第五個服務。關鍵那條量的是
#   **行為**：同一個新身分 starter 10 → 4.6 CC、starter 50 → 23.1 CC。
#   另外三條是 #99：調整經濟參數之後這台機器**還起不起得來**（政策跟著帳走，
#   不是跟著環境變數——實測改 starter 曾讓 live 排序器拒絕啟動）
cd node && node demo-service.js

# 要把**另一個 agent**拉進來：給它這一行就夠（寫給 agent 執行的，不是給人讀的）
#   https://raw.githubusercontent.com/Wolke/amcn/main/node/AGENT-JOIN.md
# 有 ssh 的話一個指令推過去（--dry-run 先看）：
cd node && ./service/deploy-join.sh user@host

# 加入一個已經在跑的網路（**別人 clone 之後要跑的那一個指令**，#96）
cd node && ./join.sh                # --check / --verifiers 3 / --provider / status / stop
#   要連去哪由 network.json 決定（靜態位址或位址記錄，都必須有 hubPin）。
#   參與者只往外撥，永遠不必開埠；.onion 位址需要本機有 tor，缺了會說怎麼修。
cd node && node demo-join.js        # 閘門（約 30 秒，9 項斷言，含兩條負對照）

# 單機起一個真的網路（推廣用的第一步，約 30 秒；留著讓人操作，不是回歸閘門）
cd node && ./quickstart.sh          # ./quickstart.sh status / stop

# 讓這台機器常駐跑（macOS launchd：開機起、崩潰重起）。Hub＋3 verifier＋只賣不買的供給端
cd node/service && ./install.sh     # status / invite / publish / ../service/uninstall.sh
#   ./arm-supply.sh 讓這台真的能賣算力：key 進 Keychain（腳本看不到）＋記下你的
#     條款聲明（P-10，要打一句話而不是按 y）＋重啟並驗證。--check 只看不改
#   五個服務：hub／panel／agent／onboard（#90 的入門採購發樁者）＋onion（--onion 時）
#   新人額度預設 starter 10 CC ＋入門採購（#90 的 D 組，理由見 credit-regime-ab.md）
#   ./install.sh publish 把 network.json 填好；commit 之後別人 clone 就能加入（#96）
#   invite 會印出可以直接貼給人的邀請（hub did 與區網位址都填好）
#   ./install.sh --onion 多裝一個常駐 onion service（com.amcn.onion）：任何地方的人
#     都能加入而這台零入向埠，Hub 同時改綁 127.0.0.1；./install.sh --lan 收回去。
#     模式存在 configs/.home-mode，兩種模式都發布 var/rendezvous.json（#45／#91）——
#     把那個檔放到任何靜態主機就是位址輪替，對方用 `node panel.js rv:<網址>` 跟著走

# 自己驗一本帳（不必相信 Hub）：逐筆驗簽、餘額由事件重放、checkpoint 比對鏈頭
cd node && node ledger-dump.js out/mine.json 127.0.0.1 47180
cd node && node verify-ledger.js out/mine.json --pin did:demo:<hub did>

# #90 入門採購 demo（約 45 秒，8 項斷言）：Treasury 買新人的「答案已知的工作」，
#   三道門＝答案可判（只收 sha256_eq）＋面板真的判過＋收款方從沒收過 CC，
#   外加每身分與全網兩個上限。四條負對照比正向那一條重要
cd node && node demo-onboard.js
#   HUB_ONBOARD_STREAK 預設 3：要連續 3 次通過才付一次。連續 1 次時交假東西的
#   攻擊者每身分仍拿 5.52 CC，連續 3 次是 0.00（誠實新人只從 196 掉到 187 人）

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

# W11 紅隊第一批（約 55 秒，50 案：協議層攻擊＋串謀結算、排序器 equivocation、
#   偽章 checkpoint、押注退還的角色與連線綁定、同價同信譽的決勝）
#   目前 block 50、known-open 0
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

# #90 的裁決用對照（約 7 分鐘）：新人的第一筆額度要送還是買。
#   四體制（送 50／零額度／零額度＋採購／小額 10＋採購）× 兩種攻擊（借了就走／
#   交假東西），因為每種體制被打穿的方式不一樣。結論與建議見
#   docs/evaluation/credit-regime-ab.md
cd sim && python3 -u -m amcn_sim.regime_ab

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
