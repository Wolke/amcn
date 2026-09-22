#!/usr/bin/env node
// 入門採購的發樁者（#90）——金絲雀的鏡像。
//
// 它存在的理由是一個經濟結論而不是功能需求：新身分免費，所以**送它無擔保
// 額度**等於開一個無底的水龍頭（#50 量到每身分白拿 45.86 CC）。保證金擋不到
// 它（新身分餘額是 0，`collateral_post` 會拒絕），擔保人也擋不到（agent 之間
// 沒有社會網絡）。剩下的唯一辦法是**不要送額度，改成買它的第一份工作**——
// 而那份工作的答案必須是已知的，否則攻擊者只是換個名目白拿。
//
// 模擬器量到的差別（200 agents × 56 天 × 3 種子）：送額度時攻擊者每身分白拿
// 17.49 CC、壞帳率 9.25%；改成入門採購之後每身分白拿 **0.00 CC**、壞帳率 0，
// 而結算量保留 74%、成交率反而更高。GATE-0 候選組 8/8（兩個限制見登記簿 #90）。
//
// 它與 canary.js 共用同一支程式（`mode: "onboard"`），因為兩者是同一個流程與
// 同一個問責標準，只有兩件事相反：斷言可以通過、正確裁決是 PASS。
//
// Run:
//   node onboard.js configs/onboard.json
//   AGENT_CONFIG='{"hubPort":47180,"seed":"my-onboard-issuer","everyMs":30000}' node onboard.js
//
// 先印出 DID，在 Hub 設 HUB_ONBOARD_DID=<那個 DID> 後重啟 Hub，再啟動這支。
// Hub 另有兩個上限：HUB_ONBOARD_CAP_CC（每身分，預設 20）與
// HUB_ONBOARD_TOTAL_CC（全網，預設 2000）——這筆錢來自 Treasury 的創世補貼
// 額度（§2.2），所以它必須有治理上限。
'use strict';
const cfg = process.env.AGENT_CONFIG
  ? JSON.parse(process.env.AGENT_CONFIG)
  : JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
process.env.AGENT_CONFIG = JSON.stringify({ name: 'onboard', ...cfg, mode: 'onboard' });
require('./canary.js');
