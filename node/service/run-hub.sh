#!/usr/bin/env bash
# 常駐 Hub（排序器）。由 launchd 拉起，崩潰會被重新拉起。
#
# 種子存在 configs/.hub-seed 而不是寫進 plist：`hub did` 就是你發給別人釘的
# 地址，丟了它所有人都要改設定，而 plist 會被備份工具與截圖帶著走。
set -euo pipefail
cd "$(dirname "$0")/.."

SEED_FILE=configs/.hub-seed
if [ ! -s "$SEED_FILE" ]; then
  mkdir -p configs
  node -e 'process.stdout.write("amcn-home-"+require("crypto").randomBytes(12).toString("hex")+"\n")' > "$SEED_FILE"
  chmod 600 "$SEED_FILE"
fi
mkdir -p out/home

export HUB_SEED="$(cat "$SEED_FILE")"
export HUB_DUMP_PATH="${HUB_DUMP_PATH:-out/home/ledger.json}"
export HUB_BIND="${HUB_BIND:-0.0.0.0}"
export HUB_PORT="${HUB_PORT:-47180}"
# 已經有一本帳就接續它。匯入會逐筆驗證，不符就拒絕啟動——那是對的：
# 一個從沒驗過的帳本啟動的排序器，比一個起不來的排序器更糟。
if [ -s "$HUB_DUMP_PATH" ]; then export HUB_IMPORT="$HUB_DUMP_PATH"; fi

exec node hub.js
