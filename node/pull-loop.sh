#!/bin/bash
# 把帳本從 Hub 那台定時拉到本機（three-machine-pilot.md §5 前置 (a)）。
#
# 為什麼需要：`HUB_DUMP_PATH` 寫的是 Hub 本機的檔，而演練要拔線的正是那台
# ——備份會跟著災難一起消失。所以待命機必須自己定期拉一份。
#
# 用法：  ./pull-loop.sh [hub IP] [hub port] [間隔秒]
#         ./pull-loop.sh 192.168.50.30
#
# 失敗一定會印 FAIL。接手時唯一的依據就是「最後一份成功的匯出」，而一段
# 沒被發現的失敗會讓那份比你以為的舊很多——那是 #76 在運維上的版本。
set -u
HUB="${1:-192.168.50.30}"
PORT="${2:-47180}"
EVERY="${3:-60}"
KEEP=60                     # 保留份數（約一小時）

cd "$(dirname "$0")"
mkdir -p out/pulled logs
echo "# 每 ${EVERY}s 從 ${HUB}:${PORT} 拉一份，保留最近 ${KEEP} 份"

while true; do
  TS=$(date +%Y%m%d-%H%M%S)
  OUT="out/pulled/ledger-$TS.json"
  if node ledger-dump.js "$OUT" "$HUB" "$PORT" > /tmp/amcn-pull.out 2>&1; then
    SZ=$(wc -c < "$OUT" 2>/dev/null || echo 0)
    RC=$(grep -o '匯出 [0-9]* 筆收據' /tmp/amcn-pull.out | head -1)
    # latest.json 永遠指向最後一份**成功**的。演練當下不該臨時去翻哪個最新。
    ln -sf "$(basename "$OUT")" out/pulled/latest.json
    echo "$(date -u +%FT%TZ)  OK   $((SZ/1024))KB  ${RC:-}"
  else
    rm -f "$OUT"            # 半份檔比沒有更危險
    echo "$(date -u +%FT%TZ)  FAIL $(tail -1 /tmp/amcn-pull.out)"
  fi
  ls -1t out/pulled/ledger-*.json 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
  sleep "$EVERY"
done
