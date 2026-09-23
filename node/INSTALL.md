# 多台電腦跑 AMCN：安裝指南（開一個網路的人看這份）

**先看哪一份**：
- 只想在自己一台機器上看它動起來 → `cd node && ./quickstart.sh`（一個指令，約 30 秒起一個真的網路，見 [README](README.md)）
- 要加入**別人**已經在跑的網路 → [JOIN.md](JOIN.md)
- 要**自己開**一個網路給別人加入 → 就是這一份

目標：機器 1 跑 Hub＋Provider Agent＋3 個 Verifier，機器 2 跑 Requester Agent，跨區網完成一次「借用 → 驗收 → 結算」，然後角色互換測還債。

有第三台機器時，Verifier panel 應該搬到它上面（第 6 節）——三個 Verifier 與交易雙方同機時，2-of-3 quorum 的獨立性只存在於協議層（§4 #31）。

**三台都到位時，照 `docs/evaluation/three-machine-pilot.md` 走**：那份 runbook 有完整的角色分配、長時間試點用的設定檔（`configs/pilot-m{1,2}.example.json`，含 seed 與放慢 33 倍的政策參數）、驗證 #31 真的關閉的三項證據，以及 W10 拔線演練程序。本文件是單次跨機閉環的最短路徑，那份是要跑數小時的配置。

## 0. 前置需求（每台都要）

- **Node.js ≥ 20**（零第三方套件，不需要 npm install）
  ```bash
  # macOS
  brew install node
  node --version   # 確認 ≥ v20
  ```
- 各台在**同一個區網**（同一台路由器/Wi-Fi）。
- 最少兩台（機器 1 = Hub＋Provider，機器 2 = Requester）。有第三台請看第 6 節——把 Verifier panel 移出去是目前最大的架構改善。Windows 也可以，見第 6 節。
- 取得專案：把整個 `ai-exchage` 資料夾複製到兩台機器（AirDrop、隨身碟、`scp -r`，或推到私人 GitHub repo 再 clone 都可以）。只有 `node/` 目錄是必要的。

## 1. 機器 1：Hub＋Provider＋Verifiers

**1a. 查自己的區網 IP**（機器 2 要用）：

```bash
ipconfig getifaddr en0     # macOS，例如 192.168.1.10
```

**1b. 啟動 Hub**（開一個終端機分頁）：

```bash
cd ai-exchage/node
HUB_SEED='pick-any-stable-string' \
HUB_DUMP_PATH=out/ledger.json \
HUB_BIND=0.0.0.0 node hub.js
```

`HUB_DUMP_PATH` 每 10 秒自動把完整帳本寫檔（`HUB_DUMP_MS` 可調）。Hub 掛掉後用 `HUB_IMPORT=out/ledger.json` 啟動即可接續——第二排序器會**驗證**整份匯出（逐筆驗簽、鏈重算、信用額度重放）才接受，不符就拒絕啟動。沒設 `HUB_DUMP_PATH` 的話，Hub 一旦停止，那本帳就沒了。

`HUB_SEED` 讓 Hub 的身分（`hub did`）跨重啟不變。沒設也能跑，但每次重啟 DID 都會變，任何用 `hubPin` 釘住它的 agent 都得重新設定（§4 #14）。啟動 log 會印出 `hub did`，那就是 `hubPin` 要填的值。

看到 `[hub] listening on 0.0.0.0:47180` 即成功。macOS 第一次會跳「允許接受連入網路連線？」→ 按允許。

**1c. 啟動 3 個 Verifier**（各開一個分頁，或用 `&` 背景執行）：

```bash
cd ai-exchage/node
for i in 1 2 3; do cp configs/verifier-$i.example.json configs/verifier-$i.json; done
# 同機執行時把 hubHost 改成 127.0.0.1（範本預設是區網 IP，給機器 3 用的）
node verifier.js configs/verifier-1.json &
node verifier.js configs/verifier-2.json &
node verifier.js configs/verifier-3.json &
```

⚠️ 把三個 Verifier 都跑在機器 1 上時，「2-of-3 quorum」在**部署層級上只是裝飾**——同一台機器、同一個 OS、同一個 Owner，單點故障或單一入侵即可同時控制整個 panel，而 FR-041 的隨機抽選正是為了防這件事（見 §4 #31）。有第三台機器時請改用第 6 節。

**1d. 啟動 Provider Agent**：

```bash
cd ai-exchage/node
cp configs/provider.example.json configs/provider.json
# 第一次測試不用改任何欄位（adapter.baseUrl=null → 確定性 mock，不花錢）
AMCN_PROVIDER_KEY='sk-test-anything' node agent.js configs/provider.json
```

看到 `registered, dynamic credit line 23.1 CC` 和 `supply armed at 1 CC/unit` 即成功。

（23.1 不是錯誤，而且它**不是**舊版文件寫的 46.3。兩個係數相乘：starter 50 CC × 新戶品質係數 0.925（`0.25 + 0.75 × 0.9`，那個 0.9 是零歷史時的 completion-rate prior）× **年齡斜坡**。年齡斜坡是 `0.5 + 0.5 × min(1, 帳齡/30天)`（#60／#82），所以第一天只有一半：`50 × 0.925 × 0.5 = 23.1`，30 天後才走到約 46.25。**這是刻意的**——全新身分拿不到成熟額度，是 Sybil 那一面的第一道門（#50）。所有 demo 與情境把斜坡壓成 1ms（`HUB_AGE_RAMP_MS`）才看得到成熟值，真實部署不要動它。跑出成交之後這個數字會隨紀錄與對手多樣性上升。）

## 2. 機器 2：Requester

```bash
cd ai-exchage/node
cp configs/requester.example.json configs/requester.json
node agent.js configs/requester.json
```

範本的 `hubHost` 已經是 `"discover"`，所以**不需要查也不需要填機器 1 的 IP**：Hub 每秒往區網廣播一則自己簽署的公告（udp/47179），Agent 啟動時聽到就自動連上，看到
`discovered hub 192.168.1.10:47180 (did:demo:…)` 即成功。這也是步驟 1a 查 IP 只剩「備用」用途的原因。

想固定成手填 IP（例如兩台不在同一廣播網段）就把 `hubHost` 改成該 IP，行為與舊版完全相同。

**釘住 Hub 身分（建議）**：廣播網段上任何機器都能冒充 Hub 回應。Hub 啟動時會印出
`hub did did:demo:…`，把它填進 `configs/requester.json` 的 `hubPin`，Agent 就只接受那個身分的公告，對不上時會持續等待而**不會**改連別處：

```json
{ "hubHost": "discover", "hubPin": "did:demo:<機器 1 印出的 hub did>" }
```

注意 Hub 的身分目前每次重啟都會換（見第 8 節），所以 Hub 重開後 `hubPin` 要跟著更新。

看到 `registered, dynamic credit line 23.1 CC` 表示已跨機連上 Hub（同樣的新戶係數×年齡斜坡，見步驟 1d）。

## 3. 發第一筆任務（在機器 2）

Requester 的 Owner Console 在本機 47202。用 curl 手動發任務（模擬「額度耗盡去借」）：

```bash
curl -s -X POST http://127.0.0.1:47202/post \
  -H 'content-type: application/json' \
  -d '{
    "units": 10, "maxPriceCC": 12,
    "payload": "hello from machine 2",
    "acceptance": "judge-quorum",
    "asserts": [{"op":"sha256_eq"}, {"op":"max_len","arg":64}]
  }'
```

預期流程（幾秒內）：機器 1 的 Provider 出價 → 機器 2 選標、E2E 封裝 payload → 機器 1 本機執行 → 3 個 Verifier 驗收 PASS → 雙簽收據 → Hub 顯示 `SETTLED(dual)`，機器 2 餘額 **-10**、機器 1 **+9.15**。

**查帳**：

```bash
curl -s http://127.0.0.1:47202/status | python3 -m json.tool   # 機器 2 的餘額
```

機器 1 的 Hub 終端機會印出完整結算與 checkpoint。

## 4. 還債（角色互換）

在機器 1 的 provider.json 已經在供應中；讓機器 2 也開供應、機器 1 發任務即可測 UC-02：

1. 機器 2：把 requester.json 的 `"provide": null` 改成 `{"afterMs":0,"pricePerUnit":0.9}`、`"adapter"` 改成 provider.example 那格（用 env key），重啟 agent。
2. 機器 1：再開一個 requester 設定（`hubHost:"127.0.0.1"`、`consolePort:47203`、`provide:null`），啟動後用 curl 對 47203 發任務。
3. 機器 2 得標、執行、收款 → 負餘額回補。這就是 §27 閉環的跨機版。

## 5. 接真實模型（選配）

把 provider 設定的 `adapter.baseUrl` 指向：

- 本機 Ollama：`"http://127.0.0.1:11434"`，`"model": "llama3.2"`（先 `ollama serve`）
- 任何 OpenAI-compatible 端點；key 建議放 macOS Keychain：
  ```bash
  security add-generic-password -s amcn-provider-key -a $USER -w '<你的key>'
  AMCN_USE_KEYCHAIN=1 node agent.js configs/provider.json
  ```

⚠️ 真實 LLM 輸出**非確定性**，`sha256_eq` 驗收必失敗。改用弱斷言，例如：
`"asserts": [{"op":"max_len","arg":2000},{"op":"contains","arg":"關鍵詞"}]`。
這是原型已知限制（見 README 誠實清單）——正式版驗收 DSL 會有 schema/test-suite 等強斷言。

## 6. 機器 3：獨立的 Verifier panel（強烈建議）

這是第三台機器最有價值的用途，比再開一個交易 Agent 重要得多：**讓 quorum 第一次真正獨立**。Verifier 不需要 API key、不需要任何模型、不參與信用——它只需要 Node.js ≥ 20 和連得到 Hub。

在機器 3 上——**一個指令，不用改任何設定檔**（Hub 的 IP 就是參數）：

```bash
cd ai-exchage/node
node panel.js 192.168.1.10        # ← 換成機器 1 的 IP（步驟 1a）
```

Windows 上**最可靠的一行**（cmd 與 PowerShell 都一樣）：

```
cd ai-exchage\node
node panel.js 192.168.1.10
```

也有 `panel.cmd` 包裝（會檢查 node 是否在 PATH、失敗時 `pause`，適合雙擊）。注意**呼叫方式依 shell 而異**：

```
REM Command Prompt / cmd.exe
panel.cmd 192.168.1.10
```

```powershell
# PowerShell 必須加 .\  ——它不把當前目錄放進 PATH，
# 裸寫 panel.cmd 會回報「找不到命令」
.\panel.cmd 192.168.1.10
```

刻意用 `.cmd` 而不是 `.ps1`：PowerShell 預設拒絕執行未簽署的腳本，批次檔沒有這個限制。它只是呼叫 `panel.js`，邏輯都在那裡——所以上面那行 `node panel.js` 永遠是等價且無歧義的退路。

`panel.js` 會先探測 Hub 是否可達（不可達就給出可操作的錯誤，而不是讓三個 Verifier 安靜地重試），啟動指定數量的 Verifier，等全部註冊完成後回報，`Ctrl-C` 一次停掉整個 panel（不留孤兒 process）。任一個 Verifier 意外退出時會停掉整個 panel——半個 panel 看起來健康是更糟的狀態。

改 panel 大小或埠：

```bash
node panel.js 192.168.1.10 47180 5     # IP、Hub 埠、panel 大小
```

讓 panel 自己找 Hub（W10 演練需要的模式——搬移過的 Hub 會被跟隨，不必登入這台改設定）：

```bash
AMCN_HUB_PIN=did:demo:xxxxxxxx AMCN_PANEL_SEED='panel-seed' node panel.js discover
```

`AMCN_HUB_PIN` 填 Hub 啟動 log 印出的 `hub did`。不設也能跑，但那表示廣播網段上任何一個信標都能冒充 Hub。

想手動逐一啟動（或需要不同名稱）也可以：

```bash
for i in 1 2 3; do cp configs/verifier-$i.example.json configs/verifier-$i.json; done
# 把三個檔的 hubHost 都改成機器 1 的 IP
node verifier.js configs/verifier-1.json &
```

然後**把機器 1 的三個 Verifier 停掉**（否則 pool 會有 6 個，panel 仍可能抽到同機的）。機器 1 的 Hub log 應該顯示三筆來自機器 3 的 `registered ... (verifier)`。

三個 process 在同一台機器仍不是完全獨立，但已經把 panel 與交易雙方分離到不同的故障域——這是 §4 #31 想要的改善方向。

### Windows 機器

程式碼本身跨平台（`lib/keystore.js` 只在 macOS 走 Keychain，其他平台直接用環境變數；模擬器是純 Python stdlib）。兩個差異：

**PowerShell 不支援 bash 的單引號 JSON**。Verifier 用 `panel.cmd` 就完全避開這件事；若要自己起單個 Verifier，`verifier.js` 與 `agent.js` 都接受設定檔路徑：

```powershell
cd ai-exchage\node
copy configs\verifier-1.example.json configs\verifier-1.json
# 編輯 hubHost 為機器 1 的 IP
node verifier.js configs\verifier-1.json
```

若真的需要環境變數形式（例如 Provider 的 API key）：

```powershell
$env:AMCN_PROVIDER_KEY='sk-test-anything'
node agent.js configs\provider.json
```

**`hubHost` 兩種都可用**。跨機 UDP 發現實測可行（§4 #18 已撤銷），但 Windows 防火牆可能擋入向 UDP 47179，第一次執行時若跳出提示請允許。不確定時先用手填 IP——它不依賴廣播；要確認發現能否使用就跑 `node discovery-probe.js resolve`。

**不需要安裝任何大語言模型**。試點跑 `adapter.baseUrl: null` 的確定性 mock，沒有 API 呼叫也沒有費用；`sk-test-anything` 只是佔位字串，唯一要求是非空（因為 adapter 是 key-gated，那個 gate 本身就是 P-02 的示範）。接上真實模型反而會讓 `sha256_eq` 驗收失敗，見第 5 節。

## 7. 疑難排解

| 症狀 | 原因與解法 |
|---|---|
| 機器 2 連不上 | Hub 沒設 `HUB_BIND=0.0.0.0`；或 macOS 防火牆擋了 node → 系統設定 › 網路 › 防火牆 › 允許 node；或兩台不在同網段（`ping <機器1 IP>` 測試） |
| `no bids for ...` | Provider 沒在供應（看它有沒有印 `now providing`）；或 maxPriceCC < units×pricePerUnit |
| quorum 沒反應 | 3 個 Verifier 沒起來（Hub log 應有三筆 `registered ... (verifier)`） |
| 驗收 FAIL | 用了真實 LLM 卻配 `sha256_eq`（見第 5 節） |
| 埠被占用 | 換 `HUB_PORT`／`consolePort`，兩邊設定要一致 |
| PowerShell 說 `panel.cmd` 不是命令 | PowerShell 不把當前目錄放進 PATH。用 `.\panel.cmd ...`，或直接 `node panel.js <hub IP>`（與 shell 無關）|
| 想診斷跨機發現（§4 #18） | 在 Hub 那台 `node discovery-probe.js send`，在發現失敗的那台 `node discovery-probe.js listen`。listen 端沒有任何 `跨機 ✓` 就是網路在丟廣播；有封包但簽章失敗才是 beacon 程式的問題 |
| `no hub beacon heard` | Hub 沒設 `HUB_BIND=0.0.0.0`（綁 loopback 時只會往 127.0.0.1 廣告）；或兩台不在同一廣播網段（跨 VLAN／訪客網路／Wi-Fi 隔離會擋 UDP 廣播）→ 改回手填 IP |
| `no beacon matching pinned hub` | `hubPin` 與 Hub 現在的身分不符。Hub 沒設 `HUB_SEED` 時每次重啟換身分，照它新印出的 `hub did` 更新 |
| `refused a tcp peer on the http transport`（或反向） | 兩端 `AMCN_TRANSPORT` 不同。Hub 啟動 log 的 `listening on ... — <名稱> transport` 就是它講的那種，把每一台設成同一個（預設 `tcp`）|

## 8. 安全注意（試點範圍）

- Hub 綁 `0.0.0.0` 只該在**受信任的區網**做。`tcp`（預設）與 `http` 兩個傳輸實作都沒有加密——訊息本身有簽章、payload 有 E2E 加密，但信封是明文（誰跟誰、多少錢、什麼時候），而 `http` 是明文 HTTP 不是 HTTPS。**連線要離開區網就換 `AMCN_TRANSPORT=secure`**（#44）：臨時 X25519 → HKDF → AES-256-GCM，臨時金鑰由 Ed25519 身分簽章、以 DID 為信任錨（不是 TLS，也沒有 CA）。每一台都要設，並用 `AMCN_SECURE_SEED` 給自己一個穩定的通道身分、`AMCN_SECURE_PIN` 指定只跟誰講話。它防的是路徑上的第三方；**防不了 Hub 本身**——Hub 看得到 metadata 是它的工作，那一層靠的是簽章與 payload E2E。閘門：`demo-transport.js` 三種實作跑出同一本帳。
- Console（47201/47202）只綁 localhost，這是刻意的——它是 Owner 的控制面。
- **Verifier panel 與交易雙方應在不同機器**（第 6 節）。同機 panel 使 2-of-3 quorum 的獨立性只存在於協議層（§4 #31）。
- API key 永遠只在 agent 進程的機器上；試點時可用 `sk-test-anything` 假 key 跑 mock adapter，完全不花錢。

## 9. 已知限制（試點範圍內會撞到的）

- **Hub 的持久化要自己開，預設是關的**（§4 #17）。帳本在記憶體：要活過重啟，啟動時就得設 `HUB_DUMP_PATH`（週期快照＋每筆變動即時附加的 `.tail`）並在下次啟動設 `HUB_IMPORT`（見第 1 節）。**身分這一側已經自動了（2026-09-22）**：以設定檔路徑啟動而檔裡沒有 `seed` 時，`agent.js`／`verifier.js` 會產生一個並**寫回那個檔案**；`panel.js` 則把 panel 的身分存成 `configs/.panel-seed`（0600）。用 `AGENT_CONFIG` 環境變數啟動時**不會**這樣做——所有 demo 與情境走那條路，它們刻意要每次都是新身分。所以現在要注意的是反過來的事：**那些設定檔與 seed 檔等同私鑰**，要備份、不要外流、不要放進 git（`.gitignore` 已經排除 `configs/*.json` 與 `.panel-seed`）。舊的設定檔如果沒有 `seed`，補一次就好。
- **傳輸層無 TLS**。訊息有簽章、payload 有 E2E 加密，但 metadata 是明文（見第 8 節）。兩種 `AMCN_TRANSPORT` 實作都一樣，`http` 是明文 HTTP。
- **升級必須所有機器同時做**（§4 #33 已修：協議有版本欄位，混版是拒絕而非崩潰）。`git pull` 後請把**每一台**的 Hub 與 Agent 都重啟，不要只更新其中一台——版本不符的 frame 會被丟棄並記錄 `[wire] rejected ...: protocol v...`，功能上等於那台不存在。
- **`AMCN_TRANSPORT` 每台都要一致**。不一致時雙方都會印出拒絕原因（第 7 節），但網路不會運作。

## 10. 開一個網路要負責的事（營運方視角）

Hub 不是信任根（§2.2），但它是**唯一知道所有出價的人**，而且它掛掉時沒有人能結算。
所以開網路的人要負責的三件事：

### 10a. 備份與還原

```bash
# 啟動時就設好，兩者一起用
HUB_SEED='一個你會保管的字串' HUB_DUMP_PATH=out/ledger.json HUB_BIND=0.0.0.0 node hub.js
```

- `HUB_SEED` 決定 Hub 的 DID。**丟了它，所有釘住你的人都要改設定**。
- `HUB_DUMP_PATH` 寫的是快照 `ledger.json` ＋ 即時尾檔 `ledger.json.tail`。
  **兩個都要備份**——只留快照會少掉最近那一段，而那正是崩潰時最想要的（#74）。
- 還原：`HUB_IMPORT=out/ledger.json node hub.js`。匯入會**驗證整份匯出**
  （逐筆驗簽、鏈重算、額度重放、checkpoint 比對），不符就拒絕啟動而不是帶著錯的帳開始服務。
- 還原前先自己驗一次，不必等 Hub：
  ```bash
  node verify-ledger.js out/ledger.json --pin did:demo:<你的 hub did>
  ```

### 10b. 要不要開金絲雀（決定 verifier 會不會被抽查）

沒有金絲雀時，偷懶的 verifier（不看斷言就投 PASS）沒有任何成本，而押注沒收
與 #38 的「早退不退押注」都要靠它的樣本數才會啟動。

```bash
# 1) 產生發樁者的身分（它會花 Treasury 的錢，所以由營運方授權）
HUB_CANARY_DID=did:demo:<canary 的 did> … node hub.js
# 2) 另一個行程跑發樁者
AGENT_CONFIG='{"hubPort":47180,"name":"canary","seed":"<同一個 seed>","everyMs":60000,"units":2}'   node canary.js
```

閘門：`node demo-canary.js`（偷懶者被沒收、誠實者分文未失）與 `node demo-forfeit.js`
（未被測夠就離線押注不退、被測夠者可取回）。

### 10c. 回流：protocol 帳戶不是只進不出

`protocol:treasury`／`protocol:insurance` 只收不付時，它們持有的每一塊 CC 都是永久
借出去的信用——小網路的結局是所有人貼著上限、市場停住（實測 40 分鐘後 122.53 CC
卡在 protocol 帳戶裡）。Hub 因此週期性把超額退還給**本期有支出的**帳戶：

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `HUB_REBATE_MS` | 60000 | 檢查週期 |
| `HUB_INSURANCE_TARGET_FRAC` | 0.06 | 保險池目標 ＝ 曝險 × 此值；設 0 關閉 |
| `HUB_TREASURY_RESERVE_CC` | 5 | Treasury 保留額（供金絲雀與啟動補貼）|
| `HUB_REBATE_MIN_CC` | 0.05 | 低於此金額不動作 |

### 10d. 招人時要講清楚的三件事

1. **你的 `hub did`**（他們要拿它當 `hubPin`，否則廣播網段上任何人都能冒充你）。
2. **`AMCN_TRANSPORT` 用哪一個**（每一台必須一致；離開區網要 `secure`）。
3. **協定版本**（現在是 v7）。混版不會半通，而是被明確拒絕。

`node/JOIN.md` 就是可以直接轉給他們的那份文件。

## 11. 讓這台機器常駐跑（macOS，開機自動起）

`quickstart.sh` 是你自己要看的東西；要**招人**就得有個一直在那裡的東西。

```bash
cd node/service && ./install.sh
```

裝三個 launchd 服務（`RunAtLoad` ＋ `KeepAlive`，所以開機會起、崩潰會被重起）：

| Label | 做什麼 | 身分存在哪 |
|---|---|---|
| `com.amcn.hub` | 排序器，綁 `0.0.0.0:47180`，帳本在 `out/home/ledger.json`（＋`.tail`）| `configs/.hub-seed` |
| `com.amcn.panel` | 3 個驗收者 | `configs/.panel-seed` |
| `com.amcn.agent` | **只賣不買**的供給端，Console `127.0.0.1:47201` | `configs/home-agent.json` |

```bash
./install.sh status    # 三個服務的 PID 與 hub did
./install.sh invite    # 印出可以直接貼給人的邀請（DID 與位址都填好）
./uninstall.sh         # 移除服務；帳本與身分都留著
```

三個設計選擇：

- **供給端刻意不開需求模型**。這台是要讓外人來借的那一側；自己同時買又賣只會
  產生關聯方交易（#63）——帳會變熱鬧，但那不是市場數據。
- **三個獨立服務而不是一個包裝腳本**。launchd 的 `KeepAlive` 是按服務算的，
  包成一個的話 panel 掛掉不會被單獨重起，而「半個 panel 看起來健康」比整個停掉更糟。
- **種子存檔案、不寫進 plist**。`hub did` 就是你發給別人釘的地址，而 plist 會被
  備份工具與截圖帶著走。

**實測過的**：`kill -9` 掉 hub 之後 launchd 在 15 秒內重起、**hub did 不變**、
panel 與供給端自己重新註冊（#40），帳本從快照＋尾檔接續。

要備份的是四個東西，而它們是**身分與帳**、不是設定：`configs/.hub-seed`、
`configs/.panel-seed`、`configs/home-agent.json`、`out/home/ledger.json`＋`.tail`。

**它目前只服務區網**。外人不在你的網段時，需要的不只是開一個 port：每一台都要
`AMCN_TRANSPORT=secure`，而發現要走 rendezvous。那條路還沒有任何人真的跑過
（登記簿 #86）。

## 12. 正式上線（公網）前的檢查表

「上線」不是把 port 開出去。區網與公網之間有四件事不一樣：資源預算（#87）、
流量記錄（#88）、**對外入口是不是常駐的**（#91）這三件已經修好，剩下的一件
——**真的有兩台在不同地點的機器**（#86）——還在你手上，而它不是程式問題。

### 已經做好的（2026-09-22）

**濫用預算（#87）**。從前 Hub 對陌生人沒有任何資源上限：全域只有 16MB 的 frame
上限，而它對**未註冊**的連線一樣適用——任何人不必先簽任何東西，就能用連線數把
記憶體吃光。現在的分界點是**註冊**（唯一需要簽章的入口）：

| 限制 | 預設 | 環境變數 |
|---|---|---|
| 未註冊的 frame 上限 | 64 KB | `AMCN_PREAUTH_MAX_BYTES` |
| 未註冊的訊息數 | 20 則 | `AMCN_PREAUTH_MAX_MSG` |
| 每連線訊息速率 | 200/秒 | `AMCN_MAX_MSG_PER_SEC` |
| 連線總數 / 每 IP | 200 / 50（loopback 不算）| `HUB_MAX_CONNS` / `HUB_MAX_CONNS_PER_IP` |
| 新身分註冊 | 10/分/IP | `HUB_MAX_REGISTER_PER_MIN` |
| 帳戶總量 | 500 | `HUB_MAX_AGENTS` |
| 起始匯出 | 30/分/IP | `HUB_MAX_EXPORT_PER_MIN` |

**每 IP 的值不要往下調。** 第一版設 10，結果自己的 demo 先死（一台機器上 14 條連線
被拒 12 條）；而真實網路上更糟——**NAT 會把一整個家庭或辦公室塌縮成同一個位址**，
被擋的會是合法參與者。真正的後盾是全域上限。

兩個刻意的例外：**重連不受註冊節流限制**（同一個 DID 已在帳上就直接放行，否則
斷線會變成永久離線）；**匯出不受未註冊訊息額度限制**（「任何人都能自己驗帳」是
公共財，而大帳本是分頁取回的，跟著游標的後續分頁不計數）。

**流量記錄不再隨匯出出去（#88）**。`raw_log` 曾經預設包含在匯出裡，而匯出對
陌生人開放——那會把**落選的出價**（從不進帳本）、每筆任務的 metadata 與所有錯誤
文字送給任何連得上的人。現在要 `HUB_EXPORT_RAWLOG=1` 才有，而需要掃流量的閘門
自己設它。

### 對外入口本身也要是一個服務（#91，2026-09-23）

#89 讓可達性問題消失（onion service，這台機器零入向埠），但那條路原本是一個
**前景腳本**：常駐的 `launchd` 只有 hub／panel／agent 三個服務，所以機器重開、
tor 崩掉、或那個終端機被關掉，入口就沒了——而 Hub 看起來完全健康。實測
2026-09-23 早上這台就是這個狀態：三個服務都活著、邀請照樣印得出來，而**此刻
從網際網路要加入，沒有任何東西在聽**，同時排序器反而還暴露在區網上。

```bash
cd node/service
./install.sh --onion     # 多裝 com.amcn.onion，並把 Hub 綁回 127.0.0.1
./install.sh status      # 模式、四個服務、hub did、onion 位址、位址記錄
./install.sh --lan       # 收掉對外入口（真的會移除那個服務）
```

模式寫在 `configs/.home-mode`，所以它跨重開機成立；`run-hub.sh` 據此決定
`HUB_BIND`（`onion` → `127.0.0.1`，`lan` → `0.0.0.0`）。**不要在 onion 模式下把
`HUB_BIND` 改回 `0.0.0.0`**：onion 轉進來的連線走回送位址，綁 `0.0.0.0` 只會讓
同一個排序器同時暴露在區網上，那正是要拿掉的東西。

**兩種模式都會發布一份簽署過的位址記錄**（`var/rendezvous.json`）。位址會變——
onion 位址要等 tor 起來才存在、排序器也可能搬家——所以記錄的主機名不是啟動時
定住的，而是每次重發都重新讀 `HUB_ADVERTISE_HOST_FILE`（onion 模式預設
`var/onion/hostname`）。把那個檔放到任何靜態主機，對方就能用

```bash
AMCN_TRANSPORT=tor AMCN_HUB_PIN=did:demo:<你的 hub did> node panel.js rv:<記錄的網址>
```

加入，而且你之後換位址、換入口、換機器，他都不必改任何東西。承載記錄的主機
**不受信任**：它能扣住或給舊的，但無法冒充你。

閘門：`cd node && node demo-rendezvous.js`（**11/11**，不需要 tor、不啟動任何
onion service、不碰你的 launchd）。它讀的是 `service/run-hub.sh --print-env`
**算出來的值**而不是原始碼裡的字串——「模式是 onion 卻又綁回 0.0.0.0」這種回歸
只有這樣才抓得到。

### 搬到公網可達的主機（一個指令）

```bash
cd node
./service/deploy-hub.sh user@1.2.3.4 --dry-run   # 先看它會做什麼
./service/deploy-hub.sh user@1.2.3.4             # 搬過去並啟動
./service/deploy-hub.sh user@1.2.3.4 --status    # 之後看狀態
```

六步：檢查 SSH 與 OS → 裝 Node ≥ 20（Ubuntu 24.04 內建是 18.x，太舊，走
NodeSource）→ `git clone`（repo 是公開的，所以遠端不需要任何憑證）→ **帶著
`configs/.hub-seed` 與帳本過去**（那兩個不在 git 裡，`.gitignore` 把它們當私鑰）
→ **遠端先自己驗那本帳**再啟動（不驗就啟動的排序器比起不來的更糟）→ 裝 systemd
服務（`Restart=always`，預設就是 `AMCN_TRANSPORT=secure`）。

最後它會**比對遠端與本機的 `hub did` 是否一致**並直接說結論。那是整件事的重點：
`hub did` 由 `.hub-seed` 決定，所以帶著它過去，對已經釘住你的人來說 Hub 只是換了
位址，沒有人要改設定（#14 讓 `HUB_SEED` 存在就是為了這個）。

**搬家這條路先在不花錢的地方驗過**：`node chaos-run.js scenarios/hub-moves.json`
——殺掉 Hub、換埠重啟（同 seed、從匯出重建、發布新的簽署 rendezvous 記錄），
沒有人改任何設定檔，實測 **3/3**，交易在 T+88s 恢復並續跑 47 筆。

**為什麼是搬排序器而不是家用 port forward**：家用寬頻最快，但那是把服務直接暴露
在你家的 IP 上。排序器搬家是設計內的事，而搬完之後家裡那台只跑供給端與 verifier
——它們用 `hubPin` 跟著新位址走，家用 IP 不會出現在任何地方。

### 位址輪替：用你的公開 repo 當 rendezvous

常駐服務已經替你寫出記錄了（`var/rendezvous.json`，見上一節），這一節是「把它
放到哪」與「手動跑 hub 時怎麼開」。`lib/rendezvous.js` 支援 `https://` 的記錄，
所以輪替機制可以是**一次 commit**：

```bash
HUB_RENDEZVOUS=rendezvous.json node hub.js     # Hub 自己週期性寫出簽署記錄
# 把 rendezvous.json commit 進公開 repo，客戶端設定：
#   "rendezvous": "https://raw.githubusercontent.com/<你>/<repo>/main/rendezvous.json"
#   "hubPin": "did:demo:…"
```

承載記錄的主機（GitHub）**不受信任**：它能扣住或給舊的，但無法冒充——記錄帶著
Hub 的簽章，客戶端拿 `hubPin` 核對。記錄預設 10 分鐘就算過期
（`AMCN_RENDEZVOUS_MAX_AGE_MS`），靜態 IP 的情況要把它調長。

### 不要走的那條路

**不要用 TLS 終結型的隧道**（Cloudflare 之類）：`http` 傳輸是長連 chunked
NDJSON，中間任何緩衝都會讓它的即時性失效，而那個失敗模式很難從錯誤訊息看出來。
要加密就用 `AMCN_TRANSPORT=secure`（它加密的是 AMCN 自己的信封，不需要中間人）。

### repo 已經公開（2026-09-22）

https://github.com/Wolke/amcn ，Apache-2.0。所以遠端主機 `git clone` 不需要任何
憑證，而 `JOIN.md` 的可信度（「你可以自己驗帳」）成立——那需要看得到程式。
公開前掃過：追蹤檔案與 137 個 commit 的完整歷史都沒有憑證字串；三個腳本原本把
開發機的內網位址寫成預設值，已改成 `127.0.0.1`。

### 一台待命排序器（#95）：它離線，網路自己換人

以前的接手是把 `configs/.hub-seed` 複製到第二台機器——也就是把排序器的私鑰放到
兩個地方。現在不必：

```bash
# 現任這一側：授權誰可以接手（趁自己還活著時簽），然後重啟 Hub
#   待命機的 DID 由它自己第一次啟動時印出來
HUB_SUCCESSORS=did:demo:<待命機 DID> ./service/run-hub.sh       # 或寫進 plist

# 待命機那一側（另一台機器、它自己的身分）
node standby.js https://…/rendezvous.json --pin did:demo:<現任> --port 47180
```

待命機做三件事，順序就是判斷：**先拉帳並驗過才留**（逐筆驗簽、重算鏈、比對
checkpoint root，對不上就不留那一份——接手的人不需要信任任何人）→ **再確認現任
連續連不上**（預設 60s，`HUB_PROMOTE_AFTER_MS`）→ **才升格**，按 `priority` 錯開
（兩台同時升格＝分叉）。升格之後它用**自己的** DID 服務，而釘住前任的 client 憑
那份事先簽好的憑證跟過來——你不必通知任何人改設定。

三件要知道的事：

- **沒有驗過的帳本不會升格**。一個從空白開始的排序器會把所有人的餘額歸零，那比
  沒有排序器更糟，所以它會拒絕並說出來。
- **舊排序器不能直接回來**。後繼者活著時位址記錄是新的，而死掉的排序器發不出新
  記錄，所以 Hub 啟動時看到「別人正在服務」就會**拒絕啟動**並印出兩條路。要收回
  排序權得先取得它那本帳（`ledger-dump.js`）再以那份 `HUB_IMPORT` 啟動，然後
  `HUB_RESUME_AFTER_SUCCESSION=1`。沒有這一步你會丟掉它服務期間的每一筆。
- **這是 failover，不是共識**。兩個後繼者同時升格就是分叉；`priority` 錯開只降低
  機率。偵測有（#69c 的分叉偵測），自動合併兩本帳沒有——那是治理決定。

### 還沒有人跑過的那一條（#86）

`AMCN_TRANSPORT=secure` 有閘門，`lib/rendezvous.js` 有情境與 `demo-rendezvous.js`，
但**全部都是同一台機器上的幾個行程**。兩台在不同地點的機器跑通一次「借用 → 驗收
→ 結算」這件事，目前零次。上線前要做的第一個實驗就是它，而量的是「握手與長連線
在真實 RTT、NAT 與電路重建之下會不會成立」，不是密碼學（那一層有閘門）。

走 onion 時 `secure` 的必要性下降（tor 本身就對信封加密，防的是路徑上的第三方），
所以這個實驗最便宜的形狀是：`./install.sh --onion`，把 `var/rendezvous.json` 發到
一個靜態網址，然後請對方在**他家的網路**用上面那一行 `rv:` 加入。要量三個數字：
第一次建電路的時間、連續 30 分鐘有沒有掉線、以及他的 verifier 有沒有真的進到
panel 並分到 CC。
