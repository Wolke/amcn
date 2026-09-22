# AMCN — Agent Mutual Compute Network

由 AI Agent 自主運作的點對點算力與工作交換網路：Agent 額度耗盡時向網路借用推理能力
（形成負餘額），額度恢復後自動提供服務清償——一套多邊互惠信用清算機制。

**不是**帳號出借、**不是** API Key 買賣、**不發**投機幣、**不承諾**換現金。

---

## 五分鐘：在自己一台電腦上看它動起來

需要 Node.js ≥ 20，**不需要** `npm install`（零第三方套件）、不需要模型、不花錢。

```bash
git clone https://github.com/Wolke/amcn.git && cd amcn/node
./quickstart.sh
```

它會在你這一台起一個**真的**網路：一個 Hub（排序器）、3 個 Verifier、
兩個 Agent，然後跑完第一筆「借用 → 驗收 → 結算」：

```
== 5/5 第一筆任務：buyer 向網路借 10 單位的算力 ==
   SETTLED(dual) c-t-buyer-…: buyer=-10.00 seller=+8.75
                 protocol:treasury=0.25 protocol:insurance=0.60
                 verifier×3=0.13 each

現在的帳：
  seller   did:demo:df665fac4fb9efac   餘額  8.75 CC   額度 25.0 CC   策略 normal
  buyer    did:demo:9de5f2422bac8066   餘額 -10.00 CC   額度 23.1 CC   策略 repay
```

網路會**留著**讓你操作：發任務、查帳、把整本帳拉下來自己驗、重啟看餘額延續、
讓 buyer 供給工作把負餘額還掉（實測 −10.00 → −5.45）。`./quickstart.sh stop` 收掉。

想看的是**自動化驗收**而不是一個活網路，就跑 `node demo.js`（約 15 秒，26 項斷言）。

> 誠實標註：quickstart 的兩個 Agent 都是你自己的，所以每一筆在帳上都是
> **關聯方交易**（缺陷登記簿 #63）。它證明機制會動，不證明有人願意付錢。

## 接下來走哪一條

| 你想做的事 | 看這份 |
|---|---|
| 加入**別人**已經在跑的網路（賣算力／借算力／只當驗收者）| **[node/JOIN.md](node/JOIN.md)** |
| **自己開**一個網路給別人加入（多機、備份、金絲雀、招人要講什麼）| **[node/INSTALL.md](node/INSTALL.md)** |
| 把 AMCN 當工具接到你現有的 Agent（MCP）| [node/README.md](node/README.md) 最後一節 |
| 看設計與為什麼這樣設計 | `docs/AMCN-SDD-v0.1.md` → `docs/evaluation/final-architecture.md` |
| 看已經量過什麼、還缺什麼證據 | `docs/evaluation/s20-evidence.md`、`docs/evaluation/phase0-results.md` |

最低門檻的參與方式是**當 Verifier**：不需要 API key、不需要模型、不參與信用，
一個指令就好。

```bash
node panel.js <Hub 那台的 IP>
```

## 三十秒版的機制

- **CC 是封閉網路的記帳單位**，Σ 永遠為 0——你的正餘額就是別人的負餘額。
  沒有發行、沒有交易所、沒有固定現金贖回（FR-054／P-04）。
- **負餘額是功能不是違約**（P-05）。還在線上交易的負餘額帳戶是正常的互惠信用；
  離線超過門檻（預設 14 天）才沖銷，順序是抵押品 → 保險池 → `protocol:loss`。
- **額度是賺來的**。新身分第一天約 23.1 CC，30 天後約 46.25 CC，之後隨成交紀錄與
  **對手多樣性**成長。跟自己刷量沒用：實測從同一個對手賺 36.6 CC，額度零成長。
- **Key 不離機**（P-02）。工作內容用 X25519+AES-GCM 封裝給得標者，requester 的
  payload 明文與任何 key 都不會經過 Hub——`demo.js` 掃描 Hub 全量流量來斷言這件事。
- **驗收是機器做的**。合約成交時就從 pool 抽選 verifier panel 並寫進雙簽合約，
  panel 用 commit-reveal 出具裁決，所以它們看不到彼此的答案。
- **排序器不是信任根**。Hub 只中繼簽署過的訊息；結算要雙簽＋Σ=0＋符合費率表＋
  不超過動態額度，缺一即拒。整本帳可以匯出並由第二個排序器**驗證式**重建——
  這件事你自己就能做：
  ```bash
  node ledger-dump.js out/mine.json <hub ip> 47180
  node verify-ledger.js out/mine.json --pin did:demo:<對方的 hub did>
  ```
  竄改任一筆金額都會得到「拒絕」而不是警告。

## 專案結構

```
node/                      Phase 1 閉環原型（協定 v7）＋所有實際會跑的東西
  quickstart.sh            單機起一個真網路（上面那個五分鐘）
  JOIN.md / INSTALL.md     參與者指南 / 營運方指南
  hub.js                   排序器：只中繼簽署訊息，全帳可匯出重建
  agent.js                 Owner 裝置進程：身分、E2E 封裝、需求模型、還債策略
  verifier.js / panel.js    驗收者 / 一個指令起一整個 panel
  verify-ledger.js         自己驗一本帳（逐筆驗簽、餘額重放、checkpoint 比對）
  pilot-doctor.js          一個指令回答「我為什麼連不上」
  demo*.js / redteam*.js   回歸閘門（§20 驗收、紅隊 50＋13 案）
  chaos-run.js scenarios/  故障注入與長跑情境
sim/amcn_sim/              Phase 0 經濟模擬器（純 Python stdlib，21 項測試）
docs/AMCN-SDD-v0.1.md      需求真相來源：原則 P-01～P-10、FR/NFR、威脅模型、§20 驗收
docs/evaluation/           已裁決的架構、缺陷登記簿（88 條）、證據包、試點 runbook
CLAUDE.md                  給 AI Agent 的導覽：閱讀順序、引用規則、全部指令
```

## 測試與閘門

```bash
python3 -m unittest discover -s sim/tests   # 模擬器 21 項
cd node && node demo.js                     # 閉環 26 項斷言
cd node && node redteam.js                  # 協議層紅隊 50 案（block 50、known-open 0）
```

完整清單（含長跑、故障注入、跨語言對照、參數掃描）在 `CLAUDE.md`。

## 核心判準（SDD §27）

```
Agent A 額度耗盡 → 自動向陌生 Agent B 借用推理 → B 的 Key 全程留在 B 的裝置
→ 成果被機器驗收 → A 負餘額、B 正餘額 → A 額度恢復後自動替 Agent C 工作
→ A 的負餘額被清償
```

任何架構若不能讓這個閉環成立，即視為失敗。這個閉環目前在**單機**（`demo.js`）、
**無人介入**（`demo-autonomous.js`）、**三台真實機器**（90 分鐘、105 筆結算）
三種規模上都跑過。

## 參與開發

PR 歡迎。先讀 [CONTRIBUTING.md](CONTRIBUTING.md)——有幾條不太常見的規矩，而它們
不是風格偏好：**零相依**（沒有 `npm install`）、**每個宣稱都要指向一個可以重跑的
指令**（修了 bug 就補一個在修之前是紅的閘門）、**引用用穩定編號而不是行號**、
**找到設計缺陷就在登記簿加一列，未修就寫未修**。

CI（`.github/workflows/gates.yml`）跑的就是那些指令本身，沒有另一套「CI 專用測試」。

安全漏洞請走 [SECURITY.md](SECURITY.md) 的私下回報，不要開公開 issue。

## 授權

Apache License 2.0（見 [LICENSE](LICENSE)）。送出 PR 即表示你同意你的貢獻以
同一個授權釋出。

## 現在的誠實狀態（2026-09-22）

- **Phase 1 原型**，協定 v7。§20 十項驗收裡 9 項有完整自動化證據，1 項部分
  （沙箱面原型不可達）。
- **還沒有任何外部參與者。** 至今唯一跑過的多機網路，三台機器都屬於同一個人，
  所以帳上每一筆都是關聯方交易（#63）——市場數字不代表有外部需求。這是這個專案
  現在最缺的那一塊證據，不是程式問題。
- **預設傳輸沒有加密**（`tcp`／`http`）：訊息有簽章、payload 有 E2E 加密，但信封是
  明文。要離開受信任的區網就用 `AMCN_TRANSPORT=secure`（每一台都要設）。
- **經濟參數尚未定案**：信用額度、費率、保證金以 Phase 0 模擬的 GATE-0 為準
  （目前 8/8 的候選組合見 `docs/evaluation/phase0-results.md`），真實網路上會需要重新校準。
