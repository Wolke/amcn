#!/usr/bin/env bash
# 移除常駐服務。帳本（out/home/）與身分（configs/.hub-seed、.panel-seed、
# home-agent.json）都不動——那些是資料，不是服務。
set -euo pipefail
LA="$HOME/Library/LaunchAgents"
# onion 先收：它是對外入口，而「服務都停了但入口還在」是最糟的中間狀態。
for l in com.amcn.onion com.amcn.agent com.amcn.panel com.amcn.hub; do
  [ -f "$LA/$l.plist" ] || continue
  launchctl unload "$LA/$l.plist" 2>/dev/null || true
  rm -f "$LA/$l.plist"
  echo "已移除 $l"
done
echo "帳本與身分都留在 node/out/home 與 node/configs（要清掉請自己刪）。"
echo "onion 位址的身分留在 node/var/onion（同一個位址下次還能用）。"
