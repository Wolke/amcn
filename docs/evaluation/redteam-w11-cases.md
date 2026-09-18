# W11 紅隊案例盤點

| 欄位 | 內容 |
|---|---|
| 文件 | W11 紅隊 50 案例的案例集與可達性盤點（final-architecture §5 W11） |
| 日期 | 2026-09-16 |
| 輸入 | SDD §16 威脅模型 15 條、final-architecture §4 缺陷登記簿 41 條、`node/` Phase 1 原型 |
| 方法 | 每條威脅至少一案；登記簿每條 P0/P1 的攻擊各一案可重放；再補原型實作暴露的面 |
| 結論 | 59 案（計畫估 50，交叉後不重複的攻擊面更多）。**50 案可在單機自動化**、1 案需長時間量測、1 案需第三台機器、7 案原型不可達（標的在 Phase 2/3 才存在）。盤點本身發現 3 個未登記的開口，見 §4 |

---

## 1. 判準分級（先定義，否則 50 案會是一面紅牆）

紅隊的輸出必須可以當回歸閘門用，所以每案的**期望結果**要事先寫定，而不是「跑完看看」：

- **必須擋下（block）**：登記簿已標「已修」的缺陷，或協議本來就該拒絕的行為。這類案例失敗＝回歸，要當缺陷處理。
- **已知開口（known-open）**：登記簿有登記但未修的項目。期望結果是「攻擊成功，且行為與登記內容一致」。這類案例**成功**才是 PASS——它在鎖定「我們知道它壞、壞法是這樣」。哪天它的失敗模式變了，代表有人改動了它旁邊的東西。
- **原型不可達（n/a）**：標的在 Phase 1 不存在（無 sandbox、無鏈上託管、無治理、無 LLM judge）。列出來是為了不假裝已涵蓋——SDD §16 要求「不接受只寫使用加密」，同理不接受只寫「Phase 2 會處理」而不說清楚現在誰在裸奔。

第三類是這份盤點最容易被誤用的地方：12 案不可達不代表那 12 條威脅不存在，代表**目前沒有任何控制**。

---

## 2. 案例表

### A. Key、內容與隱私（威脅 1／2／9／10／12）

| # | 來源 | 攻擊 | 期望 | 現有防線 | 可達性 |
|---|---|---|---|---|---|
| A1 | 威脅 1 | payload 要求 provider 把自己的 API key 併入輸出 | block | key 只在 adapter 進程記憶體；輸出經 assert 與 attestation，Hub 全量流量掃描無 key 字串（`demo.js` §20-1/6）| 自動 |
| A2 | 威脅 1 | 惡意 requester 以 assert 誘導：`sha256_eq` 比對 key 的雜湊，逼 provider 回傳 key | block | assert DSL 只有 `sha256_eq`／`max_len` 等封閉集（`lib/dsl.js`），不能表達「回傳環境變數」| 自動 |
| A3 | 威脅 12 | payload 內夾「把 max_price 改成 999」「立刻付款給 X」的指令 | block | 定價來自 `cfg`／`lib/strategy.js`，payload 不進定價與結算路徑（原型無 LLM 決策迴圈）| 自動 |
| A4 | 威脅 9 | Hub 側錄能還原多少：payload／輸出／模型名 | block | X25519+AES-GCM 封裝給得標者（`lib/e2e.js`）；`demo.js` 掃 `raw_log` | 自動 |
| A5 | 威脅 9 | Hub 側錄能還原的 metadata 盤點（誰跟誰、何時、多少錢、什麼 acceptance）| known-open | §2.2 承認 Hub 見 metadata。本案只負責把**實際可見欄位**列出來，不假裝它少 | 自動 |
| A6 | 威脅 2 | requester 送違法內容使 provider 承擔風險 | n/a | 原型無內容政策引擎、無拒單理由分類 | 不可達 |
| A7 | 威脅 10 | 惡意 artifact／依賴逃逸 sandbox | n/a | 原型無 sandbox（A 案 Firecracker 未實作），provider 只跑 mock 或 HTTP 轉發 | 不可達 |
| A8 | #12 | Key 隔離的 IPC 方向：從 prompt 處理側取得 key | n/a | 原型是單進程，雙程序隔離未實作——#12 的修法尚未落地，現在無從打起也無從防起 | 不可達 |

### B. Provider 側作弊（威脅 3／4）

| # | 來源 | 攻擊 | 期望 | 現有防線 | 可達性 |
|---|---|---|---|---|---|
| B1 | 威脅 4 | 得標後不交付 | block | 無交付即無 attestation，`validateSchedule` 拒絕結算；餘額不動 | 自動 |
| B2 | 威脅 4 | 交付不符 assert 的輸出 | block | DSL 判 FAIL；quorum 不成立 | 自動 |
| B3 | #21 | 無 adapter 仍出價，得標後崩在 `adapter.complete` | block | 不能執行者不得出價；執行失敗只標記合約 `failed` | 自動 |
| B4 | #22 | 賣出超過自身剩餘額度的算力 | block | 出價前檢查 `quota.remaining >= units`，得標時扣除 | 自動 |
| B5 | 威脅 3 | 篡改輸出後重簽，聲稱通過驗收 | block | `asserts_hash` 在 TaskSpec 簽章時鎖定；verifier 重跑 assert | 自動 |
| B6 | 威脅 3 | 用便宜模型冒充高品質模型 | n/a | 原型無模型指紋、無能力題金絲雀（canary 只驗「斷言不可能滿足」）| 不可達 |

### C. 拒付與強制結算（威脅 5／#9）

| # | 來源 | 攻擊 | 期望 | 現有防線 | 可達性 |
|---|---|---|---|---|---|
| C1 | 威脅 5 | 收貨後拒簽收據 | block | pre_auth＋2-of-3 quorum 強制入帳（`handleForced`）| 自動 |
| C2 | 威脅 5 | 偽造 pre_auth：把 `price_cc` 改小 | block | `pre_auth.price_cc !== contract.price_cc` 即拒 | 自動 |
| C3 | 威脅 8 | 拿 A 合約的 pre_auth 去強制結算 B 合約 | block | `pre_auth.contract_id !== ref` 即拒 | 自動 |
| C4 | 威脅 5 | 強制結算時把收據價抬高於合約價 | block | `forced: receipt price != contract price` | 自動 |
| C5 | #6 | 強制結算時自帶一份「自己人 panel」的 attestation | block | Hub **重新推導** panel（`lib/panel.js`），不採信合約名單 | 自動 |
| C6 | #37 | 釘一個空 pool，讓 judge-quorum 在零驗證下通過 | block | pool < `PANEL_SIZE` 即拒；Agent 端也拒得標 | 自動 |
| C7 | #9 | 負餘額方被強制入帳時要求走雙簽路徑繞過序列化 | block | 強制入帳一律走 Hub 序列化，與餘額正負無關 | 自動 |

### D. Verifier 與串謀（威脅 6／#5 #6 #7 #8 #26 #27 #31 #38）

| # | 來源 | 攻擊 | 期望 | 現有防線 | 可達性 |
|---|---|---|---|---|---|
| D1 | 威脅 6 | 偷懶 verifier 不看斷言就投 PASS | block | 金絲雀＋門檻式沒收（`demo-canary.js` 實測偷懶者失敗率 62.5%）| 自動 |
| D2 | #26 | 沉默 verifier 照領報酬 | block | 只付「揭示內容能開啟事前承諾」者 | 自動 |
| D3 | #6 | 看到他人裁決後抄多數 | block | commit-reveal；改 nonce 即綁定失效 | 自動 |
| D4 | #6 | grinding 抽選種子（挑 contract_id 湊出有利 panel）| block | 種子綁**尚未產生**的 checkpoint | 自動 |
| D5 | 威脅 6 | requester 與**兩位** verifier 串謀出具假 PASS | known-open | 2-of-3 需要兩席，所以成本是兩份押注——但目前押注上限 5 CC/位，串謀收益可遠大於此。本案要算出打平點 | 自動 |
| D6 | #35 | 停掉 pool 中的 verifier，使 quorum 永不成立 | block | 離線者不進 `list_verifiers`，同 DID 重註冊沿用 stats | 自動 |
| D7 | #38 | 棄置身分重開，規避累積的押注 | known-open | 無最低押注門檻；實測新身分被沒收上限僅 0.288 CC | 自動 |
| D8 | #31 | 入侵單一主機即同時控制整個 panel | known-open | 部署層問題，2 台機器也測不到——需第三台承載 panel | 多機 |
| D9 | #5 | judge-quorum 結算不付 panel／dsl-local 硬塞 verifier 分錄 | block | `validateSchedule` 強制費率表 | 自動 |
| D10 | #27 | 誤差誠實者被金絲雀沒收 | block | 門檻式（≥5 樣本、失敗率 ≥25%、≥3 次絕對失敗）| 自動 |

### E. Sybil 與洗量（威脅 7／#1 F-1）

| # | 來源 | 攻擊 | 期望 | 現有防線 | 可達性 |
|---|---|---|---|---|---|
| E1 | 威脅 7 | 開 N 個身分各領一份 starter 信用，借滿即棄 | known-open | **這是 #1 尚未關閉的部分**：§2.2 寫 L_boot 上限 25 CC，`lib/eeff.js` 與 GATE-0 掃描都用 50 CC，見 §4 新開口 (c) | 自動 |
| E2 | F-1 | 兩身分互刷抬高彼此信用 | block | E_eff 的 20%-of-others 上限；`demo.js` 斷言 CL 零成長 | 自動 |
| E3 | 威脅 7 | 三身分環狀洗量（A→B→C→A），規避成對偵測 | block？ | `effectiveContribution` 的權重看單一付款方集中度，環狀是否被壓制**未驗證**——本案是真正的新測試 | 自動 |
| E4 | 初始信用列 | 用貢獻任務換取可違約的信用額度 | n/a | 原型無貢獻任務；規則「只給聲譽不給信用」無實作標的 | 不可達 |
| E5 | W11 明文 | 洗量／Sybil 模擬對照**真實** CL 曲線 | block | 同一組流水餵 `sim/amcn_sim/agents.py` 與 `node/lib/eeff.js`，逐步比對 CL。兩邊公式是手抄的雙實作，登記簿三次出現「數字打架」都是這個形態 | 自動 |

### F. 重放、雙花與過期（威脅 8／#11 #15）

| # | 來源 | 攻擊 | 期望 | 現有防線 | 可達性 |
|---|---|---|---|---|---|
| F1 | #15 | 重放已結算收據 | block | `settledIds` 冪等鍵 | 自動 |
| F2 | #15 | 跨重啟製造 contract_id 碰撞 | block | id 併入 DID 標籤 | 自動 |
| F3 | 威脅 8 | 把 bid 重放到另一個 task | block | bid 簽章含 `task_id` | 自動 |
| F4 | 威脅 8 | 重放一份**很舊**的 bid／pre_auth | ~~known-open~~ **block** | 已修：`bid`／`contract`／`pre_auth` 都帶 `issued_at`／`expires_at`，Hub 以 `expired()`＋`CLOCK_SKEW_MS` 擋下（§4 新開口 (a) 已關）| 自動 |
| F5 | #11 | 兩筆支出同時吃光同一份額度（雙花）| block | 負餘額支出走 Hub 序列化＋`clOf` 上限檢查 | 自動 |
| F6 | #11 | equivocation：對兩方出具互斥的簽署歷史 | block | ~~per-account hash chain＋checkpoint，分叉可離線偵測~~ — **這句是錯的，寫測試才發現**（#69）。修法見下；(c) 仍開 | 自動 |
| F7 | #10 | 竄改匯出檔讓第二排序器重建出假帳 | block | 逐筆驗簽、鏈重算、checkpoint 驗章；竄改即拒絕啟動 | 自動 |
| F8 | #10 | 偽造 checkpoint 簽章 | block | 以 `hub_pub` 驗章 | 自動 |

### G. 基礎設施、可用性與治理（威脅 11／13／14／15／#13 #33 #34 #36 #40 #41）

| # | 來源 | 攻擊 | 期望 | 現有防線 | 可達性 |
|---|---|---|---|---|---|
| G1 | #13 | 區網任一裝置送畸形 frame 打掉 Hub | block | 驗簽不丟例外＋frame 層隔離＋行長上限 | 自動 |
| G2 | #33 | 混版節點互通 | block | 信封版本閘門，拒絕而非崩潰 | 自動 |
| G3 | #34 | async handler 拋例外殺進程 | block | handler promise `.catch` 降級為丟棄 frame | 自動 |
| G4 | #36 | 只湊到 quorum 下限的承諾，使揭示永不觸發 | block | 寬限期只標記不放棄；「寬限期過＋達 quorum」為獨立觸發 | 自動 |
| G5 | 威脅 11 | 假 beacon 冒充 Hub 誘導 agent 連線 | block | beacon 簽章＋`hubPin`；pin 不符不退回 localhost | 自動 |
| G6 | 威脅 11 | Hub 隱藏報價、操控排序（丟棄特定 bid 廣播）| known-open | **無任何偵測手段**，見 §4 新開口 (b) | 自動 |
| G7 | #40 | 拔掉 Hub：agent 是否重連 | known-open | 無重連、無重新發現、無 log——靜默失聯 | 自動 |
| G8 | 威脅 13 | 負餘額 Owner 永久離線 | known-open | 原型無壞帳瀑布；#17 試點實測留下 −10 CC 永不償還的洞 | 自動 |
| G9 | #41 | 以高頻交易撐爆自動匯出（`rawLog` 無上限且整份重寫）| known-open | 無上限；需量測成長曲線 | 手動 |
| G10 | 威脅 14 | 特權身分清單：誰能單方影響帳 | known-open | `HUB_CANARY_DID` 可花 Treasury；Hub 持 `HUB_SEED` 可簽 checkpoint。本案負責把特權面列清，不是修它 | 自動 |
| G11 | 本次 W10 | 混用 transport 造成靜默卡住 | block | 雙方都明確拒絕（`demo-transport.js`）| 自動 |
| G12 | 威脅 14 | 協議升級被少數人控制／全網凍結 | n/a | 協議層不存在全網凍結（A 案立場），但原型也沒有治理機制可打 | 不可達 |
| G13 | 威脅 15 | 模型供應商封鎖疑似轉售流量 | n/a | 外部行為，原型無從模擬；屬 §6「仍然不知道的事」| 不可達 |
| G14 | #16 | 對缺必要欄位的 frame 逐欄位驗證 | known-open | 目前靠 frame 層 try/catch 接住，錯誤訊息對送出方無指引性 | 自動 |
| G15 | #23 | 同價時以到達順序決勝，先啟動者系統性勝出 | ~~known-open~~ **block** | 已修：同價同信譽時以 `sha256(task_id + provider)` 決勝 | 自動 |

---

## 3. 可達性統計

| 類別 | block | known-open | n/a | 小計 |
|---|---:|---:|---:|---:|
| A Key／隱私 | 4 | 1 | 3 | 8 |
| B Provider | 5 | 0 | 1 | 6 |
| C 拒付 | 7 | 0 | 0 | 7 |
| D Verifier | 7 | 3 | 0 | 10 |
| E Sybil | 3 | 1 | 1 | 5 |
| F 重放 | 7 | 1 | 0 | 8 |
| G 基礎設施 | 6 | 7 | 2 | 15 |
| **合計** | **39** | **13** | **7** | **59** |

59 案而非 50——盤下來發現 SDD §16 的 15 條與登記簿 41 條交叉後，真正不重複的攻擊面比計畫估的多。建議不砍案例數，而是分兩批交付（見 §5）。

可達性另一種切法：**自動 50、需量測 1（G9）、需第三台 1（D8）、不可達 7**。

**7 案原型不可達**的意思要說白：內容政策（A6）、sandbox 逃逸（A7）、Key 程序隔離（A8）、模型冒充（B6）、貢獻任務換信用（E4）、治理（G12）、供應商封鎖（G13）——這七個面 Phase 1 **完全沒有控制**。W11 的報告不能把它們算進「已涵蓋」。

---

## 4. 盤點過程發現的新開口（建議進登記簿）

**(a) 協議物件完全沒有時效欄位** ~~建議 P1~~ — **已修並已關**（F4 現為 `block`）。 — `task`／`bid`／`contract`／`pre_authorization` 都沒有 `issued_at`、`expires_at` 或 deadline。SDD §16 威脅 8 明文列「過期 Bid 重放」，而目前唯一的重放防線是 `settledIds`（只管已結算的 contract_id）。連帶：final-architecture §2.3 第 3 點要求 Reservation 的 TTL「綁合約 deadline＋緩衝」，但原型裡合約沒有 deadline 可綁；`pre_auth` 沒有效期，provider 可以無限期後才強制結算。建議 P1。

**(b) Hub 隱藏報價無任何偵測手段** — 威脅 11。`broadcast()` 丟掉某個 bid 或某個 task，受害者看不出差別：沒有已發布任務的公開清單、bid 沒有回執、agent 也不知道自己的 bid 有沒有被轉達。§2.1 允許撮合中央化的條件是「狀態可由公開簽署事件重建」，但**未成交的報價從來不進帳本**，所以這一層的審計完全空白。建議 P1，最小修法是 Hub 對每個 task 週期性簽發「已收到的 bid 摘要」，讓遺漏可事後對質。

**(c) 新戶信用額度仍然兩個數字** — 登記簿 #1（P0）的修法寫「單一數值表由 GATE-0 定案」，但現在 §2.2 Credit Line 列仍寫 `L_boot 上限 25 CC`，而 `node/lib/eeff.js` 的 `STARTER_CC` 與 GATE-0 掃描結論都是 50 CC。兩處相差兩倍，正是 #1 當初要消滅的形態。需要 Owner 裁決哪個是真值，並讓另一處跟著改——這不是紅隊案例能解決的，是文件與實作的一致性問題。

---

## 4b. 第一批已交付（2026-09-17）

`node/redteam.js`，26 案全過（24 block、2 known-open）。做法不是憑空捏造訊息，而是**先讓誠實拓撲跑出真實的收據與證據包再變造**——憑空捏造只會測到「簽章驗不過」這一種拒絕，測不到「簽章有效但授權的是別的東西」，而後者才是有意思的攻擊（#53 正是這樣被發現的）。

| 組 | 案例 | 結果 |
|---|---|---|
| C（拒付）| C2 偽造 pre_auth 改價、C3 挪用他約 pre_auth、C4 收據不符合約、C5 自選 panel | 4/4 block |
| F（重放）| F1 重放已結算收據＋帳本零變動、F2 id 唯一、F5 改額重送、F7 竄改匯出、F8 偽造 checkpoint 簽章 | 6/6 block |
| G（基礎設施）| G1 畸形／未知 frame、G2 版本閘門、G16 偽造註冊簽章、G17 替別人送 register_ack | 4/4 block |
| **S（新增：串謀對結算驗證器）**| S1 Σ≠0、S2 超額度、S3 空 pool quorum、S4 零 attestation、S5 dsl-local 硬塞驗證費、S6 短付 Treasury、S7 未來種子、S8 短付 requester、S9 攻擊後帳本零變動 | 9/9 block |
| 已知開口 | F4 無時效欄位、G15 同價到達順序決勝 | 2/2 確認仍如登記所述 |

**S 組是盤點時沒有的，補上是因為它才是真正的信任邊界**：兩個身分可以簽任何東西，所以那些收據**簽章全部有效**——測的是 Hub 的 schedule 驗證器而不是簽章檢查。

過程中兩次抓到「案例因錯的理由通過」：S2 原本被費率表擋下，額度守門根本沒跑；修正費率拆分後才真的打到 `would exceed credit line`。這與 #51 是同一個教訓的另一面——**會給出假保證的測試比沒有測試更糟**。

## 4c. 第二批已交付（2026-09-17）

`node/redteam-agents.js`，9 案全過。對手是**參與者**而不是外部攻擊者：惡意 payload、不交付的 provider、承諾後沉默的 verifier。行為用設定旗標打開（`neverDeliver`／`corruptOutput`／`silentReveal`），與既有的 `refuseToSettle`／`alwaysPass` 同一個模式。

| 組 | 案例 | 結果 |
|---|---|---|
| A | A1 payload 要求回傳 API key、A2 payload 明文是否經 Hub、A3 payload 指示抬價 | 3/3 block |
| B | B1 得標不交付（錢）、B1b 合約被放棄而非永久掛著、B2 市場是否仍運作（**服務可用性**）| 3/3 block |
| D | D2 沉默 verifier 是否領錢、D2b 只付實際揭示者、INV 不變式 | 3/3 block |

**這一批找到兩個 P1，而且都是既有測試結構上碰不到的**：

- **#58 沉默 verifier 癱瘓結算**：demo 的三位 verifier 都會揭示，金絲雀的偷懶者也會揭示（它投 PASS 但有揭示）——「承諾後不揭示」這個狀態從來沒有被產生過。
- **#59 殺價不交付癱瘓市場**：B1 只問「攻擊者有沒有拿到錢」（沒有），但 B2 問「市場還活著嗎」（不活），而那才是攻擊者的目標。**同一個對手，兩個不同的問題，只有第二個問到了真的損害。**

## 4d. E5 已交付（2026-09-17）

`node/cl-compare.js`：同一組流水（`sim/fixtures/cl-flows.json`）分別餵給模擬器與原型，逐步比對信用額度。

**第一次執行就找到 #60**：75 步全部不一致，差距恆為 25.00 CC——掙來的部分兩邊完全相同，分歧 100% 來自年齡斜坡。修正後 **75/75 完全一致**。

這一案的價值不只是找到分歧，而是它**推翻了我五小時前對 #1 的裁決**：§2.2 的「25 CC」講的是 t=0 的有效額度，GATE-0 的「50」講的是參數，兩者都對。讀兩份程式碼不會發現這件事，因為兩邊各自都自洽——只有把同一組輸入餵進去、逐步比對輸出才會現形。

## 4e. 第三批已交付（2026-09-18）

`node/redteam.js` 38 案、`node/redteam-agents.js` 13 案，全過。這一批挑的是**盤點表上寫了防禦但從來沒被打過**的案例，而挑選標準就是「我不知道答案」。

| 案 | 組 | 結果 |
|---|---|---|
| **F6a／F6b** | 排序器 | **兩案第一次執行都失敗** → #69（P0）。盤點表寫「分叉可離線偵測」是錯的；修 `prev_root`＋`receipts_count` 對照後轉 block |
| F6c | 排序器 | known-open：分叉偵測得到、但協議裡沒有任何東西會讓誰持有雙邊產物 |
| F3 | 重放 | block：bid 簽章涵蓋 `task_id`，requester 也以**簽署內容**的 task_id 索引，搬不過去 |
| G3 | 基礎設施 | block：餵 agent 一份開不了的 `payload_box`，例外落在 async handler 內，進程仍在服務（#34 的修法確實生效）|
| G14 | 基礎設施 | known-open（#16）：Hub 完全不回應，送出方無從知道少了哪個欄位 |
| B4 | provider | block：2u 額度的 provider 掛全場最低價，對 4-5u 的任務**一次都沒出價**（#22）|
| B7 | provider | block：未聲明上游條款者不得上膛（#67／#68；原標 B3，與盤點表的 B3 撞名故改名）|
| D3 | verifier | block：承諾誠實票、揭示相反票 → 揭示不被計入、零報酬，結算仍以 2-of-3 完成 |

**這一批最重要的產出是 F6，而它的價值在於「為什麼之前沒發現」**：鏈與 checkpoint 都確實存在，讀程式讀不出少了一環——checkpoint 之間沒有連結、`receipts_count` 沒人對照。與 #60（跨語言逐步比對推翻我自己的裁決）同型：**自洽的程式不會告訴你它少了什麼**。

另外兩件記帳上的修正：**F4 與 G15 早已修好但盤點表還寫 known-open**，已改；**C7 不需要單獨寫**——S 組的 `submit` 走的就是雙簽路徑，額度守門（S2）已經在那條路上測過了。

## 5. 交付順序建議

1. **harness 先於案例**：`node/redteam.js`，每案是 `{id, expect: 'block'|'known-open', run()}`，攻擊者用 `transport.dial()`＋`sendRaw()` 直接講 wire（`demo.js` 的版本閘門與畸形 frame 測試已經是這個形狀）。輸出格式跟其他 demo 一致，才能當回歸閘門掛進 CI。
2. **第一批（約 25 案）**：C／F 兩組全部＋G1–G5、G11。都是既有防線的重放，寫起來快，而且立刻把登記簿的「已修」變成可執行斷言。
3. **第二批（約 20 案）**：A／B／D 三組，需要惡意 agent 變體（偷懶 verifier、串謀 requester）——`verifier.js` 的 `alwaysPass` 與 `agent.js` 的 `refuseToSettle` 已經是這類腳架的先例。
4. **E 組獨立**：E5（模擬 vs 原型 CL 曲線）是跨語言對照，要一份共用流水 fixture＋兩支列印腳本，跟 wire 層攻擊無關，可平行做。
5. **known-open 13 案**要與登記簿雙向對照：harness 裡的 expect 值就是登記簿狀態的鏡子，任一邊改了另一邊會紅。
