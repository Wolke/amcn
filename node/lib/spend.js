// 替別人做事會花掉**自己的** token，而那是真的錢（P-10：成本與法遵留在節點
// 主人那一側）。在這個檔案存在之前，原型對這件事一無所知：`adapter.js` 拿到
// 回應只讀 `choices[0].message.content`，**`usage` 整個丟掉**，而唯一的上限是
// `policy.quota` 的「unit」——一個與 token 和美金都沒有換算的抽象量。所以
// 「一個 agent 會不會把主人的額度賣光」這件事，先前連量都沒有量。
//
// 三個責任，刻意分開：
//   1. **計量**：能拿到 `usage` 就用真的；拿不到就估，而估出來的東西**一律
//      標成估計值**——把估計值混進帳目裡當事實，是這個專案反覆記過的錯。
//   2. **上限**：今天還能花多少。上限在本機，因為供應商那一側靠不住：
//      `docs/evaluation/key-lending-verification.md` 查過，OpenAI 的硬上限只在
//      控制台（Admin API 沒有那個開關）、Anthropic 的 `spend_limits` 只給
//      Enterprise。所以「本機預算」不是方便，是唯一可強制執行的那一層。
//   3. **回報**：每筆做完就告訴主人用掉多少、還剩多少。人讀一行 log，機器讀
//      一行 JSON（`out/owner-notices.jsonl`），因為主人通常是另一個 agent。
//
// 上限用到就**停止出價**——與 #21（不能執行者不得出價）、#22（沒有餘量不得
// 出價）同一道守門，而不是新開一條路。先接單再因為沒預算而交不出來，對網路
// 的傷害比不出價大得多（那是違約，會吃掉別人的 CC 與保險池）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  // 兩個上限同時生效，先到的那個綁住。token 上限一定有預設值，因為它**不需要
  // 價目表就能執行**；美金上限要有 usdPerMTokens 才算得出來，沒有就不生效
  // ——而那件事會被說出來，不會假裝有人在守。
  dailyTokenCap: 2000000,
  dailyUsdCap: 10,
  usdPerMTokens: null,          // { in: 0.15, out: 0.60 } 之類，按你的供應商填
  noticePath: 'out/owner-notices.jsonl',
};

const today = () => new Date().toISOString().slice(0, 10);   // UTC 日界

// 沒有 usage 時的估法。4 字元 ≈ 1 token 是英文的粗略比例，中文會低估——所以
// 它只能當下限，且一律標 estimated。
const estimate = (s) => Math.ceil(String(s || '').length / 4);

function create({ did, policy = {},
                  // AMCN_SPEND_ROOT：閘門與故障情境把用量寫在自己的目錄裡，
                  // 否則它們會讀到、也會污染這台機器真正的預算紀錄。
                  root = process.env.AMCN_SPEND_ROOT || path.join(__dirname, '..'),
                  log = console.log } = {}) {
  const cfg = { ...DEFAULTS, ...(policy.spend || {}) };
  // 檔名不留冒號：Windows 不接受它，而這個專案的試點有 Windows 機器（#32 的
  // 同一類問題——在一個平台上跑得過不代表它跨平台）。
  const file = path.join(root, 'out', 'spend',
    `${(did || 'anon').replace(/[^\w-]/g, '_')}.json`);
  let state = { day: today(), tokens_in: 0, tokens_out: 0, usd: 0, tasks: 0,
                estimated_tasks: 0 };
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 跨重啟不歸零：否則「重啟一下」就是繞過上限的辦法。換日才歸零。
    if (kept && kept.day === state.day) state = { ...state, ...kept };
  } catch { /* 第一次 */ }

  const priced = () => !!(cfg.usdPerMTokens &&
    (cfg.usdPerMTokens.in > 0 || cfg.usdPerMTokens.out > 0));

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
    } catch (e) {
      log(`[spend] 警告：預算紀錄寫不下來（${e.message}）——重啟後今天的用量會歸零`);
    }
  }

  function rollover() {
    if (state.day === today()) return;
    state = { day: today(), tokens_in: 0, tokens_out: 0, usd: 0, tasks: 0,
              estimated_tasks: 0 };
    persist();
  }

  const totalTokens = () => state.tokens_in + state.tokens_out;

  // 超了就回傳「哪一個上限」，沒超回 null。呼叫端據此拒絕出價。
  function exceeded() {
    rollover();
    if (cfg.dailyTokenCap && totalTokens() >= cfg.dailyTokenCap) {
      return { cap: 'tokens', used: totalTokens(), limit: cfg.dailyTokenCap };
    }
    if (priced() && cfg.dailyUsdCap && state.usd >= cfg.dailyUsdCap) {
      return { cap: 'usd', used: +state.usd.toFixed(4), limit: cfg.dailyUsdCap };
    }
    return null;
  }

  function usdOf(tin, tout) {
    if (!priced()) return null;
    const p = cfg.usdPerMTokens;
    return ((tin * (p.in || 0)) + (tout * (p.out || 0))) / 1e6;
  }

  // usage 是供應商回的那個物件（可能沒有）。prompt／output 只在估算時用到。
  function record({ contractId, usage, prompt, output, counterparty = null,
                    priceCC = null }) {
    rollover();
    const real = usage && (usage.prompt_tokens != null || usage.completion_tokens != null);
    const tin = real ? (usage.prompt_tokens || 0) : estimate(prompt);
    const tout = real ? (usage.completion_tokens || 0) : estimate(output);
    const usd = usdOf(tin, tout);
    state.tokens_in += tin;
    state.tokens_out += tout;
    if (usd != null) state.usd += usd;
    state.tasks += 1;
    if (!real) state.estimated_tasks += 1;
    persist();

    const capTokens = cfg.dailyTokenCap || 0;
    const leftTokens = capTokens ? Math.max(0, capTokens - totalTokens()) : null;
    const leftUsd = priced() && cfg.dailyUsdCap
      ? Math.max(0, cfg.dailyUsdCap - state.usd) : null;
    // 「大概還能接幾筆」比「還剩多少 token」好用，而它只是一個除法——所以
    // 標明它是用今天的平均算的，換一種任務就不準。
    const avg = totalTokens() / Math.max(1, state.tasks);
    const tasksLeft = leftTokens != null && avg > 0
      ? Math.floor(leftTokens / avg) : null;

    const notice = {
      at: new Date().toISOString(), kind: 'task_cost',
      contract_id: contractId || null, counterparty, price_cc: priceCC,
      tokens_in: tin, tokens_out: tout, tokens_total: tin + tout,
      usd: usd == null ? null : +usd.toFixed(6),
      estimated: !real,
      today: { tokens: totalTokens(), tokens_cap: capTokens || null,
               usd: priced() ? +state.usd.toFixed(6) : null,
               usd_cap: priced() ? cfg.dailyUsdCap : null,
               tasks: state.tasks },
      remaining: { tokens: leftTokens, usd: leftUsd == null ? null : +leftUsd.toFixed(6),
                   approx_tasks: tasksLeft },
    };
    try {
      const p = path.join(root, cfg.noticePath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, JSON.stringify(notice) + '\n');
    } catch (e) {
      log(`[spend] 警告：通知寫不下來（${e.message}）`);
    }

    const money = usd == null ? '（沒設 usdPerMTokens，算不出錢）'
      : `≈ US$${usd.toFixed(4)}`;
    const left = [
      leftTokens != null ? `token 還剩 ${leftTokens.toLocaleString()}／${capTokens.toLocaleString()}` : null,
      leftUsd != null ? `今天還剩 US$${leftUsd.toFixed(2)}／${cfg.dailyUsdCap}` : null,
      tasksLeft != null ? `大概還能接 ${tasksLeft} 筆（按今天平均）` : null,
    ].filter(Boolean).join('、');
    log(`[owner] 這筆 ${contractId || '—'} 用掉 ${(tin + tout).toLocaleString()} tokens` +
        `（in ${tin.toLocaleString()}／out ${tout.toLocaleString()}）${money}` +
        `${real ? '' : '【估計值：供應商沒回 usage】'}；${left}`);
    return notice;
  }

  function status() {
    rollover();
    return {
      day: state.day, tasks: state.tasks,
      tokens_in: state.tokens_in, tokens_out: state.tokens_out,
      tokens_cap: cfg.dailyTokenCap || null,
      usd: priced() ? +state.usd.toFixed(6) : null,
      usd_cap: priced() ? cfg.dailyUsdCap : null,
      priced: priced(), estimated_tasks: state.estimated_tasks,
      exceeded: exceeded(),
    };
  }

  // 啟動時就把「什麼在守、什麼沒在守」講清楚。一個以為有美金上限、其實只有
  // token 上限在擋的主人，比一個知道自己沒有上限的主人危險。
  function announce() {
    log(`[spend] 今日上限：token ${(cfg.dailyTokenCap || 0).toLocaleString()}` +
      (priced()
        ? `、美金 US$${cfg.dailyUsdCap}（in $${cfg.usdPerMTokens.in}／out $${cfg.usdPerMTokens.out} 每百萬 token）`
        : `；**美金上限不生效**——沒有設 policy.spend.usdPerMTokens，算不出錢，所以只有 token 上限在守`) +
      `（已用 ${totalTokens().toLocaleString()} tokens／${state.tasks} 筆，${state.day}）`);
  }

  return { record, exceeded, status, announce, cfg, file };
}

module.exports = { create, DEFAULTS, estimate };
