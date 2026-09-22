#!/bin/bash
# 待命排序器：在 M1 被拔線之後接手（three-machine-pilot.md §5）。
#
# **只在拔線之後執行。** 兩個排序器同時在同一網段上，測到的是分叉，
# 不是接手——runbook 明講 M1 不得再接回同一網段。
#
# 用同一個 HUB_SEED，所以接手的 Hub 是**同一個 DID**，pin 住它的 client
# 會自己跟上、不需要任何人改設定。代價要照實記錄：排序器的私鑰從此存在
# 兩台機器上。
#
# 匯入的是 pull-loop 拉到的最後一份**成功**的匯出。rebuild 會逐筆驗簽、
# 重算鏈、比對 checkpoint root——對不上就拒絕啟動（#78），那是正確行為。
set -eu
cd "$(dirname "$0")"

SEED="${HUB_SEED:-amcn-pilot-2026-09-21}"
# 預設本機：寫死別人家的內網位址對 clone 這份 repo 的人沒有意義（公開前的清理）。
SELF="${1:-127.0.0.1}"
IMPORT="${2:-out/pulled/latest.json}"

if [ ! -e "$IMPORT" ]; then
  echo "找不到 $IMPORT —— pull-loop 有在跑嗎？（tail logs/pull.log）" >&2
  exit 1
fi
echo "接手中：匯入 $(readlink "$IMPORT" 2>/dev/null || echo "$IMPORT")"
ls -l "$(dirname "$IMPORT")/$(readlink "$IMPORT" 2>/dev/null || basename "$IMPORT")" 2>/dev/null || true

mkdir -p logs out
HUB_BIND=0.0.0.0 \
HUB_ADVERTISE_HOST="$SELF" \
HUB_SEED="$SEED" \
HUB_IMPORT="$IMPORT" \
HUB_DUMP_PATH=out/standby-ledger.json \
  node hub.js 2>&1 | tee -a logs/standby-hub.log
