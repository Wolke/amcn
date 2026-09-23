#!/usr/bin/env bash
# 加入一個已經在跑的 AMCN 網路——clone 之後要跑的那一個指令。
#
#   ./join.sh                加入 network.json 的網路，當驗收者（門檻最低：
#                            不需要 API key、不需要模型、不參與信用）
#   ./join.sh --verifiers 3  跑三個（收到的驗收工作變多）
#   ./join.sh --provider     同時賣算力（需要上游；沒設好會告訴你要填什麼）
#   ./join.sh --check        只做前置檢查並印出要連去哪，不啟動任何東西
#   ./join.sh status | stop
#
# 這支與 quickstart.sh／service/install.sh 的差別，是**角色**而不是規模：
#   quickstart.sh  在你這台開一座自己的島（一個 Hub＋驗收者＋兩個 agent）
#   install.sh     把你這台變成主辦（常駐排序器，別人連進來）
#   join.sh        你是**參與者**：只往外撥，永遠不必開埠
set -euo pipefail
cd "$(dirname "$0")"

VERIFIERS=1
PROVIDER=0
MODE=run
while [ $# -gt 0 ]; do
  case "$1" in
    --verifiers) VERIFIERS="${2:-1}"; shift 2 ;;
    --provider)  PROVIDER=1; shift ;;
    --check)     MODE=check; shift ;;
    status|stop) MODE="$1"; shift ;;
    *) echo "不認得的參數：$1"; exit 1 ;;
  esac
done

# 可覆蓋的理由有兩個：閘門不該碰到這台機器真正的身分與 pid，而同一台機器要
# 加入第二個網路時也需要第二份。
PIDDIR="${JOIN_DIR:-var/join}"
LOGDIR="${JOIN_LOG_DIR:-logs}"
CFGDIR="${AMCN_CONFIG_DIR:-configs}"
mkdir -p "$PIDDIR" "$LOGDIR" "$CFGDIR"

if [ "$MODE" = "status" ] || [ "$MODE" = "stop" ]; then
  [ -s "$PIDDIR/pids" ] || { echo "沒有在跑（$PIDDIR/pids 不存在）"; exit 0; }
  while read -r pid name; do
    if kill -0 "$pid" 2>/dev/null; then
      if [ "$MODE" = "stop" ]; then kill "$pid" 2>/dev/null && echo "已停止 $name (pid $pid)";
      else echo "在跑  $name (pid $pid)"; fi
    else
      echo "已結束 $name (pid $pid)"
    fi
  done < "$PIDDIR/pids"
  if [ "$MODE" = "stop" ]; then rm -f "$PIDDIR/pids"; fi
  [ "$MODE" = "status" ] && echo "log 在 $LOGDIR/join-*.log；身分在 $CFGDIR/.verifier-seed（等同私鑰，要備份）"
  exit 0
fi

# --- 前置檢查。每一項失敗都要說出**怎麼修**，而不是只說失敗 -----------------
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null || {
  echo "Node.js 太舊或找不到（需要 >= 20）：$(node -v 2>/dev/null || echo '沒有 node')"
  echo "  裝一個：https://nodejs.org  （這個專案零第三方相依，不需要 npm install）"
  exit 1
}

# 要連去哪由 lib/bootstrap.js 說——一個地方決定，否則這支腳本與程式會分岔。
NET="$(node -e '
  const n = require("./lib/bootstrap").network();
  if (!n) process.exit(3);
  process.stdout.write(JSON.stringify(n));
' 2>/dev/null)" || {
  node -e 'console.log(require("./lib/bootstrap").HELP)'
  exit 3
}
get() { node -e "const n=$NET; const v=n['$1']; process.stdout.write(v==null?'':String(v))"; }
HUB_HOST="$(get hubHost)"; HUB_PORT="$(get hubPort)"
RV="$(get rendezvous)"; PIN="$(get hubPin)"; TRANSPORT="$(get transport)"
TARGET="${RV:-$HUB_HOST:$HUB_PORT}"

# .onion 只能經 tor 解析（它在 DNS 裡不存在），所以這件事要在啟動前確定，
# 而不是讓三個行程各自靜靜地重試（#76 的教訓：失敗要說出成因）。
NEED_TOR=0
case "${TRANSPORT}${HUB_HOST}${RV}" in *.onion*|*tor*) NEED_TOR=1 ;; esac
SOCKS="${AMCN_TOR_SOCKS:-127.0.0.1:9050}"
if [ "$NEED_TOR" = "1" ]; then
  export AMCN_TRANSPORT=tor
  SOCKS_HOST="${SOCKS%%:*}"; SOCKS_PORT="${SOCKS##*:}"
  if ! node -e "
    const net=require('net');const s=net.connect($SOCKS_PORT,'$SOCKS_HOST');
    s.on('connect',()=>{s.destroy();process.exit(0)});
    s.on('error',()=>process.exit(1));
    setTimeout(()=>{s.destroy();process.exit(1)},1500);
  " 2>/dev/null; then
    if [ "${JOIN_FAKE_NO_TOR:-0}" = "1" ] || ! command -v tor >/dev/null; then
      echo "這個網路的位址是 .onion，需要本機有一個 tor 的 SOCKS5 出口（${SOCKS}），而現在沒有。"
      echo "  macOS:  brew install tor"
      echo "  Debian/Ubuntu:  sudo apt install tor"
      echo "  裝好之後再跑一次這支；它會自己把 tor 起來（只當客戶端，不當中繼）。"
      exit 1
    fi
    echo "啟動本機 tor（只當客戶端，SOCKS ${SOCKS}）…"
    nohup tor --SocksPort "$SOCKS_PORT" --ClientOnly 1 >> "$LOGDIR/join-tor.log" 2>&1 &
    echo "$! tor" >> "$PIDDIR/pids"
    for _ in $(seq 1 30); do
      node -e "
        const net=require('net');const s=net.connect($SOCKS_PORT,'$SOCKS_HOST');
        s.on('connect',()=>{s.destroy();process.exit(0)});
        s.on('error',()=>process.exit(1));
      " 2>/dev/null && break
      sleep 1
    done
  fi
fi

echo "要加入的網路：${TARGET}"
echo "  釘住          ${PIN:-（沒有 pin——任何答得出來的人都會被跟隨，向邀請你的人要 hub did）}"
echo "  傳輸          ${AMCN_TRANSPORT:-tcp}$([ "$NEED_TOR" = 1 ] && echo "（經本機 tor，${SOCKS}）")"
echo "  角色          ${VERIFIERS} 個驗收者$([ "$PROVIDER" = 1 ] && echo " ＋ 一個供給端")"
if [ "$MODE" = "check" ]; then
  echo "（--check：只檢查，沒有啟動任何東西）"
  exit 0
fi

start() {   # start <名字> <指令…>
  local name="$1"; shift
  nohup "$@" >> "$LOGDIR/join-$name.log" 2>&1 &
  echo "$! $name" >> "$PIDDIR/pids"
  echo "  起了 ${name}（log: $LOGDIR/join-$name.log）"
}

if [ "$VERIFIERS" = "1" ]; then
  # 一個就用 verifier.js：它自己會走 lib/bootstrap（身分存在 configs/.verifier-seed）。
  start verifier node verifier.js
else
  # 多個要有**各自的身分**，那是 panel.js 在做的事（押注綁在身分上，#38）。
  if [ -n "$RV" ]; then
    AMCN_HUB_PIN="$PIN" start panel node panel.js "rv:$RV" "$HUB_PORT" "$VERIFIERS"
  else
    AMCN_HUB_PIN="$PIN" start panel node panel.js "$HUB_HOST" "$HUB_PORT" "$VERIFIERS"
  fi
fi

if [ "$PROVIDER" = "1" ]; then
  CFG="$CFGDIR/my-provider.json"
  if [ ! -s "$CFG" ]; then
    # 把網路那三個值先填好再交給你：手抄 hubPin 是最容易貼錯的一步。
    JOIN_PROVIDER_CFG="$CFG" node -e '
      const fs=require("fs");
      const t=JSON.parse(fs.readFileSync("configs/provider.example.json","utf8"));
      const n=require("./lib/bootstrap").network();
      if (n.rendezvous) { t.rendezvous=n.rendezvous; delete t.hubHost; delete t.hubPort; }
      else { t.hubHost=n.hubHost; t.hubPort=n.hubPort; }
      t.hubPin=n.hubPin; t.name="my-provider";
      fs.writeFileSync(process.env.JOIN_PROVIDER_CFG, JSON.stringify(t,null,2)+"\n");
    '
    echo ""
    echo "已產生 ${CFG}（網路那幾個值都填好了）。**賣算力還要你補兩段**："
    echo "  adapter.baseUrl／model／terms.attested   你的上游是誰、以及你聲明它允許替第三方執行（P-10）"
    echo "  policy.spend.usdPerMTokens               你的價目表，填了美金上限才會生效（#94）"
    echo "補完之後： node agent.js $CFG"
    echo "（沒有 adapter 的節點不會出價——不能執行者不得出價，#21）"
  else
    start provider node agent.js "$CFG"
  fi
fi

# 查帳那兩行要能直接貼。只知道位址記錄時，位址要現在解析出來——印一個
# `<hub 位址>` 的佔位符等於把最後一步又推回給使用者。
if [ -n "${HUB_HOST}" ]; then
  DUMP_TARGET="${HUB_HOST} ${HUB_PORT}"
else
  DUMP_TARGET="$(node -e '
    require("./lib/rendezvous").resolve(process.argv[1], { pin: process.argv[2] || null })
      .then((g) => process.stdout.write(g.ok ? `${g.host} ${g.port}` : "<hub 位址> <埠>"));
  ' "${RV}" "${PIN}" 2>/dev/null || echo "<hub 位址> <埠>")"
fi

cat <<OUT

在跑了。接下來：
  ./join.sh status      看還活著沒
  ./join.sh stop        停掉
  tail -f $LOGDIR/join-*.log

你的身分存在 $CFGDIR/.verifier-seed（0600）——**那個檔案等同私鑰**：押注與受測
紀錄綁在它上面，丟了就等於換一個新身分從零開始。要備份。

想知道你在這個網路上看到的帳是不是真的（不必相信對方的 Hub）：
  node ledger-dump.js out/mine.json ${DUMP_TARGET}
  node verify-ledger.js out/mine.json --pin ${PIN:-<hub did>}
細節（CC 是什麼、你的義務、押注規則）在 node/JOIN.md。
OUT
