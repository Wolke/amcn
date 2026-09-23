# 加入一個 AMCN 網路

這份是**參與者**的文件：有人已經在跑一個 Hub，你要把自己的機器接上去。
想自己開一個網路的話看 [INSTALL.md](INSTALL.md)；想先在自己一台電腦上看它動起來，
看 [README.md](README.md) 的「五分鐘」那節（`./quickstart.sh`）。

## 你需要什麼

| 要的 | 說明 |
|---|---|
| Node.js ≥ 20 | 零第三方套件，**不需要 `npm install`** |
| 這個 repo | 只有 `node/` 目錄是必要的 |
| 連得到 Hub | 同一個區網最簡單；跨網段見下面〈離開區網〉 |
| Hub 的 `hubPin` | 對方 Hub 啟動時印出的 `hub did did:demo:…`。**問他要，不要自己猜** |

**不需要**：API key（只做 verifier 的話）、任何模型、任何加密貨幣、任何錢。

## 三種參與方式，門檻差很多

| 角色 | 你付出什麼 | 你得到什麼 | 起步指令 |
|---|---|---|---|
| **Verifier**（驗收者）| 一台開著的機器 | 每筆驗收的分潤（實測約 0.13 CC／筆，隨費率與 panel 大小變） | `node panel.js <hub ip>` |
| **Provider**（賣算力）| 你自己的模型或 API 額度 | 貨款（10 CC 的任務實得 8.75 CC，其餘是手續費與風險費） | `node agent.js configs/<你的>.json` |
| **Requester**（借算力）| 未來要還的工作 | 現在就能用的算力，額度內不必先付 | 同上，加上發任務 |

一個節點可以同時是後兩者（`provide` 與 `policy` 並存），也可以同時兼 verifier
（設定檔加 `"verify": true`）——**但不能驗自己的合約**，那是協議層的守門。

---

## 路徑 A：只當 Verifier（三分鐘，門檻最低）

Verifier 不需要 key、不需要模型、不參與信用。它做的事是：Hub 把合約抽選的
panel 通知它，它跑驗收斷言（DSL），先送承諾雜湊、再揭示裁決（commit-reveal，
所以它看不到別人的答案）。

```bash
cd node
node panel.js 192.168.1.10          # ← 換成 Hub 那台的 IP
```

第一次執行會產生並保存 `configs/.panel-seed`（權限 0600）。**那個檔案就是你的
身分**：押注、受測紀錄、分潤都綁在它上面，備份它、不要外流。

要讓 panel 自己找 Hub（Hub 搬家也跟著走），改成：

```bash
AMCN_HUB_PIN=did:demo:<對方的 hub did> node panel.js discover
```

不設 `AMCN_HUB_PIN` 也能跑，但那表示**廣播網段上任何人都能冒充 Hub**。

### Verifier 的押注規則（協定 v7，登記簿 #38／#28）

這一段是做 verifier 前該知道的全部：

1. **押注不是先付的**。你不需要拿錢出來換資格——每筆驗收費的一部分會被託管進
   `protocol:stake`，直到累積到目標（預設 5 CC）。新來的人身上籌碼少、賺得也少，
   隨著做事慢慢累積，與信用額度同一個形狀。
2. **金絲雀會測你**。網路會發布「斷言不可能被滿足」的暗樁任務，唯一正確的裁決是
   FAIL。不看斷言就投 PASS 的人會被記錄；達到證據門檻（預設樣本 ≥5 且失敗 ≥3 次
   且失敗率 ≥25%）才會被沒收押注——**罰的是模式，不是一次運氣不好**。
3. **還沒被測夠就跑掉，押注不退**。離線超過門檻（預設 14 天）而金絲雀樣本還沒到
   最低數量時，託管的押注轉入保險池。所以「換個身分重來」不再便宜。
4. **被測夠了要收工，押注拿得回來**。樣本達標且失敗率過關時可以取回，CC 回到你的
   餘額。代價是**取回即結束這個身分的驗證生涯**：拿走押注還繼續驗證的人身上沒有
   東西可罰，所以取回之後這個 DID 不會再被抽進 panel，重新註冊也不會。

取回押注目前只能透過設定檔欄位（還沒有互動入口，這是已知的 UX 缺口）：

```json
{ "name": "V1", "hubHost": "192.168.1.10", "seed": "…", "releaseStakeAfterMs": 1000 }
```

```bash
node verifier.js configs/my-verifier.json   # 一秒後送出取回請求，Hub 會回覆准或拒
```

沒被測夠時 Hub 會明確拒絕：`stake: released only after 5 canary samples (have 0)`。

---

## 路徑 B：賣算力（Provider）

```bash
cd node
cp configs/provider.example.json configs/my-provider.json
```

編輯三處：

```json
{
  "name": "my-provider",
  "hubHost": "192.168.1.10",          // 或 "discover"
  "hubPin": "did:demo:<對方的 hub did>",
  "consolePort": 47201,
  "adapter": {
    "baseUrl": null,                   // null = 確定性 mock，不花錢，先用它跑通
    "model": null,
    "key": { "service": "amcn-provider-key", "env": "AMCN_PROVIDER_KEY" }
  },
  "provide": { "afterMs": 0, "pricePerUnit": 1.0, "repayment": true }
}
```

```bash
AMCN_PROVIDER_KEY=sk-test-anything node agent.js configs/my-provider.json
```

第一次啟動會把一個隨機 `seed` 寫回那個設定檔，並印出：

```
[amcn] 已為 configs/my-provider.json 產生固定身分 seed，身分將跨重啟不變。
DID my-provider did:demo:12ffa6f8b7116384 (protocol v7)
[my-provider …] supply armed at 1 CC/unit, strategy normal
[my-provider …] registered, dynamic credit line 23.1 CC
```

**設定檔從此等同私鑰**：餘額、信用紀錄、押注全綁在那個 seed 上。備份它。

### 接真實模型

把 `adapter.baseUrl` 指向任何 OpenAI-compatible 端點（本機 Ollama
`http://127.0.0.1:11434`、或商業 API），並補兩個欄位：

```json
"adapter": {
  "baseUrl": "https://api.openai.com",
  "model": "gpt-4.1-mini",
  "key": { "service": "amcn-provider" },
  "terms": { "attested": true, "note": "查證日期與依據" },
  "attribution": "openai"
}
```

- `terms.attested` **沒設就不會對外供給**。它聲明的是「你與上游的協議允許你替
  第三方請求執行推理」（P-10）。這是聲明不是驗證——作用是把責任變成設定檔裡
  可稽核的事實。接自己的硬體也要設（程式看不出 `baseUrl` 後面是誰）。
- `attribution` 讓 requester 的 DID 隨請求送上游（`user` 欄位）。方向是**把第三方
  流量標示清楚**，而不是混進自己的用量裡。細節見
  `docs/evaluation/key-lending-verification.md`。
- macOS 可以把 key 放 Keychain 而不是環境變數：
  ```bash
  security add-generic-password -s amcn-provider -a $USER -w '<你的 key>'
  AMCN_USE_KEYCHAIN=1 node agent.js configs/my-provider.json
  ```

⚠️ **真實模型的輸出不是確定性的，所以 `sha256_eq` 驗收必定失敗。** 要接真模型時，
發任務那邊的斷言得換成弱斷言（`max_len`、`contains`）。這是原型的已知限制：
強斷言（schema／test-suite）是正式版的驗收 DSL 要做的事。

---

## 路徑 C：借算力（Requester）

```bash
cd node
cp configs/requester.example.json configs/my-agent.json
# 編輯 hubHost / hubPin / consolePort，然後：
node agent.js configs/my-agent.json
```

### 手動發一筆（先確認路徑是通的）

```bash
curl -s -X POST http://127.0.0.1:47202/post -H 'content-type: application/json' \
  -d '{"units":10,"maxPriceCC":12,"payload":"hello AMCN",
       "acceptance":"judge-quorum","asserts":[{"op":"sha256_eq"},{"op":"max_len","arg":64}]}'
```

幾秒後 Hub 會印出結算，而一筆 10 CC 的任務長這樣（實測）：

```
SETTLED(dual) c-t-my-agent-…: requester=-10.00  provider=+8.75
              protocol:treasury=+0.25  protocol:insurance=+0.60
              verifier×3=+0.13 each
```

你的餘額變成 **−10 CC**，而那不是欠款催收——負餘額是這個系統的功能（P-05）。

### 讓它自己動（不靠你 curl）

`posts: []` 加上 `policy` 之後，Agent 自己偵測「額度耗盡」並轉為任務（UC-01）：

```json
"policy": {
  "quota":  { "capacityUnits": 40, "cycleMs": 120000, "cycleOffsetMs": 60000 },
  "demand": { "meanUnits": 5, "tickMs": 30000, "burstProb": 0.25, "burstMultiplier": 4 },
  "budget": { "maxPricePerUnit": 1.3, "minUnits": 3, "maxUnitsPerTask": 4 },
  "acceptance": { "method": "judge-quorum",
                  "asserts": [{ "op": "sha256_eq" }, { "op": "max_len", "arg": 64 }] }
}
```

`quota` 是你自己的額度與週期，`demand` 是需求模型，`budget` 是 Owner 的上限。
比例才是重點：每個 cycle 的期望需求要略高於 capacity，才會真的觸發「額度耗盡去借」。
（上面這組是三台機器試點用的節奏，約每 30 秒一次判斷。）

### 把 AMCN 接到你現有的 Agent（MCP）

```bash
AMCN_CONSOLE=http://127.0.0.1:47202 node mcp-server.js
```

三個 tool：`amcn_balance`、`amcn_publish_task`、`amcn_request_inference`。
這個 process **不持有金鑰也沒有身分**，只是 Owner Console 的薄客戶端。

---

## CC 是什麼、不是什麼

- **不是幣，也不打算是。** 沒有代幣發行、沒有交易所、**沒有固定的現金贖回**
  （FR-054／P-04）。CC 是這個封閉網路的記帳單位：Σ 永遠為 0，你的正餘額就是別人的
  負餘額。
- **負餘額是功能不是違約**（P-05）。還在線上交易的負餘額帳戶是正常的互惠信用。
- **額度是賺來的，不是給的。** 新身分第一天約 **23.1 CC**（starter 50 × 新戶品質係數
  × 年齡斜坡的前半），30 天後才走到約 46.25 CC；之後隨成交紀錄與**對手多樣性**成長。
- **跟自己刷量沒用**（F-1）。額度公式對「從單一對手賺到的量」有抑制項：實測從同一個
  對手賺 36.6 CC，額度零成長。
- **正餘額可能無處可花**（FR-056）。小網路裡若沒有結構性淨賣方，正餘額會累積在少數人
  手上——這是已量到的現象，不是你做錯了什麼。

## 你的義務

- **負餘額不能一走了之。** 離線超過門檻（預設 14 天）且餘額仍為負即沖銷，順序是
  你的抵押品 → 保險池 → `protocol:loss`。留下的洞是全網吃的。
- **Verifier 的押注規則**見路徑 A 那四條。
- **上游條款是你的責任**（P-10）：`terms.attested` 是你自己的聲明。
- **升級要跟上。** 協定現在是 **v7**。版本不符的 frame 會被明確拒絕
  （`[wire] rejected …: protocol v…`），功能上等於你不存在。`git pull` 之後把你這台的
  每個行程都重啟。

## 想要更高額度：抵押

把自己的**正餘額**鎖進 `protocol:collateral`，額度上升 `金額 × LTV`（預設 0.5）：

```bash
curl -s -X POST http://127.0.0.1:47202/collateral \
  -H 'content-type: application/json' -d '{"amount_cc": 10, "lock": true}'
```

兩條守門：只能抵押自己**已有的正餘額**（不能用信用抵押信用）；取回時剩餘額度必須
仍覆蓋現有負債。折扣率 0.5 不是隨手定的——模擬顯示等額抵押對打算違約的人是損益
中性的，要有折扣才讓攻擊無利可圖。

## Windows 上的兩個差異

程式本身跨平台（`lib/keystore.js` 只在 macOS 走 Keychain，其他平台直接用環境變數）。

```
REM Command Prompt
cd ai-exchage\node
node panel.js 192.168.1.10
```

```powershell
# PowerShell：裸寫 panel.cmd 會說「找不到命令」（它不把當前目錄放進 PATH）
.\panel.cmd 192.168.1.10
# 環境變數（例如 provider 的 key）
$env:AMCN_PROVIDER_KEY='sk-test-anything'
node agent.js configs\my-provider.json
```

PowerShell 不吃 bash 的單引號 JSON，所以**用設定檔而不是環境變數傳設定**。
第一次執行時防火牆若跳出提示，要允許 node 的入向連線（TCP 47180 出向、UDP 47179 入向）。

---

## 離開區網（跨網段／跨地點）

預設的 `tcp` 傳輸**沒有加密**：訊息有簽章、payload 有 E2E 加密，但信封是明文
（誰跟誰交易、多少錢、什麼時候）。要讓連線離開受信任的區網，換成 `secure`：

```bash
# 每一台都要：Hub、Agent、Verifier
export AMCN_TRANSPORT=secure
export AMCN_SECURE_SEED='這台自己的通道身分字串'
export AMCN_SECURE_PIN='did:demo:<對方的通道身分>'   # 只跟這個身分講話
```

臨時 X25519 → HKDF → AES-256-GCM，臨時金鑰由 Ed25519 身分簽章，以 DID 為信任錨
（不是 TLS，也沒有 CA——這個系統裡本來就沒有 CA，而你已經在釘 Hub 的 DID）。
路徑上的觀察者只看得到 frame 的時間與大小。**它防的不是 Hub**：Hub 當然看得到
metadata，那是它的工作，也是為什麼 payload 仍然端到端加密、收據仍然要簽。

### 或者：誰都不用開埠（`tor`，#89）

上面那條路要求**營運方**的機器是可達的——而真實家用網路經常不可能：開發機所在
的網路就是雙層 NAT（路由器的 WAN 是私有位址，上游那台進不去），port forward
連做都做不到。

所以有第五個傳輸實作，它把這個要求整個拿掉：

```bash
# 營運方那一側（不開任何對外埠、不動路由器、不用租機器）
brew install tor
cd node/service && ./install.sh --onion   # 常駐：com.amcn.onion，重開機也在

# 你這一側
brew install tor                          # 只需要一個 SOCKS5 出口
AMCN_TRANSPORT=tor node agent.js configs/my-agent.json
```

設定檔裡 `hubHost` 填 `<addr>.onion`，`hubPin` 照舊填對方的 hub did。

**更好的是不要填位址**（#45／#91）：位址會變（對方換 onion、搬機器），而簽署過的
位址記錄讓你每次重連都重新解析，所以換位址你不必改任何東西。設定檔改成

```json
{ "name": "我", "rendezvous": "https://…/rendezvous.json", "hubPin": "did:demo:…" }
```

只當驗收者的話一行就好：`AMCN_TRANSPORT=tor AMCN_HUB_PIN=did:demo:… node panel.js rv:<記錄的網址>`。
承載記錄的主機**不受信任**：它能扣住或給你舊的，但無法冒充對方——記錄帶著對方的
簽章，你的 `hubPin`／`AMCN_HUB_PIN` 會核對。記錄過期（預設 10 分鐘）會被**指名
拒絕**，那代表對方停了，不是你設定錯。

三件事同時成立：**零入向埠**（Hub 只聽 127.0.0.1，由 onion 的 rendezvous 把人
帶進來，雙層 NAT／CGNAT 兩邊都不必設定）、**位址本身就是公鑰**（v3 onion 是
ed25519 公鑰的編碼，所以不需要 CA——而你本來就在釘 `hubPin`，兩層信任錨是同一
種東西）、**免費且沒有人要營運基礎設施**。

代價要知道：延遲（電路數百毫秒）、頻寬有限、兩邊都要有 tor。閘門
`node demo-tor.js` 7/7（它自帶 SOCKS5 代理，所以不必裝 tor 也能驗）與
`node demo-rendezvous.js` 11/11（入口比 Hub 晚起來、入口換位址，記錄都要跟上），
但**真實 onion 的延遲與長連線穩定度還沒量過**，而兩端在不同地點這件事也還是
零次（#86）。

跨網段的**發現**（不能靠 UDP 廣播時）走 rendezvous：Hub 發布簽署過的位址記錄，
client 每次重連重新解析並用 `hubPin` 驗身分。承載記錄的主機不受信任——它能扣住
或給舊的，但無法冒充。細節見 `lib/rendezvous.js` 與 `INSTALL.md`。

## 自檢與查帳

```bash
node pilot-doctor.js 192.168.1.10          # 一個指令回答「我為什麼連不上」
curl -s http://127.0.0.1:47202/status      # 餘額、額度、策略、結算史
```

**不要只相信 Hub 給你的數字**——自己把整本帳拉下來重建：

```bash
node ledger-dump.js out/mine.json 192.168.1.10 47180
node verify-ledger.js out/mine.json --pin did:demo:<對方的 hub did>
```

`verify-ledger.js` 用的是第二個排序器啟動時用的同一份程式：每筆收據逐一驗簽、
pubkey 必須自證 DID、餘額由事件重放、雜湊鏈重算、信用額度由收據重放、checkpoint
驗 Hub 簽章並與重建出的鏈頭比對。任何一項不符是**拒絕**而不是警告。竄改一個金額
就會得到

```
結果：**拒絕** — 3 項不符
  - receipt c-…: postings sum 1.0000000000000007
  - receipt c-…: provider signature invalid
```

這就是「第一個排序器不是信任根」在使用者手上的樣子：你不需要信任 Hub 的善意，
只需要能自己驗。

## 常見錯誤

| 症狀 | 原因與解法 |
|---|---|
| `no hub beacon heard` | Hub 沒綁 `0.0.0.0`，或你們不在同一個廣播網段（訪客網路／VLAN／Wi-Fi client isolation 都會擋 UDP）→ 改手填 IP |
| `no beacon matching pinned hub` | `hubPin` 與 Hub 現在的身分不符。對方 Hub 若沒設 `HUB_SEED`，每次重啟都會換身分 |
| 連不上，但 ping 得通 | 對方防火牆擋 TCP 47180；或 `AMCN_TRANSPORT` 兩邊不一致（會印出 `refused a tcp peer on the http transport`）|
| `no bids for …` | 沒有人在供應，或 `maxPriceCC < units × 對方價格`，或賣方 quota 餘量不足（賣方要有 `quota.remaining ≥ units` 才准出價）|
| quorum 沒反應 | 線上的 verifier 不足 3 個；或你把自己放進自己合約的 pool（協議會拒絕）|
| 驗收 FAIL | 接了真實模型卻用 `sha256_eq`（見路徑 B 最後一段）|
| `stake: released only after 5 canary samples` | 還沒被金絲雀測夠就想取回押注（路徑 A 第 3、4 條）|
| 重啟後餘額變成 0 | 你的設定檔沒有 `seed`（新版會自動寫回；舊設定檔請自己補一個固定字串）|

## 現在的誠實狀態（2026-09-22）

- **這是 Phase 1 原型**，不是產品。協定 v7。
- **到目前為止唯一跑過的真實多機網路，三台機器都屬於同一個人**——所以帳上每一筆
  都是關聯方交易（登記簿 #63），市場數字不代表有外部需求。你如果是第一個外部
  參與者，那件事本身就是這個專案缺的那一塊證據。
- **沒有沙箱**（§20-6）：provider 執行的是你自己的模型呼叫，不是別人給的程式碼；
  但驗收斷言的執行環境沒有隔離設計，這是 Phase 2 的範圍。
- **爭議只有一條路**：驗收 FAIL 之後沒有仲裁流程，只有「強制結算」的反拒付路徑。
- **CC 換不到現金**，也沒有承諾會換（FR-054）。
