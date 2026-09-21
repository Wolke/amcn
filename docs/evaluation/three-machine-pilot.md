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

**M3 要挑最穩的那台機器。** panel 離線時 pool 在線人數為 0，judge-quorum 任務會被 Agent 端拒絕得標（#37），也就是**全網停止成交**——試點實測發生過一次：M3 整台離開網路，三個 Verifier 同一秒斷線，之後每筆任務都沒有結果。修好 #40 之後它們會在 M3 回到網路時自行重連，不需要人登入那台做任何事，但那段空窗期是真的沒有交易。

**注意：範本的兩台設定是同質的（同需求、同容量），那是小網路的最壞情況。** 模擬與 chaos 情境都顯示（登記簿 #64），小網路能不能活取決於每個參與者的需求與自身容量是否相稱；同質人口意味著沒有人是結構性淨賣方，所有人一起往下漂。真實試點若要看典型行為而不是最壞行為，就把兩台的 `policy.quota.capacityUnits` 與 `policy.demand.meanUnits` 按**同一個比例、不同規模**設定（例如 40/5 與 56/7），而不是完全相同，也不要讓比例不同——比例不同會製造永久債權人與永久債務人，比同質更糟。

M1 與 M2 **都要同時買也同時賣**。這不是對稱美學：`demo-autonomous.js` 的註解記錄了教訓——單向需求會養出只收不付的吸收端（FR-056「正餘額無處可花」），其他人撞上信用上限，閉環就停了，而且測試會綠燈通過一個壞掉的經濟。

---

## 1b. 本次試點的實際配置（2026-09-21）

| | 位址 | 連線 | 跑什麼 |
|---|---|---|---|
| **M1** | 192.168.50.30 | 有線（en0）| Hub、`pilot-m1`、`pilot-m1b` |
| **M2** | 192.168.50.175（`macbookair`）| Wi-Fi | `pilot-m2`、`pilot-m2b`、**待命 Hub（未啟動）**、匯出拉取器 |
| **M3** | 192.168.50.44 | LAN（Windows）| Verifier panel ×3 |

三台同網段 `192.168.50.0/24`，所以 UDP 信標可達（跨網段就要改用 rendezvous）。

**為什麼 Windows 拿 panel**：只有 Hub 會 `listen`，agent 與 verifier 都是往外 dial，所以 panel **完全不需要 inbound TCP**，只要一條 **UDP 47179 inbound** 讓它收得到信標。把最麻煩的防火牆配給最不需要開埠的角色，同時滿足 #31。

```
HUB_SEED = amcn-pilot-2026-09-21
hub DID  = did:demo:65f50dce855438dd      ← 已預先算出，可在 Hub 首次啟動前就 pin
```

**M1 有兩個介面在同一網段**（en0 192.168.50.30、en1 192.168.50.103），Hub 可能廣播錯的那個，所以啟動時明確指定 `HUB_BIND=0.0.0.0 HUB_ADVERTISE_HOST=192.168.50.30`——實測信標會送到 `192.168.50.255` 與 `127.0.0.1`。

**已在 M1 單機驗過整條路**：Hub 起在該 DID、信標廣播、三個 verifier 以 `discover`＋pin 找到並註冊、兩個 agent 註冊、Console 回報額度。

---

## 1c. 起 panel 之後，一定要從 Hub 那一側確認（實戰教訓）

panel 印出「全部 3 個 Verifier 已向 Hub 註冊」**不等於它們在 pool 裡**。兩個理由：
(a) #49 要求 client 回 `register_ack` 證明它聽得到，沒回的不算 online、不進 pool；
(b) 舊版的 client 可能在收到確認之前就印那句。

**2026-09-21 的試點第一次起 panel 就踩到**：M3 回報三個都註冊了，而 Hub 的 pool 是 **0**——M3 跑在 v5、Hub 是 v6，三個 verifier 在重連迴圈裡每 5 秒被版本閘門擋一次，57 次之後才被發現。閘門本身運作正常（訊息明確指出 v5 對 v6），只是**沒有人去看 Hub 那一側**。

所以每次起完 panel，在 Hub 那台跑：

```bash
cd node && node -e "
const t=require('./lib/transport').get('tcp');
const c=t.dial({host:'127.0.0.1',port:47180});
c.onMessage((m)=>{ if(m.type!=='verifiers') return;
  console.log('pool:', m.verifiers.length, '個');
  m.verifiers.forEach(v=>console.log('  ', v.did));
  c.close(); process.exit(0); });
c.send({type:'list_verifiers'});
setTimeout(()=>{console.log('無回應');process.exit(1)},5000);"
```

`pool: 3 個` 才算成功。同時掃一眼 Hub 的 log 有沒有 `rejected`：

```bash
grep -c "rejected" logs/hub.log      # 期望 0
```

**這也是「三台必須同 commit」為什麼列在最前面**——版本不符不會靜默半通，但它的症狀出現在**被拒絕的那一端看不到的地方**。

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

### 2b. Windows 機器（任一角色都可能是）

本文件其餘指令寫成 macOS 形式，但試點的任一台都可能是 Windows（INSTALL §6）。**跨平台的做法是一切經由 `node`**，不要依賴 shell 工具：

| 要做的事 | macOS / Linux | Windows（cmd 與 PowerShell 皆可）|
|---|---|---|
| 查自己的 IP | `ipconfig getifaddr en0` | `ipconfig`（看「IPv4 位址」）|
| 看設定檔指向哪、順便驗 JSON | `grep hubHost configs/x.json` | `node -e "const c=require('./configs/x.json');console.log(c.hubHost,c.hubPort)"` |
| 測 Hub 是否可達 | `nc -vz <ip> 47180` | `node ledger-dump.js out\probe.json <ip> 47180`（同一條傳輸路徑，比 port 掃描更有意義）|
| 測 TCP 埠 | 同上 | `powershell -Command "Test-NetConnection <ip> -Port 47180"` |
| 查 Console | `curl -s 127.0.0.1:47201/status` | `powershell -Command "irm http://127.0.0.1:47201/status \| ConvertTo-Json -Depth 5"` |

環境變數的設法是**最容易踩的一格**——bash 的 `VAR=x node ...` 前置寫法在 PowerShell 會被當成指令名稱：

```powershell
# PowerShell
$env:AMCN_PROVIDER_KEY='sk-test-anything'
node agent.js configs\pilot-m2.json
```

```
REM Command Prompt
set AMCN_PROVIDER_KEY=sk-test-anything
node agent.js configs\pilot-m2.json
```

同一類問題已經在 §4 #32 記錄過一次（Verifier 需要 shell 引號的 JSON，而 bash 的單引號形式在 PowerShell 不成立），當時的修法就是讓 `agent.js`／`verifier.js` 都接受**設定檔路徑**。所以 Windows 上永遠用檔案傳設定，不要用 `AGENT_CONFIG` 環境變數塞 JSON。

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

### 3c-2. 第三個交易 Agent（選配，但會明顯提高成交率）

兩個交易 Agent 的問題在試點實測出來了：買方缺料的時刻，賣方往往也沒有餘量可賣——出價前要求 `quota.remaining >= units`（#22），而兩邊需求都接近滿載時湊得出 8u 餘量的機率很低。實測**每筆任務約 5 分鐘一次，且經常 `no bids`**，階段 A 的樣本數會不夠。

兩個對策都已納入範本：

1. `maxUnitsPerTask` 由 8 降為 **4**，讓瘦的賣方也接得下。
2. 在 **Hub 那台**再開一個交易 Agent：

```bash
cd ai-exchage/node
cp configs/pilot-m1b.example.json configs/pilot-m1b.json    # 改 seed
AMCN_PROVIDER_KEY='sk-test-anything' node agent.js configs/pilot-m1b.json
```

**交易角色可以同機**——需要獨立故障域的是 Verifier panel（#31），不是交易雙方。範本的賣價刻意與 `pilot-m1` 不同（1.05 vs 1.0）：同價會讓選標退回到到達順序決勝（#23），先啟動者系統性勝出，那是啟動順序而不是市場性質。額度週期相位也錯開（30s），讓 burst 落在不同時間。

（這一節的存在本身是個提醒：`demo-autonomous.js` 用三個 Agent 是有原因的，而它的註解早就寫了——「單向需求會養出吸收端」「burst 要落在不同時間」。試點用兩個，就把那兩個條件同時放掉了。）

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

## 5. 階段 B：4 小時拔線演練（**前置已全部解除，2026-09-21**）

~~**需先修 #40**~~ **#40 已交付**：client 每次重試都重新解析目標，斷線會被偵測並記錄，`demo-reconnect.js` 8/8（含「無人介入即自行重連 6/6」）。原本擋住這一節的理由——「拔線後所有 process 靜默失聯，演練只會量到人手動重啟要多久」——已經不成立。

**這一節現在唯一缺的就是你的時段與那三台機器。** 其餘前置在 2026-09-19／20 之間補齊了：

- **#42 時間戳**：每一行 log 都有 ISO-8601，才量得出「多久發現」。
- **#45／rendezvous**：Hub 換位址後，client 憑**簽署的** rendezvous 記錄自行跟上（`scenarios/hub-moves.json` 已驗）。比 UDP 信標更適合跨網段。
- **#41 分頁匯出**：`ledger-dump.js` 現在會自動分頁，所以下面那個定時拉取在匯出超過 16MB 之後**仍然拿得到帳**——在此之前它會靜默斷線、什麼都拉不到，而那正是最需要它的時候。
- **#74／#78 快照＋尾檔**：接手的 Hub 從快照＋尾檔重建，`at` 不再遺失、root 對得上（否則 `rebuild()` 會拒絕啟動）。
- **單機四小時基準線已有**：`scenarios/soak-4h.json` 7/7（13,026 筆結算、匯出 51.1 MB、快照間隔被預算拉到 523 s）。三台機器的節奏比單機慢很多，所以**不要拿那些絕對數字當期望值**——它的用途是「同樣的機制在四小時尺度上沒有壞掉」，真機要量的是位址、時鐘、拔線這些單機測不到的東西。

**三台機器全部必須跑同一個 commit。** 協定現在是 **v6**（#41 把 `cp.heads` 移出簽署內容），而版本不符會被明確拒絕（`#33` 的版本閘門），不會靜默半通。先在三台上 `git log --oneline -1` 對過再開始。

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

### 三台機器的結構問題（先解決，否則演練量不到東西）

M1 上跑著 Hub **與兩個交易 Agent**。拔掉 M1 就同時拿掉了排序器和三個交易者中的兩個——接手之後只剩 M2 一個交易者，而 Agent 不會對自己的任務出價，所以「交易是否恢復」根本量不到。

解法是**演練前把第二個交易者搬到 M2**，並讓待命 Hub 也在 M2：

| 機器 | 演練前 | 拔線後 |
|---|---|---|
| M1 | Hub、m1、m1b | （離線，不得再接回同一網段）|
| M2 | m2、**m2b**、待命 Hub（未啟動）、匯出拉取器 | Hub、m2、m2b ← 兩個交易者，可成交 |
| M3 | Verifier panel ×3 | Verifier panel ×3（不變）|

**待命 Hub 不要放 M3。** 那會讓同一台機器同時掌握排序與全部三個 Verifier，比 #31 原本的問題更糟。M2 接手後變成「Hub ＋兩個交易者同機」，那正是 M1 演練前的形狀——誠實、可辯護，而且 panel 仍然獨立。

### 讓 client 能跟隨搬移的 Hub（這是演練成立的關鍵）

設定檔寫死 `hubHost: "192.168.50.30"` 的 client，在 M1 消失後會永遠重試那個位址——待命 Hub 在 M2 起來也沒用。所以演練配置**必須改用信標發現＋身分釘選**：

```jsonc
// M2 的兩個 agent 設定
"hubHost": "discover",
"hubPin":  "did:demo:8d36e0673ae02700"   // ← Hub 的 DID（啟動 log 印的那個）
```

```bash
# M3 的 panel（discover 模式，W10 新增）
AMCN_HUB_PIN=did:demo:8d36e0673ae02700 AMCN_PANEL_SEED='pilot-panel-CHANGE-ME' \
  node panel.js discover
```

配上 #40 的重連（每次嘗試都重新解析目標），待命 Hub 一開始廣播信標，M2 與 M3 的 client 就會自己找到它並重新註冊——**沒有人需要登入任何一台機器改設定**。這才是 §2.1「協議內發現與輪替」真正被測到的樣子。

`hubPin` 要能成立，待命 Hub 必須帶**同一個 `HUB_SEED`**（DID 由 seed 決定）。代價照實記錄：排序器的鑰匙從此存在兩台機器上。不複製的話，pinned client 會拒絕跟隨（那是 pin 的用途），演練就得手動重新 pin——兩條路都可以，但要寫進報告。

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

### 重連涵蓋不到的一件事

#40 的重連救的是**還活著的 process**。M3 在試點中睡了一次，那三個 verifier 行程隨機器一起結束——機器回到網路後 Hub 端依然空無一人，必須有人在 M3 上重新執行 `panel.js`。演練期間請把三台的睡眠關掉；真正的無人復原需要 launchd／systemd／工作排程器層級的自動啟動，目前沒做。

### 三台也測不到的

- **併發排序器**：M1 的 Hub 進程在拔線後還活著。若它與任何 agent 仍在同一網段，就是兩個排序器同時存在——所以 M1 必須完全隔離。真正的 Witness 聯邦（§2.2 Phase 2）不在本次範圍。
- **三方以上清算**：只有 M1／M2 兩個交易 agent，三角清算測不到。要測就得在 M3 上加第三個 agent，但那會讓 panel 重新與交易共域，把 #31 換回來——這個取捨要明確選，不要兩邊都想要。
- **威脅 14（治理）／威脅 10（sandbox）／威脅 15（供應商封鎖）**：原型沒有標的，見紅隊盤點 §3。
