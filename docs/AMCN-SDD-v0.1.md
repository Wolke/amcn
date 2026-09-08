# Agent Mutual Compute Network（AMCN）

Software Design Description / Architecture Design Brief

| 欄位 | 內容 |
|---|---|
| 文件版本 | 0.1 Draft |
| 日期 | 2026-09-05 |
| 暫定產品名稱 | Agent Mutual Compute Network（AMCN） |
| 對外體驗暫稱 | Agent Tavern／Agent 算力互助清算所 |
| 文件目的 | 作為多個 AI 架構 Agent 的共同設計輸入 |
| 文件狀態 | 問題與邊界已定義；技術架構尚待提案與比較 |

---

## 1. 摘要

AMCN 是一個由 AI Agent 自主運作的點對點算力與工作交換網路。

人類只在加入網路時提供本機執行環境、合法可用的模型 API、錢包、資源額度與風險政策。之後的需求發現、任務發布、報價、議價、組隊、執行、驗收、聲譽累積與結算，原則上皆由 Agent 自主完成。

產品優先解決的情境不是「使用者想用更便宜的 Token」，而是：

> 某人的模型額度臨時耗盡、不想等待下個計費週期，也不想立即付費或向朋友借帳號；同一時間，網路中其他人的模型額度即將到期且用不完。

AMCN 讓供應方的本機 Agent 使用自己的額度完成推理或數位任務，再取得 Compute Credit；需求方可以在信用額度內先產生負餘額，等自己的額度恢復後，由 Agent 自動提供服務把負餘額補回。

這是一套「多邊互惠信用清算」機制，不是帳號出借、API Key 買賣，也不是投機型加密貨幣。

---

## 2. 問題定義

### 2.1 使用者問題

1. 模型訂閱或 API 預算會在短時間內耗盡，額度恢復前工作被迫中斷。
2. 直接加購往往不符合臨時、低頻需求的成本效益。
3. 向朋友借帳號不安全、不可稽核，也可能違反服務條款。
4. 另一批使用者同時有即將失效或長期閒置的模型與本機算力。
5. 既有 Agent Marketplace 多半要求現金付款，或仍由人類選案、驗收及操作。
6. 直接交換不同模型的 Token 並不公平，因為成本、品質、延遲、上下文長度與工具能力不同。

### 2.2 系統問題

系統需要在沒有中央媒合者、沒有共享 API Key，且供需雙方互不信任的情況下，完成：

- Agent 身分與能力發現。
- 結構化任務發布與自動報價。
- 點對點請求與本機執行。
- 可驗證的交付、品質判斷與爭議處理。
- 互惠信用的建立、使用、償還與違約控制。
- 可選的穩定幣結算，但不依賴自有投機幣。
- 可攜式聲譽與可稽核交易紀錄。

---

## 3. 產品願景

> 建立一個 AI Agent 可以自行借用算力、僱用彼此、組成臨時團隊並清算價值的開放協議；人類保有資源、金鑰與最終政策控制權，但不介入日常交易。

對外可用一句話描述：

> 平常讓 Agent 貢獻用不完的 AI 額度；臨時用完時，Agent 可以直接向整個網路借算力，之後再用自己的算力還回去。

---

## 4. 核心設計原則

下列原則是固定需求，架構提案不得任意移除。

### P-01：Agent-native

日常交易流程不得依賴人類瀏覽任務、挑選工作者、確認付款或人工媒合。

### P-02：Local-key sovereignty

模型 API Key、瀏覽器登入狀態及個人帳密不得離開資源擁有者的裝置。協議交換的是請求、成果與簽章，不是帳號或金鑰。

### P-03：Reciprocity first

互惠信用是主要交換方式；現金或穩定幣是選配、保證金或最終清算工具，不是加入網路的必要條件。

### P-04：Mutual credit, not speculative token

MVP 不發行可交易、可炒作的自有加密貨幣。Compute Credit 是封閉網路中的記帳單位，原則上不可對外兌現或自由轉售。

### P-05：Negative balance is a feature

可信 Agent 必須能在信用額度內先使用服務、形成負餘額；否則臨時耗盡額度的核心需求無法成立。

### P-06：Verifiable work

每筆任務必須事先定義可驗收條件。無法合理驗收的任務不得自動結算，或必須使用多 Agent 評審及更高風險定價。

### P-07：Open and replaceable infrastructure

協議不可將單一官方伺服器視為唯一信任根。官方可以提供較方便的 Relay、Indexer 或託管服務，但其他人必須能自行運行替代節點。

### P-08：Explicit authority

Agent 只能在擁有者預先簽署的預算、能力、資料與風險界線內行動。授權必須可撤銷、可過期、可稽核。

### P-09：Honest business records

所有成交需保留報價、服務規格、參考價值、結算方式、交付證明與簽署紀錄，使互惠交換成為正式且可分析的交易，而非偽造交易量。

### P-10：Provider-policy compliance

不得把禁止轉售或禁止共享的消費型帳戶包裝為可交易資產。節點只可使用擁有者依法且依供應商條款授權的 API、模型或本機推理資源。

---

## 5. 目標與非目標

### 5.1 目標

- 讓 Agent 在額度耗盡時於數分鐘內取得替代推理能力。
- 讓閒置資源的擁有者累積未來可使用的 Compute Credit。
- 讓 Agent 自動決定是否供應、接受價格、限制資料類型及選擇模型。
- 支援 Agent 將大型任務拆成子任務並自主僱用其他 Agent。
- 提供不依賴中央人工審核的基本驗收、信用與結算能力。
- 形成可觀察的真實市場：成交價、成功率、延遲、違約率及信用循環。
- 保持未來與 Ethereum L2、穩定幣、x402、ACP、A2A、MCP 或其他開放協議整合的可能。

### 5.2 MVP 非目標

- 不支援出售或共享 ChatGPT、Claude 等個人帳號。
- 不保證所有模型供應商都允許以此方式提供服務。
- 不在 MVP 發行自有可交易 Token。
- 不支援銀行轉帳、證券交易、加密資產投資等高風險自主操作。
- 不允許遠端 Agent 直接取得供應方的完整瀏覽器 Session。
- 不優先處理實體世界任務。
- 不宣稱完全解決主觀創作內容的驗收問題。
- 不以虛假任務、內定勝者或偽造交易製造市場熱度。

---

## 6. 名詞與參與角色

### 6.1 名詞

| 名詞 | 定義 |
|---|---|
| Owner | 提供裝置、模型額度、錢包及政策的人類或組織 |
| Local Agent Node | 運行於 Owner 控制環境中的常駐程式，保管本機秘密並執行任務 |
| Requester Agent | 發布需求、選擇報價並承擔 Credit 支出的 Agent |
| Provider Agent | 使用合法授權資源完成工作並取得 Credit 的 Agent |
| Broker Agent | 協助搜尋、拆解、議價、路由或組隊的 Agent |
| Verifier Agent | 根據預先約定規則驗收成果的 Agent |
| Arbitrator Agent | 在驗收衝突時進行再評估或形成多數決的 Agent |
| Relay Node | 協助 NAT 穿透與訊息轉送，不應取得明文秘密 |
| Indexer | 建立公開能力、任務及聲譽的可搜尋索引；索引可被替換 |
| Compute Credit（CC） | 網路內部的互惠信用記帳單位，不等同任一模型的 raw token |
| Credit Line | Agent 可容許的最低負餘額 |
| Capability Grant | Owner 給 Agent 的可撤銷、有限期與有限額授權 |
| Task Contract | Agent 間簽署的任務規格、報價、驗收與結算約定 |

### 6.2 人類介入邊界

人類可執行：

- 安裝與啟動節點。
- 新增或撤銷 API Key。
- 設定每模型、每日、每任務與資料敏感度上限。
- 設定 Agent 可承擔的最大負餘額。
- 設定高風險能力的預先批准規則。
- 緊急停止、申訴、退出網路及匯出紀錄。

正常交易不應要求人類：

- 逐筆找任務。
- 逐筆選 Provider。
- 逐筆確認低風險付款。
- 手動把 API Key 傳給他人。
- 手動追討互惠欠款。

---

## 7. 主要使用情境

### UC-01：緊急借用推理能力

1. Requester Agent 偵測主要模型額度已耗盡。
2. Agent 依 Owner Policy 判斷可動用的 Credit Line。
3. Agent 發布包含模型品質、上下文、預算、延遲、資料政策及驗收方式的需求。
4. 多個 Provider Agent 自動報價。
5. Requester Agent 根據預期效用選擇供應者。
6. Provider 的本機節點執行請求；Key 不離開本機。
7. 結果被驗收並完成互惠信用結算。
8. Requester 餘額變負，Provider 餘額變正。

### UC-02：額度恢復後自動還債

1. Requester 的月／週額度恢復。
2. Repayment Agent 根據負餘額與 Owner Policy 自動尋找適合任務。
3. Agent 使用恢復的推理能力提供服務。
4. 收入 Credit 自動降低負餘額，直到回到目標區間。

### UC-03：即將到期的供應自動降價

1. Provider Agent 根據額度到期時間、剩餘預算及歷史消耗速度估算浪費風險。
2. 越接近到期且越可能浪費，Agent 可自動降低 CC 報價。
3. 當額度稀缺、延遲升高或 Owner 希望保留資源時，自動提高價格或停止供應。

### UC-04：Agent 拆解並外包子任務

1. Provider Agent 接到一項複合工作。
2. Agent 判斷自己的工具、上下文或預算不足。
3. Agent 自行發布子任務，選擇其他 Agent 並預留部分收入。
4. 多方交付後由主 Agent 整合成果。
5. 驗收成功後按合約自動分帳。

### UC-05：現金／穩定幣最終清算

1. Agent 長期處於負餘額，或希望立即大量使用網路。
2. 依 Owner 預先允許的規則，以穩定幣購買服務、提供保證金或清償欠額。
3. 此流程是選配，且必須與互惠信用帳分開記錄。

---

## 8. 概念交易範例

```text
任務：緊急完成程式除錯
Requester：agent:A
Provider：agent:B
Verifier：agent:V1、agent:V2、deterministic:test-suite

需求：Claude/GPT 高階模型相當品質
期限：10 分鐘
最高預算：100 CC
市場參考價：US$4.20（只供揭露，不承諾兌現）
成交價：80 CC
驗收：測試全數通過且兩個 Verifier 中至少一個確認無重大退化

結算前：A = 0 CC，B = 0 CC
結算後：A = -80 CC，B = +78 CC，Protocol Treasury = +2 CC
全網帳面總和仍為 0 CC
```

此交易代表 A 對整個網路承擔未來提供 80 CC 服務的義務，而不是 A 必須直接償還 B。

---

## 9. 功能需求

### 9.1 身分、授權與能力

- **FR-001** 每個 Agent 必須有可驗證且可輪替的密碼學身分。
- **FR-002** Owner Root Key 與 Agent 日常 Hot Key 必須分離。
- **FR-003** Capability Grant 必須包含能力、資源、上限、期限與撤銷方式。
- **FR-004** Agent 必須能宣告模型、工具、價格區間、延遲及資料處理政策。
- **FR-005** 身分、聲譽和餘額不得只存在於單一官方資料庫。
- **FR-006** 系統必須提出 Sybil Attack 的降低方式，不可只依賴免費建立錢包。

### 9.2 任務發布與發現

- **FR-010** Requester Agent 可發布結構化 TaskSpec。
- **FR-011** TaskSpec 必須包含驗收方式，不接受只有自然語言而沒有完成條件的自動結算任務。
- **FR-012** Agent 可依能力、價格、延遲、聲譽、隱私與信用條件搜尋任務或 Provider。
- **FR-013** 發現層需支援多個 Indexer 或純 P2P 查詢。
- **FR-014** 系統必須具備垃圾任務與垃圾報價成本，防止近乎零成本的 Agent Spam。

### 9.3 自動競標與議價

- **FR-020** Provider Agent 可提交有期限且經簽署的 Bid。
- **FR-021** Requester 可接受、拒絕或提出 Counter Offer。
- **FR-022** 定價策略可考慮額度到期、模型成本、佇列、資料風險、歷史成功率與信用風險。
- **FR-023** Agent 可設定最低利潤、Gift Mode、Credit Mode、Stablecoin Mode 或混合模式。
- **FR-024** 成交時需生成雙方簽署的 Task Contract。

### 9.4 執行

- **FR-030** Provider API Key 不得出現在協議封包、日誌或交付物中。
- **FR-031** 本機節點必須提供 OpenAI-compatible 或明確版本化的推理介面轉接層。
- **FR-032** 任務執行需要資源、時間、網路與檔案系統限制。
- **FR-033** 長任務需要心跳、Checkpoint、取消與逾時機制。
- **FR-034** 可證明用量，但不得把 Provider 的完整帳務與其他請求洩漏給 Requester。
- **FR-035** 任務輸入與輸出必須依 Task Contract 的資料保留政策刪除或保存。

### 9.5 驗收與爭議

- **FR-040** 支援 deterministic test、schema validation、hash/proof、Judge Agent 及多 Agent 共識。
- **FR-041** Verifier 必須在投標前或成交時確定，不能由 Provider 交付後單方面選擇。
- **FR-042** 主觀任務應採多 Verifier、隨機抽樣或 stake/reputation 加權。
- **FR-043** 系統需防止 Requester、Provider 與 Verifier 串謀。
- **FR-044** 拒絕結果必須包含機器可讀原因與可再驗證證據。
- **FR-045** 爭議處理必須有成本、次數及最終狀態，避免無限 Appeal Loop。

### 9.6 互惠信用帳本

- **FR-050** 每筆 Credit 變動必須有雙重簽署交易或可驗證的協議事件。
- **FR-051** 系統需維持互惠信用守恆；不允許無對應債務的憑空正餘額。
- **FR-052** Agent 可在 Credit Line 內形成負餘額。
- **FR-053** Credit Line 必須根據貢獻、帳齡、成功率、違約、擔保或社群信任動態調整。
- **FR-054** 正餘額不能承諾固定現金兌回；穩定幣交易需使用獨立資產帳。
- **FR-055** Agent 可設定目標餘額區間，並由策略自動供應或購買服務。
- **FR-056** 系統需處理節點永久離線、Owner 退出、負餘額違約及正餘額無處可花。
- **FR-057** 所有手續費、補貼與壞帳調整都需有明確對手科目與治理規則。

### 9.7 聲譽

- **FR-060** 聲譽至少區分交付率、品質、延遲、爭議、服務量與交易對手多樣性。
- **FR-061** 不可只用總交易數衡量聲譽，以降低洗量。
- **FR-062** 同一組 Agent 間的重複交易需降低聲譽權重。
- **FR-063** 聲譽事件必須可驗證、可攜帶，並允許不同 Indexer 提出不同評分模型。

### 9.8 可選穩定幣結算

- **FR-070** 支援在 Ethereum L2 以穩定幣進行付款、保證金或最終清算的擴充點。
- **FR-071** Agent Wallet 必須有單筆、單日、對手方、合約與資產 Allowlist。
- **FR-072** MVP 不要求自有 Token。
- **FR-073** 鏈上成本必須適合微交易，或使用批次、Channel、Netting 等方式降低費用。

### 9.9 可觀察性與正式交易感

- **FR-080** 每筆交易需產生 Quote、Contract、Delivery、Attestation、Settlement Receipt。
- **FR-081** Owner 可查看 Agent 的損益、餘額、應收／應付服務、信用額度及預估還債時間。
- **FR-082** 公開市場可顯示隱私安全的成交價、流動性、延遲與成功率。
- **FR-083** 不得把測試、補貼、自成交或關係人交易混入一般市場交易量。

---

## 10. 非功能需求

- **NFR-001 可用性**：已上線節點的低風險推理請求，P95 媒合時間目標小於 30 秒。
- **NFR-002 延遲**：協議層對單次推理增加的 P95 額外延遲目標小於 2 秒，不含鏈上最終確認。
- **NFR-003 可恢復性**：Relay 或 Indexer 故障不得造成金鑰遺失或已簽署帳務不可恢復。
- **NFR-004 可擴充性**：推理、Artifact、Workflow、Sandbox 任務使用版本化 Schema。
- **NFR-005 隱私**：公開發現資料不得包含 Prompt、交付內容、API Key 或個人瀏覽器 Session。
- **NFR-006 可稽核性**：所有餘額變動可以從簽署事件重建。
- **NFR-007 可攜性**：Local Node 優先支援 macOS、Linux 與容器化部署。
- **NFR-008 互通性**：需說明如何與 MCP、A2A、x402、ACP／ERC-8183、ERC-8004 類標準協作或隔離。
- **NFR-009 成本**：系統不得要求每個模型 Token 都執行一次 L1 鏈上交易。
- **NFR-010 安全更新**：協議與客戶端版本必須有簽章、回滾及最低版本政策。

---

## 11. 建議的邏輯元件

本節是設計邊界，不代表技術選型已確定。

```text
┌──────────────── Owner Device ────────────────┐
│ Owner Policy / Root Key                      │
│ Local Agent Runtime                          │
│ Secret & Provider Adapter                    │
│ Pricing / Repayment Strategy                 │
│ Sandbox / Optional Browser Worker            │
│ Encrypted Local Event Store                  │
└───────────────┬───────────────────────────────┘
                │ signed + encrypted messages
        ┌───────▼────────┐
        │ P2P Transport  │── Relay / DHT / PubSub
        └───────┬────────┘
                │
   ┌────────────▼────────────┐
   │ Agent Commerce Protocol│
   │ Task / Bid / Contract  │
   │ Delivery / Attestation │
   └──────┬─────────┬───────┘
          │         │
 ┌────────▼───┐ ┌───▼──────────────────┐
 │ Reputation │ │ Mutual Credit Ledger │
 │ & Indexers │ │ + Optional L2 Escrow │
 └────────────┘ └──────────────────────┘
```

架構提案至少需要說明：

1. Local Node Runtime。
2. P2P Transport 與 NAT Traversal。
3. Task／Bid／Negotiation Protocol。
4. Mutual Credit Ledger 與最終一致性。
5. Identity、Capability 與 Revocation。
6. Verification、Dispute 與 Reputation。
7. Stablecoin／Escrow 擴充層。
8. Indexer、Explorer 與 Owner Console。
9. 安全沙盒與資料隱私。

---

## 12. 待定資料模型

架構 Agent 可修改欄位，但必須保留等價能力。

### 12.1 AgentDescriptor

```json
{
  "agent_id": "did:key:...",
  "owner_policy_hash": "sha256:...",
  "wallets": ["eip155:8453:0x..."],
  "capabilities": ["inference.text", "code.test"],
  "endpoints": ["p2p://..."],
  "models": [
    {
      "model_class": "frontier-reasoning",
      "provider_disclosure": "optional-or-blinded",
      "context_limit": 200000,
      "data_policy": "no-retention"
    }
  ],
  "grant_expiry": "2026-09-06T00:00:00Z",
  "signature": "..."
}
```

### 12.2 TaskSpec

```json
{
  "task_id": "uuid-or-content-id",
  "requester": "did:key:...",
  "task_type": "inference.text",
  "requirements": {
    "quality_floor": "frontier-reasoning",
    "max_latency_ms": 30000,
    "max_context_tokens": 50000,
    "data_class": "confidential"
  },
  "acceptance": {
    "method": "schema+judge-quorum",
    "schema_hash": "sha256:...",
    "verifier_policy": "2-of-3"
  },
  "settlement": {
    "mode": "mutual-credit",
    "max_price_cc": 100,
    "stablecoin_fallback": false
  },
  "deadline": "2026-09-05T15:00:00Z",
  "expires_at": "2026-09-05T14:55:00Z",
  "signature": "..."
}
```

### 12.3 Bid

```json
{
  "task_id": "...",
  "provider": "did:key:...",
  "price_cc": 80,
  "estimated_start": "...",
  "estimated_finish": "...",
  "model_claim": "frontier-reasoning",
  "privacy_terms_hash": "sha256:...",
  "collateral_or_stake": null,
  "valid_until": "...",
  "signature": "..."
}
```

### 12.4 SettlementReceipt

```json
{
  "contract_id": "...",
  "delivery_hash": "sha256:...",
  "attestations": ["cid:...", "cid:..."],
  "postings": [
    {"account": "agent:A", "amount_cc": -80},
    {"account": "agent:B", "amount_cc": 78},
    {"account": "protocol:treasury", "amount_cc": 2}
  ],
  "reference_value": {"currency": "USD", "amount": "4.20"},
  "signatures": ["requester-signature", "provider-signature", "ledger-proof"]
}
```

---

## 13. 任務狀態機需求

```text
DRAFT
  → ANNOUNCED
  → BIDDING
  → AWARDED
  → RESERVED
  → RUNNING
  → SUBMITTED
  → VERIFYING
  → ACCEPTED
  → SETTLED
```

例外狀態至少包含：

```text
EXPIRED / CANCELLED / PROVIDER_FAILED / REJECTED / DISPUTED / REFUNDED
```

架構提案必須定義：

- 每個 Transition 的呼叫者、必要簽章與逾時。
- Network partition 時如何避免雙重成交或雙重支出。
- Provider 中途失敗時是否能由備援 Agent 接管。
- Verifier 無回應、意見分裂或惡意時的處理。
- Mutual Credit 與 Stablecoin 模式在狀態機上的差異。

---

## 14. Compute Credit 經濟需求

### 14.1 基本守恆

```text
Σ all account balances = 0
```

若系統收取 2 CC 費用，必須由付款方多承擔或服務方少取得，並記入 Treasury；不得無來源鑄造正餘額。

### 14.2 CC 不等同 raw token

不同模型與請求不可直接以 Token 數量一比一交換。定價至少可參考：

- 公開 API 參考成本。
- Input／Output／Cached Token 類型。
- 模型能力與歷史任務成功率。
- 上下文長度、工具使用與多模態能力。
- 延遲、可用率及額度到期時間。
- Prompt 資料敏感度與保留政策。
- Requester 違約風險。

最終成交價由 Agent 市場議價決定，參考現金價只用於透明度、風險與稅務評估，不構成固定兌現承諾。

### 14.3 信用額度

提案需提出可模擬的 Credit Line 演算法。至少應考慮：

```text
credit_limit = f(
  account_age,
  verified_contribution,
  completion_rate,
  counterparty_diversity,
  repayment_velocity,
  dispute_rate,
  stake_or_guarantee,
  sybil_risk
)
```

新 Agent 可採以下一種或多種方式取得小額初始信用：

- Owner 提供可退保證金。
- 既有會員 Vouch。
- 裝置／組織身分證明。
- 完成小型貢獻任務。
- 協議 Treasury 提供有上限的啟動額度。

### 14.4 防止囤積與永久赤字

提案必須處理：

- 正 CC 很多但市場沒有可購買服務。
- 使用者只借不還。
- 供應 Agent 為洗信用而互相交易。
- Owner 在負餘額後建立新身分逃逸。
- 額度月底到期造成供應價格短暫崩跌。
- 高品質模型持續輸出、低品質模型持續消耗的逆向選擇。

---

## 15. 執行環境與瀏覽器能力分級

### Level A：純推理

- 只接受 Prompt，回傳模型輸出。
- 無本機檔案、Shell、瀏覽器或帳號權限。
- MVP 首選。

### Level B：隔離程式執行

- 在短生命週期 Container／MicroVM 中執行。
- 限制 CPU、RAM、磁碟、時間及網路目的地。
- 不掛載 Owner 私人目錄。

### Level C：公開網頁瀏覽

- 使用乾淨、無登入狀態的隔離瀏覽器。
- 可抓取公開資料，但受 robots、網站條款與網路 Allowlist 限制。

### Level D：Owner 已登入服務

- 只能在 Owner 裝置的獨立 Browser Profile 中執行。
- 不對外傳送 Cookie、密碼或完整 Session。
- 使用動作級 Capability，例如 `facebook.create_draft`，而非提供任意瀏覽器控制。
- 發文、付款、刪除、私訊等高影響動作，MVP 預設不開放自主執行。

### Level E：高風險／不可逆行為

- 金融交易、法律承諾、帳號安全變更、資料永久刪除。
- 不列入 MVP；未來需額外政策引擎與明確授權。

---

## 16. 威脅模型最低範圍

架構提案需針對以下威脅提出具體控制，不接受只寫「使用加密」：

1. 惡意 Prompt 竊取 Provider API Key。
2. Requester 發送敏感或非法內容使 Provider 承擔風險。
3. Provider 偽造模型、用便宜模型冒充高品質模型。
4. Provider 收取 Credit 但不執行工作。
5. Requester 收到成果後惡意拒付。
6. Verifier 與交易一方串謀。
7. Sybil Agent 洗交易、洗聲譽或取得多份初始信用。
8. Replay Attack、雙重支出與過期 Bid 重放。
9. P2P Metadata 洩露 Owner 身分、工作內容或模型使用習慣。
10. 惡意 Artifact、依賴套件或程式碼逃逸 Sandbox。
11. 惡意 Indexer 隱藏報價、操控排序或提供過期資料。
12. Agent Wallet 被 Prompt Injection 誘導超額付款。
13. 負餘額 Owner 永久離線。
14. 協議升級、治理或 Treasury 被少數人控制。
15. 模型供應商封鎖疑似轉售流量。

---

## 17. 去中心化程度

提案不得只用「區塊鏈」一詞宣稱去中心化，必須逐層分析：

| 層級 | 問題 |
|---|---|
| Identity | 誰能建立、撤銷及恢復 Agent 身分？ |
| Discovery | 官方 Indexer 掛掉後是否仍能找到 Provider？ |
| Transport | NAT、Relay 與離線節點如何處理？ |
| Execution | 工作是否真正發生在 Owner 控制的環境？ |
| Verification | 誰選 Verifier？Verifier 如何被替換？ |
| Credit Ledger | 誰決定正確餘額？如何避免分叉與雙重支出？ |
| Reputation | 是否存在唯一不可質疑的評分服務？ |
| Governance | 誰能升級協議、凍結帳戶或處理漏洞？ |
| UI | 官方前端下架 Agent 後，其他客戶端能否繼續使用？ |

必須比較至少三種帳本方案：

1. Ethereum L2 Smart Contract。
2. P2P Signed Receipts + Periodic Net Settlement。
3. Federated Credit Circles／Appchain／Rollup 類方案。

最後提出 MVP 與長期架構的選擇理由。

---

## 18. 商業模式需求

網路優先促成互惠，不要求每筆交易都有現金，但仍需形成可持續的真實生意。

可評估的收入來源：

- Pro 會員：更高 Credit Line、自動還債、排程與進階策略。
- 官方 Hosted Relay／Indexer／Explorer。
- 官方安全 Sandbox、長時間 Runtime 或高可用節點。
- 企業私人 Credit Circle、稽核、SSO 與政策管理。
- Stablecoin 任務的低比例協議費。
- 仲裁、保證與風險池服務費。
- Agent Pricing／Routing／Reputation API。

商業限制：

- 免費互惠模式必須足以產生網路效應。
- 不得依賴偽造任務或補貼交易冒充自然需求。
- 測試、補貼及自成交量必須明確標示。
- 不把 CC 宣傳為投資、固定收益或可保證兌現資產。

---

## 19. MVP 範圍

### Phase 0：單機經濟模擬

- 模擬 100–10,000 個 Agent。
- 不呼叫真實付費模型。
- 驗證額度到期、緊急需求、報價、負餘額、違約與市場流動性。
- 產出關鍵指標：成交率、等待時間、Gini、負債週期、壞帳率、Credit Velocity。

### Phase 1：可信小圈實驗

- 3–20 個真實 Local Nodes。
- 只支援純文字推理或結構化摘要任務。
- API Key 只存在本機。
- 使用簡化的簽署收據與中央可替換 Indexer。
- CC 不可兌現；允許小額負餘額。

### Phase 2：P2P 與自動驗收

- 多 Relay／Indexer。
- Task、Bid、Delivery、Attestation 使用正式版本化協議。
- Deterministic Test + Judge Agent Quorum。
- 支援 Agent 自動還債與子任務。

### Phase 3：公開網路與穩定幣選配

- 引入保證金、Stake 或更強 Sybil Resistance。
- Ethereum L2 Stablecoin Escrow。
- 可攜式聲譽與公開 Explorer。
- 企業 Private Circle。

---

## 20. MVP 驗收標準

一個架構可進入實作，至少要證明：

1. 三個獨立節點可在不知道彼此 API Key 的情況下完成任務。
2. Requester 可從 0 CC 開始，在有限 Credit Line 內完成一次借用。
3. Requester 之後可替第三方完成任務並回補負餘額。
4. 全部餘額變動可由簽署事件重建且總和守恆。
5. 任一官方 Indexer 停止後，既有節點仍可恢復或轉用其他 Indexer。
6. 惡意 Task 無法讀取 Provider Key 或掛載 Owner 私人目錄。
7. 至少一種任務能以 deterministic verification 自動結算。
8. Agent 能在 Owner Policy 內自動發布、投標、選擇、執行與結算，無逐筆人工操作。
9. 測試交易、補貼交易與真實交易可被清楚區分。
10. 系統能輸出成交率、供需深度、違約率及平均還債時間。

---

## 21. 架構 Agent 必須回答的問題

1. Mutual Credit Ledger 如何在去中心化情況下避免雙重支出？
2. 為什麼需要或不需要 Blockchain？哪些資料上鏈？
3. 新 Agent 的初始信用從哪裡來，Sybil 成本是什麼？
4. 負餘額 Owner 消失時，誰承擔損失？
5. CC 如何跨模型、跨 Provider、跨任務類型定價？
6. 如何證明 Provider 使用了宣告的模型，而不暴露 API Key？
7. Prompt 與成果是否對 Provider、Verifier、Indexer 可見？
8. 哪些任務可以完全自動驗收？主觀任務如何處理？
9. Agent 如何安全地建立子任務與分帳，避免成本失控？
10. 如何處理 P2P 節點離線、NAT、重試及網路分割？
11. 哪些元件可以中央化以加快 MVP，又如何確保日後可替換？
12. 如何讓網路先有真實需求，而不是只有大量等待接案的 Agent？
13. 平台如何取得現金收入而不破壞互惠機制？
14. 如何符合模型供應商條款、隱私、稅務及消費者保護要求？
15. 12 週內可以實際驗證的最小閉環是什麼？

---

## 22. 架構提案必要交付物

每個架構 Agent 必須輸出一份完整提案，至少包含：

1. 一頁 Executive Summary。
2. 固定假設與自行新增假設。
3. C4 System Context 與 Container Diagram。
4. 核心元件責任與信任邊界。
5. UC-01、UC-02、UC-04 的 Sequence Diagram。
6. Task State Machine。
7. Identity、P2P、Ledger、Reputation、Verification 設計。
8. Mutual Credit 守恆與 Credit Line 演算法。
9. 資料模型及外部 API／P2P Message Schema。
10. 威脅模型與主要控制。
11. 故障模式與恢復策略。
12. 技術選型表及拒絕其他方案的理由。
13. MVP 里程碑、團隊角色及 12 週實作計畫。
14. 預估基礎設施成本與最可能的成本爆點。
15. 至少 10 項風險及降低方式。
16. Architecture Decision Records（至少五份）。
17. 可執行的 Prototype／Simulation 測試計畫。
18. 明確列出「現在不知道」的事項，不得假裝問題已解決。

圖表優先使用 Mermaid，以便後續合併與版本控制。

---

## 23. 三份獨立提案的視角

三個 Agent 都必須設計完整系統，不是只設計自己的單一模組；但各自採不同優化目標。

### Agent A：Decentralization-first

- 目標：最小化中央信任與不可替換元件。
- 優先研究 P2P Discovery、Signed Receipt、去中心化 Ledger、可攜聲譽及治理。
- 必須誠實量化去中心化造成的延遲、複雜度與成本。

### Agent B：MVP-first

- 目標：12 週內做出可以用真實 API 完成互惠借用與自動還債的最小閉環。
- 可以暫時中央化可替換元件，但必須提出清楚的抽換介面與遷移路線。
- 優先避免過早發幣、過度上鏈與過度泛化。

### Agent C：Adversarial economics-first

- 目標：假設參與者會作弊、洗量、違約、串謀與套利，仍讓經濟系統可存活。
- 優先設計 Credit Line、Sybil Resistance、Verification Market、壞帳處理及市場模擬。
- 必須指出哪些商業假設最可能錯誤，以及如何用實驗證偽。

---

## 24. 評選量表

| 面向 | 權重 |
|---|---:|
| 能否解決臨時額度耗盡的真實需求 | 20% |
| Key／帳密與本機環境安全 | 15% |
| Agent 自主閉環程度 | 15% |
| Mutual Credit 經濟可行性 | 15% |
| MVP 可實作性 | 15% |
| 去中心化與可替換性 | 10% |
| 驗收、反作弊與可稽核性 | 10% |

每個提案需提供自評分數；最終整合者需逐項比較，不可只選文件寫得最長者。

---

## 25. 競品與可借用標準

以下只作研究參考，不表示直接採用：

- Olas Mech Marketplace：Agent-to-Agent 服務與微付款。
- Virtuals Agent Commerce Protocol：Request、Negotiation、Transaction、Evaluation。
- OKX AI：Task Marketplace、Escrow、Evaluator Network。
- Surplus Intelligence：推理供需路由與 Provider Offer。
- WIR／Sardex：企業互惠信用、封閉流通與正式帳務。
- MCP：Agent 使用工具與服務介面。
- A2A：Agent 發現與協作通訊。
- x402：機器對機器按次付款。
- ERC-8183／ACP：Agent Job Escrow 與 Evaluator Attestation。
- ERC-8004 類規格：Agent Identity、Reputation、Validation。

提案需區分「可以沿用的標準」與「AMCN 必須自行解決的互惠信用問題」。

---

## 26. 目前最高風險假設

1. 額度用完的人是否願意承擔未來提供服務的義務？
2. 額度剩餘的人是否真的願意讓陌生任務消耗自己的 Provider 帳戶？
3. 模型供應商是否允許此種 Customer Application／代理服務模式？
4. 供應與需求是否會在時間、模型與語言上匹配？
5. 自動驗收是否足以防止低品質輸出淹沒市場？
6. Credit 的正餘額是否有足夠可用之處，還是最終仍必須現金兌回？
7. 全 Agent 自動議價消耗的 Token 是否可能高於被媒合的任務價值？
8. P2P 與鏈上成本是否會讓微型交易失去意義？
9. 使用者是否信任常駐本機 Agent 處理 API Key 與外部 Prompt？
10. 去中心化是否是核心需求，還是只需要「Key 不離開本機」？

架構設計的首要任務不是掩蓋這些風險，而是用最小成本安排可證偽實驗。

---

## 27. 最終設計判斷準則

若一個提案具備精美區塊鏈架構，卻無法讓以下閉環成立，即視為失敗：

```text
Agent A 額度耗盡
→ 自動向陌生 Agent B 借用推理能力
→ B 的 Key 全程留在 B 的裝置
→ 成果被機器驗收
→ A 形成有限負餘額、B 取得正餘額
→ A 額度恢復後，自動替 Agent C 工作
→ A 的負餘額被清償
```

AMCN 的核心不是 Token、區塊鏈或 Marketplace UI，而是這個由 Agent 自主完成的互惠信用循環。
