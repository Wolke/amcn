// #96 的閘門：clone 之後的那**一個**指令。
//
// Owner 的推廣方式很簡單：repo 公開、別人 clone、「然後整個程式就起來」。在這
// 之前 repo 裡沒有那一個指令——`quickstart.sh` 是在自己這台開一座島、
// `service/install.sh` 是把自己變成主辦，兩者都不是「加入你的網路」。而 #92 讓
// `node agent.js` 有了預設網路之後，剩下的缺口是**前置條件**：Node 版本、
// `.onion` 需要本機 tor、身分要存下來、以及「我到底連去哪、釘的是誰」。
//
// 這支守的是那條路的四個關卡，而負對照比正向那一條重要：**前置條件不滿足時要
// 說出怎麼修**，不能讓三個行程各自靜靜地重試（#76 的教訓：失敗要說出成因）。
//
// Run:  node demo-join.js      (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { identityFromSeed } = require('./lib/wire');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + 1200 + OFFSET;
const DIR = path.join(__dirname, 'out', `demo-join-${process.pid}`);
const RV = path.join(DIR, 'rendezvous.json');
const SEED = `demo-join-hub-${process.pid}`;
const HUB_DID = identityFromSeed(SEED).did;

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 250) {
  const until = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

// 假裝是**別人剛 clone 完**：身分、pid、log 都放在一個乾淨的地方，所以這支
// 不會碰到這台機器真正的身分（也不會被它影響）。
const env = (extra = {}) => ({
  ...process.env,
  AMCN_CONFIG_DIR: path.join(DIR, 'configs'),
  JOIN_DIR: path.join(DIR, 'var'),
  JOIN_LOG_DIR: path.join(DIR, 'logs'),
  ...extra,
});
const join = (args, extra = {}) => {
  const r = spawnSync('/bin/bash', [path.join(__dirname, 'join.sh'), ...args],
    { env: env(extra), encoding: 'utf8', timeout: 60000, cwd: __dirname });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  // (1) 還沒有網路可加入：三條路要說出來，而不是丟例外
  const noNet = join(['--check'], { AMCN_BOOTSTRAP: '', AMCN_HUB_PIN: '' });

  // (2) 有網路：Hub 起來並發布位址記錄
  const hub = spawn(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env, HUB_PORT: String(PORT), HUB_BIND: '127.0.0.1',
      HUB_SEED: SEED, HUB_BEACON: '0', HUB_AGE_RAMP_MS: '1',
      HUB_RENDEZVOUS: RV, HUB_RENDEZVOUS_MS: '800',
      HUB_DUMP_PATH: path.join(DIR, 'ledger.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let hubLog = '';
  hub.stdout.on('data', (d) => { hubLog += d.toString(); });
  await waitFor(() => fs.existsSync(RV));

  const netEnv = { AMCN_BOOTSTRAP: RV, AMCN_HUB_PIN: HUB_DID };
  const checked = join(['--check'], netEnv);
  const startedNothing = !fs.existsSync(path.join(DIR, 'var', 'pids'));

  // (3) 真的加入：一個指令，沒有設定檔，沒有位址
  const ran = join([], netEnv);
  const registered = await waitFor(() => /registered .*\(verifier,/.test(hubLog), 20000);
  const status = join(['status'], netEnv);
  const seedFile = path.join(DIR, 'configs', '.verifier-seed');
  const seedMode = fs.existsSync(seedFile) ? (fs.statSync(seedFile).mode & 0o777) : null;

  // (4) --provider：設定檔要把網路那幾個值**先填好**再交給人
  const prov = join(['--provider'], netEnv);
  let provCfg = null;
  try {
    provCfg = JSON.parse(fs.readFileSync(path.join(DIR, 'configs', 'my-provider.json'), 'utf8'));
  } catch { /* 沒寫出來 */ }

  // (5) 停掉：pid 要真的死
  const pids = (() => {
    try {
      return fs.readFileSync(path.join(DIR, 'var', 'pids'), 'utf8').trim().split('\n')
        .map((l) => Number(l.split(' ')[0])).filter(Boolean);
    } catch { return []; }
  })();
  const stopped = join(['stop'], netEnv);
  await sleep(800);
  const alive = pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });

  // (6) 負對照：.onion 但本機沒有 tor——要說出怎麼修，而不是讓它靜靜重試
  const onionRv = path.join(DIR, 'onion-network.json');
  fs.writeFileSync(onionRv, JSON.stringify({ name: 'onion-test',
    hubHost: 'amcnexampleaddressnotarealonion.onion', hubPort: PORT,
    transport: 'tor', hubPin: HUB_DID }, null, 2));
  const noTor = join([], { AMCN_BOOTSTRAP: '', AMCN_HUB_PIN: '',
    JOIN_FAKE_NO_TOR: '1',
    // 直接餵一份靜態位址的 network.json 給 bootstrap（#96 的第二種填法）
    AMCN_NETWORK_FILE: onionRv });

  // (7) 這個 repo 的腳本裡滿是中文輸出，而 bash 在這個 locale 下會把非 ASCII
  //     位元組當成變數名的一部分：`"$SOCKS）"` 是變數 `SOCKS）`，配上 `set -u`
  //     就在**錯誤路徑**上中止——而錯誤路徑正是最需要它說話的地方（#97）。
  //     這一條掃整個 repo，因為它是一個**類別**而不是一個 bug。
  const shellTrap = (() => {
    const bad = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'out') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.sh')) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = txt.match(/\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7f])/g);
          if (m) bad.push(`${path.relative(__dirname, full)}（${m.length} 處：${m[0]}…）`);
        }
      }
    };
    walk(path.join(__dirname, '..'));
    return bad;
  })();

  console.log('\n== #96 clone 之後的那一個指令 驗收檢查 ==');

  check('還沒有網路可加入時，說出三條可以走的路（不是例外堆疊）',
    noNet.status === 3 && /沒有預設網路/.test(noNet.out) &&
    /quickstart|--standalone/.test(noNet.out),
    `exit=${noNet.status}`);

  check('--check 印出「連去哪、釘誰、什麼傳輸、什麼角色」且**不啟動任何東西**',
    checked.status === 0 && checked.out.includes(HUB_DID) && startedNothing,
    (checked.out.split('\n').find((l) => /要加入的網路/.test(l)) || '').slice(0, 60));

  check('一個指令就加入（沒有設定檔、沒有位址、不必開埠）',
    ran.status === 0 && !!registered,
    registered ? (hubLog.match(/registered \S+ \(verifier,[^)]*\)/) || [''])[0] : '沒有註冊');

  check('身分存成 0600 的檔（押注與受測紀錄綁在它上面）', seedMode === 0o600,
    seedMode == null ? '沒有產生' : `mode ${seedMode.toString(8)}`);

  check('status 看得到它活著', status.status === 0 && /在跑/.test(status.out),
    (status.out.split('\n').find((l) => /在跑/.test(l)) || '').slice(0, 40));

  check('--provider 把網路那幾個值先填好，並指名還要人補什麼',
    !!provCfg && provCfg.hubPin === HUB_DID && !!provCfg.rendezvous &&
    /adapter\.baseUrl|terms\.attested/.test(prov.out) &&
    /usdPerMTokens/.test(prov.out),
    provCfg ? `hubPin 已填、rendezvous 已填，並要求補 adapter 與 spend` : '沒有寫出設定檔');

  check('stop 真的把行程停掉', stopped.status === 0 && alive.length === 0,
    `${pids.length} 個 pid，停完還活著 ${alive.length} 個`);

  check('負對照：位址是 .onion 而本機沒有 tor 時，說出怎麼修並且不啟動',
    noTor.status === 1 && /brew install tor|apt install tor/.test(noTor.out) &&
    /\.onion/.test(noTor.out),
    (noTor.out.split('\n')[0] || '').slice(0, 70));

  check('全 repo 的腳本沒有「$變數緊接中文」（bash 會把它吃進變數名，#97）',
    shellTrap.length === 0,
    shellTrap.length ? shellTrap.join('；') : '掃過所有 *.sh，零處');

  hub.kill();
  await sleep(300);
  fs.rmSync(DIR, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
