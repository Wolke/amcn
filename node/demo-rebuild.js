// W10「帳本匯出重建」— a second sequencer reconstructs the ledger from a
// disaster export, and refuses to start if the export does not check out.
//
// This is #10's acceptance condition. The review's objection to the original
// framing was that 「Indexer 停止」 was circular: the drill proved the thing it
// assumed. So the test here is not "does the hub restart" — it is whether a
// *different* process, on a different port, can rebuild the same balances,
// chains and credit lines from signed artefacts alone, and whether it detects
// a forged one.
//
// Nothing is inherited: balances are replayed, chains are rehashed, credit
// lines are recomputed from stats replayed out of the receipts. The only
// artefact taken on the sequencer's word is the checkpoint stream, which is
// the one thing not derivable (periodic checkpoints correspond to no
// receipt), so it is signature-checked against the origin hub's key.
//
// Run:  node demo-rebuild.js        (DEMO_PORT_OFFSET=100 to coexist)
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const transport = require('./lib/transport').fromEnv();
const rebuildLib = require('./lib/rebuild');
const { fetchLedger } = require('./lib/ledgerfetch');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT_A = 47180 + OFFSET;
const PORT_B = 47185 + OFFSET;
const PORT_C = 47186 + OFFSET;
const RUN_MS = Number(process.env.DEMO_RUN_MS || 15000);
const DUMP = path.join(__dirname, 'out', `rebuild-drill-${OFFSET}.json`);
const TAMPERED = DUMP.replace('.json', '-tampered.json');
const HUB_SEED = 'demo-rebuild-hub';

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const procs = [];
function spawnProc(file, env) {
  const p = spawn(process.execPath, [path.join(__dirname, file)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => process.stdout.write(d.toString()
    .split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n') + '\n'));
  procs.push(p);
  return p;
}
const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 512 }];
const cfg = (o, extra) => ({
  AGENT_CONFIG: JSON.stringify({ hubPort: PORT_A, adapter: null, posts: [], ...o }),
  ...extra,
});

// 走 `lib/ledgerfetch`，也就是真實客戶端該走的那條路（#41）。排序器 A 的
// 分頁預算被刻意調到 20KB，所以這支 demo 的每一次取帳都是**分頁**取回來的
// ——下面七項既有斷言因此同時是分頁路徑的閘門。一條只在 16MB 之後才會跑到
// 的路等於一條沒有人測過的路（#76 的 `AMCN_SAMPLE_DISK` 同一個理由）。
let lastFetchNotes = [];
const exportFrom = async (port) => {
  const c = transport.dial({ port });
  lastFetchNotes = [];
  try {
    return await fetchLedger(c, { timeoutMs: 12000,
      onNote: (n) => lastFetchNotes.push(n) });
  } finally { try { c.close(); } catch { /* already gone */ } }
};

async function main() {
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });

  spawnProc('hub.js', { HUB_PORT: String(PORT_A), HUB_AGE_RAMP_MS: '1',
    HUB_BEACON: '0', HUB_SEED,
    // 20KB：小到這支 demo 的匯出一定得分好幾頁（#41）。
    HUB_EXPORT_PAGE_BYTES: '20000' });
  await new Promise((r) => setTimeout(r, 500));
  for (let i = 1; i <= 3; i++) {
    spawnProc('verifier.js', cfg({ name: `V${i}`, seed: `demo-rebuild-V${i}` }));
  }
  await new Promise((r) => setTimeout(r, 400));
  spawnProc('agent.js', cfg({
    name: 'P', seed: 'demo-rebuild-P',
    adapter: { baseUrl: null, key: { env: 'PK' } },
    provide: { afterMs: 0, pricePerUnit: 1.0 },
  }, { PK: 'sk-rebuild-demo-P' }));
  spawnProc('agent.js', cfg({
    name: 'R', seed: 'demo-rebuild-R',
    policy: {
      quota: { capacityUnits: 10, cycleMs: 2500 },
      demand: { meanUnits: 6, tickMs: 800, burstProb: 0.2, burstMultiplier: 3 },
      budget: { maxPricePerUnit: 1.3, minUnits: 3, maxUnitsPerTask: 8 },
      acceptance: { method: 'judge-quorum', asserts: SHA_OK },
    },
  }));

  console.log(`\n-- 排序器 A 運行 ${RUN_MS / 1000}s，然後災難匯出 --\n`);
  await new Promise((r) => setTimeout(r, RUN_MS));

  const exA = await exportFrom(PORT_A);
  const pagedNotes = [...lastFetchNotes];
  fs.writeFileSync(DUMP, JSON.stringify(exA));

  // 這支 demo 的匯出是**分頁**取回來的（A 的預算調到 20KB），所以上面那份
  // exA、下面每一項斷言，走的都是真實客戶端在 16MB 之後會走的那條路。
  // 沒有這一條的話，預算若失效，整支 demo 會安靜地退回單頁而依然全綠——
  // 「那條路沒被測到」正是 #76 與 #78 各犯過一次的錯。
  const pageCount = Number((pagedNotes.join(' ').match(/分頁完成：(\d+) 頁/) || [])[1] || 0);
  check('§4 #41 取帳確實分頁重組（不是悄悄退回單頁）', pageCount > 1,
    pagedNotes.length ? pagedNotes.join('；') : '沒有任何分頁跡象——預算可能失效了');

  // 不會分頁的舊客戶端必須拿到**指名的拒絕**，而不是一個超過 MAX_LINE
  // 的 frame 然後靜默斷線（#76 的成因）。
  const refusal = await new Promise((resolve) => {
    const c = transport.dial({ port: PORT_A });
    const t = setTimeout(() => { try { c.close(); } catch {} resolve(null); }, 6000);
    c.onMessage((m) => {
      if (m.type !== 'ledger_export_too_large' && m.type !== 'ledger_export') return;
      clearTimeout(t); c.close(); resolve(m);
    });
    c.send({ type: 'export' });
  });
  check('§4 #41 不分頁的客戶端得到指名的拒絕，而不是靜默斷線',
    !!refusal && refusal.type === 'ledger_export_too_large' && refusal.bytes > refusal.max,
    refusal ? `${refusal.type}：${refusal.bytes} B > ${refusal.max} B｜${refusal.hint || ''}`
            : '沒有任何回應——這正是 #76 的症狀');

  // The disaster: A is gone, along with everything only it knew.
  procs.forEach((p) => p.kill());
  await new Promise((r) => setTimeout(r, 1500));

  console.log('\n-- 排序器 A 已停止；B 從匯出檔重建 --\n');
  const hubB = spawnProc('hub.js', {
    HUB_PORT: String(PORT_B), HUB_BEACON: '0', HUB_SEED,
    HUB_IMPORT: DUMP,
  });
  await new Promise((r) => setTimeout(r, 2500));

  let exB = null;
  try { exB = await exportFrom(PORT_B); } catch { /* reported below */ }

  // A forged export must be refused rather than absorbed.
  const forged = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
  const victim = forged.receipts.find((r) => r.receipt.postings.length > 2);
  if (victim) victim.receipt.postings[1].amount_cc += 1;
  fs.writeFileSync(TAMPERED, JSON.stringify(forged));
  const forgedRun = spawnSync(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env, HUB_PORT: String(PORT_C), HUB_BEACON: '0',
           HUB_SEED, HUB_IMPORT: TAMPERED },
    encoding: 'utf8', timeout: 8000,
  });
  const forgedOut = `${forgedRun.stdout || ''}${forgedRun.stderr || ''}`;

  // Offline verification of the same export, independent of any hub.
  const offline = rebuildLib.rebuild(exA);
  const offlineForged = rebuildLib.rebuild(forged);

  hubB.kill();
  console.log('\n== W10 重建驗收檢查 ==');

  check('排序器 B 接受乾淨匯出並啟動', !!exB,
    exB ? `B 在 ${PORT_B} 上重建完成` : 'B 未能啟動或未回應匯出');

  if (exB) {
    const keys = new Set([...Object.keys(exA.balances), ...Object.keys(exB.balances)]);
    const bad = [...keys].filter((k) =>
      Math.abs((exA.balances[k] || 0) - (exB.balances[k] || 0)) > 1e-6);
    check('餘額逐帳戶一致（重放事件而非複製）',
      bad.length === 0 && keys.size > 0,
      `${keys.size} 個帳戶，不符 ${bad.length} 個${bad.length ? ': ' + bad.join(',') : ''}`);

    const clKeys = Object.keys(exA.credit_lines || {});
    const clBad = clKeys.filter((k) => exB.credit_lines[k] !== undefined &&
      Math.abs(exA.credit_lines[k] - exB.credit_lines[k]) > 1e-3);
    check('信用額度由收據重算後一致（不繼承無法佐證的標準）',
      clBad.length === 0 && clKeys.length > 0,
      `${clKeys.length} 個 agent，不符 ${clBad.length} 個`);

    check('收據與帳務事件數量一致，且 B 接續鑄造 checkpoint',
      exA.receipts.length === exB.receipts.length &&
      exA.events.length === exB.events.length &&
      exB.checkpoints.length >= exA.checkpoints.length,
      `收據 ${exA.receipts.length}=${exB.receipts.length}，事件 ` +
      `${exA.events.length}=${exB.events.length}，checkpoint ` +
      `${exA.checkpoints.length}→${exB.checkpoints.length}`);

    check('§4 #14 輪替：同 HUB_SEED 使 B 延續 A 的 Hub 身分',
      exA.hub_pub === exB.hub_pub,
      `hub did ${rebuildLib.didOf(exA.hub_pub).slice(0, 18)}`);
  } else {
    for (const n of ['餘額逐帳戶一致', '信用額度重算一致', '數量一致', '輪替']) {
      check(n, false, 'B 未啟動，無法評估');
    }
  }

  check('竄改的匯出檔被拒絕啟動（而非默默吸收）',
    forgedRun.status !== 0 && /REFUSING to start/.test(forgedOut),
    forgedRun.status !== 0
      ? `exit ${forgedRun.status}，理由含簽章與 postings 不符`
      : '竄改檔竟然啟動成功');

  check('離線驗證：任何人持有匯出檔即可自行重建與證偽',
    offline.ok && !offlineForged.ok,
    `乾淨檔 ok=${offline.ok}（${offline.summary ? offline.summary.receipts : 0} 收據），` +
    `竄改檔錯誤 ${offlineForged.errors.length} 項`);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  if (offline.summary) {
    console.log(`匯出內容：收據 ${offline.summary.receipts}、事件 ${offline.summary.events}、` +
      `帳戶 ${offline.summary.accounts}、checkpoint ${offline.summary.checkpoints}`);
  }
  if (!offlineForged.ok) {
    console.log('竄改檔被指出的問題（前三項）：');
    for (const e of offlineForged.errors.slice(0, 3)) console.log(`  - ${e}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`drill failed: ${err.message}`);
  procs.forEach((p) => { try { p.kill(); } catch {} });
  process.exit(1);
});
