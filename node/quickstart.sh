#!/usr/bin/env bash
# AMCN 單機起步：在這一台上起一個真的網路（Hub＋3 個 Verifier＋兩個 Agent），
# 跑完一次「借用 → 驗收 → 結算 → 還債」，然後**留著讓你自己操作**。
#
# 與 `node demo.js` 的差別：demo 是腳本驅動的回歸閘門，跑完就結束；這支留下
# 一個活著的網路，你可以對它發任務、查帳、重啟、備份，也就是真正要學的東西。
#
# 誠實標註：這裡的兩個 Agent 都是你自己的，所以每一筆結算在帳上都是
# **關聯方交易**（#63）。它證明機制會動，不證明有人願意付錢。
#
#   ./quickstart.sh          起來並跑第一筆
#   ./quickstart.sh stop     停掉全部
#   ./quickstart.sh status   看兩邊餘額
set -uo pipefail
cd "$(dirname "$0")"

PORT="${HUB_PORT:-47180}"
RUN=out/quickstart
mkdir -p "$RUN" logs configs

need_node() {
  command -v node >/dev/null || { echo "找不到 node。請先安裝 Node.js ≥ 20。"; exit 1; }
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || { echo "Node $(node -v) 太舊，AMCN 需要 ≥ 20。"; exit 1; }
}

stop_all() {
  local n=0
  for f in "$RUN"/*.pid; do
    [ -e "$f" ] || continue
    local pid; pid="$(cat "$f")"
    if kill "$pid" 2>/dev/null; then n=$((n+1)); fi
    rm -f "$f"
  done
  echo "已停掉 $n 個行程（帳本留在 $RUN/ledger.json，下次可用 HUB_IMPORT 接續）。"
}

show_status() {
  for p in 47201 47202; do
    curl -s "http://127.0.0.1:$p/status" 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => { s += d; });
      process.stdin.on("end", () => {
        if (!s) return console.log("  (console " + process.argv[1] + " 沒有回應)");
        const d = JSON.parse(s);
        console.log(`  ${d.name.padEnd(12)} ${d.did}  餘額 ${d.balance_cc.toFixed(2).padStart(8)} CC` +
          `  額度 ${d.credit_line_cc.toFixed(1)} CC  策略 ${d.strategy.mode}`);
      });' "$p"
  done
}

case "${1:-up}" in
  stop) stop_all; exit 0 ;;
  status) show_status; exit 0 ;;
esac

need_node

if node -e "require('net').connect($PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
  echo "127.0.0.1:$PORT 已經有東西在聽——可能上一次還沒停。"
  echo "  ./quickstart.sh stop   然後再跑一次，或用 HUB_PORT=47280 ./quickstart.sh"
  exit 1
fi

start() {   # start <name> <logfile> <cmd...>
  local name="$1" log="$2"; shift 2
  "$@" > "logs/$log" 2>&1 &
  echo $! > "$RUN/$name.pid"
}

echo "== 1/5 Hub（排序器）=="
# 已經有一本帳就接續它，而不是覆蓋。第一版沒做這件事：`HUB_DUMP_PATH` 指向
# 同一個檔案，所以第二次執行會把上一次的帳靜默蓋掉——而「重啟後餘額延續」
# 正是這支 script 想讓人看到的事情之一。
if [ -z "${HUB_IMPORT:-}" ] && [ -s "$RUN/ledger.json" ]; then
  export HUB_IMPORT="$RUN/ledger.json"
  echo "   接續上一次的帳：${HUB_IMPORT}（匯入時會逐筆驗證，不符就拒絕啟動）"
fi
# HUB_SEED 讓 Hub 身分跨重啟不變（否則釘住它的 agent 每次都要改設定）。
# HUB_DUMP_PATH 讓這本帳活過重啟：快照＋即時尾檔，下次用 HUB_IMPORT 接回來。
# env 前綴給的是 node 的環境，不是這個 shell 函式的——`VAR=x func` 在 bash 裡
# 的作用範圍會咬人，所以明確用 env(1)。
start hub quickstart-hub.log env \
  HUB_SEED="${HUB_SEED:-quickstart-hub}" HUB_DUMP_PATH="$RUN/ledger.json" \
  HUB_PORT="$PORT" HUB_BIND=0.0.0.0 node hub.js
sleep 2
HUB_DID="$(grep -o 'hub did did:demo:[0-9a-f]*' logs/quickstart-hub.log | head -1 | awk '{print $3}')"
[ -n "$HUB_DID" ] || { echo "Hub 沒起來，看 logs/quickstart-hub.log"; exit 1; }
echo "   hub did ${HUB_DID}（這就是別人要釘的 hubPin）"

echo "== 2/5 Verifier panel（3 個，不需要 API key 也不需要模型）=="
start panel quickstart-panel.log node panel.js 127.0.0.1 "$PORT" 3
sleep 4
grep -c "registered as verifier" logs/quickstart-panel.log | xargs -I{} echo "   已註冊 {} 個 verifier"

mkcfg() {  # mkcfg <file> <json>
  [ -e "$1" ] || printf '%s\n' "$2" > "$1"
}

echo "== 3/5 供給端 Agent（賣算力）=="
mkcfg configs/quickstart-provider.json '{
  "name": "seller",
  "hubHost": "127.0.0.1",
  "hubPort": '"$PORT"',
  "consolePort": 47201,
  "adapter": { "baseUrl": null, "model": null, "key": { "env": "AMCN_QS_KEY" } },
  "provide": { "afterMs": 0, "pricePerUnit": 1.0, "repayment": true },
  "posts": []
}'
start seller quickstart-seller.log env AMCN_QS_KEY=sk-quickstart-placeholder \
  node agent.js configs/quickstart-provider.json

echo "== 4/5 需求端 Agent（借算力，也會供給以便還債）=="
mkcfg configs/quickstart-buyer.json '{
  "name": "buyer",
  "hubHost": "discover",
  "hubPin": "'"$HUB_DID"'",
  "consolePort": 47202,
  "adapter": { "baseUrl": null, "model": null, "key": { "env": "AMCN_QS_KEY" } },
  "provide": { "afterMs": 0, "pricePerUnit": 1.0, "repayment": true },
  "posts": []
}'
start buyer quickstart-buyer.log env AMCN_QS_KEY=sk-quickstart-placeholder \
  node agent.js configs/quickstart-buyer.json
sleep 5

echo "== 5/5 第一筆任務：buyer 向網路借 10 單位的算力 =="
curl -s -X POST http://127.0.0.1:47202/post -H 'content-type: application/json' \
  -d '{"units":10,"maxPriceCC":12,"payload":"hello AMCN",
       "acceptance":"judge-quorum",
       "asserts":[{"op":"sha256_eq"},{"op":"max_len","arg":64}]}' > /dev/null
sleep 8
grep -m1 "SETTLED" logs/quickstart-hub.log | sed 's/^/   /' || echo "   還沒結算，看 logs/quickstart-hub.log"

echo
echo "現在的帳："
show_status
cat <<EOF

網路還活著。接下來可以做的事：

  發任務      curl -s -X POST http://127.0.0.1:47202/post -H 'content-type: application/json' \\
                -d '{"units":10,"maxPriceCC":12,"payload":"任何字串","acceptance":"judge-quorum","asserts":[{"op":"sha256_eq"}]}'
  查帳        ./quickstart.sh status
  還債        讓 seller 發任務（換成 47201），buyer 會折價搶單把負餘額還掉
  自己驗帳    node ledger-dump.js $RUN/mine.json 127.0.0.1 $PORT
              node verify-ledger.js $RUN/mine.json --pin $HUB_DID
              （不必相信 Hub：逐筆驗簽、餘額由事件重放、checkpoint 比對鏈頭）
  診斷        node pilot-doctor.js 127.0.0.1 $PORT
  停掉        ./quickstart.sh stop

設定檔在 configs/quickstart-*.json——裡面的 seed 就是身分，備份它、不要外流。
下次要接續這本帳：HUB_IMPORT=$RUN/ledger.json ./quickstart.sh
別人要加入你這一台：把 hubPin $HUB_DID 給他，見 node/JOIN.md。
EOF
