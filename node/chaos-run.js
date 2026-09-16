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

  console.log(`\n=== ${sc.name} ===`);
  console.log(`   ${sc.what || ''}`);
  console.log(`   埠 ${PORT}, ${sc.agents} agents, ${sc.verifiers} verifiers, ` +
    `${sc.durationS}s, seed ${seed}, base ${sc.base || 'tcp'}` +
    (sc.profile ? `, profile ${JSON.stringify(sc.profile)}` : ''));

  spawnProc('hub', 'hub.js', {
    ...chaosEnv('hub'),
    HUB_PORT: String(PORT), HUB_BEACON: '0', HUB_SEED: `chaos-${sc.name}`,
    HUB_DUMP_PATH: path.join(dir, `${sc.name}-ledger.json`), HUB_DUMP_MS: '2000',
  });
  await sleep(600);
  for (let i = 1; i <= (sc.verifiers || 3); i++) {
    spawnProc(`V${i}`, 'verifier.js', {
      ...chaosEnv('panel'),
      AGENT_CONFIG: JSON.stringify({ name: `V${i}`, hubPort: PORT, seed: `cv-${i}` }),
    });
  }
  await sleep(400);
  const agentNames = [];
  for (let i = 0; i < (sc.agents || 3); i++) {
    const name = String.fromCharCode(65 + i);
    agentNames.push(name);
    spawnProc(name, 'agent.js', {
      ...chaosEnv('agents'),
      [`K${name}`]: `sk-chaos-${name}`,
      AGENT_CONFIG: JSON.stringify({
        name, seed: `ca-${name}`, hubPort: PORT, consolePort: CONSOLE0 + i,
        adapter: { baseUrl: null, key: { env: `K${name}` } },
        provide: { afterMs: 0, pricePerUnit: 1 + i * 0.05, repayment: true },
        posts: [],
        policy: {
          quota: { capacityUnits: 40, cycleMs: 3500, cycleOffsetMs: i * 1200 },
          demand: { meanUnits: 5, tickMs: 900, burstProb: 0.25, burstMultiplier: 4 },
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

  const ask = (type, want) => new Promise((resolve) => {
    const t = setTimeout(() => { try { c.close(); } catch {} resolve(null); }, 5000);
    const c = transport.dial({ port: PORT });
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
    setTimeout(() => {
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
    const line = `T+${t}s  pool ${advertised.length}  結算 ${lastReceipts}  ` +
      `合約開啟 ${Object.values(cs).filter(Boolean)
        .reduce((s, c) => s + (c.contracts ? c.contracts.open : 0), 0)}` +
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
