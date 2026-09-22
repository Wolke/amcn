#!/usr/bin/env bash
# 讓這台機器常駐跑 AMCN：Hub＋3 個 Verifier＋一個供給端 Agent，開機自動起、
# 崩潰自動重起（macOS launchd）。
#
#   ./install.sh          安裝並啟動
#   ./install.sh status   看三個服務的狀態與 hub did
#   ./uninstall.sh        全部移除（不會刪帳本與身分）
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
LA="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
LABELS=(com.amcn.hub com.amcn.panel com.amcn.agent)
SCRIPTS=(run-hub.sh run-panel.sh run-agent.sh)

hub_did() {
  grep -o 'hub did did:demo:[0-9a-f]*' "$REPO/logs/home-hub.log" 2>/dev/null \
    | tail -1 | awk '{print $3}'
}

if [ "${1:-install}" = "invite" ]; then
  # 直接印出可以貼給人的邀請，DID 與位址都填好——手動組裝這兩個值是最容易
  # 貼錯的一步，而貼錯的結果是對方連到別人的 Hub 或連不上而不知道為什麼。
  DID="$(hub_did)"
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<你的區網 IP>')"
  [ -n "$DID" ] || { echo "Hub 還沒起來（看 logs/home-hub.log），先 ./install.sh"; exit 1; }
  cat <<INVITE
—— 貼給對方（同區網，最低門檻：當驗收者）——

我在跑一個 AI Agent 之間互相借算力的網路（AMCN），想請你當驗收者。
你要做的事：一台開著的電腦。不需要 API key、不需要模型、不需要錢。

1. 裝 Node.js 20 以上：https://nodejs.org
2. 拿到程式：git clone <你的 repo 位址>
3. 跑這一行：
     cd ai-exchage/node && node panel.js $IP

看到「全部 3 個 Verifier 已向 Hub 註冊」就成功了。它會幫你保存身分
（configs/.panel-seed，那個檔案要留著），之後每次驗收會分到一點記帳單位（CC）。

想確認你連到的是我而不是別人，用這個版本（把我的身分釘住）：
     cd ai-exchage/node && AMCN_HUB_PIN=$DID node panel.js discover

連不上就跑： node pilot-doctor.js $IP  ——它會直接指出第一個問題在哪。
細節（CC 是什麼、你的義務、押注規則、怎麼自己驗帳）都在 node/JOIN.md。

要講清楚的三件事：CC 不是幣、換不到現金；負餘額是設計的一部分；
這是原型，目前為止網路上所有交易都是我自己的機器之間發生的。
INVITE
  exit 0
fi

if [ "${1:-install}" = "status" ]; then
  for l in "${LABELS[@]}"; do
    printf '%-18s %s\n' "$l" "$(launchctl list | awk -v L="$l" '$3==L {print "PID "$1"  上次退出碼 "$2}' || true)"
  done
  echo "hub did: $(hub_did)"
  exit 0
fi

[ -n "$NODE" ] || { echo "找不到 node，先安裝 Node.js ≥ 20"; exit 1; }
mkdir -p "$LA" "$REPO/logs"

for i in 0 1 2; do
  L="${LABELS[$i]}"; S="${SCRIPTS[$i]}"
  # 三個獨立的服務而不是一個包裝腳本：launchd 的 KeepAlive 是按服務算的，
  # 包成一個的話，panel 掛掉不會被單獨重起，而「半個 panel 看起來健康」
  # 是比整個停掉更糟的狀態。
  cat > "$LA/$L.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$L</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$REPO/service/$S</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$REPO/logs/home-${L#com.amcn.}.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/home-${L#com.amcn.}-err.log</string>
</dict>
</plist>
PLIST
done

for l in "${LABELS[@]}"; do launchctl unload "$LA/$l.plist" 2>/dev/null || true; done
launchctl load "$LA/com.amcn.hub.plist"
sleep 3
launchctl load "$LA/com.amcn.panel.plist"
launchctl load "$LA/com.amcn.agent.plist"
sleep 4

DID="$(hub_did)"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<你的區網 IP>')"
cat <<OUT

已安裝並啟動（開機自動起、崩潰自動重起）：
  com.amcn.hub     排序器      0.0.0.0:${HUB_PORT:-47180}
  com.amcn.panel   3 個驗收者  身分在 configs/.panel-seed
  com.amcn.agent   供給端      Owner Console http://127.0.0.1:47201/status

  hub did   ${DID:-（還沒印出來，看 logs/home-hub.log）}
  區網位址  $IP:${HUB_PORT:-47180}

要備份的三個東西（丟了就換身分，不是「重設密碼」）：
  configs/.hub-seed      Hub 的身分，別人釘的就是它
  configs/.panel-seed    verifier 的身分（押注綁在上面）
  configs/home-agent.json  供給端的身分
  out/home/ledger.json 與 out/home/ledger.json.tail  這本帳

  ./install.sh status    看狀態
  ./install.sh invite    印出可以直接貼給人的邀請（DID 與位址都填好）
  ./uninstall.sh         移除服務（帳本與身分都留著）
OUT
