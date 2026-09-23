#!/usr/bin/env bash
# 讓這台節點真的能賣算力——兩件**只有你能做**的事，做成一個指令。
#
#   ./arm-supply.sh --check   只印出你將要聲明什麼、以及目前缺什麼，不改任何東西
#   ./arm-supply.sh           把 key 放進 Keychain、記下你的聲明、重啟 agent 並驗證
#
# 為什麼這兩件事程式不代勞：
#   * key 進 Keychain 是你的決定（P-02：它不進設定檔、不進協定訊息，只在那個
#     行程的記憶體裡）。這支腳本**看不到也不記錄**你的 key——由 `security` 自己
#     互動式索取，不經過命令列參數（argv 會被 ps 看到）。
#   * `terms.attested` 是**你的聲明**，不是程式能驗證的事實（P-10／#67）：
#     「我與這家上游的協議允許我替第三方請求執行推理」。所以這裡要你把一句話
#     打出來，而不是按 y——一個誰都會勾的核取方塊等於沒有聲明。
set -euo pipefail
cd "$(dirname "$0")/.."

CFG=configs/home-agent.json
SERVICE=amcn-provider-key
PHRASE="我確認我的上游條款允許"

[ -s "$CFG" ] || { echo "找不到 ${CFG}——先跑 ./service/install.sh"; exit 1; }

read_cfg() { node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const a = c.adapter || {};
  process.stdout.write(JSON.stringify({
    api: a.api || (a.baseUrl ? "openai-compatible" : "mock"),
    model: a.model || null, baseUrl: a.baseUrl || null,
    attested: !!(a.terms && a.terms.attested),
    caps: ((c.policy || {}).spend) || null,
  }));
' "$CFG"; }

STATE="$(read_cfg)"
get() { node -e "const s=$STATE; const v=s['$1']; process.stdout.write(v==null?'':(typeof v==='object'?JSON.stringify(v):String(v)))"; }
HAS_KEY=no
security find-generic-password -s "$SERVICE" >/dev/null 2>&1 && HAS_KEY=yes

echo "上游        $(get api)$([ -n "$(get baseUrl)" ] && echo " → $(get baseUrl)")"
echo "模型        $(get model)"
echo "花費上限    $(get caps)"
echo "            （這是**你自己的預算**，不會進協定訊息、收據或帳本——#102）"
echo "Keychain    $([ "$HAS_KEY" = yes ] && echo "已有 $SERVICE" || echo "沒有 ${SERVICE}（下面會請你輸入）")"
echo "條款聲明    $([ "$(get attested)" = true ] && echo "已聲明" || echo "**未聲明**——沒有它就不會對外供給（#21：不能執行者不得出價）")"

if [ "${1:-}" = "--check" ]; then
  echo ""
  echo "（--check：什麼都沒有改）"
  exit 0
fi

echo ""
echo "=== 你將要聲明的事（P-10／§4 #67）==="
cat <<'DECL'
  「我與這家上游供應商的協議，允許我用自己的帳號替**第三方的請求**執行推理。」

  這是聲明，不是驗證——程式無法確認你讀過你的合約，所以責任在你。已知的事實：
    * 供應商條款明文禁止的是**轉讓 key** 與**轉售／出租帳號存取**
      （docs/evaluation/key-lending-verification.md §2–3）。AMCN 不轉讓 key。
    * 「替自己的終端使用者跑推理」是條款預設的正常情況，而借方的 DID 會被
      當成 end user 具名送上游（OpenAI 的 `user`／Anthropic 的 `metadata.user_id`）。
    * 但「用自己的帳號替第三方跑推理算不算轉售」在多數條款下**仍未解決**。
      契約面最乾淨的兩條路是本機模型，或本來就支援「為每個使用者發帶上限 key」
      的聚合型上游。
DECL
echo ""
printf '同意的話，把這句話打出來（其餘皆視為取消）：%s\n> ' "$PHRASE"
read -r TYPED
if [ "$TYPED" != "$PHRASE" ]; then echo "取消，什麼都沒有改。"; exit 1; fi

if [ "$HAS_KEY" != yes ]; then
  echo ""
  echo "把上游的 API key 放進 Keychain（由 security 自己索取，這支腳本看不到）："
  # -w 不帶值＝互動式索取，所以 key 不會出現在 argv／ps／shell history。
  security add-generic-password -U -a "$USER" -s "$SERVICE" -w
fi

node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.adapter = c.adapter || {};
  c.adapter.terms = {
    attested: true,
    attested_at: new Date().toISOString(),
    attested_by: process.env.USER || "owner",
    note: "由 service/arm-supply.sh 記錄；聲明內容見該腳本（P-10／#67）",
  };
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$CFG"
echo "已記下聲明（含日期，可稽核）→ $CFG"

echo "重啟供給端…"
launchctl kickstart -k "gui/$(id -u)/com.amcn.agent" 2>/dev/null || true
for _ in $(seq 1 20); do
  if grep -q "supply armed" logs/home-agent.log 2>/dev/null &&
     [ "$(tail -40 logs/home-agent.log | grep -c 'supply armed')" -gt 0 ]; then break; fi
  sleep 1
done
echo ""
if tail -40 logs/home-agent.log 2>/dev/null | grep -q "supply armed"; then
  tail -40 logs/home-agent.log | grep -E "supply armed|\[spend\]" | tail -3
  echo ""
  echo "上工了。每筆成交之後你會看到 [owner] 那一行（用掉多少 token、還剩多少）。"
else
  echo "還沒武裝。agent 自己說的理由："
  tail -20 logs/home-agent.log 2>/dev/null | grep -E "supply NOT armed" | tail -2 ||
    echo "  （logs/home-agent.log 裡還沒有訊息，等幾秒再看）"
fi
