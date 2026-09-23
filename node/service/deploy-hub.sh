#!/usr/bin/env bash
# 把**排序器**搬到一台可以從公網連到的 Linux 主機，而身分與帳都跟著走。
#
#   ./deploy-hub.sh user@1.2.3.4            搬過去並啟動（systemd）
#   ./deploy-hub.sh user@1.2.3.4 --dry-run  只印出會做什麼
#   ./deploy-hub.sh user@1.2.3.4 --status   看那台的狀態
#
# 為什麼是搬排序器而不是「在雲上另開一個網路」：`hub did` 是別人釘住的東西
# （hubPin），而它由 `configs/.hub-seed` 決定。帶著那個檔案過去，對所有已經
# 加入的人來說 Hub 只是換了個位址——這正是 #14 讓 HUB_SEED 存在的理由，也是
# 「第一個排序器不是信任根」在運維上的樣子。
#
# 這台（家裡那台）之後只跑供給端 Agent 與 verifier panel，它們用 hubPin 跟著
# 新位址走，家用 IP 不會出現在任何地方。
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
MODE="${2:-run}"
PORT="${HUB_PORT:-47180}"
REPO_URL="${AMCN_REPO:-https://github.com/Wolke/amcn.git}"
REMOTE_DIR="${AMCN_REMOTE_DIR:-/opt/amcn}"

[ -n "$TARGET" ] || { echo "用法：./deploy-hub.sh user@host [--dry-run|--status]"; exit 2; }

say() { printf '\n== %s ==\n' "$1"; }
run() {
  if [ "$MODE" = "--dry-run" ]; then printf '  (dry-run) ssh %s %q\n' "$TARGET" "$*";
  else ssh -o BatchMode=yes "$TARGET" "$@"; fi
}

if [ "$MODE" = "--status" ]; then
  ssh "$TARGET" "systemctl --no-pager status amcn-hub | head -20; \
    echo; journalctl -u amcn-hub -n 8 --no-pager"
  exit $?
fi

[ -s configs/.hub-seed ] || { echo "找不到 configs/.hub-seed——先在本機跑過 service/install.sh"; exit 1; }

say "0/6 檢查 SSH 與遠端 OS"
run "uname -sm; . /etc/os-release 2>/dev/null; echo \${PRETTY_NAME:-unknown}" || {
  echo "SSH 連不上 ${TARGET}。先確認你能手動 ssh 進去（金鑰、防火牆、使用者）。"; exit 1; }

say "1/6 安裝 Node.js ≥ 20（Ubuntu/Debian）"
# Ubuntu 24.04 內建的 nodejs 是 18.x，太舊（AMCN 需要 ≥ 20），所以走 NodeSource。
run "command -v node >/dev/null && node -p 'process.versions.node' || true"
run "set -e; if ! command -v node >/dev/null || [ \"\$(node -p 'process.versions.node.split(\".\")[0]')\" -lt 20 ]; then \
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -; \
      sudo apt-get install -y nodejs; \
    fi; node --version"

say "2/6 取得程式（repo 是公開的，所以遠端不需要任何憑證）"
run "set -e; sudo mkdir -p $REMOTE_DIR; sudo chown \$(id -u):\$(id -g) $REMOTE_DIR; \
     if [ -d $REMOTE_DIR/.git ]; then git -C $REMOTE_DIR pull --ff-only; \
     else git clone --depth 50 $REPO_URL $REMOTE_DIR; fi; \
     git -C $REMOTE_DIR log --oneline -1"

say "3/6 帶著身分與帳過去"
# 身分與帳本是**資料**，不在 git 裡（.gitignore 把它們當私鑰）。所以這一步是
# scp 而不是 git pull，而且只做一次——之後那台自己寫自己的快照。
if [ "$MODE" = "--dry-run" ]; then
  echo "  (dry-run) scp configs/.hub-seed → $TARGET:$REMOTE_DIR/node/configs/"
  echo "  (dry-run) scp out/home/ledger.json{,.tail} → $TARGET:$REMOTE_DIR/node/out/home/"
else
  ssh "$TARGET" "mkdir -p $REMOTE_DIR/node/configs $REMOTE_DIR/node/out/home"
  scp -q configs/.hub-seed "$TARGET:$REMOTE_DIR/node/configs/.hub-seed"
  ssh "$TARGET" "chmod 600 $REMOTE_DIR/node/configs/.hub-seed"
  for f in out/home/ledger.json out/home/ledger.json.tail; do
    [ -s "$f" ] && scp -q "$f" "$TARGET:$REMOTE_DIR/node/$f"
  done
fi

say "4/6 遠端先自己驗那本帳（不驗就啟動的排序器比起不來的更糟）"
run "cd $REMOTE_DIR/node && [ -s out/home/ledger.json ] && \
     node verify-ledger.js out/home/ledger.json || echo '（沒有既有帳本，將從零開始）'"

say "5/6 安裝 systemd 服務"
# 遠端使用者名稱取一次就好（systemd 的 unit 不會做 shell 展開，所以這個值
# 必須在寫入之前就決定）。
REMOTE_USER="$(ssh -o BatchMode=yes "$TARGET" 'id -un' 2>/dev/null || echo amcn)"
if [ "$MODE" = "--dry-run" ]; then
  echo "  (dry-run) 寫入 /etc/systemd/system/amcn-hub.service 並 enable --now"
else
  ssh "$TARGET" "sudo tee /etc/systemd/system/amcn-hub.service >/dev/null <<UNIT
[Unit]
Description=AMCN sequencer (hub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$REMOTE_USER
WorkingDirectory=$REMOTE_DIR/node
ExecStart=/bin/bash $REMOTE_DIR/node/service/run-hub.sh
Restart=always
RestartSec=15
# 上線前的濫用預算（#87）的預設值就在程式裡，這裡只留調整的位置。
Environment=HUB_PORT=$PORT
Environment=HUB_BIND=0.0.0.0
Environment=HUB_DUMP_PATH=out/home/ledger.json
# 信封加密（#44）。要離開區網就必須設，而**每一台客戶端也要設同一個**。
Environment=AMCN_TRANSPORT=secure
Environment=AMCN_SECURE_BASE=tcp
# 通道身分固定，否則客戶端每次重連都在跟一個新的通道身分握手。
Environment=AMCN_SECURE_SEED=amcn-hub-channel
StandardOutput=append:$REMOTE_DIR/node/logs/home-hub.log
StandardError=append:$REMOTE_DIR/node/logs/home-hub-err.log

[Install]
WantedBy=multi-user.target
UNIT
  sudo mkdir -p $REMOTE_DIR/node/logs
  sudo systemctl daemon-reload
  sudo systemctl enable --now amcn-hub
  sleep 3
  systemctl is-active amcn-hub"
fi

say "6/6 回報"
if [ "$MODE" = "--dry-run" ]; then echo "  (dry-run) 結束"; exit 0; fi
DID="$(ssh "$TARGET" "grep -o 'hub did did:demo:[0-9a-f]*' $REMOTE_DIR/node/logs/home-hub.log | tail -1 | awk '{print \$3}'")"
IP="${TARGET#*@}"
LOCAL_DID="$(grep -o 'hub did did:demo:[0-9a-f]*' logs/home-hub.log 2>/dev/null | tail -1 | awk '{print $3}')"
cat <<OUT

遠端 hub did：${DID:-（讀不到，看 journalctl -u amcn-hub）}
本機原本的  ：${LOCAL_DID:-（無）}
$([ -n "$DID" ] && [ "$DID" = "$LOCAL_DID" ] && echo '→ 一致：對已經釘住你的人來說，Hub 只是換了位址' || echo '→ **不一致**：.hub-seed 沒帶過去，或遠端讀不到它')

接下來（順序不能顛倒）：
  1. 雲端防火牆放行 TCP ${PORT}（Azure：az network nsg rule create；其他家看各自的控制台）
  2. 本機停掉自己的 Hub，只留供給端與 panel：
       launchctl unload ~/Library/LaunchAgents/com.amcn.hub.plist
  3. 把本機的 agent／panel 指向新位址，而且**三者都要 secure**：
       AMCN_TRANSPORT=secure AMCN_SECURE_PIN=<遠端通道身分> ...
       （見 node/JOIN.md〈離開區網〉；每一台都要設，混用會被明確拒絕）
  4. 驗一次：
       node ledger-dump.js out/wan.json $IP $PORT && node verify-ledger.js out/wan.json --pin ${DID:-<hub did>}
  5. 更新邀請詞裡的位址：service/install.sh invite

拆掉：ssh $TARGET 'sudo systemctl disable --now amcn-hub'
OUT
