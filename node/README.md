# AMCN Phase 1 閉環原型

整合計畫（`docs/evaluation/final-architecture.md` §5）W4–W8 里程碑的可執行版：三個獨立 OS 進程的 Agent＋一個 Coordination Hub，跑通 SDD §27 閉環並自動驗收 8 項判準。零第三方相依（Node.js ≥ 20）。

## 執行

```bash
cd node
node demo.js              # 約 15 秒，16 項驗收（腳本驅動，回歸閘門）
node demo-autonomous.js   # 約 20 秒，12 項驗收（W8：全程零人工）

# 兩者可與跑中的試點並存：
DEMO_PORT_OFFSET=100 node demo.js
```

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
| `adapter.js` | FR-031 OpenAI-compatible HTTP client；key 只在進程記憶體，無 baseUrl 時退回確定性 mock |
| `lib/keystore.js` | P-02 金鑰解析：macOS Keychain（`AMCN_USE_KEYCHAIN=1`）→ env fallback |
| `lib/e2e.js` | NFR-005：X25519 ECDH（ephemeral）＋HKDF＋AES-256-GCM |
| `lib/eeff.js` | 與 `sim/amcn_sim` 同構的 E_eff 信用公式（starter 50、風險費 6%/2%——GATE-0 掃描定案參數）＋保險池 |
| `fake-provider.js` | 本機 key-gated OpenAI-compatible 端點，讓真 HTTP 路徑可測而不花錢 |
| `lib/strategy.js` | FR-055 目標餘額區間＋還債排程器：`[low, high]` 預設 `[-0.3×CL, +100]`，跌破 low 則供給折價、暫停非必要消費；§20-10 平均還債時間 |
| `lib/discovery.js` | §2.1「協議內發現與輪替」的區網部分：Hub 簽署 UDP 信標，Agent 以 `hubHost: "discover"` 自動尋找並可用 `hubPin` 釘住身分（跨機尚未驗證，見 §4 #18）|
| `lib/demand.js` | W8 無人觸發源：自有額度／需求模型，額度耗盡（UC-01 步驟 1）自動轉為任務；含 Owner 預算上限與週期相位錯開 |
| `panel.js` / `panel.cmd` | 專用 Verifier panel 主機（INSTALL §6）：探測 Hub、啟動 N 個 Verifier、全數註冊後回報、Ctrl-C 一次停完。跨平台，Windows 免改 PowerShell 執行原則 |
| `demo-autonomous.js` | W8 驗收：§27 閉環全程零人工（12 項斷言）。無 `posts` 時間表、無 Console 呼叫 |
| `mcp-server.js` | §23.1 需求側入口：MCP server（JSON-RPC over stdio，協議 2025-06-18），三個 tool `amcn_balance` / `amcn_publish_task` / `amcn_request_inference`。不持有任何金鑰，只經 127.0.0.1 的 Owner Console 操作本機 Agent |

## Demo 自動斷言（11 項）

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

## 誠實簡化清單（正式版要補的）

- Verifier 是確定性 judge（跑 DSL asserts）：主觀任務需 LLM judge＋commit-reveal（訊息流已就位，換 verifier 內核即可）。
- 爭議路徑只有「強制結算」一條：FAIL 後的 DISPUTED／仲裁／押金沒收未實作。
- Verifier 無報酬 posting（違反 FR-057 精神，demo 從簡）；正式版按整合架構把驗證費列入收據。
- Panel seed 用「最新」checkpoint root，有 grinding 風險（評審 A-④）：正式版綁未來輪 checkpoint＋commit-reveal。
- credit line 的 age factor 固定為 1（demo 跑秒級）；風險費率靜態二檔，正式版依 GATE-0 結論做動態定價。
- 無心跳/逾時/備援重發（PROVIDER_FAILED 路徑）；Console 為唯讀 JSON，無政策編輯。

## 把 AMCN 當工具用（MCP，§23.1）

讓你現有的 Claude／自建 Agent 直接對 AMCN 下單。先啟動一個帶 Console 的本機 Agent，再把這個 server 指向它：

```bash
AMCN_CONSOLE=http://127.0.0.1:47203 node mcp-server.js
```

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
