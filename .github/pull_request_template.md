## 這個 PR 做了什麼

（結論先寫，不是「改了哪些檔案」）

## 為什麼

（如果它修的是一個缺陷：它在什麼情況下不成立？為什麼在此之前沒被發現？
 引用穩定編號 — FR-xxx / NFR-xxx / P-xx / §16 威脅 n / 登記簿 #nn）

## 什麼東西證明它成立

- [ ] 補了一個**在修之前是紅的**閘門，指令：`...`
- [ ] 或說明為什麼這個改動不需要新閘門（例如純文件）

## 跑過的閘門

- [ ] `python3 -m unittest discover -s sim/tests`
- [ ] `cd node && node demo.js`
- [ ] `cd node && node demo-rebuild.js`
- [ ] `cd node && node redteam.js`
- [ ] `cd node && node redteam-agents.js`
- [ ] 動到 `lib/channel.js`／`hub.js`／`agent.js`／`verifier.js` 的話：
      `node/README.md` 執行清單裡的每一支都跑過

## 影響面

- [ ] 協定版本要不要升（`node/lib/wire.js` 的 `PROTOCOL_VERSION`）？
      判準：舊版收到這個訊息會不會**靜默忽略**而讓對方等一個永遠不來的答覆
- [ ] 動到經濟公式的話，附上模擬前後的指標差異
- [ ] 新的環境變數／預設值有寫進 `node/INSTALL.md` 或 `CLAUDE.md`

## 沒做的事 / 已知限制

（誠實寫。這個專案的文件慣例是把「不宣稱什麼」寫出來）
