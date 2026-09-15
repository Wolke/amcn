# 多台電腦跑 AMCN 試點：安裝指南

目標：機器 1 跑 Hub＋Provider Agent＋3 個 Verifier，機器 2 跑 Requester Agent，跨區網完成一次「借用 → 驗收 → 結算」，然後角色互換測還債。

有第三台機器時，Verifier panel 應該搬到它上面（第 6 節）——三個 Verifier 與交易雙方同機時，2-of-3 quorum 的獨立性只存在於協議層（§4 #31）。

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
HUB_BIND=0.0.0.0 node hub.js
```

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

看到 `registered, dynamic credit line 46.3 CC` 和 `now providing at 1 CC/unit` 即成功。

（46.3 不是錯誤：starter 是 50 CC，但全新帳號沒有成交紀錄，`lib/eeff.js` 的 `creditLine` 會乘上 quality 係數 `0.25 + 0.75 × 0.9 = 0.925`——那個 0.9 是零歷史時的 completion-rate prior，所以 `50 × 0.925 = 46.25`。跑出第一批成交後這個數字會上升。）

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

看到 `registered, dynamic credit line 46.3 CC` 表示已跨機連上 Hub（同樣的 0.925 新戶係數，見步驟 1d）。

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

**`hubHost` 請用手填 IP，不要用 `"discover"`**。跨機 UDP 發現尚未修（§4 #18），而 Windows 防火牆預設擋入向 UDP，只會多一個變數。

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
| `no hub beacon heard` | Hub 沒設 `HUB_BIND=0.0.0.0`（綁 loopback 時只會往 127.0.0.1 廣告）；或兩台不在同一廣播網段（跨 VLAN／訪客網路／Wi-Fi 隔離會擋 UDP 廣播）→ 改回手填 IP |
| `no beacon matching pinned hub` | `hubPin` 與 Hub 現在的身分不符。Hub 重啟會換身分，照它新印出的 `hub did` 更新 |

## 8. 安全注意（試點範圍）

- Hub 綁 `0.0.0.0` 只該在**受信任的區網**做；傳輸層目前無 TLS（訊息本身有簽章、payload 有 E2E 加密，但 metadata 是明文）。不要暴露到公網。
- Console（47201/47202）只綁 localhost，這是刻意的——它是 Owner 的控制面。
- **Verifier panel 與交易雙方應在不同機器**（第 6 節）。同機 panel 使 2-of-3 quorum 的獨立性只存在於協議層（§4 #31）。
- API key 永遠只在 agent 進程的機器上；試點時可用 `sk-test-anything` 假 key 跑 mock adapter，完全不花錢。

## 9. 已知限制（試點範圍內會撞到的）

- **Hub 與 Agent 的狀態都不持久化**。Hub 帳本在記憶體，`export` 有出口但沒有 import 入口；而 `agent.js` 每次啟動都 `genIdentity()` 產生**新 DID**（keystore 只保管 API key，不保管身分）。所以任一邊重啟，餘額與信用歷史都會歸零、無法延續。想留證據就在重啟前把 `export` 的輸出存檔——收據本身是雙簽的，離線可獨立驗證。
- **Hub 身分每次重啟改變**，所以 `hubPin` 只在單次 Hub 生命週期內有意義，真正的「發現與輪替」還需要 Hub 身分持久化。
- **傳輸層無 TLS**。訊息有簽章、payload 有 E2E 加密，但 metadata 是明文（見第 8 節）。
- **協議沒有版本欄位，升級必須所有機器同時做**（§4 #33）。混版節點會拒絕互通——`git pull` 後請把**每一台**的 Hub 與 Agent 都重啟，不要只更新其中一台。實測中一台舊版 provider 收到新版合約時會拒絕該筆並記錄 `[wire] dropped frame`（修復前是直接崩潰）。
