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
const cfg = process.env.AGENT_CONFIG
  ? JSON.parse(process.env.AGENT_CONFIG)
  : JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
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
        cpw.observe(msg.cp.seq, msg.cp.root,
                    typeof msg.for_seq !== 'number');
        break;
      case 'registered':
        // The hub cannot tell a healthy client from one that only
        // talks unless the client proves it heard the reply (#49).
        hub.send({ type: 'register_ack', did: id.did });  // proof we can hear (#49)
        log('registered as verifier');
        break;
      case 'verify_request': kernel.onVerifyRequest(msg); break;
      case 'reveal_request': kernel.onRevealRequest(msg); break;
    }
  },
}));

kernel = require('./lib/verifier-kernel').create(
  { id, box, log, send: (m) => hub.send(m), cfg });

console.log(`DID ${cfg.name} ${id.did}`);
