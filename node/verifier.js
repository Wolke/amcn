// Verifier Agent: fixed at contract time (FR-041), runs the contract's
// locked assert set and signs an attestation with machine-readable
// verdict (FR-044). Deterministic judge for the prototype; an LLM judge
// slots in behind the same message flow.
//
// env AGENT_CONFIG: { name, hubPort, hubHost?, hubPin?, beaconPort? }
// hubHost "discover" uses the UDP beacon instead of a hand-copied IP.
'use strict';
const { genIdentity, identityFromSeed, sign, verify } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();
require('./lib/log').install();
const discovery = require('./lib/discovery');
const { genBoxKeys } = require('./lib/e2e');

// Same resolution as agent.js: env for scripted runs, a file path for
// humans. configs/verifier.example.json shipped from the first commit but
// nothing could load it — env was the only path, which also meant every
// verifier had to be started with shell-quoted JSON (a real obstacle on
// PowerShell, where bash's single-quote form does not work).
// 同 agent.js：不帶設定檔＝加入預設網路（lib/bootstrap.js）。verifier 是門檻
// 最低的角色（不需要 key、不需要模型、不參與信用），所以它最需要「一行就好」。
const STANDALONE = process.argv.slice(2).includes('--standalone');
const cfgArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const cfgPath = process.env.AGENT_CONFIG ? null : cfgArg;
const cfg = cfgPath
  ? JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf8'))
  : process.env.AGENT_CONFIG
    ? JSON.parse(process.env.AGENT_CONFIG)
    : require('./lib/bootstrap').defaultConfig('verifier', { standalone: STANDALONE });
// 與 agent.js 同一條（見那裡的說明）：從設定檔啟動而沒有 seed 時，產生一個
// 並寫回去。對 verifier 這件事現在**有價**：協定 v7 之後，還沒被金絲雀測夠
// 就換身分離開的 verifier 押注不退（#38），所以每次重啟換 DID 等於每次丟掉
// 已經託管的押注。
if (cfgPath && !cfg.seed) {
  cfg.seed = `${cfg.name || 'verifier'}-${require('node:crypto').randomBytes(12).toString('hex')}`;
  try {
    require('node:fs').writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`[amcn] 已為 ${cfgPath} 產生固定身分 seed（押注與受測紀錄都綁在` +
      '這個身分上，請備份也請不要外流）。');
  } catch (e) {
    console.error(`[amcn] 警告：無法把 seed 寫回 ${cfgPath}（${e.message}）——` +
      '重啟後押注會留在舊 DID 上，而未達金絲雀樣本門檻的棄置押注不退（#38）。');
  }
}
// A verifier without a stable identity abandons its escrowed stake on
// every restart (§4 #28), which is the same hole as #17 wearing a
// different hat — and it would make the stake unenforceable by simply
// restarting.
const id = cfg.seed ? identityFromSeed(cfg.seed) : genIdentity();
const box = genBoxKeys();
const log = (m) => console.log(`[${cfg.name} ${id.did}] ${m}`);
// 裁決邏輯在 lib/verifier-kernel.js，與 agent.js 的 `verify: true` 共用同一份
// ——複製一份會讓兩邊的規則慢慢分岔（#60 的形態）。這支因此只剩連線、註冊與
// 活性，是它日後退場的路徑（#62 階段 4）。
let kernel = null;

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub, role: 'verifier' };

// #69c：verifier 同樣參與跨觀察者比對。不加它就等於在 attestation 這條路徑
// 上沒有偵測，而那是 verifier 唯一會送給對等節點的訊息——也正是串謀最在意的
// 那一條。`cp` 掛在信封上，不進被簽署的 attestation 本體。
const cpw = require('./lib/cpwatch').create(log);
function stampPeerSends(conn) {
  const raw = conn.send.bind(conn);
  conn.send = (m) => {
    if (m && m.to) {
      const cp = cpw.stamp();
      if (cp) return raw({ ...m, cp });
    }
    return raw(m);
  };
  return conn;
}

const hub = stampPeerSends(transport.dialLazy(() => discovery.resolveHubTarget(cfg, log), {
  // A panel that lost the hub used to stay lost, which ended the network:
  // the pool goes empty and judge-quorum tasks stop being awarded (#40).
  onOpen: () => hub.send({ type: 'register', ...regBody,
                           sig: sign(id.privateKey, regBody) }),
  label: cfg.name || 'verifier',
  // Registration is a handshake, not a broadcast: retried until the hub
  // answers, because one lost frame used to leave a live but anonymous
  // connection that nothing ever noticed.
  ackType: 'registered',
  onMessage: (msg) => {
    // `checkpoint` 自己的頂層 cp 是 Hub 的 checkpoint 而不是對等戳記，
    // 要排除——否則比對的是自己跟自己（第一版就這樣寫了）。
    if (msg.cp && msg.type !== 'checkpoint') {
      cpw.check(msg.cp, `${msg.type} sender`);
    }
    switch (msg.type) {
      case 'checkpoint':
        cpw.observeEntry({ cp: msg.cp, sig: msg.sig },
                         typeof msg.for_seq !== 'number');
        break;
      case 'registered':
        // The hub cannot tell a healthy client from one that only
        // talks unless the client proves it heard the reply (#49).
        hub.send({ type: 'register_ack', did: id.did });  // proof we can hear (#49)
        if (msg.hub_pub) cpw.setHubPub(msg.hub_pub);
        log('registered as verifier');
        break;
      case 'verify_request': kernel.onVerifyRequest(msg); break;
      case 'reveal_request': kernel.onRevealRequest(msg); break;
      // #38：取回託管的押注（被測夠且通過率過關才會准）。取回即退出 pool，
      // 所以這是「收工」的動作，不是資金調度。
      case 'stake':
        log(`stake released ${msg.released_cc} CC, still escrowed ` +
            `${msg.stake_cc} CC, in_pool=${msg.in_pool}`);
        break;
      case 'error':
        log(`hub refused: ${msg.why}`);
        break;
    }
  },
}));

// 退還請求由節點自己發起（Hub 不會替人決定收工）。簽的是授權上限，實際退還
// 的是 min(上限, 託管餘額)——託管持續進行，節點手上的數字永遠稍舊。
if (cfg.releaseStakeAfterMs > 0) {
  setTimeout(() => {
    const body = { did: id.did, amount_cc: cfg.releaseStakeMaxCc || 5, stake: 'release' };
    hub.send({ type: 'stake_release', ...body, sig: sign(id.privateKey, body) });
    log('requested stake release');
  }, cfg.releaseStakeAfterMs).unref();
}

kernel = require('./lib/verifier-kernel').create(
  { id, box, log, send: (m) => hub.send(m), cfg });

console.log(`DID ${cfg.name} ${id.did}`);
