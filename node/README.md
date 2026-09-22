# AMCN Phase 1 閉環原型

整合計畫（`docs/evaluation/final-architecture.md` §5）W4–W8 里程碑的可執行版：三個獨立 OS 進程的 Agent＋一個 Coordination Hub，跑通 SDD §27 閉環並自動驗收 26 項判準。零第三方相依（Node.js ≥ 20）、協定 v7。

**要開始用而不是讀程式**：單機 `./quickstart.sh`、加入別人的網路看 [JOIN.md](JOIN.md)、自己開一個網路看 [INSTALL.md](INSTALL.md)。

## 執行

```bash
cd node
node demo.js              # 約 15 秒，26 項驗收（腳本驅動，回歸閘門）
node demo-autonomous.js   # 約 20 秒，12 項驗收（W8：全程零人工）
node demo-canary.js       # 約 30 秒，6 項驗收（W9：金絲雀沒收偷懶者押注）
node demo-rebuild.js      # 約 25 秒，7 項驗收（W10：第二排序器重建帳本）
node demo-transport.js    # 約 35 秒，7 項驗收（W10：第二個 ITransport，兩傳輸同一本帳）
node demo-reconnect.js    # 約 40 秒，8 項驗收（W10 預演：殺掉 Hub，網路自己回來）
node demo-forfeit.js      # 約 70 秒，14 項驗收（#38：押注的沒收與退還是一個 2×2）
node demo-tor.js          # 約 20 秒，7 項驗收（#89：零入向埠，不需要安裝 tor）

# 不是閘門，是給人用的：
./quickstart.sh           # 單機起一個真的網路並留著（status / stop）
node verify-ledger.js <匯出.json> --pin did:demo:…   # 自己驗一本帳
node pilot-doctor.js <hub ip>                        # 一個指令回答「為什麼連不上」

# 任一支都可與跑中的試點並存：
DEMO_PORT_OFFSET=100 node demo.js

# 傳輸層可替換（§2.1）。整個 stack 換一個實作，帳必須完全相同：
AMCN_TRANSPORT=http node demo.js
```

`AMCN_TRANSPORT` 選 `tcp`（預設）、`http`、`secure`（加密＋身分認證，連線要離開區網時用）、`tor`（零入向埠，#89）或 `chaos`（故障注入，只給情境用）。所有進程必須一致——混用時雙方都會明確拒絕並印出原因，不會靜默卡住。

`demo.js` 用 `posts: [{atMs, ...}]` 時間表驅動，證明機制正確；`demo-autonomous.js` 沒有任何時間表與 Console 呼叫，每筆任務都來自 Agent 自行偵測額度耗盡（§20-8／§6.2）。

## 展示的閉環（SDD §27）

```
A 額度耗盡 → 發布任務（僅 metadata，UC-01）→ 陌生人 B 得標
→ payload E2E 封裝只有 B 能解 → B 用「本機 keystore 解析、只進本機
provider 端點」的 API key 執行 → sha256 確定性驗收 → 雙簽收據
→ A = -40（E_eff 動態信用額度內）→ A 額度恢復、還債折扣價搶單
→ 服務第三方 C → A 負餘額完全清償（-40 → +1.7）
```

## 元件

| 檔案 | 對應 final-architecture §2.2 |
|---|---|
| `hub.js` | 第一個排序器非信任根：只中繼簽署訊息；結算需雙簽＋Σ=0＋符合費率表＋不超過動態信用額度，缺一即拒；全帳可 export 重建 |
| `agent.js` | Owner 裝置進程：Ed25519 身分＋X25519 box key；payload E2E 封裝給得標者；驗收 deterministic-first |
| `adapter.js` | FR-031 OpenAI-compatible HTTP client；key 只在進程記憶體，無 baseUrl 時退回確定性 mock。代他人執行時把 requester DID 當 end-user 識別送上游，且要求 `terms.attested`（§4 #68）|
| `lib/keystore.js` | P-02 金鑰解析：macOS Keychain（`AMCN_USE_KEYCHAIN=1`）→ env fallback |
| `lib/e2e.js` | NFR-005：X25519 ECDH（ephemeral）＋HKDF＋AES-256-GCM |
| `lib/eeff.js` | 與 `sim/amcn_sim` 同構的 E_eff 信用公式（starter 50、風險費 6%/2%——GATE-0 掃描定案參數）＋保險池 |
| `fake-provider.js` | 本機 key-gated OpenAI-compatible 端點，讓真 HTTP 路徑可測而不花錢 |
| `lib/strategy.js` | FR-055 目標餘額區間＋還債排程器：`[low, high]` 預設 `[-0.3×CL, +100]`，跌破 low 則供給折價、暫停非必要消費；§20-10 平均還債時間 |
| `lib/discovery.js` | §2.1「協議內發現與輪替」的區網部分：Hub 簽署 UDP 信標，Agent 以 `hubHost: "discover"` 自動尋找並可用 `hubPin` 釘住身分。跨機已在三台真實機器上驗證（#18 已撤銷），廣播被訪客網路／VLAN／Wi-Fi client isolation 擋時改手填 IP；跨網段用 `lib/rendezvous.js`|
| `lib/demand.js` | W8 無人觸發源：自有額度／需求模型，額度耗盡（UC-01 步驟 1）自動轉為任務；含 Owner 預算上限與週期相位錯開 |
| `lib/rebuild.js` | W10 帳本重建：從匯出檔**驗證式**重構（逐筆驗簽、pubkey 自證、鏈重算、信用額度由收據重放），任何不符即拒絕。鏈條目規則與 `hub.js` 共用同一份實作 |
| `ledger-dump.js` | 災難匯出：把 Hub 完整帳本寫成檔案 |
| `demo-rebuild.js` | W10 驗收（7 項）：第二排序器從匯出重建、餘額／額度一致、竄改檔被拒 |
| `canary.js` | W9 金絲雀稽核（proposal-C §7）：獨立進程發布「斷言不可能被滿足」的暗樁任務，唯一正確裁決是 FAIL；投 PASS 的 verifier 被記錄，達到證據門檻即沒收押注。身分由 seed 決定，需在 Hub 設 `HUB_CANARY_DID` 授權 |
| `demo-canary.js` | W9 金絲雀驗收（6 項）：偷懶 verifier 被沒收、誠實者未受罰、押注帳務一致、Σ=0 |
| `panel.js` / `panel.cmd` | 專用 Verifier panel 主機（INSTALL §6）：探測 Hub、啟動 N 個 Verifier、全數註冊後回報、Ctrl-C 一次停完。跨平台，Windows 免改 PowerShell 執行原則 |
| `demo-autonomous.js` | W8 驗收：§27 閉環全程零人工（12 項斷言）。無 `posts` 時間表、無 Console 呼叫 |
| `lib/transport.js` | §2.1 要求集中化元件配齊「至少一個開源替代實作」的那一項：`ITransport` 介面（`listen`／`dial`／`probe`）＋實作登記表＋`AMCN_TRANSPORT` 選擇 |
| `lib/channel.js` | 兩種傳輸共用的 frame 語義：JSON-lines 切分、信封版本閘門（§4 #33）、handler 例外隔離（§4 #13／#34）。傳輸層只提供 write／close，不得改寫語義——這是「兩傳輸同一本帳」能成立的原因 |
| `lib/transport-tcp.js` | 實作 1：TCP JSON-lines（至今所有試點跑的行為，原樣搬過來） |
| `lib/transport-secure.js` | 實作 4：加密＋身分認證的通道（§4 #44）。臨時 X25519 → HKDF → AES-256-GCM，臨時金鑰由 Ed25519 身分簽章，以 DID 為信任錨（不是 TLS，也沒有 CA）。防的是路徑上的第三方；防 Hub 本身仍靠簽章與 payload E2E |
| 壞帳瀑布（#61／#65）| 離線超過 `HUB_DEFAULT_AFTER_MS`（預設 14 天）且仍為負餘額即沖銷：抵押品 → 保險池 → `protocol:loss`。情境 `default-writeoff` 用 `killAgent: mostIndebted` 製造真正的違約者並驗證瀑布 |
| 抵押品（#65）| `POST /collateral {amount_cc, lock}` 到 Owner Console：把自己的正餘額鎖入 `protocol:collateral`，額度上升 `amount × AMCN_COLLATERAL_LTV`（預設 0.5，取自 `amcn_sim.sweep_deposit`）。只能抵押自己的正餘額，取回時剩餘額度必須仍覆蓋負債 |
| `lib/rendezvous.js` | 跨網段的發現與輪替（§4 #45）：Hub 發布簽署的位址記錄，client 每次重連重新解析、以 `hubPin` 驗身分。承載記錄的主機不受信任——它能扣住或給舊的，但無法冒充 |
| `lib/transport-chaos.js` | 實作 3：故障注入（`AMCN_TRANSPORT=chaos`）。包裝 tcp／http，由執行期可改的控制檔驅動：`blackhole`（寫入成功但消失、連線永不關閉）、`reset`、`latency`／`jitter`、`loss`、`freeze`（只斷入向＝對手卡死）、單向中斷。注入點在**位元組層**而非 channel 之上——否則 channel 自己的活性 ping 會繞過故障（第一版就是這樣錯的）。`AMCN_CHAOS_SEED` 讓丟包樣式可重播 |
| `lib/transport-tor.js` | 實作 5：**不需要對外開任何埠**的傳輸（#89）。Hub 只聽 127.0.0.1，由 onion service 的 rendezvous 把外面的人帶進來——雙層 NAT／CGNAT 兩邊都不必設定，不必租機器。位址本身就是公鑰（v3 onion ＝ ed25519 公鑰編碼），與協定既有的 `hubPin` 是同一種信任錨。實作上 `listen` 沿用 tcp、`dial` 只是換成經 SOCKS5 以 ATYP=0x03 連 `.onion`（在 DNS 裡不存在，必須交給 tor 解——那正是「客戶端不需要知道對方在哪」的原因）|
| `service/run-onion.sh` | 起 onion service 並印出要給對方的設定。**它建立的是一條入向路徑**，所以不由任何自動流程替 Owner 決定 |
| `lib/transport-http.js` | 實作 2：HTTP——長連 chunked NDJSON 回應載 server→client，POST 載 client→server。刻意不選另一種 socket 方言：那會共用 TCP 的故障模型，換了等於沒換。此實作線上無連線狀態、送達以請求為單位，POST 必須自行保序（單 socket keep-alive）|
| `quickstart.sh` | 推廣用的起步路徑：在一台機器上拉起 Hub＋3 個 Verifier＋兩個 Agent、跑完第一筆結算，然後**留著**讓人操作（發任務、查帳、重啟、備份）。與 `demo.js` 的分工是「活的網路」對「回歸閘門」|
| `verify-ledger.js` | 參與者自己驗一本帳（§20-4 的使用者版本）：與第二個排序器啟動時用同一份 `lib/rebuild.js`——逐筆驗簽、pubkey 自證 DID、餘額由事件重放、鏈重算、額度重放、checkpoint 比對鏈頭，任何一項不符是拒絕。`--pin` 才會檢查「是誰簽的」|
| `JOIN.md` | 可以直接轉給參與者的那份文件：三種參與方式的門檻、押注規則、CC 是什麼／不是什麼、義務、跨網段、自檢與查帳 |
| `pilot-doctor.js` | 跨平台試點診斷（§4 #43）：`node pilot-doctor.js <hub IP>` 依序驗網段、設定檔、TCP、**AMCN 協議層**、UDP 信標，並指出第一個 FAIL。只用 node，Windows 可直接跑 |
| `lib/log.js` | 長時間執行的時間戳（§4 #42）：hub／agent／verifier／canary／panel 的每一行加 UTC ISO-8601。包裝 console 而非逐一改呼叫端，因為斷線時最關鍵的行來自 `lib/channel.js`／`transport-*.js` |
| `lib/invariants.js` | 六項協議不變式（Σ=0、雜湊鏈、雙簽、quorum 支撐與費率、信用上限、contract_id 唯一）＋兩項需要現場取樣的（pool 不得宣告離線者、合約不得卡住）。**連續檢查**而非結尾檢查一次——故障情境要問的是「不變式是否曾經被破壞」 |
| `redteam.js` | W11 紅隊第一批（45 案，block 45／known-open 0）：先讓誠實拓撲產生真實收據與證據包，再變造它們攻擊 Hub。含兩個串謀身分對結算驗證器的直接攻擊（簽章全部有效，測的是 schedule 驗證）。每案的期望結果事先寫定，`known-open` 案**攻擊成功才是 PASS** |
| `cl-trace.js` / `cl-compare.js` | E5 跨語言對照：`sim/fixtures/cl-flows.json` 的同一組流水分別餵模擬器與原型，逐步比對信用額度。找到 #60（原型第一天給兩倍開機信用），修後 75/75 一致 |
| `redteam-agents.js` | W11 紅隊第二批（13 案）：對手是**參與者**——惡意 payload、不交付的 provider、承諾後沉默的 verifier。找到 #58（沉默 verifier 癱瘓結算）與 #59（殺價不交付癱瘓市場）|
| `chaos-run.js` / `scenarios/` | 情境執行器：自行拉起拓撲、依時間表注入故障、持續檢查不變式、輸出時間軸與 PASS/FAIL，每個子行程的 log 落地。`--seed` 讓失敗可重播。取代了原本需要人拔線的開發環節 |
| `demo-reconnect.js` | W10 預演（8 項）：SIGKILL 掉 Hub → 同 seed 從自動匯出重啟 → 六個 client 自行重連、重新註冊、餘額延續、交易恢復，全程無人介入（§4 #40）|
| `demo-transport.js` | W10 驗收（7 項）：同一場 `demo.js` 在兩種傳輸下 fingerprint 相同（收據／事件／餘額／額度／驗收方式全等）、混用傳輸雙方都明確拒絕 |
| `mcp-server.js` | §23.1 需求側入口：MCP server（JSON-RPC over stdio，協議 2025-06-18），三個 tool `amcn_balance` / `amcn_publish_task` / `amcn_request_inference`。不持有任何金鑰，只經 127.0.0.1 的 Owner Console 操作本機 Agent |

## Demo 自動斷言（`demo.js` 現為 26 項，下表列出其中 11 項核心判準）

W9／W10 加進來的斷言（commit-reveal、押注託管、未來 checkpoint 抽選、contract_id 冪等、版本閘門、畸形 frame 回歸閘門、傳輸可替換）沒有列在這張表裡——以 `node demo.js` 的實際輸出為準，這裡是給第一次讀的人看的地圖。

| # | 檢查 | 方法 |
|---|---|---|
| §20-1/6＋NFR-005 | Key 不離機＋E2E | Hub 全量流量掃描：無 key、無三個 payload 明文（X25519+AES-GCM 封裝給得標者） |
| FR-050 | 雙簽收據 | 兩筆自願結算的四個 Ed25519 簽章逐一驗證 |
| **T-05 反拒付** | **強制結算** | B 收貨後拒簽收據 → A 持「雙簽合約＋B 的 pre_authorization＋2-of-3 quorum PASS」強制記帳；證據包離線可驗 |
| FR-041/044 | Verifier 合約時鎖定＋機器可讀 | 3 人 panel 以 checkpoint root 為 seed 在成交時寫入雙簽合約；attestation 帶 failures[] 指向 assert index |
| NFR-006 | hash chain＋checkpoint | 每帳戶單調 seq 雜湊鏈、每筆結算後 Hub 簽 checkpoint；demo 離線重驗全鏈 |
| 防竄改 | tamper-evidence | 竄改任一筆金額後重驗必失敗（demo 實際偽造 1 CC 驗證） |
| §20-4 | Σ=0 且可重建 | 從收據重建（含 treasury＋insurance）比對 Hub 帳 |
| §20-2/3 | 借用→多邊清算閉環 | A 額度內借 40 → 服務第三方 C＋強制結算收入 → 期末 +27.8 |
| F-1 | 反洗量即時生效 | B 從單一對手賺 36.6 CC，CL 零成長 |
| §20-7 | DSL 驗收＋真 HTTP 路徑 | assert 集（sha256_eq＋max_len）於 TaskSpec 簽章時鎖 hash |
| FR-081 | Owner Console | `http://127.0.0.1:47201/status`：餘額/額度/結算史與 Hub 帳一致 |

## 接真實模型

把 agent config 的 `adapter.baseUrl` 指向任何 OpenAI-compatible 端點（如 `https://api.openai.com`、本機 Ollama `http://localhost:11434`），`key.service` 設 Keychain service name 並 `AMCN_USE_KEYCHAIN=1`。注意：真模型輸出非確定性，驗收要換成提案 B 的 DSL（schema assert / test-suite），這是下一步。

**要對外供給（`provide` 非 null）並接真實上游時，adapter 還有兩個欄位（§4 #68，P-10）**：

```json
"adapter": {
  "baseUrl": "https://api.openai.com",
  "key": { "service": "amcn-provider" },
  "terms": { "attested": true, "note": "查證日期與依據" },
  "attribution": "openai"
}
```

- `terms.attested` — **沒有它就不會上膛供給**。它聲明的是「你與這家供應商的協議允許你替第三方請求執行推理」。這是**聲明而非驗證**：沒有東西能確認你讀過合約，它的作用是把 P-10 的責任變成設定檔裡有紀錄、可稽核的事實。接本機模型（Ollama 等）也需要設，因為程式看不出 `baseUrl` 後面是誰——若那確實是自己的硬體，就沒有上游協議要遵守，設 `true` 即可。
- `attribution` — 代他人執行時，requester 的 DID 會放進 `user` 欄位送上游。`"openai"` 另加 `safety_identifier`；`"none"` 關閉（給會拒收未知欄位的嚴格伺服器，或本機模型）。**方向是把流量標示清楚而不是混進去**：條款預設客戶會有終端使用者，禁的是共用憑證與轉售，所以讓第三方工作帶著身分抵達才是合規的姿態。詳見 `docs/evaluation/key-lending-verification.md`。

## 回流：protocol 帳戶不是只進不出（§4 #71）

protocol 帳戶只收不付時，**它們持有的每一塊 CC 都是永久借出去的信用**——所以在沒有結構性淨賣方的小網路裡，交易者的總負債只會隨成交量單調成長，直到全部貼上信用上限。40 分鐘 soak 的結局正是如此：292 筆結算後最後 12 分鐘零成交，122.53 CC 卡在 protocol 帳戶裡。

Hub 因此週期性把超額退還給**本期有支出的**帳戶，按支出額加權：

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `HUB_REBATE_MS` | 60000 | 檢查週期 |
| `HUB_INSURANCE_TARGET_FRAC` | 0.06 | 保險池準備金目標 = 曝險（未償負餘額總額）× 此值。0.06 來自 #65 量到的壞帳率 0.08–2.11% 乘 3 倍安全係數；設 0 即關閉 |
| `HUB_TREASURY_RESERVE_CC` | 5 | Treasury 保留額，供金絲雀與 L_boot 補貼使用；其餘退還 |
| `HUB_REBATE_MIN_CC` | 0.05 | 低於此金額不動作，避免大量零碎分錄 |

三個設計選擇值得說明：

- **按支出加權而非平均分配**。平均分配會把錢送回給只累積的帳戶，而 #62 量到 verifier 正是最大的吸收端（原型 soak 每位 +11.9 CC）。只收不付的帳戶本期支出為 0，因此拿不到。
- **保險池的目標綁曝險而非成交量**。池子存在是為了吸收違約，而可能違約的金額就是現在的未償負餘額。這也保護 #65 的瀑布：池子不會被退到無力賠付。
- **不需要預簽 Grant**。§2.2 對 demurrage 那類非雙簽分錄要求引用 Owner 預簽的費率表，因為那種分錄會**拿走**價值；退費只 credit 非 protocol 帳戶，收款方無從受害。要守的是不變式與準備金充足性，不是同意。

對照閘門是兩個情境檔的差別而不是兩份程式：`scenarios/soak-rebate.json` 與 `scenarios/soak-norebate.json`（後者刻意保留 `tradingContinues`——它**應該**在末段停下來）。

## 誠實簡化清單（正式版要補的）

- Verifier 是確定性 judge（跑 DSL asserts）：主觀任務需 LLM judge＋commit-reveal（訊息流已就位，換 verifier 內核即可）。
- 爭議路徑只有「強制結算」一條：FAIL 後的 DISPUTED／仲裁／押金沒收未實作。
- ~~Verifier 無報酬 posting~~ **已修**：驗證費在收據裡逐 panel 成員分攤（實測一筆 10 CC 的任務每位 0.13 CC），其中一部分託管為押注（#28），而押注的沒收與退還規則見 `demo-forfeit.js`（#38、協定 v7）。
- Panel seed 用「最新」checkpoint root，有 grinding 風險（評審 A-④）：正式版綁未來輪 checkpoint＋commit-reveal。
- ~~credit line 的 age factor 固定為 1~~ **已修**（#82）：年齡斜坡是 `0.5 + 0.5 × min(1, 帳齡/30天)`，所以新身分第一天的額度約 23.1 CC 而不是 46.25；demo 與情境用 `HUB_AGE_RAMP_MS=1` 壓掉它，**真實部署不要動**。風險費率仍是靜態二檔（6%/2%，GATE-0 候選組），動態定價未做。
- 無心跳/逾時/備援重發（PROVIDER_FAILED 路徑）；Console 為唯讀 JSON，無政策編輯。

## 把 AMCN 當工具用（MCP，§23.1）

讓你現有的 Claude／自建 Agent 直接對 AMCN 下單。先啟動一個帶 Console 的本機 Agent，再把這個 server 指向它：

```bash
AMCN_CONSOLE=http://127.0.0.1:47203 node mcp-server.js
```

OpenClaw（本機已接好，2026-09-22）：

```bash
openclaw mcp add amcn --command node \
  --arg /path/to/ai-exchage/node/mcp-server.js \
  --env AMCN_CONSOLE=http://127.0.0.1:47201 \
  --cwd /path/to/ai-exchage/node --timeout 90
openclaw mcp probe     # 應該看到 amcn: 3 tools
openclaw mcp reload    # 改過 mcp-server.js 之後要重載快取的 runtime
```

三個 tool 都帶 MCP 的 `annotations`，而那一欄不是裝飾：沒有它時宿主只能假設
最壞情況（OpenClaw 的 probe 會說 `tools have no safety annotations; calls will
require interactive approval`），於是連「查餘額」都要人按一次同意。所以
`amcn_balance` 標 `readOnlyHint: true`／`idempotentHint: true`，而另外兩支
**刻意不標唯讀**——它們會花掉真的額度，宿主要求同意不是摩擦，是花錢前的閘門。

Claude Code 的設定（`.mcp.json` 或 `claude mcp add`）：

```json
{
  "mcpServers": {
    "amcn": {
      "command": "node",
      "args": ["/path/to/ai-exchage/node/mcp-server.js"],
      "env": { "AMCN_CONSOLE": "http://127.0.0.1:47203" }
    }
  }
}
```

三個 tool：

| Tool | 用途 |
|---|---|
| `amcn_balance` | 餘額、動態信用額度、可支用額、目標餘額區間與策略模式 |
| `amcn_publish_task` | 發布任務後立即返回 `task_id` / `contract_id`，不等結算 |
| `amcn_request_inference` | 發布任務並**等到結算**，回傳產出、成本與期末餘額（預設 60 秒逾時）|

設計上這個 process **不持有金鑰也沒有身分** —— 它只是 Owner Console 的薄客戶端，簽章、keystore 與 E2E 封裝全留在 Agent 進程裡，所以多這個介面不會弱化 P-02。

⚠️ `amcn_request_inference` 預設的驗收斷言是 `max_len`，不是 `sha256_eq` —— 真實模型輸出非確定性，`sha256_eq` 必然失敗（見本檔誠實清單）。
