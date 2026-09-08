# AMCN Phase 1 閉環原型

整合計畫（`docs/evaluation/final-architecture.md` §5）W4–W8 里程碑的可執行版：三個獨立 OS 進程的 Agent＋一個 Coordination Hub，跑通 SDD §27 閉環並自動驗收 8 項判準。零第三方相依（Node.js ≥ 20）。

## 執行

```bash
cd node
node demo.js    # 約 5 秒，8 項驗收檢查（§20 縮小版＋Phase 1 追加）
```

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
