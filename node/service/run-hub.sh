#!/usr/bin/env bash
# 常駐 Hub（排序器）。由 launchd 拉起，崩潰會被重新拉起。
#
# 種子存在 configs/.hub-seed 而不是寫進 plist：`hub did` 就是你發給別人釘的
# 地址，丟了它所有人都要改設定，而 plist 會被備份工具與截圖帶著走。
#
# 兩種模式，寫在 configs/.home-mode（由 service/install.sh 寫入）：
#   lan    （預設）綁 0.0.0.0，只有同區網／同 IP 網段的人連得到。
#   onion  綁 127.0.0.1，**對外零入向埠**，由 com.amcn.onion 的 onion service
#          把外面的人帶進來（#89）。這是「任何地方的人都能加入，而我不開埠、
#          不租機器、不動路由器」的那條路。
#
# 兩種模式都會發布一份**簽署過的** rendezvous 記錄（#45）。位址會變——onion
# 位址要等 tor 起來才存在、排序器也可能搬家——所以記錄的主機名不是啟動時
# 定住的，而是每次重發都重新讀 HUB_ADVERTISE_HOST_FILE（#91）。
#
#   ./run-hub.sh              啟動（launchd 用這個）
#   ./run-hub.sh --print-env  只印出算出來的設定值就結束（閘門用這個）
set -euo pipefail
cd "$(dirname "$0")/.."

MODE_FILE=configs/.home-mode
MODE="${AMCN_HOME_MODE:-$(cat "$MODE_FILE" 2>/dev/null || echo lan)}"

SEED_FILE=configs/.hub-seed
if [ ! -s "$SEED_FILE" ] && [ "${1:-}" != "--print-env" ]; then
  mkdir -p configs
  node -e 'process.stdout.write("amcn-home-"+require("crypto").randomBytes(12).toString("hex")+"\n")' > "$SEED_FILE"
  chmod 600 "$SEED_FILE"
fi
mkdir -p out/home var

export HUB_PORT="${HUB_PORT:-47180}"
export HUB_DUMP_PATH="${HUB_DUMP_PATH:-out/home/ledger.json}"
# 位址記錄：檔案就是資料，放哪都行（靜態主機、物件儲存、公開 repo 的一個
# commit）。承載它的主機不受信任——記錄帶著 Hub 的簽章，客戶端拿 hubPin 核對。
export HUB_RENDEZVOUS="${HUB_RENDEZVOUS:-var/rendezvous.json}"

if [ "$MODE" = "onion" ]; then
  # 不要在這裡改成 0.0.0.0：onion service 轉進來的連線走的是回送位址，而綁
  # 0.0.0.0 會讓同一個排序器同時暴露在區網上——那正是 #89 要拿掉的東西。
  export HUB_BIND="${HUB_BIND:-127.0.0.1}"
  # 每次重發都重新讀這個檔（#91）：tor 比 Hub 晚起來，位址也會換。
  export HUB_ADVERTISE_HOST_FILE="${HUB_ADVERTISE_HOST_FILE:-var/onion/hostname}"
else
  export HUB_BIND="${HUB_BIND:-0.0.0.0}"
fi

# 新人的第一筆額度：**送一點點，其餘去買**（登記簿 #90、對照表
# docs/evaluation/credit-regime-ab.md）。理由是量出來的：
#   starter 50 → 攻擊者每身分白拿 44.17 CC，20 個身分就讓壞帳 889 對風險費
#               收入 450（GATE-0 的 G3 破），而白拿 ≈ starter × 0.87；
#   starter 0  → 白拿歸零，但市場也塌了（結算量剩 7.7%，洗量佔 94.9%）；
#   starter 10 ＋入門採購 → 白拿 8.56、結算量回到 45%、壞帳 171 仍在風險費
#               收入 201 之內。
# 這一格是「有界且已定價」的選擇，而不是折衷的說法。要改回舊值就設
# DEMO_STARTER_CC=50（那等於接受每個新身分是一份 ~44 CC 的禮物）。
export DEMO_STARTER_CC="${DEMO_STARTER_CC:-10}"

# 入門採購（#90 的另一半）：Treasury 向還沒賺過 CC 的身分買一份**答案已知**的
# 工作。沒有這一半，starter 10 就只是「送得少一點」，新人的第一步會很難走。
# 發樁者的身分由 service/run-onboard.sh 產生並保存，Hub 這一側只要授權它。
ONBOARD_SEED=configs/.onboard-seed
if [ -s "${ONBOARD_SEED}" ]; then
  export HUB_ONBOARD_DID="${HUB_ONBOARD_DID:-$(node -e     'process.stdout.write(require("./lib/wire").identityFromSeed(require("fs").readFileSync(process.argv[1],"utf8").trim()).did)'     "${ONBOARD_SEED}")}"
  export HUB_ONBOARD_CAP_CC="${HUB_ONBOARD_CAP_CC:-20}"      # 每身分上限
  export HUB_ONBOARD_TOTAL_CC="${HUB_ONBOARD_TOTAL_CC:-2000}" # 全網治理上限
  # 連續通過才付一次。實測攻擊者每身分：1 次 5.52 CC → 3 次 0.00 CC，而誠實
  # 新人只從 196 掉到 187 人——對攻擊者是平方壓制，對誠實者幾乎無感。
  export HUB_ONBOARD_STREAK="${HUB_ONBOARD_STREAK:-3}"
fi

if [ -s "$SEED_FILE" ]; then export HUB_SEED="$(cat "$SEED_FILE")"; fi
# 已經有一本帳就接續它。匯入會逐筆驗證，不符就拒絕啟動——那是對的：
# 一個從沒驗過的帳本啟動的排序器，比一個起不來的排序器更糟。
if [ -s "$HUB_DUMP_PATH" ]; then export HUB_IMPORT="$HUB_DUMP_PATH"; fi

if [ "${1:-}" = "--print-env" ]; then
  # 閘門讀的是**算出來的值**而不是原始碼裡的字串：把預設值讀錯的那種回歸
  # （例如 onion 模式又綁回 0.0.0.0）只有這樣才抓得到。
  echo "AMCN_HOME_MODE=$MODE"
  echo "HUB_BIND=$HUB_BIND"
  echo "HUB_PORT=$HUB_PORT"
  echo "HUB_RENDEZVOUS=$HUB_RENDEZVOUS"
  echo "HUB_ADVERTISE_HOST_FILE=${HUB_ADVERTISE_HOST_FILE:-}"
  echo "HUB_IMPORT=${HUB_IMPORT:-}"
  echo "DEMO_STARTER_CC=${DEMO_STARTER_CC}"
  echo "HUB_ONBOARD_DID=${HUB_ONBOARD_DID:-}"
  echo "HUB_ONBOARD_CAP_CC=${HUB_ONBOARD_CAP_CC:-}"
  echo "HUB_ONBOARD_TOTAL_CC=${HUB_ONBOARD_TOTAL_CC:-}"
  echo "HUB_ONBOARD_STREAK=${HUB_ONBOARD_STREAK:-}"
  exit 0
fi

exec node hub.js
