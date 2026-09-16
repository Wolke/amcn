# 三台機器試點與拔線演練 runbook

| 欄位 | 內容 |
|---|---|
| 文件 | 三台機器的試點配置、驗證清單，與 W10 拔線演練程序 |
| 日期 | 2026-09-16 |
| 對應 | final-architecture §5 W10（拔線演練）、§4 #31（panel 同機）、§4 #40（無重連）|
| 分兩階段 | **階段 A**：三台跑起來、panel 獨立——今天就能做，關閉 #31。**階段 B**：4 小時拔線演練——需先修 #40，見 §5 |

---

## 1. 為什麼第三台要跑 panel

第三台最有價值的用途不是再開一個交易 Agent，而是承載 Verifier panel。理由在 §4 #31：三個 Verifier 與交易雙方同機時，同一台機器、同一個 OS、同一個 process owner、同一個故障域——單點故障或單一入侵即可同時控制整個 panel，而 FR-041 的隨機抽選存在的意義正是防這件事。在那個狀態下，「2-of-3 quorum」只存在於協議層，部署層是裝飾。

| 機器 | 角色 | 埠 | 為什麼 |
|---|---|---|---|
| **M1** | Hub＋交易 Agent m1 | 47180（Hub）、47201（Console）、47179（UDP beacon）| 「官方基礎設施」。階段 B 要拔的就是它 |
| **M2** | 交易 Agent m2（＋階段 B 的待命 Hub、匯出拉取）| 47202（Console）| 交易對手。待命 Hub 放這裡而不是 M3，是為了讓 M3 保持乾淨的單一用途 |
| **M3** | Verifier panel ×3 | 無對外埠（只出站連 Hub）| 關閉 #31。Verifier 不需要 API key、不需要模型、不參與信用 |

M1 與 M2 **都要同時買也同時賣**。這不是對稱美學：`demo-autonomous.js` 的註解記錄了教訓——單向需求會養出只收不付的吸收端（FR-056「正餘額無處可花」），其他人撞上信用上限，閉環就停了，而且測試會綠燈通過一個壞掉的經濟。

---

## 2. 前置檢查（每台都做）

```bash
node --version                 # 需 ≥ v20
ipconfig getifaddr en0         # macOS：記下 M1 的區網 IP
date                           # 三台時鐘差 < 60 秒（beacon 簽章的容許窗）
```

- 三台同一區網（同路由器／同 SSID）。訪客網路、VLAN 隔離、Wi-Fi client isolation 會擋 UDP 廣播——手填 IP 不受影響。
- macOS 第一次啟動 Hub 會問「允許接受連入網路連線？」→ 允許。Windows 上若用 `hubHost: "discover"`，允許入向 UDP 47179。
- 每台都要有 `node/` 目錄（`scp -r`、AirDrop、私人 repo clone 皆可）。

---

## 3. 階段 A：跑起來（約 15 分鐘）

**身分一定要設 seed。** 範本裡的 `seed` 欄位不是可選項——沒有它，每次重啟都產生新 DID，舊身分帶著餘額被棄置，帳上留下永不償還的洞（§4 #17 試點實測留下 −10 CC 的債與 +16.52 CC 花不掉的正餘額）。Verifier 更嚴重：重啟即棄置已託管的押注（#28）。

### 3a. M1：Hub

```bash
cd ai-exchage/node
HUB_SEED='pilot-hub-CHANGE-ME' \
HUB_DUMP_PATH=out/ledger.json \
HUB_DUMP_MS=60000 \
HUB_BIND=0.0.0.0 node hub.js
```

`HUB_DUMP_MS=60000`（預設 10000）是刻意的：試點的交易節奏比 demo 慢 33 倍，每 10 秒重寫整本帳只是在放大 #41。

**要看到**：`[hub] listening on 0.0.0.0:47180 — tcp transport, protocol v1, hub did did:demo:xxxx…`
把那個 `hub did` 抄下來——它是 `hubPin` 要填的值，也是階段 B 判斷「接手的 Hub 是否同一個身分」的依據。

### 3b. M3：Verifier panel（先於交易 Agent）

```bash
cd ai-exchage/node
AMCN_PANEL_SEED='pilot-panel-CHANGE-ME' node panel.js 192.168.1.10
```

順序有意義：`judge-quorum` 的任務在 pool 少於 3 位在線 Verifier 時**不會得標**（#37 的修復），所以 panel 必須先在。

**要看到**：M3 印出 3 個 DID 與 `registered as verifier`；M1 的 Hub 印出三筆 `registered ... (verifier)`。

### 3c. M1、M2：交易 Agent

```bash
# M1
cd ai-exchage/node
cp configs/pilot-m1.example.json configs/pilot-m1.json
# 編輯：seed 改成你自己的字串
AMCN_PROVIDER_KEY='sk-test-anything' node agent.js configs/pilot-m1.json

# M2
cd ai-exchage/node
cp configs/pilot-m2.example.json configs/pilot-m2.json
# 編輯：seed 改掉、hubHost 改成 M1 的 IP
AMCN_PROVIDER_KEY='sk-test-anything' node agent.js configs/pilot-m2.json
```

`sk-test-anything` 只是佔位字串：adapter 是 key-gated（那個 gate 本身就是 P-02 的示範），但 `baseUrl: null` 時走確定性 mock，不呼叫任何模型、不花錢。接真實模型會讓 `sha256_eq` 驗收失敗，見 INSTALL §5。

**要看到**：`registered, dynamic credit line 46.3 CC`（46.3 不是錯誤，見 INSTALL §1d）、`supply armed at ... CC/unit`。約 2 分鐘內出現第一筆 `own quota exhausted → posting`——這是 UC-01 的觸發，來自 agent 自己的額度模型，不是時間表。

### 3d. 驗證 #31 真的關掉了

不是「M3 有跑」就算，要驗 panel **確實只由 M3 的身分組成**：

```bash
# 在 M1 或 M2
curl -s http://127.0.0.1:47201/status | python3 -m json.tool | head -40
```

三項證據：

1. M1 的 Hub log 中三筆 `registered ... (verifier)` 的來源是 M3（M1 上不應該有任何 `verifier.js` 在跑——如果之前照 INSTALL §1c 起過，**先停掉**，否則 pool 會有 6 個而 panel 仍可能抽到同機的）。
2. 結算的收據裡 `verifier_pool` 的三個 DID 與 M3 印出的三個 DID 相同。
3. 實際出具 attestation 的 DID 全在那三個之內。

第 3 點才是重點：panel 由 Hub 從未來 checkpoint 的 root 重新推導（#6），不採信合約名單，所以這條等於驗證了「抽選確實從獨立故障域抽」。

---

## 4. 階段 A 要記錄什麼

跑 1–2 小時（不必 4 小時，那是階段 B 的事），記下：

| 項目 | 怎麼取 | 為什麼要記 |
|---|---|---|
| 結算筆數、Σ 餘額 | Hub log，或 `node ledger-dump.js out/snap.json` | Σ 必須為 0，否則守恆破了 |
| 每台的餘額／信用額度／mode | `curl 127.0.0.1:4720{1,2}/status` | 有沒有人卡在信用上限（閉環停止的徵兆）|
| 還債週期數與平均時間 | Console 的 `strategy.repay_episodes` / `avg_repayment_ms` | §20-10，而且這是「閉環真的閉合」的唯一證據 |
| `out/ledger.json` 大小隨時間 | `ls -l out/ledger.json` 每 15 分鐘 | **這就是 #41／紅隊 G9 的量測**，決定 rawLog 要不要設上限 |
| Hub 的 RSS | `ps -o rss= -p <pid>` | 記憶體是否無上限成長 |
| 同價決勝是否偏袒 | 收據裡的 provider 分布 | #23：同質價格市場會贏者全拿。m1/m2 價格不同（1.0 vs 0.95）所以這裡看的是 0.95 是否全拿 |

記完就是 W12 §20 證據包的第一批真實素材——現在的所有數字都來自秒級 demo。

---

## 5. 階段 B：4 小時拔線演練（**需先修 #40**）

**為什麼現在還不能跑**：沒有任何重連機制（#40）。`resolveHubTarget` 只在啟動時解析一次，channel 死掉後沒有人重新撥號，而 `chan.send()` 只回傳 `false` 且所有呼叫端都忽略它。所以拔掉 M1 的網路線之後，M2 與 M3 的所有 process 會**靜默失聯**：不重連、不重新發現、不出聲，Console 還顯示最後已知餘額。這種狀態下演練量到的是「人手動重啟 N 個 process 要多久」，不是 §2.1 退場三件套能不能運作。

另外兩項前置不需要改程式：

**(a) 匯出必須先離開 M1。** `HUB_DUMP_PATH` 寫本機檔，而要被拔線的正是那台——備份跟著災難一起消失。M2 定時拉一份：

```bash
# M2，每 60 秒拉一次
while true; do
  node ledger-dump.js out/pulled-$(date +%H%M%S).json 192.168.1.10 47180
  sleep 60
done
```

**(b) 接手的 Hub 用誰的身分。** 被 `hubPin` 釘住的 agent 依設計拒絕任何非 pinned DID（不會退回 localhost，這正是 pin 的用途）。兩條路，演練必須記錄走的是哪一條：
- 把 `HUB_SEED` 預先複製到 M2 → 接手的 Hub 是同一個 DID，pinned agent 無痛跟隨。代價：「第一個排序器」的鑰匙成為兩台共有的秘密。
- 不複製 → 接手的 Hub 是新 DID，所有 pinned agent 要手動重新 pin。代價：輪替不是自動的。

### 演練程序

| 時點 | 動作 | 記錄 |
|---|---|---|
| T+0 | 階段 A 的配置跑起來，M2 開始定時拉匯出 | 起始餘額、CL、checkpoint 序號 |
| T+0→2h | 正常自主交易，不干預 | 每 15 分鐘一次 §4 的表 |
| T+2h | **拔掉 M1 的網路線**（不是 kill 進程——A §18 要的是拔線：進程還活著、只是不可達，這是真實故障的形狀）| 各台第一個異常訊息與時間；當時卡在 `VERIFYING` 的合約後來怎麼收場 |
| T+2h+ε | M2 以最後一份拉到的匯出啟動 Hub：`HUB_IMPORT=out/pulled-xxxx.json HUB_SEED=... HUB_BIND=0.0.0.0 node hub.js` | 匯入是否通過驗證（逐筆驗簽、鏈重算、CL 重放）；餘額與斷線前是否一致 |
| | M2／M3 的 agent 與 panel 指向新 Hub | 需要手動重啟幾個 process、花多久（#40 修好後這一格應該是 0）|
| T+2h→4h | 在接手的 Hub 上繼續交易 | 是否恢復成交；CL 是否延續；`demo-rebuild.js` 的重建是否仍通過 |
| 全程 | **M1 不得再接回同一網段** | 否則測到的是雙排序器分叉，不是接手 |

### 三台也測不到的

- **併發排序器**：M1 的 Hub 進程在拔線後還活著。若它與任何 agent 仍在同一網段，就是兩個排序器同時存在——所以 M1 必須完全隔離。真正的 Witness 聯邦（§2.2 Phase 2）不在本次範圍。
- **三方以上清算**：只有 M1／M2 兩個交易 agent，三角清算測不到。要測就得在 M3 上加第三個 agent，但那會讓 panel 重新與交易共域，把 #31 換回來——這個取捨要明確選，不要兩邊都想要。
- **威脅 14（治理）／威脅 10（sandbox）／威脅 15（供應商封鎖）**：原型沒有標的，見紅隊盤點 §3。
