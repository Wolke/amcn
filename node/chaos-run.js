#!/usr/bin/env node
// Scenario runner: spawns a topology, injects faults on a timeline, checks
// invariants continuously, and reports a timeline plus PASS/FAIL.
//
// This replaces the part of the development loop that used to need a person
// (fault-injection-plan §4/§5): nobody unplugs a cable, nobody pastes a
// terminal, and a failing run replays from its seed instead of becoming an
// anecdote about a machine that has since been rebooted.
//
// Run:  node chaos-run.js scenarios/panel-blackhole.json
//       node chaos-run.js scenarios/*.json          (sequentially)
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const transport = require('./lib/transport').get('tcp'); // sampling is never faulted
const { identityFromSeed } = require('./lib/wire');
const { didOf } = require('./lib/discovery');
const inv = require('./lib/invariants');

const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = (t0) => ((Date.now() - t0) / 1000).toFixed(0).padStart(3);

async function runScenario(file) {
  const sc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const off = Number(sc.portOffset || 900);
  const PORT = 47180 + off;
  const CONSOLE0 = 47211 + off;
  const seed = String(sc.seed || 7);
  const dir = path.join(__dirname, 'out', 'chaos');
  fs.mkdirSync(dir, { recursive: true });

  // One control file per target, so a scenario can cut one group's links
  // without touching the others.
  const targets = ['hub', 'agents', 'panel'];
  const ctl = {};
  for (const t of targets) {
    ctl[t] = path.join(dir, `${sc.name}-${t}.json`);
    fs.writeFileSync(ctl[t], JSON.stringify(sc.profile || { mode: 'none' }));
  }
  const setFault = (target, fault) => {
    const f = fault === 'profile' ? (sc.profile || { mode: 'none' }) : fault;
    fs.writeFileSync(ctl[target], JSON.stringify(f));
  };

  const logs = {};
  const procs = [];
  function spawnProc(name, script, env) {
    logs[name] = '';
    const p = spawn(process.execPath, [path.join(__dirname, script)], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const grab = (d) => { logs[name] += d.toString(); };
    p.stdout.on('data', grab);
    p.stderr.on('data', grab);
    procs.push(p);
    return p;
  }
  const chaosEnv = (target) => ({
    AMCN_TRANSPORT: 'chaos', AMCN_CHAOS_BASE: sc.base || 'tcp',
    AMCN_CHAOS: ctl[target], AMCN_CHAOS_SEED: seed,
  });

  // The hub is spawned through a named helper so a scenario can kill and
  // restart it — the W10 drill as a timeline action rather than a person
  // pulling a cable.
  const dumpPath = path.join(dir, `${sc.name}-ledger.json`);
  const rvPath = path.join(dir, `${sc.name}-rendezvous.json`);
  const hubId = identityFromSeed(`chaos-${sc.name}`);
  const hubDid = didOf(hubId.pub);
  let hubProc = null;
  let hubPort = PORT;            // a scenario can move the hub (#45)
  const startHub = (withImport, port = hubPort) => {
    hubPort = port;
    hubProc = spawnProc('hub', 'hub.js', {
      ...chaosEnv('hub'),
      HUB_PORT: String(port), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0', HUB_SEED: `chaos-${sc.name}`,
      HUB_DUMP_PATH: dumpPath, HUB_DUMP_MS: '2000',
      HUB_ADVERTISE_HOST: '127.0.0.1',
      ...(sc.defaultAfterS ? {
        HUB_DEFAULT_AFTER_MS: String(sc.defaultAfterS * 1000),
        HUB_DEFAULT_SWEEP_MS: '2000',
      } : {}),
      ...(sc.rendezvous ? { HUB_RENDEZVOUS: rvPath, HUB_RENDEZVOUS_MS: '5000' } : {}),
      ...(withImport && fs.existsSync(dumpPath) ? { HUB_IMPORT: dumpPath } : {}),
    });
  };
  const killHub = () => { try { hubProc.kill('SIGKILL'); } catch { /* gone */ } };

  console.log(`\n=== ${sc.name} ===`);
  console.log(`   ${sc.what || ''}`);
  console.log(`   埠 ${PORT}, ${sc.agents} agents, ${sc.verifiers} verifiers, ` +
    `${sc.durationS}s, seed ${seed}, base ${sc.base || 'tcp'}` +
    (sc.profile ? `, profile ${JSON.stringify(sc.profile)}` : ''));

  fs.rmSync(dumpPath, { force: true });
  fs.rmSync(rvPath, { force: true });
  startHub(false);
  await sleep(600);
  for (let i = 1; i <= (sc.verifiers || 3); i++) {
    spawnProc(`V${i}`, 'verifier.js', {
      ...chaosEnv('panel'),
      AGENT_CONFIG: JSON.stringify({
        name: `V${i}`, seed: `cv-${i}`,
        ...(sc.rendezvous ? { rendezvous: rvPath, hubPin: hubDid } : { hubPort: PORT }),
      }),
    });
  }
  await sleep(400);
  const agentNames = [];
  const agentProcs = {};
  for (let i = 0; i < (sc.agents || 3); i++) {
    const name = String.fromCharCode(65 + i);
    agentNames.push(name);
    agentProcs[name] = spawnProc(name, 'agent.js', {
      ...chaosEnv('agents'),
      [`K${name}`]: `sk-chaos-${name}`,
      AGENT_CONFIG: JSON.stringify({
        name, seed: `ca-${name}`, consolePort: CONSOLE0 + i,
        ...(sc.rendezvous ? { rendezvous: rvPath, hubPin: hubDid } : { hubPort: PORT }),
        adapter: { baseUrl: null, key: { env: `K${name}` } },
        provide: { afterMs: 0, pricePerUnit: 1 + i * 0.05, repayment: true },
        posts: [],
        policy: {
          // Heterogeneous on purpose. The simulator's size sweep showed that
          // whether a small network deadlocks depends on whether the
          // population contains a structural net seller: at N=3 the pinned
          // fraction across five seeds was 66.7/66.7/66.7/0/33.3. Identical
          // agents guarantee there is no such seller — so the symmetric
          // topology every scenario used until now was measuring the worst
          // case without saying so. `symmetric: true` in a scenario keeps the
          // old behaviour when the worst case is what you want.
          // Heterogeneous in *scale*, identical in demand-to-capacity ratio
          // (8:1). The first attempt varied the ratio — 40/5, 55/3.5, 30/6.5 —
          // and made things much worse: the surplus agent became a permanent
          // creditor at +73.97 CC with zero credit events (FR-056's
          // 正餘額無處可花 again) while the deficit agent hit its ceiling 362
          // times, and the market produced 25 settlements instead of 209. So
          // what a small network cannot survive is not heterogeneity, it is a
          // structural mismatch between an agent's demand and its capacity.
          quota: {
            capacityUnits: sc.symmetric ? 40 : [40, 56, 28][i % 3],
            cycleMs: 3500, cycleOffsetMs: i * 1200,
          },
          demand: {
            meanUnits: sc.symmetric ? 5 : [5, 7, 3.5][i % 3],
            tickMs: 900, burstProb: 0.25, burstMultiplier: 4,
          },
          budget: { maxPricePerUnit: 1.3, minUnits: 3, maxUnitsPerTask: 8 },
          acceptance: { method: 'judge-quorum', asserts: SHA_OK },
        },
      }),
    });
  }

  // --- sampling ---------------------------------------------------------
  const t0 = Date.now();
  const timeline = [];
  const violations = [];
  let panelDids = [];
  const settleAt = [];          // seconds since t0 for each settlement seen
  let poolEmptyAt = null, poolRefillAt = null;
  let lastReceipts = 0;
  let lastExport = null;
  const growth = [];            // wall-clock series: RSS and dump size

  const ask = (type, want) => new Promise((resolve) => {
    const t = setTimeout(() => { try { c.close(); } catch {} resolve(null); }, 5000);
    const c = transport.dial({ port: hubPort });
    c.onMessage((m) => {
      if (m.type !== want) return;
      clearTimeout(t); c.close(); resolve(m);
    });
    c.send({ type });
  });
  const console_ = async () => {
    const out = {};
    for (let i = 0; i < agentNames.length; i++) {
      try {
        out[agentNames[i]] =
          await (await fetch(`http://127.0.0.1:${CONSOLE0 + i}/status`)).json();
      } catch { out[agentNames[i]] = null; }
    }
    return out;
  };

  for (const step of sc.timeline || []) {
    setTimeout(async () => {
      if (step.action === 'killHub') {
        killHub();
        timeline.push(`T+${nowS(t0)}s  殺掉 Hub（SIGKILL，不通知任何人）`);
        console.log(`T+${nowS(t0)}s  殺掉 Hub（SIGKILL，不通知任何人）`);
        return;
      }
      if (step.action === 'killAgent') {
        // 一個帶著負餘額消失的 agent 就是違約（#61 的瀑布觸發條件），而這
        // 是原型唯一無法用故障注入代替的事：拔線的 agent 會重連，死掉的不會。
        // 「負債最多的那一個」而不是固定名字：誰會欠債取決於那一次的需求
        // 抽樣，第一版寫死 agent C 而它當時餘額是 +0.39——殺掉一個債權人
        // 沒有違約可沖銷，情境因此測不到它要測的東西。
        let victim = step.agent;
        if (!victim || victim === 'mostIndebted') {
          const bals = (lastExport && lastExport.balances) || {};
          const consoles2 = await console_();
          const byDid = {};
          for (const [nm, c] of Object.entries(consoles2)) {
            if (c && c.did) byDid[c.did] = nm;
          }
          let worst = null;
          for (const [did, v] of Object.entries(bals)) {
            if (!byDid[did]) continue;
            if (worst === null || v < bals[worst]) worst = did;
          }
          victim = worst && bals[worst] < 0 ? byDid[worst] : agentNames.at(-1);
        }
        try { agentProcs[victim].kill('SIGKILL'); } catch { /* gone */ }
        timeline.push(`T+${nowS(t0)}s  殺掉 agent ${victim}（不再回來）`);
        console.log(`T+${nowS(t0)}s  殺掉 agent ${victim}（不再回來）`);
        return;
      }
      if (step.action === 'startHub') {
        const port = step.portDelta ? PORT + step.portDelta : hubPort;
        startHub(step.import !== false, port);
        const how = (step.import === false ? '空帳本' : '從自動匯出重建') +
          (step.portDelta ? `，換到埠 ${port}` : '');
        timeline.push(`T+${nowS(t0)}s  Hub 回來（同 seed，${how}）`);
        console.log(`T+${nowS(t0)}s  Hub 回來（同 seed，${how}）`);
        return;
      }
      setFault(step.target, step.fault);
      const label = step.fault === 'profile' ? 'profile（恢復）'
        : `${step.fault.mode}${step.fault.direction && step.fault.direction !== 'both' ? ` ${step.fault.direction}` : ''}`;
      timeline.push(`T+${nowS(t0)}s  注入 ${step.target} → ${label}`);
      console.log(`T+${nowS(t0)}s  注入 ${step.target} → ${label}`);
    }, step.atS * 1000);
  }

  const sampleMs = (sc.sampleS || 10) * 1000;
  const endAt = t0 + sc.durationS * 1000;
  while (Date.now() < endAt) {
    await sleep(sampleMs);
    const vlist = await ask('list_verifiers', 'verifiers');
    const ex = await ask('export', 'ledger_export');
    const cs = await console_();
    const t = nowS(t0);
    const advertised = vlist ? vlist.verifiers.map((v) => v.did) : [];
    if (advertised.length && !panelDids.length) panelDids = advertised.slice();
    if (ex) {
      lastExport = ex;
      for (const v of inv.checkLedger(ex)) {
        violations.push(`T+${t}s  ${v}`);
      }
      if (ex.receipts.length > lastReceipts) {
        for (let k = lastReceipts; k < ex.receipts.length; k++) settleAt.push(Number(t));
        lastReceipts = ex.receipts.length;
      }
    }
    if (advertised.length === 0 && poolEmptyAt === null && panelDids.length) {
      poolEmptyAt = Number(t);
    }
    if (poolEmptyAt !== null && advertised.length > 0 && poolRefillAt === null) {
      poolRefillAt = Number(t);
    }
    const stuck = inv.noStuckContracts(cs, (sc.maxOpenS || 120) * 1000);
    for (const sv of stuck) violations.push(`T+${t}s  noStuckContracts: ${sv}`);
    // Growth is only visible if something records it: #41 was mis-diagnosed
    // from a demo-scale extrapolation, and the real driver only showed up
    // when an hour of wall-clock was measured.
    let rssMb = null;
    try {
      const out = require('node:child_process')
        .execSync(`ps -o rss= -p ${hubProc.pid}`, { encoding: 'utf8' }).trim();
      rssMb = (Number(out) / 1024).toFixed(0);
    } catch { /* hub is down at this sample */ }
    let dumpKb = null;
    try { dumpKb = (fs.statSync(dumpPath).size / 1024).toFixed(0); } catch { /* none yet */ }
    growth.push({ t: Number(t), rssMb: Number(rssMb), dumpKb: Number(dumpKb),
                  receipts: lastReceipts });

    const line = `T+${t}s  pool ${advertised.length}  結算 ${lastReceipts}  ` +
      `合約開啟 ${Object.values(cs).filter(Boolean)
        .reduce((s, c) => s + (c.contracts ? c.contracts.open : 0), 0)}` +
      (rssMb ? `  hub ${rssMb}MB` : '') + (dumpKb ? `/${dumpKb}KB` : '') +
      (violations.length ? `  違反 ${violations.length}` : '');
    console.log(`   ${line}`);
    timeline.push(line);
  }

  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await sleep(300);

  // Every process's output lands on disk. Without this the runner reproduces
  // the pilot's original sin: a failure whose evidence lives only in a
  // terminal nobody can read afterwards.
  const logDir = path.join(dir, `${sc.name}-logs`);
  fs.mkdirSync(logDir, { recursive: true });
  for (const [name, text] of Object.entries(logs)) {
    fs.writeFileSync(path.join(logDir, `${name}.log`), text);
  }
  fs.writeFileSync(path.join(logDir, '_timeline.log'), timeline.join('\n') + '\n');
  console.log(`   （log 與時間軸：${path.relative(__dirname, logDir)}/）`);

  // --- expectations -----------------------------------------------------
  const results = [];
  const check = (name, ok, detail) => {
    results.push([name, ok]);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };
  console.log(`\n-- ${sc.name} 驗收 --`);
  for (const e of sc.expect || []) {
    switch (e.kind) {
      case 'invariantsHold':
        check('不變式全程未被破壞', violations.length === 0,
          violations.length ? violations.slice(0, 3).join(' | ') : `${lastReceipts} 筆結算下 6 項不變式持續通過`);
        break;
      case 'settlesBefore':
        check(`故障前有成交（T+${e.atS}s 之前）`,
          settleAt.some((s) => s <= e.atS), `${settleAt.filter((s) => s <= e.atS).length} 筆`);
        break;
      case 'poolEmptiesWithin': {
        const ok = poolEmptyAt !== null && poolEmptyAt - e.afterS <= e.withinS;
        check(`故障後 ${e.withinS}s 內 pool 清空（不再宣告死掉的 verifier）`,
          ok, poolEmptyAt === null ? 'pool 從未清空' : `T+${poolEmptyAt}s（故障於 T+${e.afterS}s）`);
        break;
      }
      case 'poolRefillsWithin': {
        const ok = poolRefillAt !== null && poolRefillAt - e.afterS <= e.withinS;
        check(`恢復後 ${e.withinS}s 內 pool 自行回填（無人介入）`,
          ok, poolRefillAt === null ? 'pool 從未回填' : `T+${poolRefillAt}s`);
        break;
      }
      case 'settlementResumesWithin': {
        const after = settleAt.filter((s) => s > e.afterS);
        const ok = after.length > 0 && after[0] - e.afterS <= e.withinS;
        check(`恢復後 ${e.withinS}s 內交易恢復`, ok,
          after.length ? `第一筆於 T+${after[0]}s，共 ${after.length} 筆` : '恢復後無成交');
        break;
      }
      case 'tradingContinues': {
        // The soak passed 3/3 while the economy had been dead for twelve
        // minutes: every expectation looked at the beginning or at a
        // recovery window, and none asked whether trading was still
        // happening at the end. A long run that cannot notice the market
        // stopping is not measuring the thing it exists to measure.
        const from = e.fromS || 0;
        const marks = [from, ...settleAt.filter((x) => x >= from),
                       Number(nowS(t0))];
        let gap = 0, at = null;
        for (let i = 1; i < marks.length; i++) {
          if (marks[i] - marks[i - 1] > gap) { gap = marks[i] - marks[i - 1]; at = marks[i - 1]; }
        }
        check(`交易全程未中斷超過 ${e.maxGapS}s（T+${from}s 起）`,
          gap <= e.maxGapS,
          `最長空窗 ${gap}s（自 T+${at}s）；全程 ${settleAt.length} 筆`);
        break;
      }
      case 'writeOffHappens': {
        const mt = (lastExport && lastExport.metrics) || {};
        const bal = (lastExport && lastExport.balances) || {};
        const absorbed = (mt.written_off_cc || 0);
        const insuranceUsed = e.expectInsurance === false ? true
          : (bal['protocol:insurance'] !== undefined);
        check('違約帳戶被沖銷，且瀑布順序正確（抵押→保險→損失）',
          absorbed > 0 && insuranceUsed,
          `沖銷 ${absorbed.toFixed(2)} CC，違約率 ${mt.default_rate}，` +
          `保險池 ${(bal['protocol:insurance'] || 0).toFixed(2)}、` +
          `損失 ${(bal['protocol:loss'] || 0).toFixed(2)} CC`);
        break;
      }
      case 'noSettlementDuring': {
        const during = settleAt.filter((s) => s >= e.fromS && s <= e.toS);
        check(`故障期間不得有成交（T+${e.fromS}–${e.toS}s）`, during.length === 0,
          during.length ? `有 ${during.length} 筆` : '0 筆');
        break;
      }
      default:
        check(`未知期望 ${e.kind}`, false);
    }
  }
  if (growth.length >= 4 && sc.durationS >= 600) {
    const a = growth[1], z = growth.at(-1);
    const mins = (z.t - a.t) / 60 || 1;
    console.log(`\n-- 成長（${a.t}s → ${z.t}s）--`);
    console.log(`   Hub RSS  ${a.rssMb}MB → ${z.rssMb}MB  ` +
      `(${((z.rssMb - a.rssMb) / mins).toFixed(1)} MB/分)`);
    console.log(`   匯出檔   ${a.dumpKb}KB → ${z.dumpKb}KB  ` +
      `(${((z.dumpKb - a.dumpKb) / mins).toFixed(1)} KB/分，` +
      `${z.receipts - a.receipts} 筆結算)`);
    fs.writeFileSync(path.join(dir, `${sc.name}-growth.json`),
      JSON.stringify(growth, null, 2));
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS  (${sc.name})`);
  if (violations.length) {
    console.log('--- 不變式違反（前 10 筆）---');
    violations.slice(0, 10).forEach((v) => console.log('  ' + v));
  }
  return { name: sc.name, failed, total: results.length, violations: violations.length };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法: node chaos-run.js scenarios/xxx.json [...]');
    process.exit(2);
  }
  const all = [];
  for (const f of files) all.push(await runScenario(f));
  if (all.length > 1) {
    console.log('\n=== 總結 ===');
    for (const r of all) {
      console.log(`  ${r.failed ? 'FAIL' : 'PASS'}  ${r.name}: ` +
        `${r.total - r.failed}/${r.total}，不變式違反 ${r.violations}`);
    }
  }
  process.exit(all.some((r) => r.failed) ? 1 : 0);
}
main();
