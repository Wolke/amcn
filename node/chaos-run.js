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
const tailLib = require('./lib/tail');   // wire 拿不到時的第二條路（#76）
const { fetchLedger } = require('./lib/ledgerfetch');  // 分頁取帳（#41）

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
  let hubAlive = true;
  // `startHub` 會用到它，所以宣告必須在這裡而不是取樣狀態那一段。
  let readsSinceStart = 0;  // 最近一次 startHub 之後讀到幾次帳
  const startHub = (withImport, port = hubPort) => {
    hubPort = port;
    hubAlive = true;
    readsSinceStart = 0;
    const started = spawnProc('hub', 'hub.js', {
      ...chaosEnv('hub'),
      HUB_PORT: String(port), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0', HUB_SEED: `chaos-${sc.name}`,
      // 快照慢、尾檔即時（#74）。原本 2 秒重寫整份歷史，而那個成本是
      // O(全部歷史)——雙角色長跑因此以 4.82 MB/分推高 RSS。尾檔提供逐筆
      // 耐久性，所以快照可以慢得多而不損失恢復點。
      HUB_DUMP_PATH: dumpPath, HUB_SNAPSHOT_MS: '30000',
      HUB_ADVERTISE_HOST: '127.0.0.1',
      ...(sc.defaultAfterS ? {
        HUB_DEFAULT_AFTER_MS: String(sc.defaultAfterS * 1000),
        HUB_DEFAULT_SWEEP_MS: '2000',
      } : {}),
      ...(sc.rendezvous ? { HUB_RENDEZVOUS: rvPath, HUB_RENDEZVOUS_MS: '5000' } : {}),
      // 情境可以直接設 Hub 的環境變數，這樣「同一個情境開/關某個機制」就是
      // 兩個檔案的差別而不是兩份程式（#71 的回流路徑需要這種對照）。
      ...(sc.hubEnv || {}),
      ...(withImport && fs.existsSync(dumpPath) ? { HUB_IMPORT: dumpPath } : {}),
    });
    hubProc = started;
    // 一個**拒絕啟動**的 Hub 和一個活著的 Hub，在取樣端看起來一樣：
    // `startHub` 已經把 hubAlive 設回 true。少了這一行，取樣會把磁碟上
    // 那份（沒有尾檔的）快照當成活著的帳，`noHistoryLoss` 因此報出根本
    // 沒發生的「歷史不見了」——#78 的負向對照第一次跑就是這樣紅的。
    started.on('exit', () => { if (hubProc === started) hubAlive = false; });
  };
  // 取樣要分得出「讀不到」與「沒有東西可讀」（#76）：Hub 被殺掉的那段時間
  // 磁碟上的檔案是**崩潰當下**的中間狀態，拿它去跑活著的帳才該滿足的不變式
  // 是錯的——tail-recover 的 T+160s 就是這樣報出一次 checkpoint root mismatch。
  const killHub = () => {
    hubAlive = false;
    try { hubProc.kill('SIGKILL'); } catch { /* gone */ }
  };

  console.log(`\n=== ${sc.name} ===`);
  console.log(`   ${sc.what || ''}`);
  console.log(`   埠 ${PORT}, ${sc.agents} agents, ${sc.verifiers} verifiers, ` +
    `${sc.durationS}s, seed ${seed}, base ${sc.base || 'tcp'}` +
    (sc.profile ? `, profile ${JSON.stringify(sc.profile)}` : ''));

  fs.rmSync(dumpPath, { force: true });
  fs.rmSync(rvPath, { force: true });
  startHub(false);
  await sleep(600);
  // `|| 3` 會把 verifiers: 0 當成沒設定而起三個——雙角色拓撲（#62 階段 4）
  // 的第一次煙霧測試因此報 pool 9 而不是 6，對照組在不知情的情況下被污染。
  const nVerifiers = sc.verifiers != null ? sc.verifiers : 3;
  for (let i = 1; i <= nVerifiers; i++) {
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
  const nAgents = sc.agents != null ? sc.agents : 3;
  for (let i = 0; i < nAgents; i++) {
    const name = String.fromCharCode(65 + i);
    agentNames.push(name);
    agentProcs[name] = spawnProc(name, 'agent.js', {
      ...chaosEnv('agents'),
      [`K${name}`]: `sk-chaos-${name}`,
      AGENT_CONFIG: JSON.stringify({
        name, seed: `ca-${name}`, consolePort: CONSOLE0 + i,
        ...(sc.rendezvous ? { rendezvous: rvPath, hubPin: hubDid } : { hubPort: PORT }),
        adapter: { baseUrl: null, key: { env: `K${name}` } },
        // #62 階段 3：同一個進程兼交易與驗證。約束要寫清楚——當事人不得進入
        // 自己合約的 pool（#62 階段 1），所以 judge-quorum 需要
        // 節點數 ≥ PANEL_SIZE + 2 = 5，否則扣掉 requester 與 provider 之後
        // 合格者不足三位、quorum 永遠不成立。
        ...(sc.dualRole ? { verify: true } : {}),
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
  let lastConsoles = {};
  // 取樣不再只有一條路（#76）。**wire 仍是第一順位**：那份匯出永遠是當下的，
  // 而且衍生欄位彼此一致。它失敗有兩種原因——匯出越過 `MAX_LINE`（16MB，
  // N=20 約 40 分鐘就到），或 Hub 當下是死的——兩種情況磁碟上都還有
  // 快照＋尾檔（#74），那是同一本帳。
  //
  // 走磁碟讀的是**快照**，理由見 `fromDisk`。不可以只把尾檔併進去就交給
  // `checkLedger`：`tail.merge` 依 #74 的規則會刪掉衍生欄位，而 `checkLedger`
  // 讀的正是那幾個——少了它們，七項檢查會安靜地變成空的，那就是 #76 的
  // 錯誤換個地方再犯一次。
  const fromDisk = () => {
    let ex;
    try { ex = JSON.parse(fs.readFileSync(dumpPath, 'utf8')); } catch { return null; }
    // **只讀快照，不把尾檔併進來。** 併了就得 `rebuild()` 重算 chains，而它
    // 在沒有原 chains 的情況下把每一筆的 `at` 填成 0——所有雜湊因此全變，
    // 算出來的 head root 對不上任何一個鑄過的 checkpoint（實測：applied>0
    // 的每一次都報 `chains: checkpoint root mismatch`，applied=0 的每一次都
    // 乾淨）。那是 #78，不是取樣的缺陷。
    //
    // 取樣要的是一份 Hub **真的產生過**、衍生欄位彼此一致的帳，而快照正好
    // 就是那個東西；尾檔只用來回報「這一份落後幾筆」，讓「交易是否還在
    // 進行」不會被快照間隔誤判成停擺。
    return { ex, pending: tailLib.pending(ex, `${dumpPath}.tail`), from: 'snap' };
  };
  // 取樣的 wire 路徑改走 `lib/ledgerfetch`：匯出超過一個 frame 時它會自動
  // 分頁，而不是靜默斷線（#41／#76）。磁碟那條仍然留著——Hub 死著、或
  // 分頁中途失敗時還是要有東西可讀。
  const askLedger = () => new Promise((resolve) => {
    const c = transport.dial({ port: hubPort });
    const bail = setTimeout(() => { try { c.close(); } catch {} resolve(null); }, 9000);
    fetchLedger(c, { timeoutMs: 8000 })
      .then((m) => { clearTimeout(bail); try { c.close(); } catch {} resolve(m); })
      .catch(() => { clearTimeout(bail); try { c.close(); } catch {} resolve(null); });
  });
  const readLedger = async () => {
    // 對抗腳架：強制走第二條路。一條只在 16MB 之後才會跑到的後備路徑，
    // 等於一條沒有人測過的路徑（同 #74 的 `HUB_TAIL=0`）——而它正是為了
    // 「量測失效」而存在的，自己失效就沒有人會發現。
    const live = process.env.AMCN_SAMPLE_DISK === '1' ? null : await askLedger();
    if (live) return { ex: live, pending: { receipts: 0 }, from: 'wire' };
    // Hub 死著的時候磁碟上只有崩潰當下的中間狀態，不是一本該通過檢查的帳。
    return hubAlive ? fromDisk() : null;
  };

  const blind = [];         // 讀不到帳本的取樣時刻（#76）
  let maxLag = 0;           // 快照落後尾檔最多幾筆收據
  let fromDiskSamples = 0;  // 有幾輪是靠磁碟讀到的（wire 拿不到）
  let hubDownSamples = 0;   // 有幾輪根本沒有帳可讀（Hub 當時是死的）
  let violationDumps = 0;   // 已保存幾份「違反當下的帳」
  let receiptsAtKill = 0;   // #74：殺掉 Hub 當下的收據數，供 noHistoryLoss 用
  let idAtKill = null;      // 同上，但記具體的 contract_id——數量會說謊
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
        // 殺掉的那一刻記下收據數。第一版用整輪樣本的 Math.max，而那包含了
        // 重啟之後的樣本，於是「歷史沒有倒退」變成恆真——又是一個不會失敗
        // 的檢查（#51 的教訓）。
        receiptsAtKill = Math.max(receiptsAtKill, lastReceipts);
        // 光看數量還是不夠：重啟的 Hub 從空快照起來、再跑 130 秒也能累積到
        // 比殺掉當下更多的筆數，於是「不倒退」照樣成立。所以記下一個**具體
        // 的 contract_id**，期末的帳裡必須找得到它。
        const rs = (lastExport && lastExport.receipts) || [];
        if (rs.length) idAtKill = rs[rs.length - 1].receipt.contract_id;
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
    const led = await readLedger();
    const ex = led && led.ex;
    const cs = await console_();
    const t = nowS(t0);
    const advertised = vlist ? vlist.verifiers.map((v) => v.did) : [];
    if (advertised.length && !panelDids.length) panelDids = advertised.slice();
    if (led) {
      lastExport = ex;
      readsSinceStart += 1;
      maxLag = Math.max(maxLag, led.pending.receipts || 0);
      if (led.from !== 'wire') fromDiskSamples += 1;
      const found = inv.checkLedger(ex);
      for (const v of found) violations.push(`T+${t}s  ${v}`);
      // 違反的那一份帳要留下來，否則只剩一行訊息可以看。前三次就夠了——
      // 一份 N=20 的匯出十幾 MB，而同一個成因不會因為多存十份更清楚。
      if (found.length && violationDumps < 3) {
        violationDumps += 1;
        const f = path.join(dir, `${sc.name}-violation-${t}s.json`);
        try {
          fs.writeFileSync(f, JSON.stringify({ at_s: Number(t), from: led.from,
            violations: found, export: ex }));
          console.log(`   （違反的匯出已存：${path.relative(__dirname, f)}）`);
        } catch (err) { console.log(`   （存不下違反的匯出：${err.message}）`); }
      }
      // 快照的收據數，加上尾檔裡還沒被收進去的那些。走磁碟時這個加法是
      // 必要的：#74 的預算旋鈕可以把快照間隔拉到幾分鐘，只數快照會把
      // 「還在成交」看成「停了」。
      const seen = ex.receipts.length + (led.pending.receipts || 0);
      if (seen > lastReceipts) {
        for (let k = lastReceipts; k < seen; k++) settleAt.push(Number(t));
        lastReceipts = seen;
      }
    } else if (!hubAlive) {
      // 沒有帳可讀，因為 Hub 當時是死的。這不是覆蓋率缺口——停機是情境
      // 自己安排的，恢復由 `settlementResumesWithin` 與 `noHistoryLoss`
      // 負責證明。
      hubDownSamples += 1;
    } else {
      // Hub 活著卻讀不到帳＝#76 的那個洞。第一版在這裡什麼都不做，於是
      // `lastExport` 凍結、不變式停止檢查而 PASS 照舊、`tradingContinues`
      // 把讀不到報成空窗。「未測到」與「不變式被破壞」也不能混進同一個
      // 計數器——否則修好覆蓋率的人會以為自己修的是守恆。
      blind.push(Number(t));
    }
    if (advertised.length === 0 && poolEmptyAt === null && panelDids.length) {
      poolEmptyAt = Number(t);
    }
    if (poolEmptyAt !== null && advertised.length > 0 && poolRefillAt === null) {
      poolRefillAt = Number(t);
    }
    lastConsoles = cs;   // #69c 的分叉計數要在殺掉子行程之前抓到
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
    // Hub 自報的堆與保留狀態（#74）。外部 ps 看到的 RSS 分不出「活躍集長大」
    // 與「V8 沒還頁給 OS」，而那正是判斷洩漏的關鍵。
    const m = (lastExport && lastExport.metrics) || {};
    growth.push({ t: Number(t), rssMb: Number(rssMb), dumpKb: Number(dumpKb),
                  receipts: lastReceipts,
                  heapMb: m.heap_used_mb != null ? m.heap_used_mb : null,
                  retained: m.retained || null });

    const line = `T+${t}s  pool ${advertised.length}  結算 ${lastReceipts}  ` +
      `合約開啟 ${Object.values(cs).filter(Boolean)
        .reduce((s, c) => s + (c.contracts ? c.contracts.open : 0), 0)}` +
      (rssMb ? `  hub ${rssMb}MB` : '') + (dumpKb ? `/${dumpKb}KB` : '') +
      // 讀不到帳本必須印在取樣行上。#76 的證據當時就在同一行（`合約開啟`
      // 還在跳），只是沒有任何東西說「這一輪的帳我沒讀到」。
      (led ? (led.from === 'wire' ? '' : `  ${led.from}`)
           : (hubAlive ? '  **帳本讀不到，本輪未受檢**' : '  （Hub 停機，無帳可讀）')) +
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
        // 「全程」是一個覆蓋率主張，所以讀不到帳本的取樣一樣讓它失敗：
        // #76 那一輪宣稱「1996 筆結算下持續通過」，而最後 24% 從來沒被檢查，
        // 連 1996 這個數字本身都是凍結值。未測到不是通過。
        check('不變式全程未被破壞（且全程都真的檢查過）',
          violations.length === 0 && blind.length === 0,
          violations.length ? violations.slice(0, 3).join(' | ')
            : blind.length
              ? `${blind.length} 次取樣讀不到帳本（T+${blind[0]}s 起），` +
                `這段時間未受檢——不是通過（#76）`
              : `${lastReceipts} 筆結算下 7 項不變式持續通過，` +
                `${growth.length - hubDownSamples} 次取樣全部讀到帳` +
                (hubDownSamples ? `（另有 ${hubDownSamples} 次 Hub 停機、無帳可讀）` : '') +
                (fromDiskSamples
                  ? `（其中 ${fromDiskSamples} 次 wire 拿不到、改讀磁碟快照，` +
                    `尾檔另有最多 ${maxLag} 筆未進快照；不併入的理由見 #78）`
                  : '（全部由 wire 取得）'));
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
      case 'noHistoryLoss': {
        // 恢復測試真正該問的問題。`settlementResumesWithin` 會在一個歷史被
        // 吞掉的帳上通過——重啟的 Hub 從幾乎空的快照起來、開始收新的結算，
        // 看起來完全健康。所以斷言的是**收據數不得倒退**（#74）。
        const end = lastReceipts;
        const kept = idAtKill && (lastExport.receipts || [])
          .some((r) => r.receipt.contract_id === idAtKill);
        // `readsSinceStart` 是這一案的前提：如果重啟之後一次都沒讀到帳，
        // 那麼「歷史沒有倒退」比對的是**重啟之前**那份匯出，恆真而無意義
        // （同 #74 的教訓）。一個拒絕啟動的 Hub 必須讓這一案紅，而不是讓
        // 它用舊資料通過。
        check('重啟後歷史沒有倒退（快照＋尾檔重播完整）',
          receiptsAtKill > 0 && readsSinceStart > 0 && end >= receiptsAtKill && !!kept,
          receiptsAtKill === 0
            ? '本輪沒有殺掉 Hub，本案未測到'
            : readsSinceStart === 0
            ? '重啟之後一次都沒讀到帳——Hub 沒有回來（見 hub.log）'
            : `殺掉當下 ${receiptsAtKill} 筆、期末 ${end} 筆；` +
              `殺掉前的 ${idAtKill ? idAtKill.slice(0, 22) : '?'} ` +
              (kept ? '仍在帳上' : '**不見了**'));
        break;
      }
      case 'forkDetected': {
        // 說謊的排序器（HUB_EQUIVOCATE=1）對一半的節點供應分叉的 checkpoint。
        // 它持有私鑰所以兩個分支都驗得過——攔不住。要斷言的是**有人說出來**，
        // 而那只能靠節點之間交換彼此見到的 root（#69c）。
        const forks = Object.entries(lastConsoles)
          .filter(([, c]) => c && c.checkpoint_forks > 0);
        check('說謊的排序器被節點自己抓到（#69c）',
          forks.length >= (e.minNodes || 1),
          forks.length
            ? forks.map(([n, c]) => `${n} 回報 ${c.checkpoint_forks} 次`).join('、')
            : '沒有任何節點回報分叉——偵測沒有發生');
        break;
      }
      case 'rebateReturns': {
        // 毛吸收 vs 淨吸收：protocol 帳戶收了多少 vs 真正留下多少。這條路徑
        // 的全部主張就是這兩個數字要能分開（#71）。
        const m = (lastExport && lastExport.metrics) || {};
        const rebated = m.rebated_cc || 0;
        const held = (m.insurance_cc || 0) + (m.treasury_cc || 0);
        check(`protocol 帳戶的收入有回流（≥ ${e.minCc} CC）`,
          rebated >= e.minCc,
          `退還 ${rebated.toFixed(2)} CC（保險 ` +
          `${((m.rebated_by_source || {}).insurance || 0).toFixed(2)}、Treasury ` +
          `${((m.rebated_by_source || {}).treasury || 0).toFixed(2)}），` +
          `期末仍持有 ${held.toFixed(2)} CC`);
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
        // 讀不到帳本的區間不算空窗，但也不能悄悄跳過：#76 那一輪正是把
        // 「我沒看到成交」報成「市場停了 590 秒」，而實際上那段時間成交了
        // 578 筆。未觀測到與沒有發生是兩件不同的事。
        const unobserved = (a, b) => blind.some((x) => x > a && x <= b);
        let gap = 0, at = null, skippedWindows = 0;
        for (let i = 1; i < marks.length; i++) {
          if (unobserved(marks[i - 1], marks[i])) { skippedWindows += 1; continue; }
          if (marks[i] - marks[i - 1] > gap) { gap = marks[i] - marks[i - 1]; at = marks[i - 1]; }
        }
        check(`交易全程未中斷超過 ${e.maxGapS}s（T+${from}s 起）`,
          gap <= e.maxGapS,
          `最長空窗 ${gap}s（自 T+${at}s）；全程 ${settleAt.length} 筆` +
          (skippedWindows
            ? `；另有 ${skippedWindows} 段未觀測（取樣讀不到帳本，#76）不計入空窗`
            : ''));
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
      case 'marketMetrics': {
        // §20-10 的四項指標。原型在 N=3 由 demo.js 斷言，而 W12 問的是同一組
        // 定義在試點規模上還成不成立，所以這裡讀的是匯出裡的 `metrics`——
        // 它由簽署狀態導出（FR-083 要求模擬與生產共用定義），Console 不參與。
        const mm = (lastExport && lastExport.metrics) || {};
        const bad = [];
        // 先檢查**值域**再檢查界限。第一版只設了下界，於是 N=20 那一輪的
        // 成交率 2.242 與違約代理 −1.242 直接 PASS——一個比率跑出 [0,1] 表示
        // 分子與分母來自不同的生命期（#77：`market` 計數器不隨匯入還原），
        // 而只設下界的期望永遠看不到這件事。
        if (!(mm.fill_rate >= 0 && mm.fill_rate <= 1)) {
          bad.push(`成交率 ${mm.fill_rate} 不在 [0,1]——分子分母不同生命期（#77）`);
        }
        if (!(mm.default_proxy_rate >= 0)) {
          bad.push(`違約代理 ${mm.default_proxy_rate} < 0（同上）`);
        }
        if (e.minFillRate != null && !(mm.fill_rate >= e.minFillRate)) {
          bad.push(`成交率 ${mm.fill_rate} < ${e.minFillRate}`);
        }
        if (e.minDepth != null && !(mm.avg_bids_per_task >= e.minDepth)) {
          bad.push(`供需深度 ${mm.avg_bids_per_task} < ${e.minDepth}`);
        }
        if (e.maxDefaultRate != null && !(mm.default_rate <= e.maxDefaultRate)) {
          bad.push(`違約率 ${mm.default_rate} > ${e.maxDefaultRate}`);
        }
        // #77 的可檢查部分：成交率的分母是持久化的得標集合，所以「每一筆
        // 收據的 contract_id 都在裡面」是第三方也能做的對照。漏掉一個就表示
        // 分母不完整——那正是重啟之後成交率跑出 [0,1] 的成因。
        const aw = new Set(lastExport.awarded || []);
        const orphan = (lastExport.receipts || [])
          .filter((r) => !aw.has(r.receipt.contract_id));
        if (aw.size === 0 && (lastExport.receipts || []).length) {
          bad.push('匯出沒有得標集合——成交率的分母無從對照（#77）');
        } else if (orphan.length) {
          bad.push(`${orphan.length} 筆收據的 contract_id 不在得標集合裡` +
            `（例：${orphan[0].receipt.contract_id.slice(0, 22)}）`);
        }
        // 還債時間是四項裡唯一可能**無值**的：它需要有帳戶真的穿越零點。
        // null 不是「很好」而是「這一輪沒有量到」，所以它算缺一項。
        if (mm.avg_repayment_ms == null) {
          bad.push('還債時間無值——本輪沒有任何帳戶從負餘額回到零以上');
        }
        check('§20-10 四項指標齊備且在界內', bad.length === 0,
          bad.length ? bad.join('；')
            : `成交率 ${mm.fill_rate}（${mm.contracts_awarded} 得標／` +
              `${(lastExport.receipts || []).length} 結算）、供需深度 ` +
              `${mm.avg_bids_per_task} 個出價/任務、違約率 ${mm.default_rate}` +
              `（代理 ${mm.default_proxy_rate}）、還債 ` +
              `${mm.avg_repayment_ms}ms（${mm.repayment_episodes} 次）`);
        break;
      }
      default:
        check(`未知期望 ${e.kind}`, false);
    }
  }
  // --- 人口報表（#61／#62／#64）------------------------------------------
  // soak-n6 的「信用使用率 36.0%、貼上限 1/6、verifier 佔正餘額 97.5%」是逐
  // 帳戶手算出來的，所以下一輪無法自動重現同一組數字——而 #61 的主張正是
  // 「這些數字隨 N 移動」。改由匯出計算：`credit_lines`、`balances` 與
  // `chains` 都是簽署狀態的一部分，Console 只用來把 DID 換回名字。
  if (lastExport && lastExport.credit_lines) {
    const bals = lastExport.balances || {};
    const nameOf = {};
    for (const [nm, c] of Object.entries(lastConsoles)) {
      if (c && c.did) nameOf[c.did] = nm;
    }
    // 峰值負債取 hash chain 的 `balance_after` 最小值：期末餘額看不出誰**曾經**
    // 貼到上限，而「貼上限」問的就是曾經——一個還完債的 agent 期末是 0，
    // 期間卻可能整輪貼牆。
    const troughOf = (did) => ((lastExport.chains || {})[did] || [])
      .reduce((lo, en) => Math.min(lo, en.balance_after), 0);
    let sumCl = 0, sumDebt = 0, sumPeak = 0;
    // 兩個門檻都報。#61 手算那兩點用的是 ≥90%，而第一版這裡寫 0.99——
    // 同一輪 N=20 在 90% 是 9/20、在 99% 是 0/20，也就是說**門檻的選擇會
    // 直接翻轉「貼上限隨 N 上升還是下降」這個結論**（峰值使用率密集落在
    // 93–98%，沒有人真的碰到天花板）。一個會翻轉結論的常數不該藏在程式裡。
    const pinned = { p90: 0, p99: 0 };
    const agentRows = [];
    for (const [did, cl] of Object.entries(lastExport.credit_lines)) {
      const b = bals[did] || 0;
      const peak = -troughOf(did);
      sumCl += cl; sumDebt += Math.max(0, -b); sumPeak += peak;
      // 分母是**期末**額度。額度在跑的過程中隨年齡與 E_eff 成長，所以早期
      // 貼牆的峰值會被一個更大的期末額度除——這個偏誤讓比率偏低，不偏高。
      if (cl > 0 && peak >= cl * 0.9) pinned.p90 += 1;
      if (cl > 0 && peak >= cl * 0.99) pinned.p99 += 1;
      agentRows.push({ name: nameOf[did] || did.slice(0, 14), cl, b, peak });
    }
    const isProtocol = (a) => a.startsWith('protocol:');
    let posAgents = 0, posOthers = 0;
    const otherRows = [];
    for (const [did, b] of Object.entries(bals)) {
      if (isProtocol(did) || b <= 0) continue;
      if (did in lastExport.credit_lines) posAgents += b;
      else { posOthers += b; otherRows.push({ name: nameOf[did] || did.slice(0, 14), b }); }
    }
    const pos = posAgents + posOthers;
    const pct = (x, of) => (of > 0 ? ((100 * x) / of).toFixed(1) : '—');
    console.log(`\n-- 人口（${agentRows.length} 交易 agent、` +
      `${otherRows.length} 個只收不付的帳戶）--`);
    console.log(`   信用使用率  期末 ${pct(sumDebt, sumCl)}%｜` +
      `峰值 ${pct(sumPeak, sumCl)}%（額度總計 ${sumCl.toFixed(1)} CC）`);
    // 總量使用率會被結構性順差者**沒用到的**額度稀釋（#64：一個 +673 CC 的
    // 順差者帶著 500 CC 額度幾乎沒借過），所以它不是「網路會不會鎖死」的
    // 指標；逐帳戶的峰值分佈才是。
    console.log(`   曾貼上限    ≥90% ${pinned.p90}/${agentRows.length}｜` +
      `≥99% ${pinned.p99}/${agentRows.length}｜峰值使用率 ` +
      `${[...agentRows].sort((x, y) => y.peak / y.cl - x.peak / x.cl)
        .slice(0, 5).map((r) => `${(100 * r.peak / r.cl).toFixed(0)}%`).join(' ')} …`);
    // #62 的形狀：不是「誰賺得多」，是「正餘額集中在不花錢的角色手上」。
    console.log(`   正餘額     共 ${pos.toFixed(2)} CC｜` +
      `交易 agent ${posAgents.toFixed(2)}（${pct(posAgents, pos)}%）｜` +
      `非交易角色 ${posOthers.toFixed(2)}（${pct(posOthers, pos)}%）`);
    const top = [...agentRows].sort((x, y) => y.b - x.b);
    const fmt = (r) => `${r.name} ${r.b >= 0 ? '+' : ''}${r.b.toFixed(2)}` +
      `（峰值負債 ${r.peak.toFixed(1)}/${r.cl.toFixed(1)}）`;
    console.log(`   最高       ${top.slice(0, 3).map(fmt).join('、')}`);
    // N≤6 時前三與後三會是同一批，印兩次只是噪音。
    if (top.length > 6) {
      console.log(`   最低       ${top.slice(-3).map(fmt).join('、')}`);
    }
    // 留存率 ＝ 淨額 ÷ 流入，逐帳戶（#62／#64／#66）。這是**無因次**的，
    // 所以它是原型與模擬器之間唯一可以直接比的量——原型的經濟時鐘比模擬器
    // 快約兩個數量級（需求 900ms 一跳），一個「%/天」的保管費率在兩邊根本
    // 不是同一個單位，拿來互相錨定會得出 615%/天 這種數字。
    //
    // 它也是四小時那兩輪真正的差別所在：純 verifier 留存 99.4%（收 859、
    // 付 5，設計上就不消費），而雙角色的累積者留存 23.0%（收 8,840、付
    // 6,809）——**機制完全不同，儘管期末分佈看起來一樣集中**。後者的集中
    // 來自吞吐量不對稱，不是來自不肯花錢，所以對它有效的槓桿也不一樣。
    const retention = [];
    for (const [did, chain] of Object.entries(lastExport.chains || {})) {
      if (did.startsWith('protocol:')) continue;
      let inn = 0, out = 0;
      for (const e of chain) {
        if (e.delta_cc > 0) inn += e.delta_cc; else out -= e.delta_cc;
      }
      if (inn > 0) {
        retention.push({ name: nameOf[did] || did.slice(0, 12),
                         pct: (100 * (inn - out)) / inn, inn, out });
      }
    }
    if (retention.length) {
      retention.sort((a, b) => b.pct - a.pct);
      const top = retention[0];
      const mid = retention[Math.floor(retention.length / 2)];
      console.log(`   留存率     最高 ${top.name} ${top.pct.toFixed(1)}%` +
        `（收 ${top.inn.toFixed(0)}／付 ${top.out.toFixed(0)}）｜` +
        `中位 ${mid.pct.toFixed(1)}%｜` +
        `>50% 的帳戶 ${retention.filter((r) => r.pct > 50).length}/${retention.length}`);
    }
    const mp = lastExport.metrics || {};
    console.log(`   protocol   保險 ${mp.insurance_cc}｜Treasury ` +
      `${mp.treasury_cc}｜損失 ${mp.loss_cc}｜已退還 ${mp.rebated_cc} CC`);
  }

  if (growth.length >= 4 && sc.durationS >= 600) {
    const a = growth[1], z = growth.at(-1);
    const mins = (z.t - a.t) / 60 || 1;
    console.log(`\n-- 成長（${a.t}s → ${z.t}s）--`);
    // RSS 的首尾相減對一個被 GC 的堆是沒有意義的（登記簿 #74）。soak-dual6
    // 的序列是 50→151→60→236→108→253：**掉下來就證明記憶體被回收了**，
    // 而首尾相減把它報成 5.3 MB/分的洩漏。對照組在 27–101 間震盪、無趨勢，
    // 卻可能被同一個算法報成任何數字，取決於最後一點落在鋸齒的哪裡。
    //
    // 三個數字取代一個：最小平方斜率（整體趨勢）、**地板**的斜率（兩段
    // 最小值——GC 之間的最小值才是真正的活躍集），以及峰值。真洩漏會讓
    // 地板單調上升；鋸齒只會讓峰值跳動。#41 是靠這張報表找到的，所以它
    // 給出假數字的代價是下一個 #41 找不到。
    // > 0 而不只是 isFinite：Hub 被殺掉的那幾個取樣點記成 0，而 0 會把「地板」
    // 直接壓到 0，讓這個指標變成「Hub 有沒有死過」而不是「活躍集有沒有長大」。
    const pts = growth.filter((g) => Number.isFinite(g.rssMb) && g.rssMb > 0);
    const slope = (xs, ys) => {
      const n = xs.length;
      if (n < 2) return 0;
      const mx = xs.reduce((t, v) => t + v, 0) / n;
      const my = ys.reduce((t, v) => t + v, 0) / n;
      const num = xs.reduce((t, x, i) => t + (x - mx) * (ys[i] - my), 0);
      const den = xs.reduce((t, x) => t + (x - mx) ** 2, 0);
      return den ? num / den : 0;
    };
    const fit = slope(pts.map((g) => g.t / 60), pts.map((g) => g.rssMb));
    const half = Math.floor(pts.length / 2);
    const floorOf = (arr) => Math.min(...arr.map((g) => g.rssMb));
    const f1 = floorOf(pts.slice(0, half)), f2 = floorOf(pts.slice(half));
    const floorSlope = (f2 - f1) / ((pts.at(-1).t - pts[half].t) / 60 || 1);
    const heaps = growth.filter((g) => g.heapMb != null && g.heapMb > 0);
    if (heaps.length >= 4) {
      const hf = slope(heaps.map((g) => g.t / 60), heaps.map((g) => g.heapMb));
      const hh = Math.floor(heaps.length / 2);
      const h1 = Math.min(...heaps.slice(0, hh).map((g) => g.heapMb));
      const h2 = Math.min(...heaps.slice(hh).map((g) => g.heapMb));
      const r1 = heaps[0].retained || {}, r2 = heaps.at(-1).retained || {};
      console.log(`   Hub 堆    迴歸 ${hf.toFixed(2)} MB/分｜地板 ` +
        `${h1}MB → ${h2}MB｜峰值 ${Math.max(...heaps.map((g) => g.heapMb))}MB`);
      console.log(`   保留狀態  事件 ${r1.events}→${r2.events}｜` +
        `checkpoint ${r1.checkpoints}→${r2.checkpoints}｜` +
        `鏈分錄 ${r1.chain_entries}→${r2.chain_entries}｜` +
        `rawLog ${r1.raw_log_kb}→${r2.raw_log_kb}KB`);
    }
    console.log(`   Hub RSS  迴歸斜率 ${fit.toFixed(2)} MB/分｜` +
      `地板 ${f1}MB → ${f2}MB (${floorSlope.toFixed(2)} MB/分)｜` +
      `峰值 ${Math.max(...pts.map((g) => g.rssMb))}MB｜` +
      `首尾 ${a.rssMb}→${z.rssMb}MB（首尾相減對 GC 堆無意義，見 #74）`);
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
