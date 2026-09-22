#!/usr/bin/env bash
# 讓這台機器**不開任何對外埠**也能被別人連到：tor 的 onion service（#89）。
#
#   ./run-onion.sh            啟動（前景，Ctrl-C 停）
#   ./run-onion.sh --addr     只印出目前的 onion 位址
#
# 這會建立一條**入向**路徑（外面的人可以連進來）。它不開防火牆、不動路由器、
# 也不需要公網 IP——但它確實讓這台機器變成可達，所以這個決定是你的，不是
# 這個腳本替你做的。停掉就是 Ctrl-C；位址留在 var/onion/ 裡，下次還是同一個。
#
# Hub 那一側完全不用改：它本來就只聽 127.0.0.1（`HUB_BIND` 不要設 0.0.0.0），
# tor 把外面的連線轉進那個回送位址。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${HUB_PORT:-47180}"
DIR="var/onion"
TORRC="var/torrc"

command -v tor >/dev/null || { echo "找不到 tor。先裝：brew install tor"; exit 1; }
mkdir -p "$DIR" var
chmod 700 "$DIR"

if [ "${1:-}" = "--addr" ]; then
  [ -s "$DIR/hostname" ] && cat "$DIR/hostname" || echo "（還沒有位址——先啟動一次）"
  exit 0
fi

cat > "$TORRC" <<CONF
SocksPort 9050
HiddenServiceDir $(pwd)/$DIR
HiddenServicePort $PORT 127.0.0.1:$PORT
# 只做這一件事：不當中繼、不當出口。
ClientOnly 1
CONF

echo "啟動 tor（onion service → 127.0.0.1:${PORT}）…"
tor -f "$TORRC" &
TOR_PID=$!
trap 'kill $TOR_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  [ -s "$DIR/hostname" ] && break
  sleep 1
done

ADDR="$(cat "$DIR/hostname" 2>/dev/null || true)"
if [ -z "$ADDR" ]; then echo "tor 沒有產生位址，看上面的輸出"; exit 1; fi

HUB_DID="$(grep -o 'hub did did:demo:[0-9a-f]*' logs/home-hub.log 2>/dev/null | tail -1 | awk '{print $3}')"
cat <<OUT

onion 位址：$ADDR
（這個位址本身就是公鑰——v3 onion 是 ed25519 公鑰的編碼——所以它不需要憑證。
 但它**不是** AMCN 的身分：對方仍然要釘 hubPin，那是兩層不同的東西。）

要給對方的設定：
  {
    "name": "你的名字",
    "hubHost": "${ADDR%.onion}.onion",
    "hubPort": $PORT,
    "hubPin": "${HUB_DID:-did:demo:<你的 hub did>}"
  }
  他那一側：brew install tor（或任何提供 SOCKS5 的 tor），然後
  AMCN_TRANSPORT=tor node agent.js configs/他的.json

要驗這條路通不通（他自己就能跑）：
  AMCN_TRANSPORT=tor node ledger-dump.js out/mine.json $ADDR $PORT
  node verify-ledger.js out/mine.json --pin ${HUB_DID:-<你的 hub did>}

$DIR/hostname 與 $DIR/hs_ed25519_secret_key 就是這個位址的身分——備份、不要外流。
OUT

wait $TOR_PID
