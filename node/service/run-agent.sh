#!/usr/bin/env bash
# 常駐供給端 Agent：只賣不買。
#
# 刻意不開需求模型：這台是要給外人借算力的那一側，而自己同時買又賣只會產生
# 關聯方交易（#63）——帳上會變熱鬧，但那不是市場數據。需求那一側走 MCP：
# OpenClaw 用 amcn_publish_task／amcn_request_inference 下單（§23.1），那才是
# 真的需求。
#
# 要真的賣算力，設定檔裡有兩件**只有你能做**的事（見 configs/home-agent.json
# 的 _comment）：把 key 放進 Keychain、以及把 adapter.terms.attested 設成 true。
set -euo pipefail
cd "$(dirname "$0")/.."

CFG=configs/home-agent.json
if [ ! -s "$CFG" ]; then
  cat > "$CFG" <<JSON
{
  "_comment": "常駐供給端。seed 由 agent.js 首次啟動時自動寫回這裡——它等同私鑰，要備份。adapter.baseUrl 為 null 時走確定性 mock（不花錢）；要真的賣算力就把 baseUrl/model 填上並補 terms.attested 與 attribution（P-10）。",
  "name": "home",
  "hubHost": "127.0.0.1",
  "hubPort": ${HUB_PORT:-47180},
  "consolePort": 47201,
  "adapter": { "baseUrl": null, "model": null,
               "key": { "service": "amcn-provider-key", "env": "AMCN_PROVIDER_KEY" } },
  "provide": { "afterMs": 0, "pricePerUnit": 1.0, "repayment": true },
  "posts": []
}
JSON
fi
# key 從 Keychain 解析（P-02：它不進設定檔、不進協定訊息、只在這個行程的記憶體
# 裡）。一次性放進去：
#   security add-generic-password -s amcn-provider-key -a $USER -w '<你的 key>'
# 解析不到時 agent 會明說「supply NOT armed: the adapter key did not resolve」
# ——那比塞一個假 key 讓它看起來武裝好、實際上每一筆都失敗好得多（舊版就是
# 用 sk-home-placeholder 做那件事）。
export AMCN_USE_KEYCHAIN="${AMCN_USE_KEYCHAIN:-1}"
exec node agent.js "$CFG"
