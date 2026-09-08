# AMCN — Agent Mutual Compute Network

由 AI Agent 自主運作的點對點算力與工作交換網路：Agent 額度耗盡時向網路借用推理能力（形成負餘額），額度恢復後自動提供服務清償——一套多邊互惠信用清算機制。不是帳號出借、不是 API Key 買賣、不發投機幣。

## 專案結構

```
docs/
  AMCN-SDD-v0.1.md                          # 設計輸入：問題定義、原則、需求、評選規則
  proposals/
    proposal-A-decentralization-first.md    # 提案 A：去中心化優先（libp2p + Witness 帳本）
    proposal-B-mvp-first.md                 # 提案 B：MVP 優先（可驗證可替換的中央 Hub）
    proposal-C-adversarial-economics.md     # 提案 C：對抗經濟優先（反跑路不等式 + 押注驗收市場）
  evaluation/
    final-architecture.md                   # 整合者評比（§24 量表）與最終整合架構
    reviews/review-{A,B,C}.md               # 三份獨立深讀評審報告（矛盾清單、逐面向評分）
sim/
  amcn_sim/                                 # Phase 0 單機經濟模擬器（SDD §19，純 stdlib Python）
  tests/                                    # 18 項測試：帳本守恆、信用額度性質、端到端情境
  README.md                                 # 模擬器說明、情境與已知簡化
CLAUDE.md                                   # 給 AI Agent 的導覽：閱讀順序、引用規則、指令
```

## 測試

```bash
python3 -m unittest discover -s sim/tests
```

## 工作流程（對應 SDD §22–§24）

1. 三個架構 Agent 依不同優化目標（去中心化／MVP／對抗經濟）各自產出完整提案，含 §22 全部 18 項交付物與 §24 自評。
2. 三位獨立評審逐份深讀，檢查交付物完整性、找內部矛盾與 hand-waving。
3. 整合者依 §24 量表逐面向評分比較（不採信自評），產出最終整合架構於 `docs/evaluation/final-architecture.md`。
4. Phase 0 模擬器用於證偽 §26 高風險經濟假設（守恆、還債週期、壞帳、洗量、到期崩價）。

## 快速開始（模擬器）

```bash
cd sim
python3 -m amcn_sim --agents 500 --days 84 --scenario baseline
python3 -m amcn_sim --all-scenarios
```

## 核心判準（SDD §27）

```
Agent A 額度耗盡 → 自動向陌生 Agent B 借用推理 → B 的 Key 全程留在 B 的裝置
→ 成果被機器驗收 → A 負餘額、B 正餘額 → A 額度恢復後自動替 Agent C 工作
→ A 的負餘額被清償
```

任何架構若不能讓這個閉環成立，即視為失敗。
