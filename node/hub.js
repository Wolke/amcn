// Coordination Hub — the "first sequencer, not a trust root" (proposal B).
//
// This round adds the ledger-integrity and anti-refusal layer:
// - per-account hash chains over settled postings + hub-signed checkpoints
//   after every settlement → tamper-evident history, rebuildable by anyone
// - verifier registry; verifier panels are fixed in the dual-signed
//   contract (FR-041)
// - forced settlement (threat T-05, "requester refuses to pay"): a
//   provider holding {dual-signed contract, requester's pre_authorization,
//   2-of-3 PASS attestations} can settle without the requester's receipt
//   signature — the pre_auth IS the requester's standing signature.
//
// The hub still cannot move balances on its own: every path requires
// either two receipt signatures or contract+pre_auth+quorum evidence,
// all verifiable offline from the export.
'use strict';
const { verify, sha256, canon, PROTOCOL_VERSION,
        genIdentity, identityFromSeed, sign } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();
require('./lib/log').install();
const eeff = require('./lib/eeff');
const discovery = require('./lib/discovery');
const panel = require('./lib/panel');
const rebuildLib = require('./lib/rebuild');

const PORT = Number(process.env.HUB_PORT || 47180);
const BIND = process.env.HUB_BIND || '127.0.0.1'; // 0.0.0.0 for LAN pilots
const TREASURY = 'protocol:treasury';
const INSURANCE = 'protocol:insurance';
// §4 #28: a verifier's stake has to be real CC held somewhere, or "slashing"
// can only ever take what the verifier happened to have earned — which
// coupled deterrence to the fee rate, an implementation artifact rather than
// a design. proposal-C assumes a verifier posts a deposit up front, but a
// verifier here starts at 0 CC with no credit line, so pay-to-play is not
// available. Instead a share of each verification fee is escrowed until the
// target is met: a new verifier has little at risk and earns little, and
// works its way to full standing — the same shape as the credit line.
const STAKE = 'protocol:stake';
// 抵押品託管（#65）。與 protocol:stake 分開：押注是 verifier 的履約保證、
// 由收入累積；抵押品是交易方自願鎖入以換取額度上限，可在無負債時取回。
const COLLATERAL = 'protocol:collateral';
// 壞帳瀑布的最後一層（模擬器的 protocol:loss）。保險池不夠時剩下的落在這裡，
// 它就是「網路真正吃掉的損失」，與保險池已收的費用分開才看得出保險夠不夠用。
const LOSS = 'protocol:loss';
// 離線多久且仍為負餘額就視為違約。預設 14 天，與模擬器的 write-off 條件同；
// demo 與情境會壓縮它，否則沒有任何測試跑得到這條路徑。
const DEFAULT_AFTER_MS = Number(process.env.HUB_DEFAULT_AFTER_MS || 14 * 24 * 3600 * 1000);
// 回流路徑（登記簿 #71）。protocol 帳戶只進不出，所以它們持有的每一塊 CC
// 都是永久借出去的信用——40 分鐘 soak 的結局就是三人全部貼牆、122.53 CC
// 卡在 protocol 帳戶裡。§2.2「Treasury 啟動」把回流列為設計的一部分。
//
// 兩個來源、兩種規則，因為兩個帳戶的性質不同：
//   保險池是**準備金**，所以目標綁曝險（未償負餘額總額）× 預期損失率。
//     0.06 來自 #65 的壞帳率量測（0.08–2.11%）乘 3 倍安全係數。
//   Treasury 是**收入**，所以只保留一筆準備金供金絲雀與 L_boot 補貼使用，
//     其餘退還——把 Treasury 退到零會讓 §2.2 設計的另外兩條支出路徑停擺。
//
// 為什麼這不需要預簽 Grant：§2.2 對 demurrage 那類非雙簽分錄要求引用 Owner
// 預簽的費率表，因為那種分錄會**拿走**價值。退費只會 credit 非 protocol
// 帳戶，方向相反，收款方無從受害——需要守的是不變式與準備金充足性，不是同意。
// 明確的總開關。第一版用 `HUB_INSURANCE_TARGET_FRAC=0` 當「關閉」，而那個值
// 的語意是「準備金目標為零」——也就是**把保險池全部退還**，比預設更激進。
// 於是 #71 的對照組跑了 23 分鐘才發現它根本不是對照組。0 是一個合法的政策，
// 不能同時當關閉的意思。
const REBATE_ON = process.env.HUB_REBATE !== '0';
// 對抗腳架（#69c 的完整攻擊面）：對一半的節點供應分叉的 checkpoint。
const EQUIVOCATE = process.env.HUB_EQUIVOCATE === '1';
// 對抗腳架（#75）：cp 內容全部真實，只有簽章不是這個 Hub 簽的。模擬線上注入
// 者（信封 metadata 無加密，#44）或冒充的排序器。註冊回應裡的 `hub_pub` 仍是
// 真鑰，所以這一案問的就是節點到底有沒有驗章——而不是它能不能被騙到別的 Hub。
//
// 分兩檔，因為兩檔的後果完全不同：`broadcast`（`1` 亦同）只偽造推播，而
// `checkpoint_request` 的回答仍用真章——實測那條拉取路徑（#41 為了稀疏儲存
// 而加的）會自己把節點救回來，代價只是延遲。`all` 才是一致說謊的排序器：
// 兩條路都偽造，於是驗章的節點什麼都不採信，種子永遠等不到（後果同 #72）。
const CP_FORGE = process.env.HUB_CP_FORGE === '1' ? 'broadcast'
  : (process.env.HUB_CP_FORGE || '');
const forgeId = CP_FORGE ? identityFromSeed('cp-forge-impostor') : null;
// path 是 'broadcast' 或 'answer'（checkpoint_request 的回覆）。
const cpSig = (cp, realSig, path) =>
  (CP_FORGE === 'all' || (CP_FORGE && path === 'broadcast'))
    ? sign(forgeId.privateKey, cp) : realSig;
const INSURANCE_TARGET_FRAC = Number(
  process.env.HUB_INSURANCE_TARGET_FRAC != null
    ? process.env.HUB_INSURANCE_TARGET_FRAC : 0.06);
const TREASURY_RESERVE_CC = Number(process.env.HUB_TREASURY_RESERVE_CC || 5);
const REBATE_MS = Number(process.env.HUB_REBATE_MS || 60000);
const REBATE_MIN_CC = Number(process.env.HUB_REBATE_MIN_CC || 0.05);
const DEFAULT_SWEEP_MS = Number(process.env.HUB_DEFAULT_SWEEP_MS || 60000);
// FR-083 / §20-9. `market` is the only class that counts as real trade;
// `test` is a rehearsal, `subsidy` is Treasury-funded (canary decoys,
// bootstrap grants) and `related-party` is trade between identities the
// requester itself declares as related.
const TX_CLASSES = new Set(['market', 'test', 'subsidy', 'related-party']);
// Clocks on different machines disagree; the beacon already tolerates 60s
// (lib/discovery.js) and expiry checks use the same allowance. Refusing a
// settlement because the requester's clock is a minute fast would be a worse
// failure than accepting a slightly stale authorisation.
const CLOCK_SKEW_MS = Number(process.env.HUB_CLOCK_SKEW_MS || 60000);
// An expiry the hub can check: absent is still accepted for now (a receipt
// from a client that predates the field), but a *present* one is enforced.
// Making it mandatory is a separate step from making it work.
function expired(obj, what) {
  if (!obj || typeof obj.expires_at !== 'number') return null;
  const over = Date.now() - (obj.expires_at + CLOCK_SKEW_MS);
  return over > 0 ? `${what} expired ${Math.round(over / 1000)}s ago` : null;
}
const STAKE_TARGET_CC = Number(process.env.HUB_STAKE_TARGET_CC || 5);
const STAKE_ESCROW_FRAC = Number(process.env.HUB_STAKE_ESCROW_FRAC || 0.5);
// proposal-C §7: 「Treasury 定期以隨機身分發布已知答案任務」. The issuer is a
// separate agent, not the hub: having the hub originate tasks would make the
// sequencer a market participant, which §2.2's "第一個排序器不是信任根" is
// specifically trying to avoid. The cost is a privileged DID — one identity
// whose signed canary reports the hub acts on, and which spends Treasury
// funds. That privilege is why it is operator-configured and named in the
// startup log rather than inferred.
const CANARY_DID = process.env.HUB_CANARY_DID || null;
// §4 #27/#30: punish a pattern, not a single unlucky verdict, and require an
// absolute count so a small sample cannot cross a rate threshold by luck.
const SLASH_FRAC = Number(process.env.HUB_SLASH_FRAC || 0.10);
const SLASH_THRESHOLD = Number(process.env.HUB_SLASH_THRESHOLD || 0.25);
const SLASH_MIN_SAMPLES = Number(process.env.HUB_SLASH_MIN_SAMPLES || 5);
const SLASH_MIN_FAILURES = Number(process.env.HUB_SLASH_MIN_FAILURES || 3);
// §4 #38：離線多久才算「丟掉身分」而不是「暫時斷線」。預設同違約門檻（14
// 天），因為兩件事問的是同一個問題——這個 DID 還會回來嗎。
const STAKE_FORFEIT_AFTER_MS = Number(
  process.env.HUB_STAKE_FORFEIT_AFTER_MS || DEFAULT_AFTER_MS);
// §4 #41: how often an *unchanged* checkpoint is still kept, as a heartbeat
// in the audit trail. Root changes are always kept; idle ticks between them
// are not. Measured on the pilot: 1 hour idle produced 718 KB of dump made
// almost entirely of 3,246 identical-root checkpoints, rewritten in full on
// every auto-dump.
const CHECKPOINT_KEEP_MS = Number(process.env.HUB_CHECKPOINT_KEEP_MS || 60000);

// §4 #14: hubPin only meant anything for one hub lifetime, because a fresh
// keypair every start changed the identity agents were told to pin. With
// HUB_SEED the hub keeps its DID across restarts, which is what makes
// rotation a real operation: move the hub, keep the seed, and every pinned
// agent follows it to the new address.
const hubId = process.env.HUB_SEED
  ? identityFromSeed(process.env.HUB_SEED)
  : genIdentity(); // signs checkpoints

// 接手憑證（#95）。兩個來源都要帶：
//   HUB_SUCCESSORS        我事先授權誰可以接手我（趁自己還活著時簽）
//   HUB_SUCCESSION_CERTS  授權「我」的那條鏈（我自己就是接手上來的）
// 它們隨**位址記錄**出去（client 憑它跟過來），也隨**匯出**出去（第三方憑它
// 才驗得過前任簽的 checkpoint——那一條是閘門抓到的，不是設計時想到的）。
const successionCerts = (() => {
  const su = require('./lib/succession');
  const out = [];
  const inherited = process.env.HUB_SUCCESSION_CERTS;
  if (inherited) {
    try {
      const got = JSON.parse(require('node:fs').readFileSync(inherited, 'utf8'));
      if (Array.isArray(got)) out.push(...got);
    } catch (err) {
      console.error(`[hub] 讀不到接手憑證 ${inherited}: ${err.message}` +
        '——我會照樣服務，但釘住前任的 client 不會跟過來，' +
        '而前任簽的 checkpoint 會讓這本帳在第三方手上驗不過');
    }
  }
  const names = (process.env.HUB_SUCCESSORS || '').split(',')
    .map((x) => x.trim()).filter(Boolean);
  names.forEach((did, i) => {
    out.push(su.cert(hubId, { successor: did, priority: i + 1,
      note: 'signed while primary was live' }));
  });
  return out;
})();
const settledIds = new Set(); // contract_id idempotency keys
const stakes = new Map();     // verifier did -> CC held in protocol:stake
const collateral = new Map(); // did -> CC locked in protocol:collateral
const writtenOff = new Map();  // did -> CC absorbed by the waterfall
const canaryStats = new Map(); // verifier did -> {seen, failed, slashed_cc}
const canarySeen = new Set();  // canary contract_ids already scored
// 曾經取回押注的 DID（#38）。放在這裡而**不是**放在 agent 記錄上，因為
// `register` 會整個換掉那筆記錄——旗標掛在上面的話，斷線重連就把它清乾淨了，
// 於是「取回押注 → 重新註冊 → 帶著乾淨的受測紀錄回到 pool，但身上零押注」
// 成為一條免費偷懶的路（比 #38 原本那條更好，因為連換身分都不必）。
// 這個集合可由事件流重建（見匯入處），所以它不是新的信任狀態。
const stakeReleased = new Set();
// #90 入門採購：Treasury 向**還沒有任何賺得紀錄**的身分購買**答案已知的工作**。
//
// 它是「保證金」那個問題的答案，而不是保證金的變體：保證金要求新人先有錢
// （新身分餘額是 0，`collateral_post` 因此拒絕它——那正是 #90 的內容），
// 擔保人要求新人先有關係（而 agent 之間沒有社會網絡，Owner 當場否決）。
// 入門採購只要求新人**先做事**，於是 Sybil 的經濟反轉：N 個身分要拿 N 份 CC
// 就得交付 N 份真實工作，而那不是攻擊，那是供給。模擬器量到每身分白拿由
// 17.49 CC 變 0.00（GATE-0 候選組 8/8，但兩個限制見登記簿 #90）。
//
// **「答案已知」是這件事成立的硬條件**：模擬器裡 Treasury 只是消耗掉對方的
// 產能，而真實版本若買的是做工給你看的東西，攻擊者就是每身分白拿一筆、
// 只換了記帳名目。所以這裡只接受 `sha256_eq` 這類**確定性**斷言——發樁者
// 自己算得出正確答案，因此「有沒有真的做」是可判的，而不是靠信任。
const ONBOARD_DID = process.env.HUB_ONBOARD_DID || null;
const ONBOARD_CAP_CC = Number(process.env.HUB_ONBOARD_CAP_CC || 20);
const ONBOARD_TOTAL_CC = Number(process.env.HUB_ONBOARD_TOTAL_CC || 2000);
// 要**連續**通過幾次才付一次款（#90）。
//
// 「答案已知」只讓單一次交付判得出來；它擋不住「一直試、矇中一次就拿錢」。
// 模擬器量到的形狀：連續 1 次時交假東西的攻擊者每身分仍拿 5.52 CC、連續 2 次
// 掉到 1.33、連續 3 次是 **0.00**，而誠實新人只從 196 人掉到 187 人（每人
// 19.2 → 16.1 CC）。那 9 個沒領到的是品質低到連續三次都過不了的節點，
// 而「連續交出三份通過驗收的工作」正是「證明你做得出來」本身。
//
// 為什麼不是「失敗幾次就出局」：那條實測沒有用——一次出局讓攻擊者拿 4.89 CC
// （比三次出局的 5.52 只低一點），卻讓 200 人裡 26 個誠實新人進不了門。
// 失敗上限限制的是「失敗幾次」，限制不了「矇中幾次」。
const ONBOARD_STREAK = Number(process.env.HUB_ONBOARD_STREAK || 3);
const onboardStreak = new Map();  // did -> 目前連續通過次數
const onboarded = new Map();   // did -> 已領的 CC
// 「曾經收到過 CC」的身分。入門採購的合格條件用這個，而**不是** E_eff＝0：
// verifier 的驗證費不進 `stats.earnedBy`（那張表只記結算的買賣雙方），所以用
// E_eff 判斷會讓每一個 verifier 都永遠算「新人」——閘門第一次跑就是這樣露出來的
// （負對照三本來該以「已有紀錄」被拒，卻是以「面板不足」被拒）。
// 可由事件流重建（見匯入處），所以它不是新的信任狀態。
const inflowSeen = new Set();
const onboardSeen = new Set(); // 已計入的 contract_id
let onboardSpent = 0;
// #87 上線前的濫用預算。區網裡這些都不需要；公網上少了它們，任何人都能
// 用連線數與註冊數把 Hub 的記憶體吃光，而且不必先證明自己是誰。
const MAX_CONNS = Number(process.env.HUB_MAX_CONNS || 200);
// 每 IP 上限預設放寬到 50，而且 loopback 完全不算——第一版設 10 並且對本機
// 一視同仁，結果**自己的 demo 先死**：`demo-forfeit` 在一台機器上有 6 個
// verifier、3 個 agent、canary 加上取帳的連線，實測 14 條裡被拒 12 條。
//
// 而那不只是 demo 的問題：**NAT 會把一整個家庭或辦公室塌縮成同一個位址**，
// 所以一個低的每 IP 上限擋掉的是合法參與者，不是攻擊者。真正的後盾是全域
// 上限（同時也限制記憶體與 fd），每 IP 只是讓單一來源不要一口氣吃掉全部。
const MAX_CONNS_PER_IP = Number(process.env.HUB_MAX_CONNS_PER_IP || 50);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
// 註冊會建立永久狀態（帳戶、統計、餘額），所以它比別的訊息貴。
const MAX_REGISTER_PER_MIN = Number(process.env.HUB_MAX_REGISTER_PER_MIN || 10);
// 身分是免費的（#50），所以帳戶總量要有上限，否則註冊洪水會把帳本灌成垃圾。
const MAX_AGENTS = Number(process.env.HUB_MAX_AGENTS || 500);
const conns = new Set();
const ipConns = new Map();     // ip -> 連線數
const regWindow = new Map();   // ip -> [timestamps]
// 匯出對陌生人是開放的（那是 §20-4 的公共財），但它是最貴的操作：整本帳的
// 序列化。所以它有自己的每 IP 節流，而不是靠未註冊訊息額度去擋——後者會把
// 分頁取回的大帳本（十幾頁）誤判成濫用。
const MAX_EXPORT_PER_MIN = Number(process.env.HUB_MAX_EXPORT_PER_MIN || 30);
const exportWindow = new Map(); // ip -> [timestamps]

// Post a balanced set that is not a settlement (escrow, slashing). Same
// conservation and hash-chain rules; kept separate so `receipts` stays the
// list of things two parties signed.
function applyPostings(kind, ref, postings) {
  // 入門採購本身不算「曾經收到 CC」，否則第一筆就把自己的資格取消掉。
  if (kind !== 'onboarding') {
    for (const p of postings) {
      if (p.amount_cc > 1e-9 && !p.account.startsWith('protocol:')) {
        inflowSeen.add(p.account);
      }
    }
  }
  const total = postings.reduce((t, p) => t + p.amount_cc, 0);
  if (Math.abs(total) > 1e-9) {
    console.error(`[hub] refusing ${kind} ${ref}: postings sum ${total} != 0`);
    return false;
  }
  const idx = receipts.length;
  for (const p of postings) {
    balances.set(p.account, bal(p.account) + p.amount_cc);
    chainAppend(p.account, idx, p.amount_cc);
  }
  // Internal accounting movements are not trade at all; labelling them keeps
  // them out of every market figure without anyone having to remember to
  // filter by `kind` at the call site.
  events.push({ kind, ref, postings, receipt_idx: idx,
                tx_class: kind === 'canary' ? 'subsidy' : 'protocol' });
  makeCheckpoint();
  return true;
}
const agents = new Map();    // did -> {pub, boxPub, chan, stats, role}
const balances = new Map();
const outVolume = new Map();  // did -> 本退費週期內的支出額（#71）
const receipts = [];         // {kind:'dual'|'forced', receipt, sigs, evidence?}
const chains = new Map();    // account -> [{seq,prev_hash,receipt_idx,delta_cc,balance_after,hash}]
// Sparse: root changes plus a CHECKPOINT_KEEP_MS heartbeat. cpSeq is the
// authoritative sequence — it advances on every mint whether or not the entry
// is stored, because `panel_seed_cp` pins a number in this sequence.
const checkpoints = [];
let cpSeq = 0;
let cpKeptAt = 0;
// Every posting set applied, in order. §2.2 promises 「全部狀態可由公開簽署
// 事件重建」, and receipts alone cannot deliver that: stake escrow, slashing
// and canary payouts also move CC, and slashing/canary are not derivable
// from receipts at all. The simulator's ledger.py has always kept a full
// event list; this side only had receipts, so an export could not be
// rebuilt. W10's export->rebuild is what surfaced it.
const events = [];          // {kind, ref, postings, receipt_idx?}
// Stats replayed from an import, adopted when the DID registers.
const importedStats = new Map();
// Every public key ever seen, not just the ones currently connected. The
// export used to derive this from the live `agents` map, so a dump taken
// while nobody was connected carried no keys — and since the auto-dump
// overwrites the same file every couple of seconds, one such moment
// replaced a good backup with one that cannot verify a single receipt.
// HUB_IMPORT then refuses to start and the ledger is unrecoverable. #17 added
// the auto-dump so recovery would not depend on a person; this is the part
// that made it able to poison itself.
const pubkeys = new Map();
// When each DID first registered, so the bootstrap line can ramp the way the
// simulator's does (E5). Persisted with the ledger: an identity that survives
// a restart must not have its age reset, or #17's whole point is lost.
const joinedAt = new Map();
// 30 days in production; harnesses compress it so a demo is not stuck at half
// the starter line for its entire few seconds of life.
// 定義搬到 lib/eeff.js，與 rebuild 共用——兩邊各算各的正是 #82 的成因。
const AGE_RAMP_MS = eeff.AGE_RAMP_MS;
const ageFactorOf = (did) => eeff.ageFactor(joinedAt.get(did));
// The full-traffic audit log the NFR-005 plaintext scan reads. Bounded,
// because it is the dominant term in a long run: 20 minutes of the soak
// produced 5.4 MB of it against 1.3 MB of actual ledger, and it used to be
// re-serialised into the disaster dump every couple of seconds. A recent
// window is what the scan needs; the ledger never needed it at all.
const RAW_LOG_MAX_BYTES = Number(process.env.HUB_RAW_LOG_MAX_BYTES || 2 * 1024 * 1024);
// What the hub relays is enough for the market figures: it sees every task
// broadcast, every bid and every award go past.
const market = { tasks: 0, bids: 0, contracts: new Set() };

const rawLog = [];
let rawLogBytes = 0;
function recordRaw(line) {
  rawLog.push(line);
  rawLogBytes += line.length + 1;
  while (rawLogBytes > RAW_LOG_MAX_BYTES && rawLog.length > 1) {
    rawLogBytes -= rawLog.shift().length + 1;
  }
}

const bal = (a) => balances.get(a) || 0;
const statsOf = (did) => agents.get(did)?.stats;
const clOf = (did) =>
  agents.has(did)
    ? eeff.creditLine(did, agents.get(did).stats, statsOf, ageFactorOf(did),
                      collateral.get(did) || 0)
    : 0;

// 角色判斷的唯一入口。舊匯出檔與舊節點只有 `role`，所以缺 `roles` 時退回它
// ——相容規則與 `checkpoint_seq`／`prev_root` 一致（#69）。
const hasRole = (a, r) =>
  !!a && (a.roles ? a.roles.has(r) : a.role === r);

function broadcast(obj, exceptDid) {
  for (const [did, a] of agents) if (did !== exceptDid && a.chan) a.chan.send(obj);
}
// 每個型別裡「handler 會直接解參照、缺了就會拋例外」的欄位。刻意只列這些：
// 多列會變成在錯的層做語意檢查，少列則回到靜默丟棄。
const REQUIRED = {
  register: ['did', 'pub', 'box_pub', 'sig'],
  register_ack: ['did'],
  // task 是廣播，沒有 `to`——第一版把它列成必填，於是所有任務被拒、市場整個
  // 停掉，紅隊連真實收據都拿不到。列必填欄位本身就是一次規格宣告，寫錯的
  // 代價是把合法流量當成畸形流量。
  task: ['task'],
  bid: ['to', 'bid'],
  contract: ['to', 'contract'],
  contract_ack: ['to', 'contract_id'],
  delivery: ['to', 'delivery'],
  delivery_request: ['to', 'contract_id'],
  verify_request: ['to', 'request'],
  attestation: ['to', 'attestation'],
  attestation_commit: ['to', 'commit'],
  reveal_request: ['to', 'contract_id'],
  receipt_half: ['to'],
  receipt: ['receipt', 'sigs'],
  forced_settlement: ['receipt', 'provider_sig', 'evidence'],
  canary_result: ['report', 'sig'],
  onboard_result: ['report', 'sig'],
  checkpoint_request: ['seq'],
  collateral_post: ['did', 'amount_cc', 'sig'],
  collateral_release: ['did', 'amount_cc', 'sig'],
  stake_release: ['did', 'amount_cc', 'sig'],
  fee_quote: ['contract_id', 'requester', 'price'],
};
function missingFields(msg) {
  const need = REQUIRED[msg && msg.type];
  if (!need) return null;
  const missing = need.filter((k) => msg[k] === undefined || msg[k] === null);
  if (!missing.length) return null;
  return `${msg.type}: missing required field(s) ` +
    missing.map((k) => `"${k}"`).join(', ');
}

function fail(chan, why, ref) {
  chan.send({ type: 'error', why, ref });
  console.log(`[hub] REJECT ${ref || ''}: ${why}`);
}
function feeTerms(requesterDid, price, panelSize = 0) {
  const fee = +(price * eeff.FEE_RATE).toFixed(4);
  const risk = +(price * eeff.riskRate(agents.get(requesterDid).stats)).toFixed(4);
  // Equal split, and the remainder goes to the first verifier so the postings
  // still sum to zero at 4 decimals.
  const verifierTotal = panelSize
    ? +(price * eeff.VERIFIER_RATE).toFixed(4) : 0;
  const each = panelSize ? +(verifierTotal / panelSize).toFixed(4) : 0;
  const shares = [];
  for (let i = 0; i < panelSize; i++) shares.push(each);
  if (panelSize) {
    shares[0] = +(shares[0] + (verifierTotal - each * panelSize)).toFixed(4);
  }
  return { fee, risk, verifierTotal, verifierShares: shares };
}

// --- hash chain + checkpoints ------------------------------------------
function chainAppend(account, receiptIdx, delta) {
  const chain = chains.get(account) || [];
  // Shared with lib/rebuild.js so an append and a replay cannot disagree.
  chain.push(rebuildLib.chainEntry(account, chain, receiptIdx, delta,
    bal(account), Date.now()));
  chains.set(account, chain);
}
function makeCheckpoint() {
  const heads = {};
  for (const [acct, chain] of chains) heads[acct] = chain.at(-1).hash;
  // prev_root chains the checkpoints to each other (§4 #69). Without it two
  // validly-signed checkpoints at the same seq with different roots are
  // indistinguishable from each other — threat 8's equivocation — and the
  // only way to notice was to be holding the colliding pair. With it, any
  // later checkpoint from the other branch exposes the fork, because its
  // prev_root will not match.
  //
  // It chains over *stored* checkpoints, not minted ones: sparse storage
  // (§4 #41) drops unchanged roots, so a link to a root that was never
  // retained would be unverifiable by the observer who received the export.
  // The chain therefore covers exactly what anyone can actually check.
  const prevEntry = checkpoints.at(-1);
  // `heads` **不進 cp**（#41）。它與 `root` 完全冗餘——root 就是
  // `sha256(canon(heads))`——而實測它佔每個 checkpoint 2496／2782 bytes，
  // 也就是 N=20 四十分鐘那份 18.74MB 匯出裡的 **43.8%**。而且沒有任何
  // 消費端讀它：`demo.js`、`lib/invariants.js`、`lib/rebuild.js` 全都是
  // **自己從 chains 重算 heads** 再跟 root 對照（#78 新增的那條也是），
  // 簽章覆蓋 root 就已經覆蓋了它們。歷史 checkpoint 的 per-account heads
  // 仍可從匯出的 chains 回推（每筆分錄帶 `receipt_idx`，對照
  // `cp.receipts_count` 即得當時的前綴），所以 equivocation 的逐帳戶
  // 取證能力沒有消失，只是要算。
  const cp = {
    seq: cpSeq++,
    root: sha256(canon(heads)),
    receipts_count: receipts.length,
    prev_root: prevEntry ? prevEntry.cp.root : null,
  };
  const entry = { cp, sig: sign(hubId.privateKey, cp) };
  // Store root changes always; store an unchanged one only as a heartbeat
  // (§4 #41). Minting is still unconditional: #24 deadlocked a fresh network
  // when checkpoints only appeared on settlement, and a pinned future seed
  // needs the sequence to keep advancing even in a silent hour.
  const prev = prevEntry;
  const moved = !prev || prev.cp.root !== cp.root ||
    prev.cp.receipts_count !== cp.receipts_count;
  const now = Date.now();
  if (moved || now - cpKeptAt >= CHECKPOINT_KEEP_MS) {
    checkpoints.push(entry);
    cpKeptAt = now;
  }
  // Panels are seeded from a checkpoint that does not exist yet (§4 #6), so
  // every agent needs to learn roots as they are minted — broadcast on every
  // tick, stored or not, or an agent waiting for seed #N never learns that
  // #N has been reached.
  if (EQUIVOCATE) {
    // 對抗腳架，與 agent 的 refuseToSettle／verifier 的 alwaysPass 同一個模式，
    // 只是這次對手是**排序器自己**（§16 威脅 8）。它持有私鑰，所以兩個分支都
    // 簽得出來、都驗得過——攔不住，而 §2.2 賭的是偵測得到。
    //
    // 分支的分法是「註冊順序的奇偶」而不是隨機：要讓兩邊各自內部一致，否則
    // 每個節點都看到一堆互相矛盾的 root，那不是 equivocation 而是雜訊，而且
    // 會讓「偵測到了」變得毫無資訊量。
    // cp 不再帶 heads（#41），所以分支直接改 root——對這個腳架來說要的就是
    // 「同一個 seq、兩個都驗得過的 root」，heads 從來不是它測的東西。
    const forked = { ...cp, root: sha256(cp.root + 'branch-B') };
    const forkedSig = sign(hubId.privateKey, forked);
    let i = 0;
    for (const [, a] of agents) {
      if (!a.chan) continue;
      const odd = (i++ % 2) === 1;
      a.chan.send(odd
        ? { type: 'checkpoint', cp: forked, sig: forkedSig }
        : { type: 'checkpoint', cp, sig: entry.sig });
    }
    tailAppend();
    return cp;
  }
  if (CP_FORGE) {
    broadcast({ type: 'checkpoint', cp, sig: cpSig(cp, entry.sig, 'broadcast') });
    tailAppend();
    return cp;
  }
  broadcast({ type: 'checkpoint', cp, sig: entry.sig });
  // 每一筆帳本變動之後都會走到這裡（applyPostings 與結算路徑都呼叫
  // makeCheckpoint），所以這是唯一不會漏掉任何 append 的位置（#74）。
  tailAppend();
  return cp;
}

// --- settlement core ----------------------------------------------------
// Which panel members actually produced an accountable PASS. A verdict
// counts only if the reveal opens a commitment the verifier signed before
// seeing anyone else's — that binding is what makes the three checks
// independent rather than one check copied twice (§2.2 commit-reveal).
function validAttesters(receipt, attestations, panelDids) {
  const ok = new Set();
  for (const e of attestations || []) {
    const a = e && e.attestation;
    if (!a || a.contract_id !== receipt.contract_id || a.verdict !== 'PASS') continue;
    const v = agents.get(a.verifier);
    if (!hasRole(v, 'verifier') || !panelDids.includes(a.verifier)) continue;
    if (!verify(v.pub, a, e.sig)) continue;
    // commitment must bind this exact verdict, and be signed by this verifier
    if (typeof e.nonce !== 'string' || typeof e.commitment !== 'string') continue;
    if (sha256(canon(a) + e.nonce) !== e.commitment) continue;
    const commitBody = { contract_id: a.contract_id, verifier: a.verifier,
                         commitment: e.commitment };
    if (!verify(v.pub, commitBody, e.commit_sig)) continue;
    ok.add(a.verifier);
  }
  return ok;
}

function validateSchedule(receipt, chan, ref, attestations) {
  // contract_id is the settlement idempotency key: one contract, one
  // settlement. Both the dual and forced paths come through here.
  if (settledIds.has(ref)) {
    fail(chan, 'duplicate contract_id: already settled', ref);
    return false;
  }
  const sum = receipt.postings.reduce((s, p) => s + p.amount_cc, 0);
  if (Math.abs(sum) > 1e-9) { fail(chan, `postings sum ${sum} != 0`, ref); return false; }
  // §16 威脅 8: an expired authorisation must not settle. Checked here rather
  // than trusted from the sender, because the sender is the party that
  // benefits from a stale one being honoured.
  {
    const why = expired(receipt, 'receipt');
    if (why) { fail(chan, why, ref); return false; }
  }
  // §20-9: every settlement declares what kind of trade it is, so market
  // metrics can exclude test and subsidised volume. Unlabelled is refused
  // rather than defaulted — a default would silently relabel whatever the
  // sender forgot, which is how measurement lies start.
  if (!TX_CLASSES.has(receipt.tx_class)) {
    fail(chan, `tx_class must be one of ${[...TX_CLASSES].join('/')}, ` +
      `got ${receipt.tx_class === undefined ? '(absent)' : receipt.tx_class}`, ref);
    return false;
  }
  const price = -receipt.postings.find((p) => p.account === receipt.requester).amount_cc;
  // §4 #5: a judge-quorum settlement must pay the panel, and the hub derives
  // that panel itself from the receipt's pinned pool and future seed — the
  // requester cannot invent payees. dsl-local acceptance pays no verifiers.
  let panelDids = [];
  if (receipt.acceptance_method === 'judge-quorum') {
    const seedEntry = receipt.panel_seed_cp < cpSeq
      ? panel.checkpointAt(checkpoints, receipt.panel_seed_cp) : null;
    if (!seedEntry) {
      fail(chan, `seed checkpoint #${receipt.panel_seed_cp} not minted yet`, ref);
      return false;
    }
    // 當事人不得進入自己合約的 verifier pool（#62 合併角色的前提）。
    //
    // 今天不可能發生：Hub 的 role 是互斥的，`list_verifiers` 只廣告
    // role==='verifier'，所以交易者永遠不在任何 pool 裡。但 #62 要讓 verifier
    // 也參與市場（N=6 的實測顯示它們持有 210.44 CC、佔全部正餘額 97.5%），
    // 角色一旦可以重疊，「自己裁判自己」就從不可能變成只差一個設定檔。
    //
    // 守門放在 Hub 而不只是 agent 端，因為 pool 是 requester 在合約時**自己
    // 釘的**，Hub 只比對雜湊是否與釘住的一致——雜湊自洽不代表內容合法。
    // 這與 #6 的教訓同型：能被一方選擇的東西就必須被另一方重新檢查。
    const parties = [receipt.requester, receipt.provider];
    const selfJudge = (receipt.verifier_pool || [])
      .map((v) => (typeof v === 'string' ? v : v.did))
      .filter((d) => parties.includes(d));
    if (selfJudge.length) {
      fail(chan, `contract party in its own verifier pool: ` +
        selfJudge.map((d) => d.slice(0, 18)).join(', '), ref);
      return false;
    }
    if (panel.poolHash(receipt.verifier_pool) !== receipt.verifier_pool_hash) {
      fail(chan, 'verifier pool does not match its pinned hash', ref);
      return false;
    }
    panelDids = panel.deriveDids(receipt.verifier_pool, ref, seedEntry.cp.root);
  }
  // A judge-quorum settlement with an empty pool used to skip the quorum
  // check entirely, so a receipt could claim quorum acceptance while nobody
  // had verified anything — the ledger would record it as a quorum
  // settlement. Acceptance must not degrade silently just because the pool
  // was empty when the contract was written.
  if (receipt.acceptance_method === 'judge-quorum' &&
      panelDids.length < panel.PANEL_SIZE) {
    fail(chan, `judge-quorum needs a pool of at least ${panel.PANEL_SIZE}, ` +
      `got ${panelDids.length}`, ref);
    return false;
  }
  // §4 #26: only verifiers whose reveal opened a prior commitment get paid.
  // A panel member that stayed silent earns nothing.
  let payees = panelDids;
  if (panelDids.length) {
    const attesters = validAttesters(receipt, attestations, panelDids);
    if (attesters.size < 2) {
      fail(chan, `quorum not met: ${attesters.size} accountable PASS ` +
        `attestations (need 2)`, ref);
      return false;
    }
    payees = panelDids.filter((d) => attesters.has(d)); // panel order
  }
  const { fee, risk, verifierTotal, verifierShares } =
    feeTerms(receipt.requester, price, payees.length);
  const expect = {
    // requester 也要列進來，否則下面的白名單會把付款方本人擋掉。它的金額是
    // 恆等式（price 就是從這一筆導出來的），列出它的作用是讓「允許的帳戶集合」
    // 完整——白名單只有在完整時才是白名單。
    [receipt.requester]: +(-price).toFixed(4),
    [receipt.provider]: +(price - fee - risk - verifierTotal).toFixed(4),
    [TREASURY]: fee, [INSURANCE]: risk,
  };
  payees.forEach((did, i) => { expect[did] = verifierShares[i]; });
  // 這裡原本有一段「收據裡角色為 verifier 的分錄必須恰好等於 payees」的檢查。
  // 已刪除，因為 #73 的白名單讓它成為多餘：分錄集合**恰好**等於 `expect`，
  // 所以非當事人、非 protocol 的帳戶就正好是 payees。
  //
  // 刪掉它同時拿掉了驗證器裡最後一個角色推論——「付給 role==='verifier' 帳戶
  // 的分錄就是驗證費」。那個代理判斷在角色互斥時成立，而 #62 階段 2 要讓角色
  // 重疊，它就會把 provider 的收款誤判成驗證費。**用結構判斷取代身分判斷**，
  // 這也是 #73 能被發現的同一個角度。
  // 分錄集合必須**恰好**等於費率表算出來的集合（紅隊 S17／S18，登記簿 #73）。
  //
  // 原本只做「該有的都在且金額對」，沒有人問「有沒有多的」——而 `find()` 只取
  // 第一筆，所以同一帳戶的第二筆完全不受約束。兩個串謀身分因此可以在自己簽的
  // 收據裡多塞一筆把**未參與的第三方**抽走，Σ=0 仍然成立、雙方簽章全部有效，
  // 而受害者從未簽署任何東西。實測旁觀者餘額 −3 CC。
  //
  // 這是 #53 那一類的最惡形態：**簽章有效，但授權的是別的東西**。守門的正確
  // 形狀是白名單而不是逐項比對——逐項比對永遠只能證明「至少有這些」。
  const seen = new Set();
  for (const p of receipt.postings) {
    if (seen.has(p.account)) {
      fail(chan, `duplicate account in postings: ${p.account.slice(0, 18)}`, ref);
      return false;
    }
    seen.add(p.account);
    if (!(p.account in expect)) {
      fail(chan, `unexpected posting to ${p.account.slice(0, 18)} — the ` +
        'posting set must equal the fee schedule exactly', ref);
      return false;
    }
  }
  for (const [acct, amt] of Object.entries(expect)) {
    const p = receipt.postings.find((x) => x.account === acct);
    if (!p || Math.abs(p.amount_cc - amt) > 1e-6) {
      fail(chan, `posting ${acct} != fee schedule (${amt})`, ref); return false;
    }
  }
  for (const p of receipt.postings) {
    if (agents.has(p.account) &&
        bal(p.account) + p.amount_cc < -clOf(p.account) - 1e-9) {
      fail(chan, `${p.account} would exceed credit line ${clOf(p.account).toFixed(1)}`, ref);
      return false;
    }
  }
  return true;
}

function applySettlement(kind, receipt, sigs, evidence) {
  const idx = receipts.length;
  const price = -receipt.postings.find((p) => p.account === receipt.requester).amount_cc;
  const provNet = receipt.postings.find((p) => p.account === receipt.provider).amount_cc;
  for (const p of receipt.postings) {
    balances.set(p.account, bal(p.account) + p.amount_cc);
    chainAppend(p.account, idx, p.amount_cc);
    // #90：結算的分錄**不走 applyPostings**（收據是雙方簽的物件，另一條路），
    // 所以「曾經收到過 CC」要在這裡也記一次。漏掉這裡的後果是：verifier 的
    // 驗證費不算收入，於是每個 verifier 都永遠符合入門採購的資格。
    if (p.amount_cc > 1e-9 && !p.account.startsWith('protocol:')) {
      inflowSeen.add(p.account);
    }
  }
  const req = agents.get(receipt.requester), prov = agents.get(receipt.provider);
  req.stats.paidTo.set(receipt.provider,
    (req.stats.paidTo.get(receipt.provider) || 0) + price);
  prov.stats.earnedBy.set(receipt.requester,
    (prov.stats.earnedBy.get(receipt.requester) || 0) + provNet);
  prov.stats.completed += 1;
  receipts.push({ kind, receipt, sigs, evidence });
  events.push({ kind: 'settlement', ref: receipt.contract_id,
                postings: receipt.postings, receipt_idx: idx });
  // 本期流出量，供退費加權（#71）。用**支出**而非任何分錄：#66 的第一版把
  // 「閒置」定義成「最近沒有分錄」，而 verifier 每收一筆費用就算有動——儘管
  // 餘額只增不減。獎勵累積者正是這條路徑要修的東西。記在這裡而不是
  // applyPostings 裡，因為結算是直接 push events 的、不經過那個函式。
  for (const p of receipt.postings) {
    if (p.amount_cc < 0 && !p.account.startsWith('protocol:')) {
      outVolume.set(p.account, (outVolume.get(p.account) || 0) - p.amount_cc);
    }
  }
  settledIds.add(receipt.contract_id);
  const cp = makeCheckpoint();
  console.log(`[hub] SETTLED(${kind}) ${receipt.contract_id}: ` +
    receipt.postings.map((p) => `${p.account.slice(0, 18)}=${p.amount_cc.toFixed(2)}`)
      .join(' ') + ` | checkpoint#${cp.seq} ${cp.root.slice(0, 12)}`);
  broadcast({ type: 'settled', receipt, kind });
  // Escrow part of each verifier's fee into the stake account. A separate
  // posting set, not folded into the receipt: the receipt is what both
  // parties signed, and the hub must not be able to alter it after the fact.
  // 用**結構**判斷而不是身分判斷：驗證費就是「收據裡既不是當事人、也不是
  // protocol 帳戶的那些正分錄」。原本問的是「這個帳戶的角色是 verifier 嗎」，
  // 而那個代理判斷在角色互斥時才成立——#62 階段 2 讓角色可以重疊，於是一個
  // 同時交易的 verifier 收到 **provider 貨款**時會被誤託管成押注。
  // #73 的白名單保證分錄集合恰好等於費率表，所以這個結構判斷是精確的。
  const parties = new Set([receipt.requester, receipt.provider]);
  for (const p of receipt.postings) {
    if (p.amount_cc <= 0) continue;
    if (parties.has(p.account) || p.account.startsWith('protocol:')) continue;
    const held = stakes.get(p.account) || 0;
    const room = +(STAKE_TARGET_CC - held).toFixed(4);
    if (room <= 0) continue;
    const take = +Math.min(room, p.amount_cc * STAKE_ESCROW_FRAC).toFixed(4);
    if (take <= 0) continue;
    stakes.set(p.account, +(held + take).toFixed(4));
    applyPostings('stake_escrow', receipt.contract_id,
      [{ account: p.account, amount_cc: -take }, { account: STAKE, amount_cc: take }]);
  }
  // The band's low bound is -0.3 x CL (FR-055), and CL moves with every
  // settlement, so each party needs its new line, not the one it got at
  // registration.
  for (const did of [receipt.requester, receipt.provider]) {
    const a = agents.get(did);
    if (a) a.chan.send({ type: 'credit_update', did, credit_line: clOf(did) });
  }
}

function handleReceipt(msg, chan) {
  const { receipt, sigs } = msg;
  const req = agents.get(receipt.requester), prov = agents.get(receipt.provider);
  const ref = receipt.contract_id;
  if (!req || !prov) return fail(chan, 'unknown party', ref);
  if (!verify(req.pub, receipt, sigs.requester) ||
      !verify(prov.pub, receipt, sigs.provider)) {
    return fail(chan, 'bad signature: dual-signed receipt required', ref);
  }
  if (!validateSchedule(receipt, chan, ref, msg.attestations)) return;
  applySettlement('dual', receipt, sigs);
}

// 入門採購的結果（#90）。金絲雀的鏡像：金絲雀發**不可能通過**的樁來抓偷懶的
// verifier；入門採購發**答案已知且可通過**的任務，讓還沒有紀錄的新人用一次
// 真的交付換到它的第一筆 CC。
//
// 三道門，缺一不可：
//   1. **答案是可判的**——只接受確定性斷言（`sha256_eq`），發樁者自己算得出
//      正確答案。少了這一條，入門採購就是換個名目白給（登記簿 #90 的條件 i）。
//   2. **面板真的判過**——與結算同一個問責標準：commit-reveal 的承諾必須在
//      看到別人的裁決之前就送出，而且 quorum 要足。
//   3. **收款方真的是新人**——沒有任何賺得紀錄（E_eff ≈ 0）。老手要更高上限
//      走抵押（#65），不走這裡。
// 另有每身分與全網兩個上限，因為這筆錢來自 Treasury 的創世補貼額度（§2.2）。
function handleOnboardResult(msg, chan) {
  const { report, sig, attestations } = msg;
  const ref = report && report.contract_id;
  if (!ONBOARD_DID) return fail(chan, 'onboarding not enabled on this hub', ref);
  const issuer = agents.get(report.issuer);
  if (!issuer || report.issuer !== ONBOARD_DID) {
    return fail(chan, 'onboarding report from an unauthorised issuer', ref);
  }
  if (!verify(issuer.pub, report, sig)) {
    return fail(chan, 'bad onboarding report signature', ref);
  }
  if (onboardSeen.has(ref)) return fail(chan, 'onboarding already paid', ref);
  if (report.expected_verdict !== 'PASS') {
    return fail(chan, 'onboarding task must expect PASS (its answer is known)', ref);
  }
  // 失敗的嘗試也要報上來，而它的作用就是**把連續次數歸零**。
  if (report.outcome === 'FAIL') {
    if (onboardSeen.has(ref)) return fail(chan, 'onboarding already scored', ref);
    onboardSeen.add(ref);
    const had = onboardStreak.get(report.provider) || 0;
    onboardStreak.set(report.provider, 0);
    console.log(`[hub] onboarding ${String(report.provider).slice(0, 18)}: ` +
      `交付未通過，連續次數 ${had} → 0`);
    chan.send({ type: 'onboard_progress', contract_id: ref,
                provider: report.provider, streak: 0, required: ONBOARD_STREAK });
    return;
  }
  // 條件 (i)：只接受確定性斷言。`contains`／`max_len` 這類弱斷言連「有沒有做」
  // 都判不出來，而那正是整個機制的支點。
  const asserts = Array.isArray(report.asserts) ? report.asserts : [];
  if (!asserts.some((a) => a && a.op === 'sha256_eq')) {
    return fail(chan, 'onboarding task needs a deterministic assert ' +
      '(sha256_eq); a task whose answer cannot be checked cannot price identity', ref);
  }
  const prov = agents.get(report.provider);
  if (!prov) return fail(chan, 'onboarding payee is not registered', ref);

  // 條件 (iii)：收款方必須從來沒有收到過任何 CC。
  //
  // 用「曾經收到過 CC」而不是 E_eff＝0：verifier 的驗證費不進 `stats.earnedBy`
  // （那張表只記結算的買賣雙方），所以 E_eff 會讓每個 verifier 都永遠算新人。
  // 這個錯誤是閘門第一次跑就露出來的，而它的後果是「已經在賺錢的帳戶可以
  // 反覆領入門採購」——被每身分上限擋住，但語意是錯的。
  if (inflowSeen.has(report.provider)) {
    return fail(chan, 'onboarding is for identities that have never been paid ' +
      'anything; 已經在賺錢的帳戶要更高上限請走抵押（#65）', report.provider);
  }
  const already = onboarded.get(report.provider) || 0;
  const price = Number(report.price_cc);
  if (!(price > 0)) return fail(chan, 'onboarding price must be positive', ref);
  if (already + price > ONBOARD_CAP_CC + 1e-9) {
    return fail(chan, `onboarding cap for ${report.provider.slice(0, 18)}: ` +
      `${already.toFixed(2)} + ${price} > ${ONBOARD_CAP_CC}`, ref);
  }
  if (onboardSpent + price > ONBOARD_TOTAL_CC + 1e-9) {
    return fail(chan, `onboarding allowance exhausted ` +
      `(${onboardSpent.toFixed(2)}/${ONBOARD_TOTAL_CC})`, ref);
  }

  // 條件 (ii)：面板真的判過，而且是可問責的 PASS。
  const panelDids = panel.deriveDids(report.verifier_pool, ref, report.seed_root);
  if (panel.poolHash(report.verifier_pool) !== report.verifier_pool_hash) {
    return fail(chan, 'onboarding pool does not match its pinned hash', ref);
  }
  const passers = new Set();
  for (const e of attestations || []) {
    const a = e && e.attestation;
    if (!a || a.contract_id !== ref || a.verdict !== 'PASS') continue;
    const v = agents.get(a.verifier);
    if (!hasRole(v, 'verifier') || !panelDids.includes(a.verifier)) continue;
    if (!verify(v.pub, a, e.sig)) continue;
    if (typeof e.nonce !== 'string' || sha256(canon(a) + e.nonce) !== e.commitment) continue;
    if (!verify(v.pub, { contract_id: ref, verifier: a.verifier,
                         commitment: e.commitment }, e.commit_sig)) continue;
    passers.add(a.verifier);
  }
  if (passers.size < 2) {
    return fail(chan, `onboarding needs 2 accountable PASS attestations, ` +
      `got ${passers.size}`, ref);
  }

  onboardSeen.add(ref);
  // 連續通過才付。發樁者無法用「只報成功」繞過這條，因為連續是由 Hub 自己
  // 數的；它能做的是不發任務（那本來就在它的權限內）或多報失敗——後者只會
  // 讓新人更難通過，而發樁者是營運方授權的身分，那個權力本來就存在。
  const streak = (onboardStreak.get(report.provider) || 0) + 1;
  onboardStreak.set(report.provider, streak);
  if (streak < ONBOARD_STREAK) {
    console.log(`[hub] onboarding ${report.provider.slice(0, 18)}: ` +
      `連續通過 ${streak}/${ONBOARD_STREAK}（還不付款）`);
    chan.send({ type: 'onboard_progress', contract_id: ref,
                provider: report.provider, streak, required: ONBOARD_STREAK });
    return;
  }
  onboardStreak.set(report.provider, 0);
  if (!applyPostings('onboarding', ref,
        [{ account: TREASURY, amount_cc: -price },
         { account: report.provider, amount_cc: price }])) return;
  onboarded.set(report.provider, +(already + price).toFixed(4));
  onboardSpent = +(onboardSpent + price).toFixed(4);
  console.log(`[hub] ONBOARD ${report.provider.slice(0, 18)}: ${price} CC ` +
    `（連續 ${ONBOARD_STREAK} 份答案已知的工作、最後一份 ${passers.size} 位 ` +
    `verifier 判 PASS；累計 ${onboarded.get(report.provider)}/${ONBOARD_CAP_CC}、` +
    `全網 ${onboardSpent}/${ONBOARD_TOTAL_CC}）`);
  chan.send({ type: 'onboard_paid', contract_id: ref, provider: report.provider,
              price_cc: price, total_cc: onboarded.get(report.provider) });
}

// A canary result: the issuer reports how the panel judged a decoy whose
// correct verdict is knowable. Recorded per verifier, and a pattern of
// passing known-bad work costs stake.
function handleCanaryResult(msg, chan) {
  const { report, sig, attestations } = msg;
  const ref = report && report.contract_id;
  if (!CANARY_DID) return fail(chan, 'canary reports not enabled on this hub', ref);
  const issuer = agents.get(report.issuer);
  if (!issuer || report.issuer !== CANARY_DID) {
    return fail(chan, 'canary report from an unauthorised issuer', ref);
  }
  if (!verify(issuer.pub, report, sig)) {
    return fail(chan, 'bad canary report signature', ref);
  }
  if (canarySeen.has(ref)) return fail(chan, 'canary already scored', ref);
  if (report.expected_verdict !== 'FAIL') {
    return fail(chan, 'canary must expect FAIL (its asserts are unsatisfiable)', ref);
  }
  const panelDids = panel.deriveDids(report.verifier_pool, ref, report.seed_root);
  if (panel.poolHash(report.verifier_pool) !== report.verifier_pool_hash) {
    return fail(chan, 'canary pool does not match its pinned hash', ref);
  }
  canarySeen.add(ref);

  const wrong = [];
  for (const e of attestations || []) {
    const a = e && e.attestation;
    if (!a || a.contract_id !== ref) continue;
    const v = agents.get(a.verifier);
    if (!hasRole(v, 'verifier') || !panelDids.includes(a.verifier)) continue;
    if (!verify(v.pub, a, e.sig)) continue;
    // Same accountability bar as a settlement: the reveal must open a
    // commitment made before the verifier saw anyone else's verdict.
    if (typeof e.nonce !== 'string' || sha256(canon(a) + e.nonce) !== e.commitment) continue;
    if (!verify(v.pub, { contract_id: ref, verifier: a.verifier,
                         commitment: e.commitment }, e.commit_sig)) continue;
    const st = canaryStats.get(a.verifier) || { seen: 0, failed: 0, slashed_cc: 0 };
    st.seen += 1;
    if (a.verdict === 'PASS') { st.failed += 1; wrong.push(a.verifier); }
    canaryStats.set(a.verifier, st);
  }

  const slashed = [];
  for (const did of wrong) {
    const st = canaryStats.get(did);
    const rate = st.failed / st.seen;
    if (st.seen < SLASH_MIN_SAMPLES || st.failed < SLASH_MIN_FAILURES ||
        rate < SLASH_THRESHOLD) continue;  // recorded, not punished
    const held = stakes.get(did) || 0;
    const take = +Math.min(held, STAKE_TARGET_CC * SLASH_FRAC).toFixed(4);
    if (take <= 0) continue;
    stakes.set(did, +(held - take).toFixed(4));
    st.slashed_cc = +(st.slashed_cc + take).toFixed(4);
    // Forfeited stake funds the insurance pool, which is what absorbs the
    // bad debt that undetected bad work produces.
    applyPostings('slash', ref, [{ account: STAKE, amount_cc: -take },
                                 { account: INSURANCE, amount_cc: take }]);
    slashed.push(`${did.slice(0, 18)}=-${take}`);
  }

  // FR-083: the decoy is real work for the provider, paid by Treasury and
  // marked a test transaction so it never counts as organic volume.
  const price = report.price_cc;
  if (price > 0 && agents.has(report.provider)) {
    applyPostings('canary', ref, [{ account: TREASURY, amount_cc: -price },
                                  { account: report.provider, amount_cc: price }]);
  }
  console.log(`[hub] CANARY ${ref}: ${panelDids.length} panel, ` +
    `${wrong.length} passed known-bad work` +
    (slashed.length ? `, slashed ${slashed.join(' ')}` : ', none above the evidence bar') +
    `, treasury paid provider ${price} CC`);
  chan.send({ type: 'canary_scored', contract_id: ref,
                   wrong: wrong.length, slashed: slashed.length });
}

function handleForced(msg, chan) {
  const { receipt, provider_sig, evidence } = msg;
  const ref = receipt.contract_id;
  const req = agents.get(receipt.requester), prov = agents.get(receipt.provider);
  if (!req || !prov) return fail(chan, 'unknown party', ref);
  const { contract, contract_sigs, pre_auth, pre_auth_sig, attestations } = evidence;
  // 1. dual-signed contract binding both parties to price + verifier panel
  if (contract.contract_id !== ref || contract.requester !== receipt.requester ||
      contract.provider !== receipt.provider ||
      !verify(req.pub, contract, contract_sigs.requester) ||
      !verify(prov.pub, contract, contract_sigs.provider)) {
    return fail(chan, 'forced: contract not dual-signed by both parties', ref);
  }
  for (const [obj, what] of [[contract, 'contract'], [pre_auth, 'pre_authorization']]) {
    const why = expired(obj, `forced: ${what}`);
    if (why) return fail(chan, why, ref);
  }
  // 2. requester's standing pre_authorization ("quorum PASS ⇒ settle")
  if (pre_auth.contract_id !== ref || pre_auth.price_cc !== contract.price_cc ||
      pre_auth.condition !== 'quorum-accepted' ||
      !verify(req.pub, pre_auth, pre_auth_sig)) {
    return fail(chan, 'forced: invalid pre_authorization', ref);
  }
  // 3. 2-of-3 PASS attestations from the panel the seed checkpoint selects.
  // Re-derived here, not read off the contract: otherwise a requester could
  // fan out to a panel of its choosing and have the attestations accepted.
  const seedEntry = contract.panel_seed_cp < cpSeq
    ? panel.checkpointAt(checkpoints, contract.panel_seed_cp) : null;
  if (!seedEntry) {
    return fail(chan, `forced: seed checkpoint #${contract.panel_seed_cp} not minted yet`, ref);
  }
  if (panel.poolHash(contract.verifier_pool) !== contract.verifier_pool_hash) {
    return fail(chan, 'forced: verifier pool does not match its pinned hash', ref);
  }
  const expected = new Set(panel.deriveDids(
    contract.verifier_pool, ref, seedEntry.cp.root));
  const passers = new Set();
  for (const { attestation, sig } of attestations) {
    const v = agents.get(attestation.verifier);
    if (!hasRole(v, 'verifier')) continue;
    if (!expected.has(attestation.verifier)) continue;
    if (attestation.contract_id !== ref || attestation.verdict !== 'PASS') continue;
    if (verify(v.pub, attestation, sig)) passers.add(attestation.verifier);
  }
  if (passers.size < 2) {
    return fail(chan, `forced: quorum not met (${passers.size}/2 PASS)`, ref);
  }
  // 4. provider signature over this exact receipt + fee schedule + CL
  if (!verify(prov.pub, receipt, provider_sig)) {
    return fail(chan, 'forced: bad provider signature', ref);
  }
  if (-receipt.postings.find((p) => p.account === receipt.requester).amount_cc
      !== contract.price_cc) {
    return fail(chan, 'forced: receipt price != contract price', ref);
  }
  if (!validateSchedule(receipt, chan, ref, attestations)) return;
  console.log(`[hub] FORCED settlement ${ref}: requester refused, ` +
    `pre_auth + ${passers.size}-of-${expected.size} quorum stands in ` +
    `(panel seeded from checkpoint #${contract.panel_seed_cp})`);
  applySettlement('forced', receipt,
    { requester: `pre_auth:${pre_auth_sig}`, provider: provider_sig }, evidence);
}

// §20-10: 成交率、供需深度、違約率、平均還債時間.
//
// Derived here rather than read off anyone's console, because FR-083 asks
// the simulator and production to share metric definitions and a console is
// one agent's private view. Everything below comes from what the hub has
// relayed or settled, so a third party can recompute it from the export.
//
// The class split is the point (§20-9): a figure that mixes subsidised
// decoys and rehearsal traffic into "market volume" is not a market figure.
function buildMetrics() {
  // 由事件導出而不是累加計數器：§20-4 要求指標可由簽署狀態重建，一個只存在
  // 於記憶體計數器裡的數字可能與產生它的分錄不一致（同 #65 抵押品的理由）。
  const rebated = { insurance: 0, treasury: 0 };
  for (const ev of events) {
    if (ev.kind !== 'rebate') continue;
    const which = String(ev.ref).split(':')[1];
    if (which in rebated) {
      rebated[which] += ev.postings.filter((p) => p.amount_cc > 0)
        .reduce((t, p) => t + p.amount_cc, 0);
    }
  }
  const byClass = {};
  const bump = (cls, field, n = 1) => {
    byClass[cls] = byClass[cls] || { settlements: 0, volume_cc: 0 };
    byClass[cls][field] += n;
  };
  for (const r of receipts) {
    const cls = r.receipt.tx_class || 'unlabelled';
    const price = -(r.receipt.postings
      .find((p) => p.account === r.receipt.requester) || { amount_cc: 0 }).amount_cc;
    bump(cls, 'settlements');
    bump(cls, 'volume_cc', +price.toFixed(4));
  }
  for (const e of events) {
    if (e.tx_class !== 'subsidy') continue;
    const out = e.postings.filter((p) => p.amount_cc > 0)
      .reduce((t, p) => t + p.amount_cc, 0);
    bump('subsidy', 'volume_cc', +out.toFixed(4));
  }

  // Repayment time from the signed chains: how long an account stayed below
  // zero. Same definition the simulator uses, computable by anyone holding
  // the export.
  const episodes = [];
  for (const [, chain] of chains) {
    let since = null;
    for (const e of chain) {
      if (e.balance_after < 0 && since === null) since = e.at || null;
      else if (e.balance_after >= 0 && since !== null) {
        if (e.at) episodes.push(e.at - since);
        since = null;
      }
    }
  }
  const avgRepay = episodes.length
    ? Math.round(episodes.reduce((t, x) => t + x, 0) / episodes.length) : null;

  const awarded = market.contracts.size;
  return {
    tasks_broadcast: market.tasks,
    bids_seen: market.bids,
    // 供需深度: how many providers actually competed for each task.
    avg_bids_per_task: market.tasks
      ? +(market.bids / market.tasks).toFixed(2) : 0,
    contracts_awarded: awarded,
    // 成交率: awarded contracts that reached settlement.
    fill_rate: awarded ? +(receipts.length / awarded).toFixed(3) : 0,
    // 違約率 proxy: awarded and never settled. Not the same as a written-off
    // default, which is `default_rate` below and has been real since the
    // waterfall shipped (#65); this one stays because it also catches
    // contracts that simply never completed, and is named as a proxy.
    unsettled_awarded: Math.max(0, awarded - receipts.length),
    default_proxy_rate: awarded
      ? +((awarded - receipts.length) / awarded).toFixed(3) : 0,
    // 真正的違約率：已沖銷金額 ÷ 結算量（與模擬器的 bad_debt_rate 同定義，
    // 所以兩邊第一次可比）。
    written_off_cc: +[...writtenOff.values()]
      .reduce((t, v) => t + v, 0).toFixed(4),
    default_rate: (() => {
      const vol = receipts.reduce((t, r) => t - (r.receipt.postings
        .find((p) => p.account === r.receipt.requester) || { amount_cc: 0 }).amount_cc, 0);
      const off = [...writtenOff.values()].reduce((t, v) => t + v, 0);
      return vol > 0 ? +(off / vol).toFixed(4) : 0;
    })(),
    // 自己報堆使用量（登記簿 #74）。從外面用 `ps` 看 RSS 無法區分「活躍集
    // 長大」與「V8 沒把已釋放的頁還給 OS」，而那個區別正是「有沒有洩漏」。
    // 順手報出保留狀態的規模，讓成長能被歸因而不只是被觀察到。
    heap_used_mb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    rss_mb: +(process.memoryUsage().rss / 1048576).toFixed(1),
    retained: {
      events: events.length, receipts: receipts.length,
      checkpoints: checkpoints.length,
      chain_entries: [...chains.values()].reduce((t, c) => t + c.length, 0),
      raw_log_kb: +(rawLogBytes / 1024).toFixed(0),
    },
    insurance_cc: +bal(INSURANCE).toFixed(4),
    treasury_cc: +bal(TREASURY).toFixed(4),
    loss_cc: +bal(LOSS).toFixed(4),
    // 回流（#71）。protocol 帳戶**淨**吸收多少才是真正離開流通的金額，
    // 而毛額會高估——這個區別就是這條路徑要證明的東西。
    rebated_cc: +(rebated.insurance + rebated.treasury).toFixed(4),
    rebated_by_source: {
      insurance: +rebated.insurance.toFixed(4),
      treasury: +rebated.treasury.toFixed(4),
    },
    avg_repayment_ms: avgRepay,
    repayment_episodes: episodes.length,
    // 哪幾個數字站得住什麼樣的腳（#77）。寫進匯出而不是只寫進文件——
    // 讀匯出的人不會去讀文件，而 §20-10 原本一句「全部由簽署狀態導出」
    // 對供需深度是**過度宣稱**：只有排序器看得到所有出價。
    provenance: {
      // 收據與 hash chain 算得出來，任何人可自行重算。
      signed: ['default_rate', 'written_off_cc', 'avg_repayment_ms', 'by_class'],
      // 分母是一組**雙方簽署的合約 id**，所以「每一筆收據都在得標集合裡」
      // 可被第三方檢查；但集合的**完整性**是排序器的主張（漏報會讓成交率
      // 偏高），所以它不是純粹的簽署導出。
      sequencer_set: ['fill_rate', 'contracts_awarded', 'unsettled_awarded',
                      'default_proxy_rate'],
      // 純粹的排序器觀測值，且跟著快照走——崩潰最多損失一個快照間隔。
      sequencer_observed: ['tasks_broadcast', 'bids_seen', 'avg_bids_per_task'],
    },
    by_class: byClass,
  };
}

// One definition of the export, shared by the `export` message and the
// auto-dump, so a dumped ledger can never differ from a queried one.
// includeRawLog=false for the disaster dump: recovery needs receipts,
// events, chains, checkpoints and pubkeys, and lib/rebuild.js verifies from
// exactly those. Carrying the audit log as well made the dump 4x larger than
// the ledger it exists to protect, rewritten on every interval.
// --- 分頁匯出（#41 的另一半 / #76 殘留）---------------------------------
// 一份匯出遲早超過 `MAX_LINE`（16MB），而超過的後果從前是**靜默丟連線**——
// 取樣端因此瞎了 590 秒而沒有任何人知道（#76）。兩件事一起修：
// (1) 沒帶游標而匯出過大時，回一個**指名的拒絕**，不是一個送不出去的 frame；
// (2) 帶游標時分頁供應。
//
// 分頁必須來自**凍結的快照**。逐頁現算會讓第 1 頁的 receipts 與第 3 頁的
// chains 來自不同的帳，重建出來的東西不對應任何一個真的存在過的狀態——
// 那正是這本登記簿反覆抓到的形態（#76／#78 都是）。所以第一頁建立一份快照
// 並發一個 token，之後每一頁都從同一份切。
const EXPORT_PAGE_BYTES = Number(process.env.HUB_EXPORT_PAGE_BYTES || 4 * 1024 * 1024);
const EXPORT_PAGE_TTL_MS = Number(process.env.HUB_EXPORT_PAGE_TTL_MS || 120000);
const pagedExports = new Map();   // token -> { ex, accounts, at }
const BIG_ARRAYS = ['receipts', 'events', 'checkpoints', 'chains'];

function exportScalars(ex) {
  const out = {};
  for (const [k, v] of Object.entries(ex)) {
    if (!BIG_ARRAYS.includes(k)) out[k] = v;
  }
  return out;
}

function exportPage(sess, cur) {
  const ex = sess.ex;
  const out = { receipts: [], events: [], checkpoints: [], chains: {} };
  let used = 0;
  const take = (arr, from, into) => {
    let i = from;
    while (i < arr.length && used < EXPORT_PAGE_BYTES) {
      used += JSON.stringify(arr[i]).length + 1;
      into.push(arr[i]); i += 1;
    }
    return i;
  };
  const r = take(ex.receipts || [], cur.r, out.receipts);
  const e = take(ex.events || [], cur.e, out.events);
  const c = take(ex.checkpoints || [], cur.c, out.checkpoints);
  // chains 逐帳戶整條給：一條鏈遠小於一頁（N=20 四十分鐘平均 242KB），
  // 而切一半會讓收方無法驗雜湊鏈結。真有超大帳戶時那一頁會超出預算——
  // 記在 #79，不在這一輪處理。
  let ch = cur.ch;
  while (ch < sess.accounts.length && used < EXPORT_PAGE_BYTES) {
    const acct = sess.accounts[ch];
    out.chains[acct] = (ex.chains || {})[acct];
    used += JSON.stringify(out.chains[acct]).length;
    ch += 1;
  }
  const more = r < (ex.receipts || []).length || e < (ex.events || []).length ||
    c < (ex.checkpoints || []).length || ch < sess.accounts.length;
  return { out, next: more ? { token: cur.token, r, e, c, ch } : null };
}

// #88：全量流量記錄**預設不隨匯出出去**。
//
// 匯出對任何人開放是刻意的（§20-4：不必相信排序器，自己重建）。但帳本揭露的
// 是「發生了什麼」，而 `raw_log` 揭露的是「所有人講過的每一句話」——包含
// **落選的出價**（那從來不進帳本）、每一筆任務的 metadata、以及所有錯誤文字。
// 在區網試點裡那是功能（demo 的 NFR-005 明文掃描靠它）；對一個公開的 Hub，
// 那是把整個市場的私有資訊送給任何連得上的人。
//
// 所以預設關閉，`HUB_EXPORT_RAWLOG=1` 打開——所有需要掃描流量的閘門
// （demo、demo-autonomous、redteam-agents）自己設它。相對於「預設開著、
// 上線前記得關」，這個方向的錯誤是安全的那一邊。
const EXPORT_RAWLOG = process.env.HUB_EXPORT_RAWLOG === '1';

function buildExport({ includeRawLog = EXPORT_RAWLOG } = {}) {
  return {
    receipts,
    pubkeys: Object.fromEntries(pubkeys),
    joined_at: Object.fromEntries(joinedAt),
    collateral: Object.fromEntries(collateral),
    metrics: buildMetrics(),
    balances: Object.fromEntries(balances),
    credit_lines: Object.fromEntries(
      [...agents].filter(([, a]) => hasRole(a, 'agent'))
        .map(([d]) => [d, clOf(d)])),
    chains: Object.fromEntries(chains),
    checkpoints,
    // The sequence position, which the sparse array no longer implies.
    checkpoint_seq: cpSeq,
    // #77：得標的合約 id，與 `tasks`/`bids` 兩個計數器。§20-10 的成交率是
    // 「已結算 ÷ 得標」，而得標**只有排序器看得見**（它是中繼）。原本這三個
    // 數字只活在記憶體裡，於是 Hub 一重啟，分子（已還原的全部收據）與分母
    // （重啟後才開始數）就來自不同的生命期——實測成交率 2.242、違約代理
    // −1.242。合約本身是雙方簽署的物件，所以持久化 id 之後，任何人拿著匯出
    // 都能檢查「每一筆收據的 contract_id 都在得標集合裡」。
    awarded: AWARDED_PERSIST ? [...market.contracts] : [],
    // 這兩個是**排序器自報的觀測值**，不是簽署狀態：只有 Hub 看得到所有
    // 出價。它們跟著快照走，所以崩潰最多損失一個快照間隔——供需深度因此
    // 是「近似的累計值」，這一點必須寫在證據包裡而不是假裝它可驗證。
    market_counters: { tasks: market.tasks, bids: market.bids },
    stakes: Object.fromEntries(stakes),
    canary_stats: Object.fromEntries(canaryStats),
    canary_scored: [...canarySeen],
    // #90：誰領過入門採購、領了多少。它是 Treasury 的支出，所以必須可稽核。
    onboarded: Object.fromEntries(onboarded),
    onboard_streak: Object.fromEntries(onboardStreak),
    onboard_paid: [...onboardSeen],
    events,
    hub_pub: hubId.pub,
    // #95：前任簽的 checkpoint 要能被第三方驗過，所以委派鏈跟著帳一起走。
    ...(successionCerts.length ? { succession: successionCerts } : {}),
    // 取匯出的時刻（#82）。信用額度含年齡項，而重建一定發生在匯出**之後**，
    // 沒有這個時間戳就重算不出同一個值——只會算出一個比較大的。
    exported_at: Date.now(),
    // 斜坡長度是**這個 Hub 的政策**，不是重建方的環境變數。第一版讓兩邊
    // 各自讀 `HUB_AGE_RAMP_MS`，於是 `demo-rebuild`（hub 設 1ms、自己沒設）
    // 又對不上——換一個地方犯同一個錯。跟著匯出走才對得起來。
    age_ramp_ms: AGE_RAMP_MS,
    // #99：starter 與斜坡同理——它是**這本帳的政策**。少了它，營運方調整
    // starter 之後自己的 Hub 就會因為「重算的額度對不上匯出」而拒絕啟動
    // （實測：調成 10 之後 `credit line mismatch … rebuilt 5.160 vs export
    // 25.798`，整個網路停在那裡）。
    starter_cc: eeff.STARTER_CC,
    ...(includeRawLog ? { raw_log: rawLog.join('\n') } : {}),
  };
}

// A disaster export you have to remember to take is not disaster recovery.
// The pilot proved it: export->import shipped, then the hub went down with
// nobody having run ledger-dump.js, and that ledger was gone regardless.
// 快照＋附加尾檔（登記簿 #74）。
//
// 原本每 `HUB_DUMP_MS`（預設 2 秒，chaos 設定）把**整份歷史**重新
// `JSON.stringify` 一次，成本 O(全部歷史)。實測：雙角色拓撲的匯出檔以
// 296.9 KB/分成長，而每 2 秒重寫一次就是每分鐘上百 MB 的暫時字串——RSS
// 因此以 4.82 MB/分爬升（堆完全是平的，所以那不是洩漏，是配置 churn）。
// 4 小時後匯出檔約 50MB，每 2 秒重寫就是每秒 25MB，Owner 裁定的 4 小時
// 演練會死在這裡。這與 #41 同型：稀疏 checkpoint 只修掉其中一個實例。
//
// 改法：快照不常寫，每一筆新的 event／receipt／checkpoint **立刻附加**到
// `<file>.tail`（JSON-lines）。成本從 O(全部) 變成 O(新增)，而且耐久性
// **比原本更好**——原本崩潰最多損失一個間隔（2 秒），現在損失的是尚未
// 落盤的那一筆。
//
// 崩潰安全的順序：寫快照 tmp → rename → 才清空尾檔。若在 rename 與清空
// 之間崩潰，尾檔會含有快照裡已有的記錄——所以每一行都帶**目標陣列的索引**，
// 匯入時只在「剛好是下一筆」時套用，重播因此是幂等的。寫到一半被截斷的
// 最後一行由 JSON.parse 的守衛跳過。
const dumpTail = { file: null,
  written: { events: 0, receipts: 0, checkpoints: 0, pubkeys: 0, chains: {},
             awarded: 0 } };
// 鏈分錄要不要進尾檔（#78 的負向對照）。關掉就回到只帶 events/receipts 的
// 舊行為，而那正是讓恢復後的雜湊全部改變的那個版本——`rebuild` 現在會因此
// 拒絕啟動，所以這個旋鈕測的是「那條防線真的會紅」。
const TAIL_CHAINS = process.env.HUB_TAIL_CHAINS !== '0';
// #77 的負向對照：不持久化得標集合＝舊行為。重啟之後分子是已還原的全部
// 收據、分母從零開始，成交率因此 >1（實測 2.242）。旋鈕存在的理由與
// `HUB_TAIL_CHAINS` 相同——一條「修好了」的路必須有辦法證明它會壞。
const AWARDED_PERSIST = process.env.HUB_AWARDED_PERSIST !== '0';
const chainLens = () => Object.fromEntries([...chains].map(([a, c]) => [a, c.length]));
function tailAppend() {
  if (!dumpTail.file) return;
  const lines = [];
  // 公鑰**無法從事件推導**，所以尾檔必須帶它。第一版沒帶，於是快照（開場寫、
  // 當時還沒有人註冊）之後所有重播的收據都報「provider signature invalid」
  // ——439 筆套用成功、96 個驗證失敗。demo-rebuild 照不出這個洞，因為它的
  // 匯出檔本來就是完整的；要靠「歷史只存在於尾檔」的情境才會現形。
  const pkEntries = [...pubkeys.entries()];
  for (let i = dumpTail.written.pubkeys; i < pkEntries.length; i++) {
    const [did, pub] = pkEntries[i];
    lines.push(JSON.stringify({ k: i, did, pub, joined: joinedAt.get(did) || null }));
  }
  for (let i = dumpTail.written.events; i < events.length; i++) {
    lines.push(JSON.stringify({ e: i, ev: events[i] }));
  }
  for (let i = dumpTail.written.receipts; i < receipts.length; i++) {
    lines.push(JSON.stringify({ r: i, rc: receipts[i] }));
  }
  // 鏈分錄（#78）。它們是**衍生**的，但 `at` 只存在於這裡——events 沒有任何
  // 時間欄位，所以尾檔不帶的話，恢復時每一筆的 `at` 會變成 0、全部雜湊改變，
  // 重算出的 head root 對不上任何一個已簽署的 checkpoint，而 `rebuild` 從前
  // 不會注意到。寫在 checkpoint **之前**：checkpoint 承諾的就是這些 head。
  // 得標 id（#77）。只放在快照裡不夠：崩潰之後收據會從尾檔回來、得標不會，
  // 成交率就再一次 >1——那正是 #78 剛教過的形狀。
  if (AWARDED_PERSIST) {
    const aw = [...market.contracts];
    for (let i = dumpTail.written.awarded || 0; i < aw.length; i++) {
      lines.push(JSON.stringify({ w: i, aw: aw[i] }));
    }
  }
  if (TAIL_CHAINS) {
    for (const [acct, chain] of chains) {
      for (let i = dumpTail.written.chains[acct] || 0; i < chain.length; i++) {
        lines.push(JSON.stringify({ a: acct, ce: chain[i] }));
      }
    }
  }
  for (let i = dumpTail.written.checkpoints; i < checkpoints.length; i++) {
    lines.push(JSON.stringify({ c: i, cp: checkpoints[i] }));
  }
  if (!lines.length) return;
  try {
    require('node:fs').appendFileSync(dumpTail.file, lines.join('\n') + '\n');
    dumpTail.written = { events: events.length, receipts: receipts.length,
                         checkpoints: checkpoints.length,
                         pubkeys: pubkeys.size, chains: chainLens(),
                         awarded: market.contracts.size };
  } catch (err) {
    console.error(`[hub] tail append failed: ${err.message}`);
  }
}

function startAutoDump() {
  const file = process.env.HUB_DUMP_PATH;
  if (!file) return;
  // 快照間隔與原本的 dump 間隔分開：尾檔已經提供逐筆耐久性，所以快照只是
  // 為了讓重播不必從創世開始，可以慢得多。
  const ms = Number(process.env.HUB_SNAPSHOT_MS
    || process.env.HUB_DUMP_MS || 60000);
  const fs = require('node:fs');
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  // HUB_TAIL=0 關掉尾檔，退回「只有快照」的舊行為。存在的理由有兩個：
  // 一是它讓 `tail-recover` 的斷言可以被證明**會失敗**（關掉之後歷史就真的
  // 不見，#51 的教訓——不會失敗的檢查等於沒有檢查）；二是萬一附加寫入在某個
  // 檔案系統上出問題，有一條退路。
  dumpTail.file = process.env.HUB_TAIL === '0' ? null : `${file}.tail`;
  if (!dumpTail.file) console.log('[hub] tail disabled (HUB_TAIL=0)');
  if (dumpTail.file) {
    try { fs.rmSync(dumpTail.file, { force: true }); } catch { /* 沒有就算了 */ }
  }
  const write = () => {
    try {
      // 寫 tmp 再 rename，所以寫一半崩潰不會把可恢復的檔案換成截斷的檔案。
      const tmp = `${file}.tmp`;
      const snap = buildExport({ includeRawLog: false });
      const body = JSON.stringify(snap);
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      // 順序：快照就位之後才清空尾檔。反過來的話，兩者之間的崩潰會讓那段
      // 歷史兩邊都沒有。
      if (dumpTail.file) fs.writeFileSync(dumpTail.file, '');
      dumpTail.written = { events: snap.events.length,
                           receipts: snap.receipts.length,
                           checkpoints: (snap.checkpoints || []).length,
                           pubkeys: Object.keys(snap.pubkeys || {}).length,
                           chains: chainLens(),
                           awarded: (snap.awarded || []).length };
      return body.length;
    } catch (err) {
      console.error(`[hub] snapshot failed: ${err.message}`);
      return 0;
    }
  };
  // 快照間隔隨檔案大小自動放慢，讓快照的寫入頻寬有上界（#74）。
  //
  // 這件事**只有在尾檔存在時才做得到**：原本放慢間隔的代價是崩潰損失的視窗
  // 變長，而尾檔已經提供逐筆耐久性，所以放慢快照不損失任何恢復點——它只是
  // 讓重播的起點舊一些。11 分鐘實測：固定 30 秒把 RSS 迴歸從 4.82 壓到 2.02
  // MB/分，剩下的成長就是「快照仍是 O(全部歷史)」這一項。
  //
  // 預算式而非固定倍數：4 小時後匯出檔約 50MB，固定 30 秒是每秒 1.7MB，而
  // 100 KB/s 的預算會把間隔拉到 8 分鐘。尾檔在那 8 分鐘裡累積的是事件而不是
  // 整份歷史，所以代價很小。
  const budgetKbs = Number(process.env.HUB_SNAPSHOT_KBPS || 100);
  let timer = null;
  const schedule = (lastBytes) => {
    const needed = budgetKbs > 0
      ? Math.round(lastBytes / 1024 / budgetKbs * 1000) : ms;
    const next = Math.max(ms, needed);
    if (needed > ms) {
      console.log(`[hub] snapshot ${(lastBytes / 1048576).toFixed(1)}MB → ` +
        `下一次延到 ${(next / 1000).toFixed(0)}s（預算 ${budgetKbs} KB/s）`);
    }
    timer = setTimeout(() => { const n = write(); schedule(n); }, next);
    timer.unref();
  };
  schedule(write());
  console.log(`[hub] snapshot every ${ms}ms → ${file}` +
    (dumpTail.file
      ? `（每筆變動即時附加到 ${require('node:path').basename(dumpTail.file)}）`
      : '（尾檔已關閉，崩潰最多損失一個快照間隔）'));
}

// W10: start as a second sequencer from a disaster export. Verified, not
// trusted — see lib/rebuild.js. A refusal to start is the correct outcome
// when the export does not check out; carrying on with an unverified ledger
// would make the sequencer exactly the trust root §2.2 says it is not.
// 尾檔重播（#74）搬到 `lib/tail.js`：取樣端（#76）需要同一個格式來算
// 「快照落後多少」，而一條規則兩個實作會分岔（#60 的形狀）。
const tail = require('./lib/tail');
function mergeTail(ex, tailFile) {
  const r = tail.merge(ex, tailFile);
  if (r.applied || r.skipped || r.torn) {
    console.log(`[hub] tail replay: ${r.applied} applied, ${r.skipped} already in ` +
      `snapshot, ${r.torn} torn`);
  }
  return r.applied;
}

if (process.env.HUB_IMPORT) {
  const file = process.env.HUB_IMPORT;
  let ex;
  try {
    ex = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[hub] cannot read import ${file}: ${err.message}`);
    process.exit(1);
  }
  if (process.env.HUB_TAIL !== '0') mergeTail(ex, `${file}.tail`);
  const r = rebuildLib.rebuild(ex, { expectHubDid: process.env.HUB_EXPECT_DID || null });
  if (!r.ok) {
    console.error(`[hub] REFUSING to start: import failed verification ` +
      `(${r.errors.length} problems)`);
    for (const e of r.errors.slice(0, 10)) console.error(`  - ${e}`);
    if (r.errors.length > 10) console.error(`  … and ${r.errors.length - 10} more`);
    process.exit(1);
  }
  // 政策換過（例如 starter 從 50 調成 10）是一個**事實**，而它會改變每個人的
  // 額度——所以它必須出現在啟動的那幾行裡，不能只活在一個回傳值裡（#99）。
  for (const n of (r.notes || [])) console.log(`[hub] ${n}`);
  for (const [k, v] of r.balances) balances.set(k, v);
  for (const [k, v] of r.chains) chains.set(k, v);
  for (const [k, v] of r.stakes) stakes.set(k, v);
  for (const [k, v] of r.canaryStats) canaryStats.set(k, v);
  for (const c of r.canaryScored) canarySeen.add(c);
  // #38：曾經取回押注的身分由事件流認定，不是由匯出的摘要欄位認定——否則
  // 一個少了旗標的匯出會讓它重新進 pool。
  // #90 同理：「曾經收到過 CC」也從事件流重建，否則重啟之後每個人都又變成新人。
  for (const e of (ex.events || [])) {
    if (e.kind === 'stake_release') {
      for (const p of (e.postings || [])) {
        if (p.account !== STAKE && p.amount_cc > 0) stakeReleased.add(p.account);
      }
    }
    if (e.kind !== 'onboarding') {
      for (const p of (e.postings || [])) {
        if (p.amount_cc > 1e-9 && !p.account.startsWith('protocol:')) {
          inflowSeen.add(p.account);
        }
      }
    }
  }
  for (const [did, cc] of Object.entries(ex.onboarded || {})) {
    onboarded.set(did, cc);
    onboardSpent = +(onboardSpent + cc).toFixed(4);
  }
  for (const c of (ex.onboard_paid || [])) onboardSeen.add(c);
  for (const c of r.settledIds) settledIds.add(c);
  // #77：得標集合與觀測計數器要跟著回來，否則成交率的分子分母不同生命期。
  for (const c of (ex.awarded || [])) market.contracts.add(c);
  market.tasks += (ex.market_counters || {}).tasks || 0;
  market.bids += (ex.market_counters || {}).bids || 0;
  receipts.push(...r.receipts);
  events.push(...r.events);
  checkpoints.push(...r.checkpoints);
  cpSeq = r.checkpointSeq;
  cpKeptAt = Date.now();
  // Stats drive the credit line, and they were recomputed from the receipts
  // rather than copied, so an imported agent cannot inherit standing the
  // ledger does not justify. The agent entry is created on registration;
  // park the stats until then.
  for (const [did, st] of r.stats) importedStats.set(did, st);
  for (const [did, pub] of Object.entries(r.pubkeys || {})) pubkeys.set(did, pub);
  for (const [did, at] of Object.entries(ex.joined_at || {})) joinedAt.set(did, at);
  for (const [did, c] of Object.entries(r.collateral || {})) collateral.set(did, c);
  console.log(`[hub] rebuilt from ${file}: ${r.summary.receipts} receipts, ` +
    `${r.summary.events} events, ${r.summary.accounts} accounts, ` +
    `${r.summary.checkpoints} checkpoints — all signatures and chains verified` +
    (r.hubDid ? `, origin hub ${r.hubDid}` : ''));
}

// §2.2 calls for a periodic public checkpoint, and a future-seeded panel
// needs one: with checkpoints minted only on settlement, a contract awaiting
// verification in a quiet network would wait for a seed that never arrives.
const CHECKPOINT_MS = Number(process.env.HUB_CHECKPOINT_MS || 1200);
// Unconditionally, including before the first settlement. An empty-heads
// checkpoint is well-formed (root = hash of {}), and gating on chains.size
// deadlocked a fresh network: the first contract's panel seed is a checkpoint
// that only a settlement would have minted, and that settlement needed the
// panel. A network whose first task wanted a quorum could never start.
setInterval(makeCheckpoint, CHECKPOINT_MS).unref();

// --- 壞帳瀑布（#61 的另一半）---------------------------------------------
// 原型一直沒有違約偵測，所以抵押品只會抬高額度、永遠不會被沒收；§20-10 的
// 違約率只能是「已得標未結算」的代理值；而模擬器早就有完整瀑布（保證金 →
// 保險池 → protocol:loss），兩邊因此不可比。
//
// 觸發條件與模擬器一致：離線超過 DEFAULT_AFTER_MS 且餘額仍為負。用「離線」
// 而非「逾期未還」是刻意的——一個還在線上、還在交易的負餘額帳戶不是違約，
// 那是正常的互惠信用（FR-052）。
function writeOff(did) {
  const debt = -bal(did);
  if (debt <= 1e-9) return 0;
  const col = Math.min(debt, collateral.get(did) || 0);
  const afterCol = debt - col;
  const ins = Math.min(afterCol, Math.max(0, bal(INSURANCE)));
  const loss = afterCol - ins;
  const postings = [{ account: did, amount_cc: debt }];
  if (col > 1e-9) postings.push({ account: COLLATERAL, amount_cc: -col });
  if (ins > 1e-9) postings.push({ account: INSURANCE, amount_cc: -ins });
  if (loss > 1e-9) postings.push({ account: LOSS, amount_cc: -loss });
  if (!applyPostings('write_off', `writeoff:${did}:${Date.now()}`, postings)) return 0;
  if (col > 1e-9) collateral.set(did, (collateral.get(did) || 0) - col);
  writtenOff.set(did, (writtenOff.get(did) || 0) + debt);
  console.log(`[hub] WRITE-OFF ${did}: ${debt.toFixed(2)} CC ` +
    `(抵押 ${col.toFixed(2)}、保險 ${ins.toFixed(2)}、損失 ${loss.toFixed(2)})`);
  return debt;
}

// §4 #38：偷懶的 verifier 原本最好的策略是「在金絲雀測夠次數之前換身分」。
// 押注是從收入託管來的，換身分只是把它留在舊 DID 上——沒有人拿走，所以 churn
// 幾乎不花錢。模擬器量到 2 天換一次身分就由 −0.30 轉為 +0.30 CC 的優勢
// （c99869b），而同一支模擬器加上這條規則後 1／2／3 天 churn 的淨收益分別掉到
// 0.72／1.81／2.86 CC，優勢全部翻回 −44 CC 以下：換得越快、賠得越多。
//
// 為什麼綁 `seen < SLASH_MIN_SAMPLES` 而不是一律沒收：一個已經被測夠、
// 通過率良好的 verifier 離線是**退出**，不是規避。沒收它的押注會把押注變成
// 罰金；#38 的判斷是「a bond you do not get back」——沒被測夠就走的人拿不回
// 保證金，被測過的人拿得回。
function forfeitStake(did, a, now) {
  if (!hasRole(a, 'verifier')) return 0;
  const held = stakes.get(did) || 0;
  if (held <= 1e-9) return 0;
  const st = canaryStats.get(did) || { seen: 0, failed: 0, slashed_cc: 0 };
  if (st.seen >= SLASH_MIN_SAMPLES) return 0;   // 測夠了，押注是它的
  const take = +held.toFixed(4);
  stakes.set(did, 0);
  const ok = applyPostings('stake_forfeit', `forfeit:${did}:${now}`,
    [{ account: STAKE, amount_cc: -take }, { account: INSURANCE, amount_cc: take }]);
  if (!ok) { stakes.set(did, held); return 0; }
  // 記在 canary_stats 裡而不是另開一張表，是因為重建把「各 verifier 現在持有
  // 多少押注」定義為託管減去 canary_stats 的沒收額，並用 Σ持有 = protocol:stake
  // 交叉檢查（lib/rebuild.js）。沒收額若不落在同一個地方，重建會對不上。
  st.forfeited_cc = +((st.forfeited_cc || 0) + take).toFixed(4);
  canaryStats.set(did, st);
  console.log(`[hub] STAKE FORFEIT ${did.slice(0, 18)}: ${take.toFixed(4)} CC ` +
    `→ 保險池（離線 ${Math.round((now - a.offlineSince) / 1000)}s、` +
    `金絲雀樣本 ${st.seen}/${SLASH_MIN_SAMPLES}）`);
  return take;
}

setInterval(() => {
  const now = Date.now();
  for (const [did, a] of agents) {
    if (a.online !== false || !a.offlineSince) continue;
    if (now - a.offlineSince >= STAKE_FORFEIT_AFTER_MS) forfeitStake(did, a, now);
    if (now - a.offlineSince < DEFAULT_AFTER_MS) continue;
    if (bal(did) >= -1e-9) continue;
    writeOff(did);
    a.offlineSince = now;        // 不要每個 sweep 都重算同一個帳戶
  }
}, DEFAULT_SWEEP_MS).unref();

// 回流（#71）。加權用本期支出，所以只收不付的帳戶拿不到——#62 量到 verifier
// 是最大的吸收端，而平均分配會把錢送回給它們。
function rebateFrom(source, amount, label) {
  const movers = [...outVolume].filter(([did, v]) => v > 1e-9 && agents.has(did));
  const wsum = movers.reduce((t, [, v]) => t + v, 0);
  if (!movers.length || wsum <= 1e-9) return 0;
  const give = Math.min(amount, Math.max(0, bal(source)));
  if (give < REBATE_MIN_CC) return 0;
  // 逐筆四捨五入後再由來源帳戶吸收餘數，否則 Σ=0 會因為分配誤差而不成立，
  // 而 applyPostings 會（正確地）拒絕整筆。
  const shares = movers.map(([did, v]) => [did, +(give * v / wsum).toFixed(4)])
    .filter(([, amt]) => amt > 1e-9);
  if (!shares.length) return 0;
  const total = +shares.reduce((t, [, amt]) => t + amt, 0).toFixed(4);
  const postings = [{ account: source, amount_cc: -total }]
    .concat(shares.map(([did, amt]) => ({ account: did, amount_cc: amt })));
  if (!applyPostings('rebate', `rebate:${label}:${Date.now()}`, postings)) return 0;
  console.log(`[hub] REBATE ${label}: ${total.toFixed(2)} CC → ` +
    shares.map(([d, a]) => `${d.slice(0, 18)}=${a.toFixed(2)}`).join(' '));
  return total;
}

if (REBATE_ON) setInterval(() => {
  // 曝險 = 現在的未償負餘額總額，也就是「可能違約的金額」。保險池的目標綁
  // 它而不是綁成交量，因為池子存在是為了吸收違約。
  let exposure = 0;
  for (const did of agents.keys()) exposure += Math.max(0, -bal(did));
  const insSurplus = bal(INSURANCE) - exposure * INSURANCE_TARGET_FRAC;
  if (insSurplus > REBATE_MIN_CC) rebateFrom(INSURANCE, insSurplus, 'insurance');
  const trSurplus = bal(TREASURY) - TREASURY_RESERVE_CC;
  if (trSurplus > REBATE_MIN_CC) rebateFrom(TREASURY, trSurplus, 'treasury');
  outVolume.clear();   // 權重要反映「最近」而不是全期
}, REBATE_MS).unref();

// 有人正在接手的時候，舊排序器**不能**直接回來（#95）。
//
// 分叉最常見的成因不是攻擊，是人：拔線演練之後把原本那台插回同一個網段。
// 三台真機的 runbook 用一句話處理它（「M1 不得再接回同一網段」），而一句話
// 不是守門。可以檢查的事實是：**後繼者活著的時候，位址記錄是新的**——一個
// 死掉的排序器發不出新記錄，所以記錄的新鮮度就是「現在誰是現任」的證據。
//
// 刻意不自動合併兩本帳：那需要決定哪些分錄留下，而那是治理決定不是程式決定。
// 這裡只做一件事——說清楚現況與兩條路，然後拒絕啟動。
if (process.env.HUB_RENDEZVOUS && process.env.HUB_RESUME_AFTER_SUCCESSION !== '1') {
  try {
    const fs_ = require('node:fs');
    const rec = JSON.parse(fs_.readFileSync(process.env.HUB_RENDEZVOUS, 'utf8'));
    const rv = require('./lib/rendezvous');
    const mine = discovery.didOf(hubId.pub);
    const seen = rv.check(rec, { pin: null });
    if (seen.ok && seen.did !== mine) {
      const su = require('./lib/succession');
      const authorised = su.chain(rec.succession || [], { from: mine, to: seen.did });
      console.error(
        `[hub] REFUSING to start: ${seen.did} 正在服務（位址記錄 ${Math.round(seen.ageMs / 1000)}s 前才更新，` +
        `${seen.host}:${seen.port}）` +
        (authorised ? '，而那是我自己授權的後繼者' : '，而它不是我授權的（可能是別人的網路用了同一個記錄位置）'));
      console.error('[hub] 直接起來就是分叉：兩個排序器會各自延伸同一段歷史，' +
        '而釘住我的 client 會被分到兩本帳上。兩條路：');
      console.error('  1. 接受它是現任，我改當待命（推薦）：');
      console.error(`       node standby.js ${process.env.HUB_RENDEZVOUS}`);
      console.error('  2. 我要收回排序權：先取得它的帳（ledger-dump.js）並以那份 ' +
        'HUB_IMPORT 啟動，然後 HUB_RESUME_AFTER_SUCCESSION=1。');
      console.error('     那份帳延續的是它的歷史——沒有這一步，你會丟掉它服務期間的每一筆。');
      process.exit(1);
    }
  } catch { /* 沒有記錄、或讀不出來：照原本的路啟動 */ }
}

// --- server ---------------------------------------------------------------
transport.listen({
  port: PORT,
  host: BIND,

  onChannel: (chan) => {
    // 上線前的濫用預算（#87）。Hub 是唯一對陌生人開放的入口，所以限流在這裡
    // 打開而不是在傳輸層預設開啟——撥出方數的是收到的訊息，對稱的規則會讓
    // 正常的客戶端自殺（見 lib/channel.js 的說明）。
    chan.enforceLimits();
    // 連線上限：總量與每個來源位址。少了這兩個，一台機器就能開滿連線把
    // Hub 的記憶體與 fd 吃光，而每條連線在註冊前都還有 64KB 的 frame 預算。
    const ip = String(chan.remote || '').replace(/:\d+$/, '');
    if (conns.size >= MAX_CONNS) {
      chan.refuse(`hub at capacity (${MAX_CONNS} connections)`);
      return;
    }
    const perIp = (ipConns.get(ip) || 0) + 1;
    if (!LOOPBACK.has(ip) && perIp > MAX_CONNS_PER_IP) {
      chan.refuse(`too many connections from ${ip} (limit ${MAX_CONNS_PER_IP})`);
      return;
    }
    conns.add(chan);
    ipConns.set(ip, perIp);
    chan.onClose(() => {
      conns.delete(chan);
      const n = (ipConns.get(ip) || 1) - 1;
      if (n > 0) ipConns.set(ip, n); else ipConns.delete(ip);
    });
    // Departures matter for the verifier pool: a panel is drawn from the pool
    // pinned at contract time, so a verifier that has gone away keeps being
    // selected, produces no attestation, and silently blocks settlement once
    // the quorum cannot be met. Mark offline rather than delete — the stats
    // feed the credit line, and dropping them would reset an agent's standing
    // on reconnect while its balance persisted.
    chan.onClose(() => {
      for (const [did, a] of agents) {
        if (a.chan !== chan || a.online === false) continue;
        a.online = false;
        a.offlineSince = Date.now();
        console.log(`[hub] ${did} disconnected (${a.role})`);
      }
    });
    chan.onRaw(recordRaw);
    chan.onMessage((msg) => {
      // 逐欄位驗證（登記簿 #16，紅隊 G14）。原本靠 frame 層的 try/catch 接住
      // 例外——進程不會死（G1／G3 驗過），但**送出方什麼都學不到**：Hub 完全
      // 不回應，所以一個少打一個欄位的設定檔跟一個網路問題長得一模一樣。
      //
      // 只檢查「handler 會直接解參照」的欄位，不做完整 schema：目標是把
      // 「靜默丟棄」換成「指名缺什麼」，不是在這一層重做簽章與語意檢查——
      // 那些仍然在各自的 handler 裡，而且應該留在那裡。
      const why = missingFields(msg);
      if (why) { fail(chan, why, msg.ref || msg.contract_id); return; }
      switch (msg.type) {
        case 'register': {
          // 註冊節流與帳戶總量上限（#87）。順序是刻意的：**先驗簽再計數**，
          // 否則一個不帶有效簽章的洪水就能把別人的註冊配額用掉。
          const ip = String(chan.remote || '').replace(/:\d+$/, '');
          const body = { did: msg.did, pub: msg.pub, box_pub: msg.box_pub };
          if (msg.role) body.role = msg.role;
          // roles 也要進簽署本體，否則任何人都能改別人的角色宣告。
          if (msg.roles) body.roles = msg.roles;
          if (!verify(msg.pub, body, msg.sig)) {
            return fail(chan, 'bad register signature', msg.did);
          }
          const prior = agents.get(msg.did);
          // 重連（同一個 DID 已經在帳上）不受節流與上限限制：那是既有參與者
          // 回來，而擋掉它等於把斷線變成永久離線——#40 的重連與 #17 的固定
          // 身分都會被這條規則反過來打壞。
          if (!prior && !pubkeys.has(msg.did) && !LOOPBACK.has(ip)) {
            const now = Date.now();
            const win = (regWindow.get(ip) || []).filter((t) => now - t < 60000);
            if (win.length >= MAX_REGISTER_PER_MIN) {
              return fail(chan, `too many new registrations from ${ip} ` +
                `(${MAX_REGISTER_PER_MIN}/min)`, msg.did);
            }
            if (agents.size >= MAX_AGENTS) {
              return fail(chan, `hub at capacity (${MAX_AGENTS} identities); ` +
                'an operator has to raise HUB_MAX_AGENTS', msg.did);
            }
            win.push(now);
            regWindow.set(ip, win);
          }
          agents.set(msg.did, {
            // online stays false until the peer confirms it received our
            // reply. A client that can send but not hear re-registers every
            // idle timeout forever, and marking it online on `register` made
            // each retry look healthy: a verifier that could not receive one
            // verify_request stayed in the pool for the whole outage, and
            // every contract awarded against it was doomed. Sending proves
            // nothing; hearing does.
            pub: msg.pub, boxPub: msg.box_pub, chan, online: false,
            // Keep the history on reconnect: stats drive the credit line.
            stats: prior ? prior.stats
              : (importedStats.get(msg.did) || eeff.newStats()),
            role: msg.role || 'agent',
            // 角色可以重疊（#62 階段 2）。`role` 保留給 log 與既有匯出欄位，
            // 判斷一律走 hasRole——一個節點同時交易又驗證是 SDD 的模型
            // （FR-041「驗證」是從 pool 抽選的角色，不是另一種物種），
            // 而原型把兩者拆成兩個進程只是 Phase 1 的方便。
            roles: new Set(Array.isArray(msg.roles) && msg.roles.length
              ? msg.roles : [msg.role || 'agent']),
          });
          pubkeys.set(msg.did, msg.pub);
          if (!joinedAt.has(msg.did)) joinedAt.set(msg.did, Date.now());
          balances.set(msg.did, bal(msg.did));
          // Hand back what this identity already holds. A seeded agent that
          // restarts keeps its DID and therefore its debt (§4 #17), but its
          // own view starts at zero — and the strategy engine reads that
          // balance, so a restarted agent carrying real debt would believe it
          // was at zero, skip repayment mode, and overestimate what it can
          // spend until the hub refused it.
          chan.send({ type: 'registered', did: msg.did,
                           // 節點原本完全不知道 Hub 的公鑰——`hub_pub` 只在
                           // 匯出檔裡——所以它收到 checkpoint 時**沒有驗簽**，
                           // 卻拿 cp.root 去推導 panel（#6 的種子）。交出公鑰
                           // 不是信任宣告：DID 是公鑰的雜湊，所以釘了 DID 的
                           // 節點可以自己核對，而 #69c 的分叉指控也因此變成
                           // 可證明的（否則未簽署的戳記會變成阻斷攻擊的入口）。
                           hub_pub: hubId.pub,
                           credit_line: clOf(msg.did), fee_rate: eeff.FEE_RATE,
                           balance_cc: bal(msg.did),
                           stake_cc: stakes.get(msg.did) || 0,
                           settlements: receipts.filter((r) =>
                             r.receipt.postings.some((p) => p.account === msg.did)).length });
          break;
        }
        case 'register_ack': {
          const a = agents.get(msg.did);
          if (!a || a.chan !== chan) break;  // only the channel that registered
          if (a.online) break;
          a.online = true;
          // 這條連線從「陌生人」升級成「參與者」（#87）：frame 上限回到
          // MAX_LINE、未註冊訊息數的限制解除。分界點選在 register_ack 而不是
          // register，因為前者才證明對方**聽得到**（#49）——一個只會送不會
          // 收的連線不該拿到大預算。
          chan.markAuthenticated();
          console.log(`[hub] registered ${msg.did} (${a.role}, ` +
            `CL ${clOf(msg.did).toFixed(1)})`);
          break;
        }
        case 'task': {
          const req = agents.get(msg.task.requester);
          if (!req || !verify(req.pub, msg.task, msg.sig)) {
            return fail(chan, 'bad task signature', msg.task.task_id);
          }
          console.log(`[hub] task ${msg.task.task_id} broadcast ` +
            `(${msg.task.units}u, max ${msg.task.max_price_cc} CC, ` +
            `acceptance ${msg.task.acceptance.method})`);
          market.tasks += 1;
          broadcast(msg, msg.task.requester);
          break;
        }
        case 'list_verifiers': {
          // The lock reports where the sequence actually is, not where the
          // last stored entry sits — with sparse storage those differ during
          // an idle stretch, and an agent comparing lock < seed needs the
          // real position.
          const latest = checkpoints.at(-1);
          chan.send({
            type: 'verifiers',
            verifiers: [...agents]
              // === true, not !== false: a verifier that has not confirmed it
            // can hear us is not eligible (#49's sibling).
            // 取回押注者不再進 pool（#38）：身上沒有東西可罰的驗證者無從
            // 嚇阻。這實質上讓「取回押注」＝**結束這個 DID 的驗證生涯**——
            // 要再驗證就得用新身分，而新身分沒有受測紀錄、也重新暴露在
            // 「未達標就棄置 → 押注不退」那條規則下。那是刻意的：唯一不該
            // 存在的組合是「乾淨的受測紀錄 ＋ 身上零押注」。
            .filter(([did, a]) => hasRole(a, 'verifier') && a.online === true
              && !stakeReleased.has(did))
              .map(([did, a]) => ({ did, pub: a.pub, box_pub: a.boxPub })),
            lock: { checkpoint_seq: latest ? latest.cp.seq : -1,
                    root: latest ? latest.cp.root : sha256('genesis') },
            // The seq a contract written now must seed its panel from: one that
            // has not been minted, so its root cannot be ground against.
            next_checkpoint_seq: cpSeq,
          });
          break;
        }
        case 'fee_quote': {
          const size = (msg.panel || []).length;
          const { fee, risk, verifierShares } =
            feeTerms(msg.requester, msg.price, size);
          chan.send({ type: 'fee_terms', contract_id: msg.contract_id,
                           requester: msg.requester, price: msg.price, fee, risk,
                           panel: msg.panel || [], verifier_shares: verifierShares });
          break;
        }
        case 'bid': case 'contract':
          if (msg.type === 'bid') {
            const why = expired(msg.bid, 'bid');
            if (why) { fail(chan, why, msg.bid && msg.bid.task_id); break; }
            market.bids += 1;
          }
          if (msg.type === 'contract' && msg.contract) {
            market.contracts.add(msg.contract.contract_id);
          }
          // falls through to the relay below
        case 'contract_ack': case 'delivery':
        case 'delivery_request':
        case 'receipt_half': case 'verify_request': case 'attestation':
        case 'attestation_commit': case 'reveal_request': {
          const to = agents.get(msg.to);
          if (to && to.chan) to.chan.send(msg);
          break;
        }
        case 'receipt': handleReceipt(msg, chan); break;
        case 'forced_settlement': handleForced(msg, chan); break;
        case 'canary_result': handleCanaryResult(msg, chan); break;
        case 'onboard_result': handleOnboardResult(msg, chan); break;
        case 'collateral_post': {
          // 自願鎖入 CC 換取額度上限。必須是自己的正餘額——不能用信用額度
          // 去抵押信用額度，那等於無擔保放大，正是折扣率要避免的事。
          const a = agents.get(msg.did);
          if (!a || a.chan !== chan) break;
          const amt = Number(msg.amount_cc);
          if (!(amt > 0)) { fail(chan, 'collateral: amount must be positive', msg.did); break; }
          if (!verify(a.pub, { did: msg.did, amount_cc: amt, lock: true }, msg.sig)) {
            fail(chan, 'collateral: bad signature', msg.did); break;
          }
          if (bal(msg.did) < amt) {
            fail(chan, `collateral: balance ${bal(msg.did).toFixed(2)} < ` +
              `${amt} (credit cannot collateralise credit)`, msg.did);
            break;
          }
          if (!applyPostings('collateral_post', `col:${msg.did}:${Date.now()}`,
                [{ account: msg.did, amount_cc: -amt },
                 { account: COLLATERAL, amount_cc: amt }])) break;
          collateral.set(msg.did, (collateral.get(msg.did) || 0) + amt);
          chan.send({ type: 'collateral', did: msg.did,
                      locked_cc: collateral.get(msg.did),
                      credit_line: clOf(msg.did), ltv: eeff.COLLATERAL_LTV });
          console.log(`[hub] ${msg.did} locked ${amt} CC as collateral ` +
            `(total ${collateral.get(msg.did)}, CL ${clOf(msg.did).toFixed(1)})`);
          break;
        }
        case 'collateral_release': {
          // 只有在釋放後的額度仍然覆蓋現有負債時才准取回，否則取回抵押品
          // 就成了「先借滿、再抽走擔保」的兩步走。
          const a = agents.get(msg.did);
          if (!a || a.chan !== chan) break;
          const amt = Number(msg.amount_cc);
          const held = collateral.get(msg.did) || 0;
          if (!(amt > 0) || amt > held) {
            fail(chan, `collateral: cannot release ${amt} of ${held}`, msg.did); break;
          }
          if (!verify(a.pub, { did: msg.did, amount_cc: amt, lock: false }, msg.sig)) {
            fail(chan, 'collateral: bad signature', msg.did); break;
          }
          const after = eeff.creditLine(msg.did, a.stats, statsOf,
            ageFactorOf(msg.did), held - amt);
          if (bal(msg.did) < -after + 1e-9) {
            fail(chan, `collateral: releasing ${amt} would leave debt ` +
              `${(-bal(msg.did)).toFixed(2)} above the remaining line ` +
              `${after.toFixed(2)}`, msg.did);
            break;
          }
          if (!applyPostings('collateral_release', `rel:${msg.did}:${Date.now()}`,
                [{ account: COLLATERAL, amount_cc: -amt },
                 { account: msg.did, amount_cc: amt }])) break;
          collateral.set(msg.did, held - amt);
          chan.send({ type: 'collateral', did: msg.did,
                      locked_cc: held - amt, credit_line: clOf(msg.did),
                      ltv: eeff.COLLATERAL_LTV });
          break;
        }
        case 'stake_release': {
          // #38 的另一半，而少了它沒收只是記帳。押注從前只進不出（託管 →
          // 罰沒），所以「不退押注」對離開的人毫無差別——那筆 CC 早就不在它
          // 的餘額裡了。要讓「拿不回來」有意義，必須存在**拿得回來**的情形。
          //
          // 退還與沒收是同一條線的兩側：金絲雀樣本達標（被測夠了）且失敗率
          // 沒到罰沒門檻，就可以取回；沒被測夠就走的，轉入保險池。
          //
          // 取回即**退出 pool，而且是這個 DID 的永久退出**：一個把押注抽走還
          // 繼續驗證的人身上沒有東西可罰，那是 pay-to-play 的反面（#28）。
          // 重新註冊也回不去（`stakeReleased` 不掛在 agent 記錄上），因為
          // 「乾淨的受測紀錄 ＋ 身上零押注」正是唯一不該存在的組合。要再
          // 驗證就得用新身分——沒有受測紀錄，並重新暴露在沒收規則下。
          const a = agents.get(msg.did);
          if (!a || a.chan !== chan) break;
          if (!hasRole(a, 'verifier')) { fail(chan, 'stake: not a verifier', msg.did); break; }
          const want = Number(msg.amount_cc);
          const held = stakes.get(msg.did) || 0;
          if (!(want > 0)) { fail(chan, 'stake: amount must be positive', msg.did); break; }
          // 簽的是「最多取回這麼多」（授權上限），實際動的是 min(want, held)，
          // 因為託管是持續進行的、節點手上的數字永遠稍舊。
          if (!verify(a.pub, { did: msg.did, amount_cc: want, stake: 'release' }, msg.sig)) {
            fail(chan, 'stake: bad signature', msg.did); break;
          }
          // 樣本數先看、託管餘額後看。反過來寫的話，一個還沒託管到任何押注的
          // 新 verifier 會拿到「nothing held」——拒絕的**理由**變成偶然的託管
          // 時序，而真正的規則（沒被測過的不退）就從回覆裡消失了。
          const st = canaryStats.get(msg.did) || { seen: 0, failed: 0 };
          if (st.seen < SLASH_MIN_SAMPLES) {
            fail(chan, `stake: released only after ${SLASH_MIN_SAMPLES} canary ` +
              `samples (have ${st.seen}) — 沒被測過的押注不退，否則 #38 的規則` +
              `就有一個繞道`, msg.did);
            break;
          }
          if (st.seen > 0 && st.failed / st.seen >= SLASH_THRESHOLD) {
            fail(chan, `stake: failure rate ${(st.failed / st.seen).toFixed(2)} ` +
              `at or above the slashing threshold ${SLASH_THRESHOLD}`, msg.did);
            break;
          }
          if (held <= 1e-9) { fail(chan, 'stake: nothing held', msg.did); break; }
          const give = +Math.min(want, held).toFixed(4);
          if (!applyPostings('stake_release', `strel:${msg.did}:${Date.now()}`,
                [{ account: STAKE, amount_cc: -give },
                 { account: msg.did, amount_cc: give }])) break;
          stakes.set(msg.did, +(held - give).toFixed(4));
          stakeReleased.add(msg.did);
          chan.send({ type: 'stake', did: msg.did, released_cc: give,
                      stake_cc: stakes.get(msg.did), in_pool: false });
          console.log(`[hub] STAKE RELEASE ${msg.did.slice(0, 18)}: ` +
            `${give.toFixed(4)} CC 退還（樣本 ${st.seen}/${SLASH_MIN_SAMPLES}、` +
            `失敗 ${st.failed}），已退出 verifier pool`);
          break;
        }
        case 'checkpoint_request': {
          // A lost checkpoint broadcast used to strand a contract: the
          // requester needs the seed root to derive its panel and had no way
          // to ask for it.
          const e = typeof msg.seq === 'number' && msg.seq < cpSeq
            ? panel.checkpointAt(checkpoints, msg.seq) : null;
          if (e) chan.send({ type: 'checkpoint', cp: e.cp,
                             sig: cpSig(e.cp, e.sig, 'answer'),
                             for_seq: msg.seq });
          break;
        }
        case 'export': {
          // 只對**起始**請求計數。跟著游標取後續分頁不算新的匯出——一份
          // 50MB 的帳本要幾十頁（四小時長跑實測），把每一頁都算成一次匯出
          // 會讓限流誤殺唯一能取回大帳本的那條路（#41 的分頁）。
          const exIp = String(chan.remote || '').replace(/:\d+$/, '');
          if (!msg.cursor && !LOOPBACK.has(exIp)) {
            const ip = exIp;
            const now = Date.now();
            const win = (exportWindow.get(ip) || []).filter((t) => now - t < 60000);
            if (win.length >= MAX_EXPORT_PER_MIN) {
              fail(chan, `too many ledger exports from ${ip} ` +
                `(${MAX_EXPORT_PER_MIN}/min) — 帳本是公開的，但整份序列化不便宜`);
              break;
            }
            win.push(now);
            exportWindow.set(ip, win);
          }
          if (msg.paged || msg.cursor) {
            // 過期的 session 先清掉，否則一個中途離開的客戶端會讓 Hub
            // 一直抱著一份完整匯出。
            for (const [t, sv] of pagedExports) {
              if (Date.now() - sv.at > EXPORT_PAGE_TTL_MS) pagedExports.delete(t);
            }
            let cur = msg.cursor;
            if (!cur) {
              const token = sha256(`${Date.now()}:${cpSeq}:${Math.random()}`).slice(0, 16);
              // **真的凍結**。`buildExport()` 只做淺拷貝：`checkpoints` 是
              // Hub 那個陣列本身，`chains` 的每條鏈也是同一個陣列參照。
              // 單頁匯出在同一個 tick 就序列化完，看不出差別；分頁會跨好
              // 幾個來回，於是第 1 頁的 receipts 序列化於 t1、第 3 頁的
              // chains 序列化於 t3，而 t3 的鏈已經長過 t2 送出去的
              // checkpoint——收方重算出的 head root 因此對不上任何一個
              // checkpoint。實測就是這樣：`pagekill`（分頁＋重啟）必紅，
              // 而單獨分頁或單獨重啟都不紅。
              //
              // 各陣列複製一層就夠：收據、事件、checkpoint、鏈分錄一旦
              // push 進去就不再被原地修改，所以複製指標即可，不必深拷貝
              // 整份十幾 MB。
              const frozen = buildExport();
              frozen.receipts = [...(frozen.receipts || [])];
              frozen.events = [...(frozen.events || [])];
              frozen.checkpoints = [...(frozen.checkpoints || [])];
              frozen.chains = Object.fromEntries(
                Object.entries(frozen.chains || {}).map(([a, c]) => [a, [...c]]));
              pagedExports.set(token, { ex: frozen,
                accounts: Object.keys(frozen.chains), at: Date.now() });
              cur = { token, r: 0, e: 0, c: 0, ch: 0 };
            }
            const sess = pagedExports.get(cur.token);
            if (!sess) {
              // 指名的失敗。過期之後靜默回空頁會讓客戶端以為帳就是這麼短。
              chan.send({ type: 'ledger_export_expired', token: cur.token,
                          ttl_ms: EXPORT_PAGE_TTL_MS });
              break;
            }
            const { out, next } = exportPage(sess, cur);
            const first = !cur.r && !cur.e && !cur.c && !cur.ch;
            chan.send({ type: 'ledger_export_page', ...out, cursor: next,
                        ...(first ? exportScalars(sess.ex) : {}) });
            if (!next) pagedExports.delete(cur.token);
            break;
          }
          const whole = buildExport();
          const body = JSON.stringify(whole);
          if (body.length > EXPORT_PAGE_BYTES) {
            // 從前這裡會送出一個超過 `MAX_LINE` 的 frame，收方靜默丟連線
            // 而且不知道為什麼（#76）。指名它。
            chan.send({ type: 'ledger_export_too_large', bytes: body.length,
              max: EXPORT_PAGE_BYTES,
              hint: '改送 {type:"export", paged:true} 並跟著回覆裡的 cursor（#41）' });
            break;
          }
          chan.send({ type: 'ledger_export', ...whole });
          break;
        }
      }
    });
  },

  onError: (err) => {
    console.error(`[hub] listen failed on ${BIND}:${PORT}: ${err.code || err.message}` +
      (err.code === 'EADDRINUSE' ? ' — another hub is already running, or set HUB_PORT' : ''));
    process.exit(1);
  },

  onListening: () => {
    console.log(
      `[hub] listening on ${BIND}:${PORT} — ${transport.name} transport, ` +
      `protocol v${PROTOCOL_VERSION}, ` +
      // The DID an agent pins with hubPin, so it must not depend on whether
      // the beacon happens to be enabled.
      `hub did ${discovery.didOf(hubId.pub)}, ` +
      `starter CL ${eeff.STARTER_CC}, fee ${eeff.FEE_RATE * 100}%, ` +
      `risk ${eeff.RISK_THIN * 100}%/${eeff.RISK_BASE * 100}%, hash-chained + checkpointed`);
    if (process.env.HUB_BEACON === '0') {
      console.log('[hub] discovery beacon disabled (HUB_BEACON=0)');
    } else {
      // Targets follow BIND, so the hub only ever advertises addresses it serves.
      const b = discovery.startBeacon(hubId, PORT, { bind: BIND });
      console.log(`[hub] discovery beacon on udp/${b.port} → ${b.targets.join(', ')}`);
    }
    if (!process.env.HUB_SEED) {
      console.log('[hub] no HUB_SEED: this hub\'s DID changes on every restart, ' +
        'so agents pinning it (hubPin) must be reconfigured after a restart');
    }
    startAutoDump();
  // §4 #45: publish where I am, signed, so clients on other networks can
  // find me and keep finding me after a move. The file is data, not a
  // service — put it anywhere stable.
  if (process.env.HUB_RENDEZVOUS) {
    const rv = require('./lib/rendezvous');
    const where = process.env.HUB_RENDEZVOUS;
    // 憑證隨每一份位址記錄出去，所以 client 取一次就同時拿到「你是誰」與
    // 「憑什麼是你」。它們不在記錄的簽署範圍內——是別人簽的（見 rendezvous.js）。
    const succession = successionCerts;
    // 對外的埠不一定等於自己聽的埠：任何一層轉發（NAT 轉發、反向代理、
    // 負載平衡）都可能換掉它，而記錄裡要寫的是**別人要連的那一個**。
    // 原本只讓主機名可覆蓋、埠寫死成自己聽的 PORT，所以一旦中間有一層
    // 轉發，發出去的記錄就是錯的——而它還帶著正確的簽章，所以客戶端會
    // 老實地去連一個連不上的地方。
    const advertisePort = Number(process.env.HUB_ADVERTISE_PORT || PORT);
    // 對外的**主機**同樣不是啟動時就知道的（#91）。常駐的 onion service 是
    // 另一個行程（`service/run-onion.sh`），位址要等 tor 把目錄建好才出現，
    // 而它也會因為換位址而變。原本在 listen 那一刻解析一次就定住，所以
    // 「Hub 先起來、入口後起來」這個**常駐服務必然的順序**會讓記錄永遠
    // 帶著回送位址或區網位址——而它帶著正確的簽章，客戶端於是老實地去連
    // 一個連不上的地方（與上面那個埠的缺陷同一個形態，只是換一個欄位）。
    // 修法與 #40 的 `dialLazy` 相同：持有**解析方式**而不是解析結果。
    const hostFile = process.env.HUB_ADVERTISE_HOST_FILE || null;
    const advertiseHost = () => {
      if (hostFile) {
        try {
          const v = require('node:fs').readFileSync(hostFile, 'utf8').trim();
          if (v) return { host: v, from: hostFile };
        } catch { /* 入口還沒起來——先發下面那個位址，下一輪再跟上 */ }
      }
      const fallback = process.env.HUB_ADVERTISE_HOST ||
        (BIND === '0.0.0.0' ? (discovery.localAddrs()[0] || '127.0.0.1') : BIND);
      return { host: fallback, from: process.env.HUB_ADVERTISE_HOST ? 'HUB_ADVERTISE_HOST' : `bind ${BIND}` };
    };
    let announced = null;
    const republish = () => {
      const { host, from } = advertiseHost();
      try {
        rv.publish(hubId, { host, port: advertisePort }, where, succession);
        // 只在位址**變了**的時候說話：常駐服務每 60 秒重發一次，逐次列印
        // 會把「入口換了位址」這件唯一值得看的事埋掉。
        if (host !== announced) {
          console.log(`[hub] rendezvous published → ${where} ` +
            `(${host}:${advertisePort}，來源 ${from})` +
            (announced ? ` — 位址已更新，前一個是 ${announced}` : ''));
          announced = host;
        }
      } catch (err) { console.error(`[hub] rendezvous publish failed: ${err.message}`); }
    };
    republish();
    setInterval(republish, Number(process.env.HUB_RENDEZVOUS_MS || 60000)).unref();
  }
    const authorised = (process.env.HUB_SUCCESSORS || '').split(',')
      .map((x) => x.trim()).filter(Boolean);
    if (authorised.length) {
      console.log(`[hub] 已簽接手憑證給 ${authorised.length} 個待命排序器：` +
        authorised.map((d, i) => `${d}（優先序 ${i + 1}）`).join('、') +
        '——它們不需要我的私鑰，client 釘的仍然是我');
    }
    if (CANARY_DID) {
      console.log(`[hub] canary issuer authorised: ${CANARY_DID} ` +
        '(may spend Treasury on decoy tasks)');
    }
  },
});
