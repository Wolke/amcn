# AMCN Phase 1 最小閉環原型

整合計畫（`docs/evaluation/final-architecture.md` §5）W6–W8 里程碑的縮小可執行版：三個獨立 OS 進程的 Agent＋一個 Coordination Hub，跑通 SDD §27 閉環並自動驗收。零第三方相依（Node.js ≥ 20，`node:crypto` Ed25519＋TCP JSON-lines）。

## 執行

```bash
cd node
node demo.js    # 約 5 秒，輸出 7 項 §20 驗收檢查
```

## 展示的閉環（SDD §27）

```
A 額度耗盡 → 發布任務（UC-01）→ 陌生人 B 得標、用「只存在 B 進程」的
API key 本機執行 → sha256 確定性驗收 → 雙簽收據 → A = -80、B = +78
→ A 額度恢復，以還債折扣價供應（UC-02）→ 搶贏 B、服務第三方 C
→ A 負餘額 -80 → -24.4（多邊清算：還給網路，不是還給 B）
```

## 對應 SDD §20 驗收（demo 自動斷言）

| §20 | 檢查 | 方法 |
|---|---|---|
| 1/6 | Key 不離機 | Hub 記錄全部協議原始流量，掃描不含任何 API key 字串 |
| 2 | 從 0 CC 在信用額度內借用 | A 結算後 -80，未超過 100 CC credit line |
| 3 | 替第三方工作回補負餘額 | A 的收入來自 C 的任務，非債主 B |
| 4 | 帳可由簽署事件重建且 Σ=0 | 從雙簽收據重建全部餘額並比對 Hub 帳 |
| 7 | 確定性驗收自動結算 | output == sha256(payload)，通過才簽收據 |
| 8 | 零人工介入 | 全程政策計時器驅動，無互動輸入 |

## 架構對應（與 final-architecture §2.2 一致）

- **Hub＝第一個排序器，不是信任根**：只中繼簽署訊息；結算必須雙簽、postings Σ=0、不得超過 credit line，缺一即拒。全帳可 export 重建。
- **Agent＝Owner 裝置上的進程**：Ed25519 身分（did:demo 前綴）、API key 只存在進程記憶體、adapter 無 key 拒絕執行、`usage_proof` 用 HMAC 證明用了 key 而不暴露 key。
- **驗收 deterministic-first**：mock adapter 的輸出是 `sha256(payload)`，requester 本地重算比對——換成真模型後，此路徑對應提案 B 的驗收 DSL（test-suite / schema assert）。

## 誠實簡化清單（Phase 1 正式版要補的）

- mock adapter：真版本換成 OpenAI-compatible client＋本機 Keychain 取 key。
- payload 明文經 Hub：真版本 E2E 加密（Hub 只見 metadata）。
- credit line 是 Hub 設定的常數：真版本用 `sim/amcn_sim` 定案的 E_eff 公式＋風險費。
- 無 per-account hash chain / checkpoint、無爭議路徑、無 Verifier quorum（demo 的驗收是 requester 本地確定性測試）。
- 合約單簽（requester）、收據才雙簽：正式版兩者皆雙簽＋pre_authorization。
