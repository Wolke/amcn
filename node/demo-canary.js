// W9 canary audit: a verifier that collects fees without doing the work
// loses stake, and honest ones do not.
//
// Everything this exercises exists because the simulator said it should
// (§4 #25/#27/#29/#30): fee at 4%, canary as a share of volume, and slashing
// gated on an absolute failure count as well as a rate, because a rate
// threshold on a small sample punishes ordinary competence error.
//
// The population is deliberately mixed. Normal judge-quorum traffic has to
// run alongside the decoys: verifier stake is escrowed out of real
// verification fees (§4 #28), and a canary only pays the provider, so
// without genuine work there is no stake to forfeit and the audit would
// prove nothing.
//
// Run:  node demo-canary.js        (DEMO_PORT_OFFSET=100 to coexist)
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { identityFromSeed } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + OFFSET;
const RUN_MS = Number(process.env.DEMO_RUN_MS || 26000);
const CANARY_SEED = 'demo-canary-issuer';
const CANARY = identityFromSeed(CANARY_SEED);

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

function spawnProc(file, env, arg) {
  const args = [path.join(__dirname, file)];
  if (arg) args.push(arg);
  const p = spawn(process.execPath, args,
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => process.stdout.write(d.toString()
    .split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n') + '\n'));
  return p;
}

const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 512 }];
const agentCfg = (o, extra) => ({
  AGENT_CONFIG: JSON.stringify({ hubPort: PORT, adapter: null, posts: [], ...o }),
  ...extra,
});

async function main() {
  const procs = [];
  procs.push(spawnProc('hub.js', {
    HUB_PORT: String(PORT), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0',
    // The issuer is authorised by DID, which is why canary.js derives its
    // identity from a seed: the hub has to know it before it starts.
    HUB_CANARY_DID: CANARY.did,
    HUB_SLASH_MIN_SAMPLES: '5', HUB_SLASH_MIN_FAILURES: '3',
  }));
  await new Promise((r) => setTimeout(r, 500));

  // V3 votes PASS without checking — the behaviour the canary exists to find.
  procs.push(spawnProc('verifier.js', agentCfg({ name: 'V1' })));
  procs.push(spawnProc('verifier.js', agentCfg({ name: 'V2' })));
  procs.push(spawnProc('verifier.js', agentCfg({ name: 'V3-lazy', alwaysPass: true })));
  await new Promise((r) => setTimeout(r, 400));

  // Real traffic, so verification fees flow and stake accumulates.
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'P', adapter: { baseUrl: null, key: { env: 'P_KEY' } },
    provide: { afterMs: 0, pricePerUnit: 1.0 },
  }, { P_KEY: 'sk-canary-demo-P' })));
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'R',
    policy: {
      quota: { capacityUnits: 12, cycleMs: 3000 },
      demand: { meanUnits: 6, tickMs: 700, burstProb: 0.2, burstMultiplier: 3 },
      budget: { maxPricePerUnit: 1.3, minUnits: 3, maxUnitsPerTask: 8 },
      acceptance: { method: 'judge-quorum', asserts: SHA_OK },
    },
  })));
  await new Promise((r) => setTimeout(r, 600));

  procs.push(spawnProc('canary.js', agentCfg({
    name: 'canary', seed: CANARY_SEED, everyMs: 2200, units: 2,
  })));

  console.log(`\n-- 金絲雀稽核 ${RUN_MS / 1000}s：V3 是偷懶者（不看斷言就投 PASS）--\n`);
  await new Promise((r) => setTimeout(r, RUN_MS));

  const ex = await new Promise((resolve) => {
    const c = transport.dial({ port: PORT });
    c.onMessage((m) => { if (m.type === 'ledger_export') resolve(m); });
    c.send({ type: 'export' });
  });
  procs.forEach((p) => p.kill());

  const { balances, stakes = {}, canary_stats = {}, chains } = ex;
  const stats = Object.entries(canary_stats);

  console.log('\n== W9 金絲雀驗收檢查 ==');

  const audited = stats.filter(([, st]) => st.seen > 0);
  check('金絲雀確實被稽核：panel 成員都收到暗樁並出具裁決',
    audited.length >= 3,
    stats.map(([d, st]) =>
      `${d.slice(0, 14)} seen=${st.seen} failed=${st.failed}`).join('  ') || '無紀錄');

  // The lazy one passes known-bad work every time; honest ones never should.
  const lazy = stats.filter(([, st]) => st.failed >= 3);
  const honest = stats.filter(([, st]) => st.failed === 0);
  check('偷懶者被辨識：對已知錯誤的工作投 PASS，且誠實者零失敗',
    lazy.length === 1 && honest.length >= 2,
    `${lazy.length} 位失敗 ≥3 次, ${honest.length} 位零失敗`);

  const slashedTotal = stats.reduce((t, [, st]) => t + (st.slashed_cc || 0), 0);
  const honestSlashed = honest.reduce((t, [, st]) => t + (st.slashed_cc || 0), 0);
  check('§4 #27/#30 只罰模式、不罰運氣：偷懶者被沒收押注，誠實者分文未失',
    slashedTotal > 0 && honestSlashed === 0,
    `沒收總額 ${slashedTotal.toFixed(4)} CC，誠實者被沒收 ${honestSlashed.toFixed(4)} CC`);

  // Forfeited stake lands in the insurance pool, and the stake account must
  // still equal the sum of what verifiers hold.
  const stakeAccount = balances['protocol:stake'] || 0;
  const stakeSum = Object.values(stakes).reduce((t, v) => t + v, 0);
  check('§4 #28 押注帳務一致：沒收後 protocol:stake = 各自持有額之和',
    Math.abs(stakeAccount - stakeSum) < 1e-6,
    `protocol:stake=${stakeAccount.toFixed(4)} = Σ持有 ${stakeSum.toFixed(4)}`);

  // FR-083: the decoy is real work, paid by Treasury, never organic volume.
  const canaryEvents = Object.values(chains)
    .flat().filter((e) => e.seq !== undefined).length;
  check('FR-083 暗樁由 Treasury 出資（provider 仍獲付，不計入自然量）',
    (balances['protocol:treasury'] || 0) !== 0 && canaryEvents > 0,
    `treasury=${(balances['protocol:treasury'] || 0).toFixed(2)} CC`);

  const sum = Object.values(balances).reduce((s, v) => s + v, 0);
  check('Σ=0 在託管與沒收之後依然成立',
    Math.abs(sum) < 1e-9, `Σ=${sum.toFixed(10)}`);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  console.log('金絲雀紀錄：');
  for (const [did, st] of stats) {
    console.log(`  ${did.slice(0, 18)}  seen ${st.seen}  failed ${st.failed}  ` +
      `slashed ${(st.slashed_cc || 0).toFixed(4)} CC  stake ${(stakes[did] || 0).toFixed(4)} CC`);
  }
  console.log('帳：', Object.entries(balances)
    .filter(([, v]) => Math.abs(v) > 1e-9)
    .map(([a, v]) => `${a.startsWith('did') ? a.slice(0, 14) : a}=${v.toFixed(2)}`)
    .join('  '));
  process.exit(failed ? 1 : 0);
}

main();
