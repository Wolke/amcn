#!/usr/bin/env bash
# 常駐的入門採購發樁者（#90／#96）：Treasury 向**還沒賺過任何 CC 的身分**購買
# 一份答案已知的工作。
#
# 它存在的理由是量出來的，不是功能需求：新身分免費，所以「送無擔保額度」等於
# 一個無底的水龍頭（#50：每身分白拿 45.86 CC，20 個身分就把保險池打穿）。改成
# 買第一份工作之後，N 個身分要拿到 N 份 CC 就得交付 N 份真實工作——那不是攻擊，
# 那是供給。條件是**買的必須是答案已知、可驗證的工作**（與金絲雀同一個機制），
# 否則攻擊者只是換個記帳名目白拿。
#
#   ./run-onboard.sh            啟動（launchd 用這個）
#   ./run-onboard.sh --did      只印出發樁者的 DID（Hub 要授權的就是它）
#   ./run-onboard.sh --check    印出算出來的設定值就結束（閘門用）
set -euo pipefail
cd "$(dirname "$0")/.."

SEED_FILE=configs/.onboard-seed
if [ ! -s "${SEED_FILE}" ]; then
  mkdir -p configs
  node -e 'process.stdout.write("amcn-onboard-"+require("crypto").randomBytes(12).toString("hex")+"\n")' > "${SEED_FILE}"
  chmod 600 "${SEED_FILE}"
fi
SEED="$(cat "${SEED_FILE}")"
DID="$(node -e 'process.stdout.write(require("./lib/wire").identityFromSeed(process.argv[1]).did)' "${SEED}")"

if [ "${1:-}" = "--did" ]; then echo "${DID}"; exit 0; fi

EVERY_MS="${HUB_ONBOARD_EVERY_MS:-60000}"
if [ "${1:-}" = "--check" ]; then
  echo "ONBOARD_DID=${DID}"
  echo "ONBOARD_EVERY_MS=${EVERY_MS}"
  echo "SEED_FILE=${SEED_FILE}"
  exit 0
fi

# 發樁者是**營運方授權的身分**，所以它能多報失敗來卡住某個新人。那個權力本來
# 就存在（它也可以乾脆不發任務給你），制衡是它的支出全部在帳上、可稽核、有
# 治理上限（HUB_ONBOARD_CAP_CC 每身分、HUB_ONBOARD_TOTAL_CC 全網）。
export AGENT_CONFIG="$(node -e '
  process.stdout.write(JSON.stringify({
    hubHost: process.env.HUB_HOST || "127.0.0.1",
    hubPort: Number(process.env.HUB_PORT || 47180),
    seed: process.argv[1],
    everyMs: Number(process.argv[2]),
  }));
' "${SEED}" "${EVERY_MS}")"
exec node onboard.js
