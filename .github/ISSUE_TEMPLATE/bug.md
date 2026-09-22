---
name: Bug／行為不對
about: 某個指令或情境的結果與文件不符
labels: bug
---

## 跑了什麼

```
（完整指令，含環境變數）
```

## 看到什麼

```
（貼輸出。如果是 Hub 那一側，logs/ 裡的對應檔案更有用）
```

## 預期什麼、依據是哪一份文件

（`node/JOIN.md`、`node/INSTALL.md`、`docs/` 的哪一節，或穩定編號）

## 環境

- OS：
- `node --version`：
- `git log --oneline -1`：
- `AMCN_TRANSPORT`（沒設就是 tcp）：

## 先跑過的自我診斷

```
node pilot-doctor.js <hub 的 IP 或 127.0.0.1>
```

（貼結果。它會直接指出第一個 FAIL 在哪一層）
