// #94 的閘門：替別人做事會花掉自己的 token，而那是真的錢。
//
// 在這一輪之前，原型對這件事一無所知：`adapter.js` 拿到供應商的回應只讀
// `choices[0].message.content`，**`usage` 整個丟掉**，而唯一的上限是
// `policy.quota` 的「unit」——一個與 token 和美金都沒有換算的抽象量。
//
// 這支守三件事，而第三件最重要：
//   1. **計量**：拿得到 `usage` 就記真值；拿不到就估，而估出來的一律**標成
//      估計值**（把估計值當事實混進帳目，是這個專案反覆記過的錯）。
//   2. **回報**：每筆做完主人就知道花了多少、還剩多少。人讀一行 log，
//      機器讀一行 JSON——主人通常是另一個 agent。
//   3. **上限真的會擋住出價**（不是只印個警告）：預算用完就不出價。先接單
//      再因為沒預算而交不出來，對網路的傷害比沉默大得多——那是違約，會吃掉
//      對手的 CC 與保險池。所以這裡有一組正／負對照：同一個任務、同一個
//      賣方，唯一的差別是它今天還有沒有預算。
//
// Run:  node demo-spend.js      (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { identityFromSeed } = require('./lib/wire');
const spendLib = require('./lib/spend');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + 1000 + OFFSET;
const FAKE_PORT = PORT + 1;
const KEY = 'sk-demo-spend-SECRET';
const ROOT = path.join(__dirname, 'out', `demo-spend-${process.pid}`);
const PROVIDER_SEED = `demo-spend-provider-${process.pid}`;
const PROVIDER_DID = identityFromSeed(PROVIDER_SEED).did;

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 12000, step = 200) {
  const until = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

// --- 第一部分：帳目規則（不需要起任何行程，所以它是確定性的）---
function accounting() {
  const root = path.join(ROOT, 'acct');
  const lines = () => {
    try {
      return fs.readFileSync(path.join(root, 'out', 'owner-notices.jsonl'), 'utf8')
        .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  const mk = (policy) => spendLib.create({ did: 'did:demo:acct', policy, root, log: () => {} });

  // 真的 usage：記的是供應商說的數字，不是估的。
  const a = mk({ spend: { dailyTokenCap: 1000, usdPerMTokens: { in: 1, out: 2 } } });
  const n1 = a.record({ contractId: 'c1', usage: { prompt_tokens: 100, completion_tokens: 50 },
                        prompt: 'x'.repeat(4000), output: 'y'.repeat(4000) });
  // 沒有 usage：估算，且標成估計值。
  const n2 = a.record({ contractId: 'c2', usage: null, prompt: 'x'.repeat(400), output: 'y'.repeat(200) });
  const before = a.status();
  // 上限：加到超過 1000 tokens 就該被擋。
  a.record({ contractId: 'c3', usage: { prompt_tokens: 900, completion_tokens: 0 } });
  const capped = a.exceeded();
  // 換一個行程（＝重啟）：同一個 DID、同一天，用量不該歸零。
  const b = mk({ spend: { dailyTokenCap: 1000, usdPerMTokens: { in: 1, out: 2 } } });
  const afterRestart = b.status();
  // 沒有價目表：美金上限不生效，而且要說出來。
  let said = '';
  const c = spendLib.create({ did: 'did:demo:acct2', policy: { spend: { dailyUsdCap: 10 } },
                              root, log: (m) => { said += m + '\n'; } });
  c.announce();
  const cStatus = c.status();
  return { n1, n2, before, capped, afterRestart, said, cStatus, lines: lines() };
}

// --- 第二部分：上限真的擋住出價（起一整個小市場）---
function agentCfg(o) {
  return { AGENT_CONFIG: JSON.stringify({ hubPort: PORT, ...o }) };
}
function spawnProc(file, env, tag) {
  const p = spawn(process.execPath, [path.join(__dirname, file)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const box = { text: '', child: p };
  const grab = (d) => { box.text += d.toString(); };
  p.stdout.on('data', grab);
  p.stderr.on('data', grab);
  return box;
}

async function market({ cap, preload }) {
  const dir = path.join(ROOT, `mkt-${cap}`);
  fs.mkdirSync(path.join(dir, 'out', 'spend'), { recursive: true });
  if (preload) {
    // 「今天已經花掉這麼多了」——用檔案表達，因為那正是它跨重啟的方式。
    fs.writeFileSync(
      path.join(dir, 'out', 'spend', `${PROVIDER_DID.replace(/[^\w-]/g, '_')}.json`),
      JSON.stringify({ day: new Date().toISOString().slice(0, 10),
                       tokens_in: preload, tokens_out: 0, usd: 0, tasks: 3,
                       estimated_tasks: 0 }));
  }
  const procs = [];
  const hub = spawnProc('hub.js', { HUB_PORT: String(PORT), HUB_BEACON: '0',
    HUB_AGE_RAMP_MS: '1', HUB_DUMP_PATH: path.join(dir, 'ledger.json') });
  procs.push(hub);
  procs.push(spawnProc('fake-provider.js', { FAKE_PORT: String(FAKE_PORT), FAKE_KEY: KEY }));
  await sleep(900);
  for (const v of ['V1', 'V2', 'V3']) procs.push(spawnProc('verifier.js', agentCfg({ name: v })));
  await sleep(300);
  // 賣方：預算上限就是這次的變數。AMCN_SPEND_ROOT 讓它把用量寫在這個情境自己
  // 的目錄裡，而不是碰到這台機器真正的紀錄。
  const seller = spawnProc('agent.js', {
    ...agentCfg({
      name: 'seller', seed: PROVIDER_SEED,
      adapter: { baseUrl: `http://127.0.0.1:${FAKE_PORT}`,
                 key: { env: 'SPEND_KEY', service: 'amcn-demo-spend' },
                 terms: { attested: true, note: 'demo upstream is fake-provider.js' } },
      provide: { afterMs: 0, pricePerUnit: 1.0 },
      policy: { spend: { dailyTokenCap: cap, noticePath: 'out/owner-notices.jsonl' } },
    }),
    SPEND_KEY: KEY, AMCN_SPEND_ROOT: dir,
  });
  procs.push(seller);
  // 買方：一個任務就夠。
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'buyer', adapter: null, provide: null,
    posts: [{ atMs: 1200, units: 5, maxPriceCC: 8, payload: 'spend gate task',
              acceptance: 'dsl-local', asserts: [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }] }],
  })));
  // 成交與否由 **Hub** 說，而不是由買方的字串說——「有沒有進帳」是帳的事實。
  const settled = await waitFor(() => /SETTLED/.test(hub.text), 12000);
  await sleep(500);
  const out = { settled: !!settled, sellerText: seller.text };
  procs.forEach((p) => { try { p.child.kill(); } catch { /* gone */ } });
  await sleep(400);
  return out;
}

// 第二種上游形狀（#101）：Anthropic 的 Messages API。驗的是三件會安靜出錯的
// 事——認證頭（`x-api-key`＋`anthropic-version`，不是 Bearer）、回應解析
// （`content[]` 不是 `choices[]`）、以及 **usage 的欄位對映**
// （`input_tokens`／`output_tokens` → prompt／completion）。最後那一項寫錯的
// 症狀最壞：賣得出去、但花費上限拿不到數字，於是 #94 變成裝飾。
async function anthropicShape() {
  const port = PORT + 30;
  const fake = spawnProc('fake-provider.js',
    { FAKE_PORT: String(port), FAKE_KEY: KEY });
  await sleep(600);
  const adapter = require('./adapter');
  const out = await adapter.complete({
    api: 'anthropic', baseUrl: `http://127.0.0.1:${port}`,
    model: 'claude-opus-5', apiKey: KEY, maxTokens: 256,
    terms: { attested: true }, attribution: 'user',
  }, 'anthropic shape probe', { endUser: 'did:demo:someone', contractId: 'c-x' });
  const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  fake.child.kill();
  return { out, stats };
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const acct = accounting();
  const anth = await anthropicShape();
  console.log(`\n-- 帳目規則 --\n  真值：${acct.n1.tokens_total} tokens、US$${acct.n1.usd}` +
    `｜估算：${acct.n2.tokens_total} tokens（estimated=${acct.n2.estimated}）\n`);

  // 有預算 → 會成交；今天已經花超 → 不出價。同一個任務、同一個賣方。
  const rich = await market({ cap: 2000000, preload: 0 });
  const broke = await market({ cap: 1000, preload: 5000 });

  console.log('\n== #94 token 計量、上限與回報 驗收檢查 ==');

  check('供應商回了 usage 就記真值（不是用字數估的）',
    acct.n1.tokens_in === 100 && acct.n1.tokens_out === 50 && acct.n1.estimated === false,
    `in ${acct.n1.tokens_in}／out ${acct.n1.tokens_out}，estimated=${acct.n1.estimated}`);

  check('供應商沒回 usage 時仍然計入，但標成估計值',
    acct.n2.estimated === true && acct.n2.tokens_in === 100 && acct.n2.tokens_out === 50,
    `in ${acct.n2.tokens_in}／out ${acct.n2.tokens_out}（4 字元≈1 token），estimated=true`);

  check('有價目表就算得出錢（in/out 分開計價）',
    Math.abs(acct.n1.usd - (100 * 1 + 50 * 2) / 1e6) < 1e-12,
    `US$${acct.n1.usd}（100×$1 + 50×$2 每百萬）`);

  check('沒有價目表時**明說美金上限不生效**，而不是假裝有人在守',
    /美金上限不生效/.test(acct.said) && acct.cStatus.priced === false &&
    acct.cStatus.usd_cap === null,
    (acct.said.match(/美金上限不生效[^；]*/) || [''])[0].slice(0, 40));

  check('主人拿到的通知是機器可讀的，且帶「還剩多少／大概還能接幾筆」',
    acct.lines.length >= 2 && acct.lines[0].kind === 'task_cost' &&
    acct.lines[0].remaining.tokens === 850 &&
    typeof acct.lines[0].remaining.approx_tasks === 'number',
    `${acct.lines.length} 行 JSON，第一行 remaining.tokens=${acct.lines[0]?.remaining?.tokens}`);

  check('超過上限就回報是哪一個上限綁住的', !!acct.capped && acct.capped.cap === 'tokens',
    acct.capped ? `${acct.capped.cap} ${acct.capped.used}/${acct.capped.limit}` : '沒有擋');

  check('用量跨重啟不歸零（否則「重啟一下」就是繞過上限的辦法）',
    acct.afterRestart.tokens_in === acct.before.tokens_in + 900 &&
    !!acct.afterRestart.exceeded,
    `重開後 in=${acct.afterRestart.tokens_in}、仍被擋=${!!acct.afterRestart.exceeded}`);

  check('正對照：有預算時同一個任務會成交', rich.settled,
    rich.settled ? '成交' : '沒成交（那這支閘門的負對照就沒有意義了）');

  check('負對照：今天的 token 用完就**不出價**（不是接了單再交不出來）',
    !broke.settled && /停止出價/.test(broke.sellerText),
    !broke.settled
      ? (broke.sellerText.match(/今日.*停止出價[^，]*/) || [''])[0].slice(0, 60)
      : '竟然成交了');

  check('每筆結算後主人真的被告知（log 一行、給人看的那一份）',
    /\[owner\] 這筆 .* 用掉 .* tokens/.test(rich.sellerText),
    (rich.sellerText.match(/\[owner\] 這筆[^\n]*/) || [''])[0].slice(0, 90));

  check('第二種上游形狀（Anthropic 原生）：回應解析得出內容',
    !!anth.out && typeof anth.out.content === 'string' && anth.out.content.length > 0,
    `content ${(anth.out.content || '').slice(0, 16)}…（content[] 不是 choices[]）`);

  check('usage 的欄位對映正確（input/output → prompt/completion，否則上限變裝飾）',
    !!anth.out.usage && anth.out.usage.prompt_tokens > 0 &&
    anth.out.usage.completion_tokens > 0,
    JSON.stringify(anth.out.usage));

  check('第三方流量在這一家也具名（metadata.user_id，#67）',
    anth.stats.users.includes('did:demo:someone') && anth.stats.unattributed === 0,
    `${anth.stats.users.length} 筆具名、${anth.stats.unattributed} 筆匿名`);

  fs.rmSync(ROOT, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
