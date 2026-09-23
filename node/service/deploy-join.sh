#!/usr/bin/env bash
# 讓**另一台**電腦加入這個網路：一個指令，從這裡推過去。
#
#   ./deploy-join.sh user@192.168.1.50             裝好並加入（當驗收者）
#   ./deploy-join.sh user@192.168.1.50 --dry-run   只印出會做什麼
#   ./deploy-join.sh user@192.168.1.50 --status    看那台的狀態
#
# 與 deploy-hub.sh 的差別是**角色**：那一支是把排序器搬家（帶著身分與帳本），
# 這一支是讓一台新機器**加入**——它不需要任何祕密，所以這裡不複製任何檔案，
# 只是 clone 公開的 repo 然後跑 join.sh。要連去哪由 repo 裡的 network.json 決定。
#
# 如果對方不是你的機器、或你不想用 ssh：直接把這一行給對方（或對方的 agent）：
#   https://raw.githubusercontent.com/Wolke/amcn/main/node/AGENT-JOIN.md
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
MODE="${2:-run}"
REPO_URL="${AMCN_REPO:-https://github.com/Wolke/amcn.git}"
REMOTE_DIR="${AMCN_REMOTE_DIR:-~/amcn}"

[ -n "${TARGET}" ] || { echo "用法：./deploy-join.sh user@host [--dry-run|--status]"; exit 2; }

say() { printf '\n== %s ==\n' "$1"; }
run() {
  if [ "${MODE}" = "--dry-run" ]; then printf '  (dry-run) ssh %s %q\n' "${TARGET}" "$*";
  else ssh -o BatchMode=yes "${TARGET}" "$@"; fi
}

if [ "${MODE}" = "--status" ]; then
  ssh "${TARGET}" "cd ${REMOTE_DIR}/node && ./join.sh status && tail -5 logs/join-*.log"
  exit $?
fi

say "1/5 檢查 ssh 與作業系統"
run "uname -s && uname -m"

say "2/5 檢查 Node ≥ 20 與 tor（缺了就說怎麼裝，不自己亂裝）"
run 'node --version 2>/dev/null || echo "NO_NODE"; command -v tor >/dev/null && tor --version | head -1 || echo "NO_TOR"'
cat <<'NOTE'
  這一步刻意不自動安裝：在別人的機器上裝套件是他的決定，不是這支腳本的。
  缺 node → https://nodejs.org（>= 20）
  缺 tor  → macOS: brew install tor ／ Debian: sudo apt install tor
NOTE

say "3/5 取得程式（公開 repo，不需要任何憑證）"
run "test -d ${REMOTE_DIR}/.git && (cd ${REMOTE_DIR} && git pull --ff-only) || git clone ${REPO_URL} ${REMOTE_DIR}"

say "4/5 先看它要連去哪（--check 不會啟動任何東西）"
run "cd ${REMOTE_DIR}/node && ./join.sh --check"

say "5/5 加入（角色：驗收者——不需要 key、不需要模型、不參與信用）"
run "cd ${REMOTE_DIR}/node && nohup ./join.sh > /tmp/amcn-join.out 2>&1; tail -20 /tmp/amcn-join.out"

if [ "${MODE}" != "--dry-run" ]; then
cat <<OUT

接下來要量的（見 docs/evaluation/second-machine.md）：
  ./service/deploy-join.sh ${TARGET} --status      看它還活著沒
  ssh ${TARGET} 'cd ${REMOTE_DIR}/node && tail -f logs/join-verifier.log'

那台的 DID 會出現在它自己的 log 裡，而它的身分存在
  ${REMOTE_DIR}/node/configs/.verifier-seed   （0600，等同私鑰，要備份）
OUT
fi
