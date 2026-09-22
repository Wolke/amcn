#!/usr/bin/env bash
# 常駐供給端 Agent：只賣不買。
#
# 刻意不開需求模型：這台是要給外人借算力的那一側，而自己同時買又賣只會產生
# 關聯方交易（#63）——帳上會變熱鬧，但那不是市場數據。
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
export AMCN_PROVIDER_KEY="${AMCN_PROVIDER_KEY:-sk-home-placeholder}"
exec node agent.js "$CFG"
