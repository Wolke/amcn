# AMCN 最終評比與整合架構

| 欄位 | 內容 |
|---|---|
| 文件 | 三提案評比（SDD §24）與最終整合架構決議 |
| 日期 | 2026-09-05 |
| 輸入 | `docs/proposals/` 三份完整提案＋三份獨立深讀評審報告 |
| 評選方法 | 每案由提案 Agent 自評、由未參與撰寫的獨立評審逐頁深讀複評（含交付物完整性、矛盾挖掘），最後由整合者裁決。依 SDD §24 要求逐面向比較，不以文件長度取勝（三案皆約 1,500 行，長度已中性化） |
| 結論 | **以提案 B（MVP-first）為工程骨幹，移植提案 C 的經濟層與驗證市場、提案 A 的架構原則與稽核模組**；三案各有評審實證的缺陷，整合前必修清單見 §4 |

---

## 1. 評比結果

### 1.1 §24 逐面向分數（自評 / 獨立評審 / 整合者裁定）

| 面向 | 權重 | A 自評/評審/裁定 | B 自評/評審/裁定 | C 自評/評審/裁定 |
|---|---:|:---:|:---:|:---:|
| 解決臨時額度耗盡的真實需求 | 20% | 7 / 6 / **6** | 8 / 8 / **8** | 7 / 6 / **6** |
| Key／帳密與本機環境安全 | 15% | 9 / 8 / **8** | 8 / 8 / **8** | 8 / 7 / **7** |
| Agent 自主閉環程度 | 15% | 8 / 8 / **8** | 8 / 8 / **8** | 7 / 7 / **7** |
| Mutual Credit 經濟可行性 | 15% | 7 / 6 / **6** | 6 / 6 / **6** | 8 / 7 / **7** |
| MVP 可實作性 | 15% | 6 / 4 / **4** | 9 / 8 / **8** | 6 / 5 / **5** |
| 去中心化與可替換性 | 10% | 9 / 8 / **8** | 5 / 5 / **5** | 6 / 5 / **5** |
| 驗收、反作弊與可稽核性 | 10% | 8 / 6 / **6** | 6 / 5 / **5** | 9 / 8 / **8** |
| **加權總分** | | 7.55 / 6.50 / **6.50** | 7.35 / 7.10 / **7.10** | 7.15 / 6.40 / **6.40** |

整合者裁定全數採納獨立評審分數。理由：三位評審均完成逐頁深讀、每個扣分都附提案章節證據，且一致地發現了提案自評未揭露的實質矛盾（A 案 7 項、B 案 10 項、C 案 8 項）；相比之下自評分數系統性偏高 0.4–1.05。特別說明兩處大幅下修：

- **A 案 MVP 可實作性 6→4**：45–55k LOC 的新穎分散式系統 ÷ 72 人週，且 W9–10 兩週要塞五個子系統、Firecracker 承諾未排程、無形式化方法人力卻要交 TLA+。這不是「緊」，是大概率交不出 §20 十條驗收。
- **C 案 Mutual Credit 8→7、驗收 9→8**：機制框架是三案最強，但「攻擊者期望值 < 0」的三張關鍵成本表被評審逐一算破（幣值錨定差 10 倍、旗艦分錄不守恆、金絲雀成本低估約 40 倍）——結論方向可信，數字必須重算。

### 1.2 逐面向勝者與理由

| 面向 | 勝者 | 一句話理由 |
|---|---|---|
| 真實需求 | **B** | 唯一給出需求側具體入口（MCP server 3 tool／3 人日）與 429/quota 觸發的完整實作路徑；A 的協議開銷 P95 11–40s 在「現在很急」場景踩線，C 的緊急路徑疊了太多反作弊摩擦 |
| Key 安全 | **A/B 並列** | A 的程序級隔離（Sandbox 與 Keystore 不同程序、單向窄介面）是結構性設計；B 的封包側錄＋日誌掃描驗收是可證偽的驗收法。整合架構兩者都收 |
| 自主閉環 | **A/B 並列** | 兩案的還債策略、目標餘額區間、全 transition 逾時定義都完整；C 的預批門檻與人工爭議略多 |
| 經濟可行性 | **C** | INV-C1、T_flow 信任流、四層壞帳瀑布、六種經濟攻擊逐一參數化——是唯一把 Sybil 防禦搬到額度層並可稽核的框架（數字待修） |
| MVP 可實作性 | **B** | 逐週交付物、砍單順序、「永不砍」清單、4.5 FTE 相稱範圍；評審仍估超載 40–60%，但遠優於另兩案 |
| 去中心化 | **A** | 九層分析＋「官方消失後」欄＋拔線演習；「哪幾層不可晚做」的判準是三案唯一說清楚的 |
| 驗收反作弊 | **C** | seeded-random＋commit-reveal＋雙向金絲雀＋偏離 slash＋tx_class 誠實計量，且「稽核稽核者」為獨有設計 |

**依 SDD §27 判準的最終裁決：選 B 為骨幹。** §27 說得明白：核心不是 Token、區塊鏈或 Marketplace UI，而是 Agent 自主完成的互惠信用閉環。三位評審一致認定 B 是「最可能在 12 週內真的跑出閉環」的提案；A 案評審的原話是它應作為「原則來源與經濟／稽核模組供應者，而非直接採納的 MVP 實作路線」；C 案評審的原話是其經濟機制「應成為整合架構的骨幹」但證明尚未成立。三個結論拼起來就是本文件的整合方案。

---

## 2. 整合架構決議

### 2.1 最高決策原則（採 A 案 §25 Q11，全文照收）

> **不可事後補裝的層（第一天就要做對）：身分、帳本語義、收據格式、驗收權分配。** 因為遷移成本＝全網信任重置。
> **可以先中央化的層（綁定退場三件套）：撮合、傳輸、索引、託管。** 每個中央化元件必須配齊：協議內發現與輪替機制、至少一個開源替代實作、全部狀態可由公開簽署事件重建。

### 2.2 分層決策表

| 層 | 採用 | 設計要點 | MVP 誠實現況 |
|---|---|---|---|
| **Identity** | A 案 | did:key（Ed25519）＋Root/Hot 分離＋UCAN 0.10 委派鏈（子任務縮小委派）＋三層撤銷（短效期／gossip 撤銷／高額線上查驗） | 第一天即去中心化，零基礎設施依賴 |
| **Transport / 撮合** | B 案 | 出站 WSS 至 Coordination Hub，E2E 加密（Hub 只見 metadata）；`ITransport` 介面抽換，**W10 強制交付第二實作＋拔線演練（A 案演習納入）** | 中央化。**第二實作已交付**（`lib/transport-{tcp,http}.js`，`demo-transport.js` 斷言兩傳輸產生同一本帳）；4 小時拔線演練仍未做，見 §4 #10 |
| **Ledger 語義** | B 案骨架＋A/C 補強 | 複式帳、每組 posting Σ=0、雙簽 SettlementReceipt、per-account hash chain、每小時公開 Merkle checkpoint；Hub 是「第一個排序器」不是信任根。**負餘額支出採 C 案不對稱一致性**：使餘額更負的支出需經序列化確認（MVP 由 Hub 擔任、Phase 2 起 3–5 席可替換 Witness 聯邦 2/3 共簽），正餘額支出走雙簽＋樂觀對帳 | 排序中央化；語義（收據格式、守恆規則、checkpoint 驗證）第一天即最終版 |
| **單方 posting 合法性**（修 A①/B⑤） | 新規則 | Hub/協議可執行的非雙簽 posting（demurrage、違約罰、announce 費、沖銷）**必須引用 Owner 預簽的標準政策 Grant**（加入網路時簽署的費率表 UCAN）；審計重放時無對應 Grant 的單方 posting 一律判無效。Hub 從「能單方改帳」變成「只能執行被預簽的規則」 | — |
| **Credit Line** | C 案（修數字） | INV-C1：`credit_limit ≤ k_earn × E_eff + collateral + L_boot`，**L_boot 明文列為不變式的有界例外**（上限 25 CC、Treasury 補貼科目、tx_class=subsidy）；E_eff＝多樣性折減（單一對手 ≤20%）× T_flow 信任流加權；A 案的 WilsonLower95＋1−HHI 併入 E_eff 實作 | 全部參數先過 Phase 0 模擬 GATE-0 |
| **初始信用**（修 B③） | 新規則 | 貢獻任務**只給聲譽，不給信用額度**；CL 只能來自押金、Vouch 連帶（擔保人 50% 連帶、同時上限 5 個）、多樣性折減後的已驗收淨貢獻。堵死「Treasury 付錢的工作反向養出可違約額度」 | — |
| **Verification** | B 案 deterministic-first＋C 案市場 | 驗收 DSL（assert 集在 TaskSpec 簽章時鎖 hash、Provider 可預跑）＋Attestation.reasons 指向 assert index；Judge quorum **列入「永不砍」清單**（修 B⑦：它是三條例外路徑的唯一出口）；抽選種子＝**未來一輪** checkpoint hash（修 A④ grinding）＋commit-reveal；Verifier 報酬顯式列入每筆 postings（修 A⑦/C⑤）；金絲雀抽查以**重算後的成本**編列並限定高風險對手方分層抽樣（修 C⑦ 的 40 倍低估） |
| **防拒付** | A 案＋C 案 | 成交時 Requester 預簽 `pre_authorization`（驗收通過即結算）；Requester 拖延時 Provider 持「合約＋交付＋attestation＋預簽」證據包強制入帳——在本整合中入帳者是負餘額序列化器（Hub/Witness），與 C 案 ADR-006 的路徑衝突（C⑥）就此消解：**強制入帳一律走序列化路徑，無論餘額正負** |
| **Reputation** | A 案 | 事件層（對手方/Verifier 簽章、錨定收據 CID）與評分層（模型任選、可替換）分離；同對手重複交易次線性折損 |
| **誠實計量** | A/C 案 | 收據強制 `tx_class: market / test / subsidy / related-party`；writeoff 為一級科目；模擬與生產共用指標定義（FR-083、§20-9/10） |
| **Treasury 啟動**（修 B②/C 相關） | 新規則 | Treasury 創世餘額 0；啟動期支出（金絲雀、逆週期收購、L_boot 補貼）計入**有治理上限的「創世補貼額度」**（Treasury 在該額度內可為負，全部 tx_class=subsidy）；熔斷規則改為「淨部位觸及補貼上限」而非「餘額 <0」，否則網路第一天即熔斷 |
| **Stablecoin/L2** | 三案一致 | Phase 3 選配 Escrow 擴充點；MVP 不上鏈、不發幣。狀態機差異：Stablecoin 模式在 AWARDED 加 `ESCROW_LOCKED` 子狀態 |
| **Governance** | A 案立場 | 協議層不存在全網凍結；「讓 fork 便宜」；最低版本政策與簽章更新（NFR-010）走 B 案的發布管線 |

### 2.3 狀態機

採 B 案狀態機為基準（全 transition 有呼叫者/簽章/逾時），疊加三個修正：

1. `VERIFYING` 逾時的備援 Verifier 與 default 分支保留 A 案規則（deterministic 任務 default-accept if evidence 自帶、主觀任務 default-reject）。
2. `ACCEPTED → SETTLED` 增加強制結算路徑（見上表防拒付列）。
3. Reservation（C 案負餘額預留）統一時序：**發標前**向序列化器取得 Reservation（金額＝max_price），`AWARDED` 時折算為實際成交價，TTL 綁合約 deadline＋緩衝而非固定 15 分鐘（修 C④）。

---

## 3. Phase 0 模擬（已實作）

`sim/amcn_sim/` 已依 SDD §19 實作並通過煙霧測試（120 agents × 21 天）：

- 守恆 Σ=0、全帳可由簽署事件重建：PASS（§20 驗收 4 的模擬級證明）
- 借用→負餘額→額度恢復→還債閉環成立，還債週期中位數 ≈ 3 天
- 已實作情境：`baseline` / `expiry_cliff`（月底同日到期崩價）/ `high_default`（15% 跑路）/ `wash_heavy`（20% 洗量對）

**待辦**：以整合後的 C 案公式（INV-C1＋E_eff）替換現行簡化 credit_limit；跑全量（500–10,000 agents × 84 天）驗證 GATE-0 八判準。全量模擬前先與 Owner 確認執行。

---

## 4. 整合前必修缺陷登記簿

三位評審共發現 25 項實質矛盾。按「不修就不能開工」分級：

### P0（阻斷開工）

| # | 來源 | 缺陷 | 整合修法 |
|---|---|---|---|
| 1 | B①/C③ | 新戶信用額度數字三處打架；INV-C1 被 L_boot 形式違反 | §2.2「Credit Line」與「初始信用」列；單一數值表由 GATE-0 模擬定案（W3） |
| 2 | B②/C② | Treasury 創世即負、熔斷自觸發；CC/USD 錨定差 10 倍 | §2.2「Treasury 啟動」列；全案統一 1 CC = US$0.05，三張攻擊成本表重算（W2 交付） |
| 3 | A① | 非自願扣帳在自簽鏈中無法落地、守恆不封閉 | §2.2「單方 posting 合法性」列（預簽政策 Grant） |
| 4 | B⑦ | Judge quorum 在可砍清單卻是例外路徑唯一出口 | 移入「永不砍」；最小三人池 W9 交付 |
| 5 | C⑤/A⑦ | 驗證費在旗艦分錄中憑空消失／三套數字並存 | **已交付**（W9）：收據新增 `acceptance_method`／`verifier_pool`／`verifier_pool_hash`／`panel_seed_cp`，judge-quorum 每筆結算必須付給**由 Hub 自行推導**的 panel（成交價 4%、均分，從 provider 毛額扣除），dsl-local 不得有 verifier 分錄；`validateSchedule` 強制此規則，雙簽與強制結算路徑共用。`demo.js` 有對應斷言。**費率 4% 取 proposal-C 3–6% 中點，尚無模擬證據**——模擬器沒有 Verifier agent，見 #25 |

### P1（開工後兩週內修）

| # | 來源 | 缺陷 | 整合修法 |
|---|---|---|---|
| 6 | A④ | Verifier 抽選種子可 grinding | **未來 checkpoint 已交付**（W9）：合約不再指名 panel，只釘住 pool 雜湊與一個**尚未產生**的 checkpoint 序號；panel 由該 checkpoint 的 root 推導，Hub 在強制結算時**重新推導**而非採信合約名單。`node/lib/panel.js` 為雙方共用規則，`demo.js` 斷言「合約時已知序號 < 種子序號」且實際 attester 全在推導結果內。commit-reveal 亦已交付（見 #26）|
| 7 | A⑤/C⑦ | Verifier 押金 vs 經手上限差 20 倍；金絲雀成本低估 40 倍 | 經手上限 ≤ 押金×3；金絲雀改分層抽樣並重編預算 |
| 8 | B⑥ | 抽查率 0.13% 撐不起威懾宣稱 | 同上＋高風險對手方加權抽樣 |
| 9 | C⑥ | 不對稱一致性與強制入帳互斥 | 強制入帳一律走序列化路徑（§2.2） |
| 10 | B④ | 「Indexer 停止」驗收是循環論證 | **部分已修**：`demo-rebuild.js` 的驗收不是「Hub 能否重啟」，而是**另一個進程、另一個埠**能否僅憑簽署產物重建出相同餘額、鏈與信用額度，並偵測偽造品——實測 7 收據／28 事件／8 帳戶零不符，竄改檔被拒。**第二個 `ITransport` 實作已交付**（W10）：`lib/transport.js` 定義介面（`listen`／`dial`／`probe`）、`transport-tcp.js` 是原行為、`transport-http.js` 是長連 chunked NDJSON＋POST。刻意不選另一種 socket 方言——那共用 TCP 的故障模型，換了等於沒換；HTTP 線上無連線狀態、送達以請求為單位、POST 需自行保序。關鍵斷言不是「兩種都連得上」而是**同一場閉環在兩種傳輸下產生同一本帳**：`demo-transport.js` 比對 fingerprint（收據／事件／餘額／額度／驗收方式），實測 `2ea62f9f…` 完全相同，且四支 demo（21／12／6／7 項）在兩種傳輸下全過。抽取過程本身暴露一件事：語義原本散在傳輸層裡——frame 切分、版本閘門（#33）、handler 隔離（#13／#34）全都寫在 `wire.js` 的 socket 讀取器內，若讓第二實作各自複製一份，兩份帳分岔只是時間問題；因此移到 `lib/channel.js` 由兩者共用，傳輸層只准提供 write／close。混用傳輸時雙方都會明確拒絕（tcp 端回 HTTP 400、http 端回一行 framed `transport_error`）——這是 #36「靜默卡住比崩潰難查」的教訓。**仍缺 4 小時真實拔線演練**，Owner 裁定等第三台機器到位再跑（2 台雖足以驗證「官方基礎設施消失後能否由簽署產物接手」這個主張，但切換後全網跑在單一主機上，2-of-3 quorum 在部署層仍是裝飾——見 #31）。演練排程前有三項前置：**(a) #40 重連**，否則量到的是手動重啟時間而非接手能力；**(b) 匯出必須先離開 Hub 那台**（`HUB_DUMP_PATH` 寫本機檔，而受災節點就是它——第二台以 `ledger-dump.js <out> <hub-ip> <port>` 定時拉取即可，無需改碼）；**(c) 接手者的 Hub 身分**——pinned agent 依設計拒絕非 pinned DID，所以要嘛預先把 `HUB_SEED` 複製到待命機（「第一個排序器」的鑰匙成為多台共有的秘密，本身是應登記的安全性質），要嘛接受 pinned agent 不跟隨並手動重新 pin。演練必須記錄走的是哪一條。另需明確：拔線後受災節點**不得**再接回同一網段，否則測到的是雙排序器分叉而非接手 |
| 11 | A②③ | 雙花上限低估 5 倍、未見證折損對 equivocation 無效 | 整合架構負餘額支出走序列化，此攻擊面整類消失；正餘額路徑保留分叉偵測作稽核 |
| 12 | B⑩ | Key 隔離的 IPC 方向寫反 | 採 A 案程序模型：Prompt 處理程序無 Key，經單向窄介面提交推理請求給持 Key 的 Adapter 程序 |

（其餘 P2 級文字/排程不一致 13 項，開發中隨頁修正；完整清單見三份評審報告原文。）

### Phase 1 原型實作發現（非評審來源）

上列 1–12 項來自三份獨立評審。以下由 `node/` 的 Phase 1 原型與兩台機器試點實作過程發現——評審讀不到的層級，只有跑起來才會暴露：

| # | 級別 | 缺陷 | 狀態與修法 |
|---|---|---|---|
| 13 | **P0** | Hub 對畸形 frame 會整個進程崩潰：`createPublicKey()` 遇到壞 DER 是丟例外而非回傳 false，例外從 socket `data` handler 逃出即 uncaught。Hub 綁 `0.0.0.0` 時，區網任一裝置送一行垃圾就能打掉整個網路（掛在上面的 Verifier 全數斷線） | **已修**（`lib/wire.js` 驗簽不丟例外＋frame 層隔離＋socket error 處理＋行長上限；`demo.js` 回歸閘門） |
| 14 | **P1** | 中央化 Transport／撮合層缺「協議內發現與輪替機制」——§2.1 把它列為中央化的綁定條件，§2.2 裁定 B 案時未交付。Hub 位址只存在各機設定檔，換位址等於全網手改 | **已修**：發現＝區網 UDP 簽署信標（`lib/discovery.js`，`hubHost: "discover"`，跨機實測可行見 #18）；輪替＝`HUB_SEED` 讓 Hub 身分跨重啟不變（`identityFromSeed`，本來為金絲雀授權而加），`hubPin` 因此第一次有跨生命週期的意義——搬移 Hub 只要保留 seed，所有釘住的 agent 會跟著新位址。Hub 啟動 log 一律印出 `hub did`（不再取決於 beacon 是否開啟）|
| 15 | **P1** | `contract_id` 可重複：任務 id 為 `t-<設定名>-<seq>`，`seq` 每次啟動歸零且設定名不唯一，導致兩個不同 DID 持有相同 contract_id 的收據。W1 已凍結的 schema 中 contract_id 是結算冪等鍵，識別碼不唯一將使 W9 爭議、W11 紅隊重放、W12 §20 證據包出現雙重計算 | **已修**（id 併入 DID 標籤；Hub 以 `settledIds` 拒絕重複結算，雙簽與強制路徑共用同一守門；`demo.js` 重放斷言） |
| 16 | **P2** | Hub 的 `receipt`／`task`／`forced_settlement` handler 對缺必要欄位的 frame 會丟例外。目前由 #13 的 frame 層 try/catch 接住並記錄為 `[wire] dropped frame`，但缺逐欄位驗證，錯誤訊息對送出方也不具指引性 | 未修。建議與 W1 schema v1 的欄位驗證一併實作 |
| 17 | **P2** | Hub 帳本與 Agent 身分皆不持久化：帳本在記憶體、`export` 有出口無 import 入口，`agent.js` 每次啟動 `genIdentity()` 產生新 DID。任一邊重啟即歸零，且被棄置的負餘額身分會在帳上留下永不償還的洞（試點實測留下 +16.52 CC 花不掉的正餘額與 −10 CC 不會還的債）| **身分已修（W10 前半）**：`agent.js`／`verifier.js`／`panel.js` 接受 `seed`（`identityFromSeed`），Hub 用 `HUB_SEED`；搭配 #35 的「同 DID 重註冊沿用既有 stats」，重啟後餘額與信用額度歷史都延續。**測試時發現身分穩定並不夠**：agent 自己的餘額檢視仍從 0 開始，而策略引擎（FR-055 區間、還債模式）與 `planPurchase` 都讀它——帶著真實負債重啟的 agent 會以為自己在 0、不進入還債模式、並高估可支用額度。Hub 現在於註冊回應中交還 `balance_cc`／`stake_cc`／`settlements`，agent 採用之。實測：同 seed 重啟後 DID 與 −8.00 CC 餘額皆延續，Console 與 Hub 視角一致。**帳本 export→import 已交付**（W10 後半）：Hub 匯出完整帳務事件流（此前只有收據，而託管／沒收／金絲雀付款無法由收據推導——這正是 W10 揭露的缺口），`HUB_IMPORT` 讓第二排序器重建並**驗證而非信任**（逐筆驗簽、pubkey 自證、鏈重算、信用額度由 stats 重放，唯 checkpoint 需以 `hub_pub` 驗章）；`ledger-dump.js` 匯出、`demo-rebuild.js` 7 項斷言。竄改的匯出檔會使 Hub 拒絕啟動。**另加 `HUB_DUMP_PATH` 週期自動匯出**——export→import 交付後，試點 Hub 隨即在沒人執行 `ledger-dump.js` 的情況下下線，那本帳照樣丟了：需要人記得執行的災難匯出不是災難復原。自動匯出寫 temp 檔再 rename，崩在寫入中途不會留下截斷檔取代可用檔 |
| 18 | **P1** | 原登記：跨機 UDP 發現無法使用。**已證否**——`discovery-probe.js` 在原本失敗的那台實測：真實 hub_beacon 跨機抵達、簽章 OK、時差 1020ms（容許 60s），且 `resolve` 模式成功發現 Hub | **已撤銷**：登記本身有瑕疵——當初是從「機器 2 未出現在註冊清單」推論發現失敗，從未取得該機的 log，commit message 還寫入未經驗證的成因（AP isolation 等）。仍然成立的部分：`demo.js` 的發現檢查只驗同機、`af5836a` 宣稱「Verified on the real LAN」為錯誤陳述，該檢查已更名。診斷工具保留，若再發生可用 `listen`／`resolve` 定案 |
| 25 | **P1** | Verifier 費率 4%（#5 交付值）沒有模擬支持：`sim/amcn_sim` 完全沒有 Verifier agent | **已修**：模擬器加入 Verifier 族群（押注、收費、偷懶行為、金絲雀懲罰），`amcn_sim.sweep_verifier` 掃描 fee {0,2,4,6}% × canary {0,1,3,5}% × lazy {0,33}% 共 32 組。**4% 獲得支持**（與 #20 相反）：fee 0% 時驗證市場不存在（零收入）；4%＋canary 3% 下誠實者 56 天最低淨收 42.60 CC、偷懶者被抓率 62.5%、G3/G4/G5 全 PASS、成交率 97%、經手/押金比 1.17（≤3，滿足 #7）。CSV 在 `sim/out/sweep_verifier.csv` |
| 27 | **P1** | 金絲雀懲罰誠實者的一般能力誤差：零偷懶者情境下 fee 4%＋canary 3% 仍沒收 20.21 CC（占 verifier 收入 4.6%）。proposal-C 的「canary_failed 即沒收押注 10%」不區分誤差與作弊 | **已修**：改為門檻式——需先看過 `slash_min_samples`（預設 5）個金絲雀，且失敗率 ≥ `slash_threshold`（預設 25%）才沒收。實測完美分離：誠實 7 位失敗率 **2/77 = 2.6%、沒收 0.00 CC**；偷懶 2 位失敗率 **10/16 = 62.5%、沒收 21.79 CC**。偵測率不受影響（仍 62.5%），門檻在 0.10–0.60 之間結果一致（安全帶寬）|
| 36 | **P0** | commit-reveal 的揭示流程會**永久放棄**合約：寬限計時器（1500ms）觸發時若承諾不足 2 份即記錄後返回、不重試；而唯一的另一個觸發條件是「panel 全員都承諾」，因此最後只湊到 2 份承諾的合約永遠不會揭示，結算靜默卡住。只在真實跨機延遲下出現——localhost demo 的承諾一定在 1500ms 內到齊。實測：Windows panel 上線後 16 次 `cannot reveal`、21/39 筆任務未結算 | **已修**：計時器只標記「寬限期已過」而不再放棄；「寬限期已過 ＋ 達到 quorum」成為獨立觸發條件；寬限期改為可設定（`policy.revealGraceMs`，預設 3000ms）|
| 37 | **P1** | 空 pool 讓 judge-quorum 靜默降級為零驗證：`validateSchedule` 的 quorum 檢查包在 `if (panelDids.length)` 裡，pool 為空時整段跳過，收據便以 judge-quorum 名義在**沒有任何 attestation** 的情況下通過，帳本記錄成 quorum 結算。惡意 requester 只要釘住空 pool 即可繞過驗證。發現時機：查「無 verifier 在線時 12 筆任務為何全部卡住」 | **已修**：Hub 要求 judge-quorum 的 pool ≥ `PANEL_SIZE` 否則拒絕結算；Agent 端也拒絕在 pool 不足時得標（否則會產生永遠無法結算的合約，而 log 完全看不出原因——那 12 筆就是這樣）|
| 38 | **P1** | 「從收入託管押注」（#28 的資金模型）使**新身分幾乎沒有東西可失**：實測偷懶者累積 0.288 CC 押注、被沒收 0.288 CC，而 `SLASH_FRAC × STAKE_TARGET = 0.5 CC` 根本取不到——沒收上限是已累積的押注，所以全新身分可以先抽費一段時間才開始有代價。這是 earn-your-stake 的內生性質，也是一個 Sybil 角度：棄置身分重開比累積押注便宜 | 未修。選項：(a) 要求最低押注才能進 panel（回到 pay-to-play，原型辦不到）；(b) 以未實現收入為抵押（未託管的費用先凍結）；(c) 押注未達標前降低 panel 選中機率。需以模擬決定 |
| 39 | **P2** | `demo-canary.js` 證明的是**機制**（偷懶被辨識、押注被沒收、誠實者未受罰），不是**威懾充足性**：原型中「偷懶」不省下任何成本（mock adapter 無論如何都是即時的），所以無法回答「罰款是否大於作弊收益」。該問題只能由模擬器回答（目前：偵測率 72–87%）| 未修，屬定義問題而非缺陷。已在 demo 檔頭與此處註明，避免把機制驗證誤讀為經濟結論 |
| 35 | **P0** | Hub 沒有任何斷線處理，`agents` 只增不減——因此**離線的 Verifier 仍會被抽選**：panel 由合約時釘住的 pool 推導，選到已消失的 verifier 就永遠拿不到 attestation，低於 2 份可歸責 PASS 即拒絕結算，網路靜默卡死。發現時機：要把 panel 從機器 1 搬到 Windows 機器（#31），停掉舊 panel 會讓 pool 變成「6 個裡 3 個是死的」，多數 panel 的 quorum 將不可能成立 | **已修**：socket `close` 時標記 `online = false`（不刪除——stats 餵信用額度，刪掉會讓重連後標準歸零而餘額留存），`list_verifiers` 只提供在線者，同 DID 重新註冊時沿用既有 stats。已簽署合約仍可能含離線成員，但 2-of-3 容許一個 |
| 33 | **P0** | 協議訊息完全沒有版本欄位，混版節點以**崩潰**而非拒絕收場。實測：pre-W9 provider 收到 W9 合約後在 `c.verifiers.length` 拋例外並死在合約中途 | **已修**：`lib/wire.js` 定義 `PROTOCOL_VERSION`，`sendLine` 在信封層自動蓋上 `v`（呼叫端無法漏），`attachLineReader` 拒絕版本不符或無版本的 frame 並給出「請所有機器一起升級」的可操作訊息。**刻意放在信封層而非簽署內文**——`receipt`／`contract`／`pre_auth` 的簽章是對那些物件本身計算的，加欄位會讓所有既有簽章失效且需雙方就位置達成一致；信封是未簽署的轉發 metadata，本來就是版本協商該待的地方。Hub 與 Agent 啟動 log 都顯示版本；`demo.js` 有 v99 被拒＋v1 正常的斷言 |
| 34 | **P0** | #13 的 frame 層 try/catch 只接住**同步**拋出。`agent.js` 的訊息 handler 是 `async`，任何 async throw 都變成 unhandled rejection 並殺掉進程——#21 只針對 adapter 那一條路徑修，通用情況一直開著。#33 的崩潰就是這個機制放大的：一個欄位不存在，整個 agent 死在合約中途 | **已修**：`attachLineReader` 對 handler 回傳的 promise 掛 `.catch`，async throw 降級為 `[wire] dropped frame`。單元測試：async handler 拋例外後進程存活且後續 frame 正常處理 |
| 32 | **P2** | `configs/verifier.example.json` 從第一個 commit 就在版控裡，但 `verifier.js` 只讀 `AGENT_CONFIG` 環境變數——沒有任何程式路徑能載入那個範本。連帶後果：每個 Verifier 都必須用 shell 引號的 JSON 啟動，而 bash 的單引號形式在 PowerShell 不成立，Windows 機器實質上無法照文件操作 | **已修**：`verifier.js` 與 `agent.js` 採同一套解析（env 優先，否則讀 `process.argv[2]` 指定的檔案）；範本改為 `verifier-{1,2,3}.example.json`，INSTALL 第 6 節附 PowerShell 指令 |
| 31 | **P1** | 試點的三個 Verifier 全部跑在機器 1：同一台機器、同一個 OS、同一個 process owner、同一個故障域。因此「panel of 3 verifiers」與「2-of-3 quorum」在**部署層級上是裝飾**——單一機器故障或單一 Owner 被入侵即可同時控制整個 panel，而 FR-041 的隨機抽選正是為了防這件事。`demo.js` 與 `demo-autonomous.js` 同樣把全部角色跑在一台 | 未修。需把 Verifier panel 分散到獨立的機器／Owner；試點若有第三台機器，最高價值的用途就是承載 panel 而非再開一個交易 Agent |
| 28 | **P2** | 押注並未真正託管：slashing 取 `min(押金×10%, 餘額)`，導致威懾強度與費率耦合——費率越低威懾越弱，這是實作產物而非設計意圖 | **已修（node 端）**：新增 `protocol:stake` 帳戶，每筆驗證費按 `HUB_STAKE_ESCROW_FRAC`（預設 50%）託管至 `HUB_STAKE_TARGET_CC`（預設 5 CC）為止。**設計決定並非照抄提案**：proposal-C 假設 verifier 先繳押金，但原型中 verifier 起始 0 CC 且無信用額度，「先繳後做」不可能；改為從收入累積——新 verifier 風險小、收入也少，靠工作累積到完整地位，與信用額度同構。託管走獨立的 posting set（不折進收據，因為收據是雙方簽署的內容，Hub 不得事後改動），且是收據流的**確定性函數**，所以 §20-4「可由簽署事件重建」仍成立——`demo.js` 的重建套用同一條規則後通過。模擬器端仍為舊模型 |
| 29 | **P2** | 金絲雀比例的單位與提案不符：proposal-C §7 指定占**全網量** 2–5%，模擬器的 `canary_rate` 是每 tick 注入機率，實測只產生 0.5–1.3% | **已修**：`canary_rate` 改為「占結算量的目標比例」，注入以該比例為控制目標（含抖動避免可預測的節奏）。實測追蹤精確：2%→2.00%、3%→2.99%、5%→4.99%。**代價被揭露**：按提案真正的比例，金絲雀從約 12 筆增至 72–176 筆、沒收從 22 CC 增至 106–120 CC——提案的設定比模擬器原本的行為激進得多 |
| 30 | **P2** | 偷懶者被抓率與 pool 大小強耦合，9 個 Verifier 的數字不可外推 | **已修（並推翻原本的擔憂）**：修好 #29 後金絲雀**絕對數量隨網路量成長**，pool 放大到 90 時每人仍看到 6.4 個樣本，偵測率維持 72%（pool 9/30/90 分別 71%/87%/72%）——#8「抽查率撐不起威懾」在「占量比例」的定義下不成立。但揭露了新問題：pool 90 時每人樣本僅 6.4，25% 的比例門檻在小分母上失去統計意義，誠實者被沒收回升到 25.85 CC，**#27 的修復在規模化時自我失效**。已加上絕對失敗次數要求（`slash_min_failures = 3`），誠實者誤罰降到 4.55 CC （pool 9/30 為 0.00），偵測率不變。**縮放律**：每人樣本 ≈ 金絲雀數 × panel_size ÷ pool_size，故 `canary_rate` 必須隨 pool 規模上調才能維持證據門檻——大型網路不能沿用小池子的比例 |
| 26 | **P2** | Verifier 報酬按**推導出的 panel** 均分，而非按實際出具 attestation 者。2-of-3 quorum 成立時，缺席的第三位仍領到報酬 | **已修**（W9 commit-reveal）：Hub 只付給「揭示內容能開啟事前簽署之承諾」的 verifier（`validAttesters`），沉默者零收入；少於 2 份可歸責的 PASS 即拒絕結算 |
| 24 | **P0** | 未來-checkpoint 抽選的 bootstrap 死鎖：週期 checkpoint 原本以 `if (chains.size)` 為條件，而 `chains` 只在第一筆結算後才有內容。全新網路若第一筆任務就要 quorum，種子 checkpoint 永不產生 → 無法驗收 → 沒有第一筆結算。`demo.js` 未踩到（第一筆是 `dsl-local`），只有 `demo-autonomous.js` 全 quorum 才暴露 | **已修**：無條件鑄造 checkpoint（空 heads 的 checkpoint 完全合法，root = hash of `{}`）|
| 21 | **P0** | `agent.js` 的 `provide` 若沒有可解析的 adapter，得標後才在 `adapter.complete(null, ...)` 崩潰——而合約當時已雙簽，requester 只能等強制結算。同一個 await 在 async handler 內，**任何** adapter 錯誤（含真實端點回 500）都會變成 unhandled rejection 殺掉整個 agent | **已修**：無 adapter 則不武裝供給（不能執行者不得出價）；執行失敗改為記錄並標記合約 `failed`，不再毀掉進程 |
| 22 | **P1** | `agent.js` 出價完全不檢查自己剩餘額度，可以賣出根本沒有的算力。模擬器 `collect_offers` 一直有 `remaining_quota < 1.0` 守門，node 端沒有——W8 的無人運行才暴露（額度模型存在但不約束供給側） | **已修**：出價前要求 `quota.remaining >= units`，得標時扣除；Console 新增 `sold_units` |
| 23 | **P2** | 選標同價時以到達順序決勝（`bids.sort` 為穩定排序），使先啟動的 Agent 在同質價格市場中系統性勝出。三節點 demo 中最後啟動者永遠拿不到單，是啟動順序而非市場性質 | 未修。選標是 requester 自身職權（FR-012），先到先服務可辯護，但同質市場會產生贏者全拿。建議改為以 `sha256(contract_id + did)` 決勝（驗收 panel 抽選已用同一手法）|
| 20 | **P1** | W7 的還債策略參數三處不一致：還債折價 proposal-B §8.4 寫 10%、`sim/amcn_sim/market.py` 一直用 35%、node 原型照提案實作 10%；band 下界 §8.4 寫 −0.3×CL、模擬器用固定 −5.0 CC；band 上界 §8.4 寫 +100、模擬器用每 agent `uniform(30,120)`。同 #1「新戶信用額度數字三處打架」的形態 | **已修**：`amcn_sim.sweep_repay` 掃描 折價 {0,10,20,35,50}% × band {fixed, −0.15CL, −0.30CL} × {baseline, high_default} 共 30 組。結論：**折價 35% ＋ band 下界 −0.15×CL**。§8.4 的兩個數字都被推翻——10% 在 high_default 下 G3 全滅（壞帳 6.5–7% > 保險收入 4.6–4.7%），−0.30×CL 每個折價檔都 G4 FAIL（還債週期 33–40 天）。35% 勝過 50% 在還債週期（14d vs 25d）與末週價（0.69 vs 0.53，50% 壓垮價格 41%）。node `lib/strategy.js` 與模擬器預設均已對齊，CSV 在 `sim/out/sweep_repay.csv` |
| 40 | **P0** | **沒有任何重連機制**：`resolveHubTarget` 只在啟動時解析一次，`dialLazy` 取得 channel 後不再管它。Hub 一消失，`chan.send()` 只回傳 `false`，而所有呼叫端都忽略回傳值——agent／verifier／canary 從此**靜默失聯**：不重連、不重新發現、不出聲，Console 仍顯示最後已知餘額。發現時機：評估 W10 拔線演練可行性時追「Hub 被拔線後 agent 會怎樣」。連帶後果：#14 交付的「發現與輪替」在運行期不可用——輪替只有在**所有進程同時重啟**時才生效，而這正是輪替該避免的事；#19 的「WARNING: not connected」只覆蓋啟動期，斷線後不會再說話 | **已修**：`dialLazy` 改為持有**解析函式**而非一次性 promise，每次重連都重新解析目標——所以 `hubHost: "discover"` 會重新聽信標，搬移過的 Hub 不改設定檔就會被跟上（#14 的輪替第一次在運行期成立）。退避 500ms→15s（±20% 抖動，否則整個 panel 會同步重試）、斷線與重連都有 log、重連時呼叫 `onOpen` 重發 `register` 並重新索取 `list_verifiers`（pool 與 checkpoint lock 在離線期間都動過）。**離線期間的送出改為丟棄並記數，不排隊**——原本計畫排隊，但沒有任何協議物件帶有效期（另案登記），長時間離線後重播一批過期的 bid 與 attestation 比丟掉更糟，而且在要跑數小時的進程裡無界緩衝本身就是缺陷；關鍵是「丟棄」現在會被計數並在重連訊息中報出，而非隱形。`demo-reconnect.js` 8 項斷言：SIGKILL 掉 Hub、6 秒後以同一 seed 從自動匯出重啟，六個 client 全部自行重連、重新註冊、餘額延續（實測 A 的 −5.93 CC 未歸零）、並在接手的 Hub 上產生新結算——全程無人重啟任何進程。**修的過程自己踩到兩個坑**：(a) 重試計時器原本 `.unref()`，而 Verifier 除了那個 socket 沒有任何 handle 撐住事件迴圈，於是 Hub 一死 verifier 進程就靜默結束——正是試點那個「panel 消失」的失敗換一件衣服；(b) 移除連線前排隊後，`canary.js` 模組載入時就送出的 `list_verifiers` 被丟棄，金絲雀因此看到空 pool——所以「重連要重建哪些狀態」必須明列，不能靠隊列補 |
| 49 | **P0** | **註冊是射後不理**：`register` 送出後沒有任何確認機制。故障注入下的實際後果：一個 verifier 在靜默中斷期間重連成功（TCP 連上了），它的 `register` frame 被丟棄；故障解除後雙方的活性 ping 開始互通，於是兩端的閒置計時器**再也不會超時**——連線活著、雙方都報健康，而 Hub 完全不知道對方是誰。那個 verifier 永久隱形，pool 停在 2 位、低於 `PANEL_SIZE`，Agent 因此拒絕得標（#37），全網停止成交。發現方式：`panel-blackhole` 情境在修好 #48 之後仍然「恢復後無成交」，逐一比對三個 verifier 的 log 才看出 V1 在某個時刻之後完全靜止——**這種比對只有在 log 落地時做得到**，也是 chaos-run 把每個子行程輸出寫檔的理由 | **已修**：`dialLazy` 新增 `ackType`，把註冊變成需要確認的握手——送出後若在 `handshakeMs`（預設 5s）內沒收到 `registered` 就重送，直到收到為止，並記錄「連線已建立但匿名」。一個丟失的 frame 本來就足以造成這個狀態，而丟包只需要做到這件事 |
| 48 | **P1** | **VERIFYING 沒有任何逾時**：合約在驗收階段卡住時，requester 與 provider 都會無限期持有它。實測（`panel-blackhole`）：panel 連線被靜默切斷期間得標的合約全部永久開啟——三個 Agent 各累積 12–18 筆，最舊的 155 秒且持續成長，因為 `verify_request` 送進虛空而沒有任何重試。連帶後果：`asRequester`／`asProvider` 兩個 Map 只增不減，長時間執行即記憶體洩漏。§2.3 第 1 點要求「VERIFYING 逾時的備援 Verifier 與 default 分支」，原型一項都沒有 | **部分已修**：requester 在 `verifyTimeoutMs`（預設 15s）後重送 `verify_request`，重試 `verifyRetries`（預設 2）次後放棄——標記合約結束、計入 Console 的 `abandoned`、並印出明確原因；provider 端有對應的放棄計時器。**刻意只做有界的那一半**：panel 由釘住的 pool＋種子推導，重試打到的是同一批（可能已死的）verifier，真正的修法是 §2.3 的**備援 panel（改用後續 checkpoint 重新推導）**，那需要 Hub 端配合驗證新種子，屬協議變更。放棄時 provider 已完成工作卻拿不到報酬，這是目前的誠實代價，log 明說 |
| 47 | **P1** | **時間常數以 loopback 校準**：選標視窗是固定的 500ms。在 80ms±40 的跨地點延遲下（兩端各注入一次，單跳約 160ms），task→bid 來回就要 320ms＋抖動，於是**每一筆任務都 `no bids`**——同一個拓撲無延遲時 60 秒成交 27 筆，加上延遲後 90 秒成交 **0** 筆。與 #36 同型（1500ms 寬限期在真實延遲下卡住），但後果更糟：不是卡住而是市場根本不存在。而 Owner 裁定的驗收環境正是不同地點的機器（見 §7 於 fault-injection-plan）| **已修**：選標改為事件驅動而非猜測——bid 停止到達 `bidQuietMs`（預設 250ms）後才決標，但不早於 `bidWindowMs`（500ms，所以區網行為不變）也不晚於 `bidWindowMaxMs`（3s）。「必須同時適用於 loopback 與 WAN 的常數」這種東西應該被移除而不是重新調校。`forceAfterMs` 與 `verifyTimeoutMs` 也一併變成 `policy.timing` 可設。實測修後同條件 90 秒 **33 筆** |
| 46 | **P0** | **靜默中斷時雙方都是瞎的**：連線被靜默切斷（封包被丟棄、連線不關閉）時，Hub 與 client 都察覺不到任何事。實測：注入 `blackhole` 後 120 秒，Hub 仍回報 3 位 verifier 在線、`list_verifiers` 持續把死掉的 pool 交給 Agent、Hub 零次偵測、verifier 也零次自認斷線（所以 #40 的重連永遠不會觸發）。後果比「全網停止成交」嚴重：Agent 會得標 judge-quorum 合約、把 verify_request 送進虛空、永遠拿不到 attestation——**合約產生了但永遠無法結算，且沒有任何一行 log 說明原因**，正是 #37 註明「最難查」的那個狀態。#35 只處理乾淨關閉；三台機器試點的情境 A 想測這個，但關 Wi-Fi 時 OS 送出 RST，兩秒就被偵測，測到的其實是乾淨關閉 | **已修**：`lib/channel.js` 加對稱的應用層活性——閒置就送 `ping`（預設 5s），對方靜默超過 `IDLE_TIMEOUT_MS`（預設 20s）即視為消失並關閉 channel。Hub 端關閉＝標記離線（#35），client 端關閉＝開始重連（#40），一份實作同時服務兩個方向與兩種傳輸。**刻意不用 TCP keepalive**：node 的 `setKeepAlive` 只設閒置時間，探測間隔與次數由 OS 決定（macOS 預設換算下來約十分鐘），而且它看不見「socket 活著但應用層卡死」的對手。`ping` 不進 `rawLog`（否則會膨脹每一份匯出，見 #41）。實測修後偵測時間 **20–25 秒**，兩邊皆然。**發現方式本身是這次的重點**：由 `lib/transport-chaos.js` 自動注入，不需要任何人拔線 |
| 45 | **P1** | 「協議內發現與輪替」只在區網成立：`lib/discovery.js` 是 UDP 廣播信標，跨網段／NAT／公網一律聽不到。Owner 裁定第一個可運行版本的驗收環境是**不同地點的多台機器**，那個環境裡 `hubHost` 只能是固定的公開位址——於是搬移 Hub 又變回「每台手改設定」，正是 #14 要消滅的事。§2.1 允許 Transport 中央化的三個條件之一因此在目標環境中不成立 | 未修。選項：(a) 以簽署的 rendezvous 記錄（DNS TXT／HTTPS 端點／靜態檔）發布 Hub 位址與 DID，client 週期性重新解析——`dialLazy` 每次重試都重新解析（#40），所以介面已經就位；(b) 多個候選位址寫進設定，pin 決定信任哪一個，輪替＝換位址但同 seed；(c) SDD §6 的 Relay Node。(a) 最小，且與 `hubPin` 的信任模型一致 |
| 44 | **P1** | 傳輸層無任何加密。訊息有簽章、payload 有 E2E（NFR-005），但**信封 metadata 是明文**：誰跟誰交易、金額、時間、acceptance 方式、DID 全都在線上可讀。在受信任區網可接受（INSTALL §8 明確這樣寫），但 Owner 裁定驗收環境是不同地點的機器——流量會經過公網，§16 威脅 9「Metadata 洩露 Owner 身分、工作內容或模型使用習慣」就對任何路徑上的觀察者完全敞開 | 未修。W10 抽出的 `ITransport` 讓它變成新增一個實作而非改造既有的：`transport-tls`（`node:tls`＋自簽憑證，以 `hubPin` 同型的釘選建立信任，零相依）。注意這**不取代**簽章與 E2E——那兩層防的是 Hub 本身，TLS 防的是路徑上的第三方。兩者都需要 |
| 43 | **P2** | 跨平台診斷不存在：機器 2（Windows）連不上時，唯一的排查方式是逐條貼 `grep`／`nc`／`curl` 的輸出，而那些指令在 Windows 上不存在——與 #32（Verifier 需要 shell 引號 JSON）同一類問題，同一個根因：文件與工具預設了 Unix | **已修**：`pilot-doctor.js` 只用 node，三台都能跑，一個指令依序檢查 node 版本、本機位址是否與 Hub 同網段（跨 VLAN／訪客網路／VPN 是最難從錯誤訊息看出的原因）、設定檔 JSON 合法性與它實際指向哪、是否有固定 seed、TCP 可達、**AMCN 協議層可達**（送 `export` 並等回應——埠開著不代表協議通，傳輸實作不同或版本不符只會在這一關現形）、UDP 信標是否聽得到，最後指出第一個 FAIL 作為最可能原因 |
| 42 | **P2** | 長時間執行的 log **沒有任何時間戳**。發現時機：三台試點的 panel 掉線後，唯一可用的時間線索是 log 檔的 mtime。所有 demo 只跑 15–35 秒，順序就夠用、時鐘是雜訊——但 W10 演練要量的核心數字正是「多久才發現斷線」與「接手花了多久」 | **已修**：`lib/log.js` 在 hub／agent／verifier／canary／panel 安裝 UTC ISO-8601 前綴。**刻意包裝 console 而非逐一改呼叫端**：斷線時最關鍵的那幾行來自 `lib/channel.js` 與 `lib/transport-*.js`（`socket error`／`disconnected`／`reconnected`），應用層 logger 碰不到它們。用 UTC 是因為演練要跨三台機器對時間軸，本地時間會在最糟的時刻引起時區或日光節約的爭論。demo harness 刻意不安裝——它們的輸出是要被比對的驗收報告，不是時間軸。`AMCN_LOG_TIME=0` 可關閉 |
| 41 | **P1** | 自動匯出的成本隨歷史無上限成長，且 `HUB_DUMP_PATH` 每次都重寫整份匯出（`JSON.stringify` 整段歷史，在事件迴圈上阻塞）。所有 demo 只跑 15–35 秒，這個量級從未被觸及 | 未修，但**成因已量測，且推翻了本欄原本的假設**。原記：主因是 `rawLog`（保留每一行、供 NFR-005 明文掃描），依據是 `demo.js` 9 秒累積 38.5 KB。真實試點（三台、慢 33 倍節奏）實測 **1 小時後 718 KB，其中 0 筆收據、0 筆事件、`raw_log` 僅 1,664 bytes、checkpoint 3,246 個**——主因是**週期性 checkpoint**，與交易量完全無關：`CHECKPOINT_MS` 預設 1200ms，即每小時約 3,000 個，閒置也照長。推估：一天約 17 MB、一個月約 500 MB，而且每個 dump 間隔重寫一次。教訓與 #39 同型：demo 尺度的量測外推到試點尺度時，連「誰是主因」都會錯。修法不能是「閒置就不鑄造」——#24 的 bootstrap 修復正需要 checkpoint 無條件產生，否則未來-checkpoint 抽選的種子永遠不會到。選項：(a) dump 改增量；(b) 匯出只帶最近 N 個 checkpoint＋一份簽署摘要，完整歷史另存；(c) 調高 `HUB_CHECKPOINT_MS`——但它同時是 panel 種子的等待時間，調成 12s 會讓每筆 judge-quorum 任務的驗收最多延後 12s，**帳本成長與驗收延遲是同一個旋鈕的兩端**，這個耦合先前沒人注意到 |
| 19 | **P2** | `now providing` 由 `agent.js` 的純計時器觸發，不檢查 Hub 連線狀態：一個從未註冊成功的 agent 在 `provide.afterMs` 後照樣印出該行。試點中因此誤判機器 2 已上線 | **已修**（W7 `d821eca`，本表一度漏標）：改為 `supply armed at N CC/unit, strategy X`，並在沒有 hub socket 時附 `WARNING: not connected to a hub yet`。試點重啟時實測有效 |

---

## 5. 12 週整合實作計畫

| 週 | 交付物 | 來源 |
|---|---|---|
| W1–2 | 重算三張攻擊成本表（統一幣值錨定）；收據/合約/attestation schema v1 凍結（含 tx_class、Verifier posting、pre_authorization）；`sim/amcn_sim` 換裝 INV-C1＋E_eff 公式 | C 修正＋B §9 |
| W3 | **GATE-0**：全量模擬過八判準（壞帳率、還債週期、洗量 CL 壓制、到期崩價幅度…），經濟參數凍結。不過門檻即回 W1 調參，不得帶病開工 | C §17 |
| W4–5 | Local Node（TS）：Keystore（OS Keychain）＋雙程序 Key 隔離＋Provider Adapter＋政策引擎；Hub：排序器＋hash chain＋checkpoint | B §13 |
| W6 | **首次真實閉環**：3 節點、A 借 B 還，deterministic 驗收，帳可重建 | §20 驗收 1/2/4/7 |
| W7 | 還債排程器＋目標餘額區間策略；MCP server 需求側入口（3 tool） | B §8.4/§23.1 |
| W8 | **完整借用＋自動還債 demo**（§27 閉環全程零人工） | §20 驗收 3/8 |
| W9 | 驗證市場最小版：3 人 Judge quorum＋未來-checkpoint 抽選＋commit-reveal＋金絲雀（重算後預算）；爭議單次上訴 | C §7 修正版 | **原型現況**：未來-checkpoint 抽選、commit-reveal、Verifier 報酬入帳、押注託管、金絲雀＋門檻式懲罰皆已交付並有斷言。**爭議單次上訴延後至 Phase 2**：現行驗收是確定性 DSL，裁決可計算、爭議由重算解決，上訴沒有可仲裁的對象；判斷性驗收（LLM judge）依 SDD §19 在 Phase 2，屆時才有意義。|
| W10 | **強制里程碑（不可砍）**：第二 ITransport 實作＋帳本匯出重建＋官方基礎設施拔線 4 小時演練 | B §13.3＋A §18 | **原型現況**：帳本匯出重建已交付（`demo-rebuild.js`，7 項）；第二 ITransport 實作已交付（`demo-transport.js`，7 項——tcp 與 http 同一本帳）。**拔線 4 小時演練未做**，它需要真實時段與多台機器，不是程式碼能自證的部分。程式碼前置已備齊（#40 重連、#42 時間戳），秒級預演 `demo-reconnect.js` 8 項斷言通過 |
| W11 | 紅隊：50 案例（含 P0/P1 登記簿全部攻擊重放）；洗量/Sybil 模擬對照真實 CL 曲線 | B §17＋C §10 |
| W12 | 10–20 節點封閉試點；輸出 §20 十項驗收證據包與市場指標（成交率、供需深度、違約率、平均還債時間） | §20 驗收 5/6/9/10 |

**團隊**：4.5–5.5 FTE（B 案編制＋0.5–1 FTE 經濟模擬專職——評審認定 B 案原編制超載 40–60%，模擬與紅隊不得掛在同一位 QA 身上）。

---

## 6. 仍然不知道的事（不得假裝已解決）

繼承三案「現在不知道」章節的交集，這些不是架構能解的，只能用實驗證偽（SDD §26）：

1. **需求側意願**（§26-1）：額度用完的人是否願意承擔未來服務義務——W8 demo 後的封閉試點是第一個數據點；MCP 入口是最便宜的證偽工具。
2. **供應商 ToS**（§26-3）：任何提供者條款變更可使供給瞬間萎縮；架構只能降低（本機開源模型 fallback）不能消除。上線前需逐家法遵判讀。
3. **議價 Token 摩擦**（§26-7）：全 Agent 議價的推理成本可能吃掉 2–10% 任務價值（A 案爆點 1）；MVP 用規則式定價引擎壓低，學習型議價延後。
4. **正餘額效用**（§26-6）：正 CC 是否有足夠可花之處，還是終將倒逼現金兌回——這是對 P-04 的長期壓力測試，試點期監控「正餘額週轉天數」。
5. **模型身分證明**（§21-Q6）：三案一致承認無密碼學證明 Provider 用了宣告模型；整合方案是金絲雀＋統計偏離懲罰，其威懾力依賴抽查預算（P1-7/8 修正後仍是估計值）。

---

## 附錄：評選過程工件

- 提案：`docs/proposals/proposal-{A,B,C}-*.md`（各約 1,500 行，§22 十八項交付物）
- 獨立評審報告：`docs/evaluation/reviews/review-{A,B,C}.md`；其矛盾清單已整編為本文件 §4 登記簿
- Phase 0 模擬器：`sim/amcn_sim/`（守恆、還債閉環、四情境）
