#!/usr/bin/env node
// 演練取樣器：把「Hub 何時發現對方消失」變成可讀的時間軸。
//
// 拔線演練要量的是延遲，而延遲只能從時間戳重建（#42）。這支每隔 N 秒問
// Hub 一次「現在有哪些 Verifier 在線」，並從自動匯出讀結算數與序號，狀態
// 一變就標記，並印出距離上次變動多久。
//
// 刻意只問 list_verifiers 而不要整份 export：export 帶著全部 checkpoint 與
// raw_log，每 15 秒抓一次會讓量測本身變成負載（#41 的教訓）。
//
// Run:  node drill-watch.js [hubHost] [hubPort] [每幾秒] [dump路徑]
'use strict';
const fs = require('node:fs');
const transport = require('./lib/transport').fromEnv();

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3] || 47180);
const EVERY = Number(process.argv[4] || 15) * 1000;
const DUMP = process.argv[5] || 'out/ledger.json';

const short = (did) => String(did).replace('did:demo:', '').slice(0, 8);
let lastKey = null;
let lastChange = Date.now();

function askVerifiers() {
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { c.close(); } catch {} resolve(null); }, 5000);
    const c = transport.dial({ host: HOST, port: PORT });
    c.onMessage((m) => {
      if (m.type !== 'verifiers') return;
      clearTimeout(t); c.close();
      resolve({ dids: m.verifiers.map((v) => v.did), lock: m.lock,
                next: m.next_checkpoint_seq });
    });
    c.send({ type: 'list_verifiers' });
  });
}

function fromDump() {
  try {
    const st = fs.statSync(DUMP);
    const d = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
    return { receipts: d.receipts.length, cpSeq: d.checkpoint_seq,
             kept: d.checkpoints.length, kb: (st.size / 1024).toFixed(0),
             ageS: ((Date.now() - st.mtimeMs) / 1000).toFixed(0) };
  } catch { return null; }
}

async function tick() {
  const v = await askVerifiers();
  const d = fromDump();
  const stamp = new Date().toISOString();
  const online = v ? v.dids.map(short).sort() : null;
  const key = JSON.stringify([online, d && d.receipts]);
  const changed = lastKey !== null && key !== lastKey;
  const sinceS = ((Date.now() - lastChange) / 1000).toFixed(0);
  console.log(
    `${changed ? '** ' : '   '}${stamp}  ` +
    (v ? `在線 verifier ${online.length} [${online.join(' ')}]` : 'Hub 無回應') +
    (d ? `  結算 ${d.receipts}  cp_seq ${d.cpSeq} (存 ${d.kept})  匯出 ${d.kb}KB/${d.ageS}s前` : '  無匯出') +
    (changed ? `   ← 距上次變動 ${sinceS}s` : ''));
  if (changed) lastChange = Date.now();
  lastKey = key;
}

console.log(`== 演練取樣：${HOST}:${PORT}，每 ${EVERY / 1000}s，dump ${DUMP} ==`);
tick();
setInterval(tick, EVERY);
