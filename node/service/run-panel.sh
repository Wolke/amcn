#!/usr/bin/env bash
# 常駐 Verifier panel（3 個）。身分存在 configs/.panel-seed——押注與受測紀錄
# 綁在它上面，而協定 v7 之後「未被金絲雀測夠就換身分」押注不退（#38），
# 所以這個檔案要備份。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node panel.js 127.0.0.1 "${HUB_PORT:-47180}" "${PANEL_SIZE:-3}"
