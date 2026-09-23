#!/usr/bin/env bash
# 讓這台機器常駐跑 AMCN：Hub＋3 個 Verifier＋一個供給端 Agent，開機自動起、
# 崩潰自動重起（macOS launchd）。
#
#   ./install.sh          安裝並啟動（區網模式：只有同網段的人連得到）
#   ./install.sh --onion  同上，外加一個常駐 onion service：**任何地方**的人
#                         都能加入，而這台機器對外零入向埠（#89／#86）
#   ./install.sh --lan    切回區網模式（會停掉 onion service）
#   ./install.sh publish  把 network.json 填成這個網路（commit 之後別人 clone 就能加入）
#   ./install.sh status   看服務狀態、hub did、對外位址
#   ./install.sh invite   印出可以直接貼給人的邀請
#   ./uninstall.sh        全部移除（不會刪帳本與身分）
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
LA="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
MODE_FILE="$REPO/configs/.home-mode"
RV_FILE="$REPO/var/rendezvous.json"

hub_did() {
  grep -o 'hub did did:demo:[0-9a-f]*' "$REPO/logs/home-hub.log" 2>/dev/null \
    | tail -1 | awk '{print $3}'
}
onion_addr() { cat "$REPO/var/onion/hostname" 2>/dev/null || true; }
mode() { cat "$MODE_FILE" 2>/dev/null || echo lan; }

# 記錄是資料而不是服務，所以這裡只是把它讀出來給人看——它到不到得了別人手上
# 是你怎麼發布它的問題（靜態主機、物件儲存、公開 repo 的一個 commit）。
rv_summary() {
  [ -s "$RV_FILE" ] || { echo "（還沒有記錄——Hub 起來後 60 秒內會寫出）"; return; }
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const age = Math.round((Date.now() - r.ts) / 1000);
    console.log(`${r.host}:${r.port}（${age}s 前發布）`);
  ' "$RV_FILE" 2>/dev/null || echo "（記錄讀不出來：${RV_FILE}）"
}

if [ "${1:-install}" = "invite" ]; then
  # 直接印出可以貼給人的邀請，DID 與位址都填好——手動組裝這兩個值是最容易
  # 貼錯的一步，而貼錯的結果是對方連到別人的 Hub 或連不上而不知道為什麼。
  DID="$(hub_did)"
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<你的區網 IP>')"
  ONION="$(onion_addr)"
  [ -n "$DID" ] || { echo "Hub 還沒起來（看 logs/home-hub.log），先 ./install.sh"; exit 1; }
  cat <<INVITE
—— 貼給對方（同區網，最低門檻：當驗收者）——

我在跑一個 AI Agent 之間互相借算力的網路（AMCN），想請你當驗收者。
你要做的事：一台開著的電腦。不需要 API key、不需要模型、不需要錢。

1. 裝 Node.js 20 以上：https://nodejs.org
2. 拿到程式：git clone https://github.com/Wolke/amcn.git
3. 跑這一行：
     cd amcn/node && node panel.js $IP

看到「全部 3 個 Verifier 已向 Hub 註冊」就成功了。它會幫你保存身分
（configs/.panel-seed，那個檔案要留著），之後每次驗收會分到一點記帳單位（CC）。

想確認你連到的是我而不是別人，用這個版本（把我的身分釘住）：
     cd amcn/node && AMCN_HUB_PIN=$DID node panel.js discover

連不上就跑： node pilot-doctor.js $IP  ——它會直接指出第一個問題在哪。
INVITE
  if [ -n "$ONION" ]; then
    cat <<INVITE

—— 不在我的區網（任何地方都可以，而我不必開任何埠）——

     brew install tor
     git clone https://github.com/Wolke/amcn.git && cd amcn/node
     AMCN_TRANSPORT=tor AMCN_HUB_PIN=$DID node panel.js $ONION ${HUB_PORT:-47180}

走的是 onion service：位址本身就是公鑰，我這邊零入向埠。代價是延遲
（取一次帳約 2.5 秒）與兩邊都要有 tor。

**位址會變，所以更好的是這一行**——跟著簽署過的記錄走（#45），我換位址
你不必改任何東西：

     AMCN_TRANSPORT=tor AMCN_HUB_PIN=$DID node panel.js rv:<記錄的網址>

我現在發布的記錄指向 $(rv_summary)
承載記錄的那台主機**不受信任**：它能扣住或給你舊的，但無法冒充我——記錄帶著
我的簽章，你的 AMCN_HUB_PIN 會核對它。
INVITE
  fi
  cat <<INVITE

細節（CC 是什麼、你的義務、押注規則、怎麼自己驗帳）都在 node/JOIN.md。

要講清楚的三件事：CC 不是幣、換不到現金；負餘額是設計的一部分；
這是原型，目前為止網路上所有交易都是我自己的機器之間發生的。
INVITE
  exit 0
fi

if [ "${1:-install}" = "publish" ]; then
  # 「發布一個網路」＝把 network.json 填好並 commit。手抄 onion 位址與 hub did
  # 是整條推廣路徑上最容易貼錯的一步，而貼錯的結果是對方連到別人的 Hub 或
  # 連不上而不知道為什麼——所以這一步由程式做。
  DID="$(hub_did)"; ONION="$(onion_addr)"
  [ -n "${DID}" ] || { echo "Hub 還沒起來（看 logs/home-hub.log），先 ./install.sh"; exit 1; }
  if [ -z "${ONION}" ]; then
    echo "還沒有 onion 位址——只有區網位址的話，clone 這份 repo 的人連不到你。"
    echo "  先跑： ./install.sh --onion   （常駐 onion service，對外零入向埠）"
    exit 1
  fi
  # install.sh 自己 cd 到 service/ 底下，所以這裡要用絕對路徑——
  # 相對路徑在第一版就讓它去找 service/network.json 了。
  node -e '
    const fs = require("fs");
    const p = process.argv[5];
    const cur = JSON.parse(fs.readFileSync(p, "utf8"));
    const out = { _: cur._, name: process.argv[1], hubHost: process.argv[2],
                  hubPort: Number(process.argv[3]), transport: "tor",
                  rendezvous: null, hubPin: process.argv[4] };
    fs.writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
  ' "${NETWORK_NAME:-amcn}" "${ONION}" "${HUB_PORT:-47180}" "${DID}" "${REPO}/network.json"
  echo "已把 node/network.json 填成這個網路："
  echo "  位址  ${ONION}:${HUB_PORT:-47180}（tor）"
  echo "  釘住  ${DID}"
  echo ""
  echo "剩下一步是 commit 它——那就是「發布」的全部內容："
  echo "    git add node/network.json && git commit -m 'publish the network' && git push"
  echo ""
  echo "之後任何人 clone 這份 repo 就能直接加入，不必問你任何值："
  echo "    cd node && ./join.sh"
  echo "（對方需要本機有 tor；沒裝的話 join.sh 會說怎麼裝。你這邊仍然零入向埠。）"
  exit 0
fi

if [ "${1:-install}" = "status" ]; then
  echo "模式      $(mode)$([ "$(mode)" = onion ] && echo '（對外零入向埠）' || echo '（只有同區網連得到）')"
  for l in com.amcn.hub com.amcn.panel com.amcn.agent com.amcn.onboard com.amcn.onion; do
    [ -f "$LA/$l.plist" ] || continue
    printf '%-18s %s\n' "$l" "$(launchctl list | awk -v L="$l" '$3==L {print "PID "$1"  上次退出碼 "$2}' || true)"
  done
  echo "hub did   $(hub_did)"
  echo "onion     $(onion_addr || echo '（無）')"
  echo "位址記錄  $(rv_summary)"
  exit 0
fi

WANT_MODE="$(mode)"
case "${1:-install}" in
  --onion) WANT_MODE=onion ;;
  --lan)   WANT_MODE=lan ;;
  install|"") ;;
  *) echo "不認得的參數：$1（用 --onion／--lan／status／invite）"; exit 1 ;;
esac

[ -n "$NODE" ] || { echo "找不到 node，先安裝 Node.js ≥ 20"; exit 1; }
if [ "$WANT_MODE" = "onion" ] && ! command -v tor >/dev/null; then
  echo "onion 模式需要 tor：brew install tor（裝好再跑一次 ./install.sh --onion）"
  exit 1
fi
mkdir -p "$LA" "$REPO/logs" "$REPO/configs" "$REPO/var"
echo "$WANT_MODE" > "$MODE_FILE"
# 發樁者的身分要**在 Hub 啟動之前**存在：Hub 讀 configs/.onboard-seed 算出 DID
# 並授權它（HUB_ONBOARD_DID）。順序反了的話，第一次啟動的 Hub 誰都沒授權，而
# 發樁者的每一筆都會被拒絕——那種失敗很安靜，只會看起來像「新人沒有工作可做」。
ONBOARD_DID="$(bash "$REPO/service/run-onboard.sh" --did)"

LABELS=(com.amcn.hub com.amcn.panel com.amcn.agent com.amcn.onboard)
SCRIPTS=(run-hub.sh run-panel.sh run-agent.sh run-onboard.sh)
ARGS=("" "" "" "")
if [ "$WANT_MODE" = "onion" ]; then
  # 入口本身也要是一個**服務**。原本它是一個前景腳本，所以「常駐跑這個網路」
  # 與「外面的人能加入」是兩回事：機器重開、tor 崩掉、或那個終端機被關掉，
  # 入口就沒了，而 Hub 看起來完全健康（#86）。
  LABELS+=(com.amcn.onion)
  SCRIPTS+=(run-onion.sh)
  ARGS+=("--service")
fi

for i in "${!LABELS[@]}"; do
  L="${LABELS[$i]}"; S="${SCRIPTS[$i]}"; A="${ARGS[$i]}"
  # 四個獨立的服務而不是一個包裝腳本：launchd 的 KeepAlive 是按服務算的，
  # 包成一個的話，panel 掛掉不會被單獨重起，而「半個 panel 看起來健康」
  # 是比整個停掉更糟的狀態。
  cat > "$LA/$L.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$L</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$REPO/service/$S</string>$([ -n "$A" ] && echo "<string>$A</string>")</array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$REPO/logs/home-${L#com.amcn.}.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/home-${L#com.amcn.}-err.log</string>
</dict>
</plist>
PLIST
done

for l in com.amcn.hub com.amcn.panel com.amcn.agent com.amcn.onboard com.amcn.onion; do
  launchctl unload "$LA/$l.plist" 2>/dev/null || true
done
# 切回區網模式時要把入口真的收掉，否則「我以為我沒有對外」與事實不一致——
# 那比從來沒開過更糟。
if [ "$WANT_MODE" != "onion" ]; then rm -f "$LA/com.amcn.onion.plist"; fi

if [ "$WANT_MODE" = "onion" ]; then
  launchctl load "$LA/com.amcn.onion.plist"   # tor 先起來，位址才會存在
fi
launchctl load "$LA/com.amcn.hub.plist"
sleep 3
launchctl load "$LA/com.amcn.panel.plist"
launchctl load "$LA/com.amcn.agent.plist"
# 發樁者最後起：它要 Hub 已經在聽，而且 Hub 必須已經授權它。
launchctl load "$LA/com.amcn.onboard.plist"
sleep 4

DID="$(hub_did)"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<你的區網 IP>')"
cat <<OUT

已安裝並啟動（開機自動起、崩潰自動重起），模式 ${WANT_MODE}：
  com.amcn.hub     排序器      $([ "$WANT_MODE" = onion ] && echo "127.0.0.1:${HUB_PORT:-47180}（對外零入向埠）" || echo "0.0.0.0:${HUB_PORT:-47180}")
  com.amcn.panel   3 個驗收者  身分在 configs/.panel-seed
  com.amcn.agent   供給端      Owner Console http://127.0.0.1:47201/status
  com.amcn.onboard 入門採購    Treasury 向新人買「答案已知的工作」（#90）
$([ "$WANT_MODE" = onion ] && echo "  com.amcn.onion   對外入口    onion service → 127.0.0.1:${HUB_PORT:-47180}")

  hub did   ${DID:-（還沒印出來，看 logs/home-hub.log）}
  新人額度  starter 10 CC ＋入門採購（每身分上限 20、全網 2000）；發樁者 ${ONBOARD_DID}
            送額度的白拿 ≈ starter × 0.87，所以這個值就是你對 Sybil 的曝險上界
            （為什麼是 10：docs/evaluation/credit-regime-ab.md。要改回 50 就設
             DEMO_STARTER_CC=50，那等於接受每個新身分是一份 ~44 CC 的禮物）
  區網位址  $IP:${HUB_PORT:-47180}
  對外位址  $([ "$WANT_MODE" = onion ] && echo "$(onion_addr || echo '（tor 還在建，約 30 秒）')" || echo '（區網模式：沒有）')
  位址記錄  $RV_FILE → $(rv_summary)

把 $RV_FILE 放到任何靜態主機（物件儲存、公開 repo 的一個 commit）就是位址
輪替機制：客戶端設 "rendezvous": "<那個網址>" 與 "hubPin"，之後你換位址、
換入口、換機器，都不必有人改設定（#45）。承載它的主機不受信任。

要備份的東西（丟了就換身分，不是「重設密碼」）：
  configs/.hub-seed      Hub 的身分，別人釘的就是它
  configs/.panel-seed    verifier 的身分（押注綁在上面）
  configs/home-agent.json  供給端的身分
  configs/.onboard-seed    入門採購發樁者的身分（Hub 授權的就是它）
  out/home/ledger.json 與 out/home/ledger.json.tail  這本帳
$([ "$WANT_MODE" = onion ] && echo "  var/onion/hs_ed25519_secret_key  onion 位址的身分（丟了位址就換）")

  ./install.sh status    看狀態
  ./install.sh invite    印出可以直接貼給人的邀請（DID 與位址都填好）
  ./install.sh publish   把 network.json 填好；commit 之後別人 clone 就能加入
  ./install.sh --lan     收掉對外入口，改回只有區網連得到
  ./uninstall.sh         移除服務（帳本與身分都留著）
OUT
