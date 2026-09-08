// Coordination Hub — the "first sequencer, not a trust root" (proposal B).
//
// Phase 1 upgrades over the first prototype:
// - dynamic credit lines via the E_eff formula shared with the simulator
//   (lib/eeff.js): earnings from concentrated counterparties don't grow
//   credit — the anti-wash property runs live in the hub
// - risk fee (6% thin / 2% established) into protocol:insurance (F-2)
// - relays E2E-sealed payload boxes; sees metadata only (NFR-005)
//
// It still cannot forge a settlement: receipts must be dual-signed, sum
// to zero, match the fee schedule, and stay within credit lines. The full
// receipt log is exportable so anyone can rebuild every balance (§20-4).
'use strict';
const { attachLineReader, sendLine, verify, net } = require('./lib/wire');
const eeff = require('./lib/eeff');

const PORT = Number(process.env.HUB_PORT || 47180);
const TREASURY = 'protocol:treasury';
const INSURANCE = 'protocol:insurance';

const agents = new Map();   // did -> {pub, boxPub, sock, stats}
const balances = new Map(); // account -> number
const receipts = [];
const rawLog = [];

const bal = (a) => balances.get(a) || 0;
const addBal = (a, d) => balances.set(a, bal(a) + d);
const statsOf = (did) => agents.get(did)?.stats;
const clOf = (did) =>
  agents.has(did) ? eeff.creditLine(did, agents.get(did).stats, statsOf) : 0;

function broadcast(obj, exceptDid) {
  for (const [did, a] of agents) if (did !== exceptDid) sendLine(a.sock, obj);
}
function fail(sock, why, ref) {
  sendLine(sock, { type: 'error', why, ref });
  console.log(`[hub] REJECT ${ref || ''}: ${why}`);
}

function feeTerms(requesterDid, price) {
  const fee = +(price * eeff.FEE_RATE).toFixed(4);
  const risk = +(price * eeff.riskRate(agents.get(requesterDid).stats)).toFixed(4);
  return { fee, risk };
}

function handleReceipt(msg, sock) {
  const { receipt, sigs } = msg;
  const req = agents.get(receipt.requester);
  const prov = agents.get(receipt.provider);
  const ref = receipt.contract_id;
  if (!req || !prov) return fail(sock, 'unknown party', ref);
  if (!verify(req.pub, receipt, sigs.requester) ||
      !verify(prov.pub, receipt, sigs.provider)) {
    return fail(sock, 'bad signature: dual-signed receipt required', ref);
  }
  const sum = receipt.postings.reduce((s, p) => s + p.amount_cc, 0);
  if (Math.abs(sum) > 1e-9) return fail(sock, `postings sum ${sum} != 0`, ref);

  // postings must match the published fee schedule exactly
  const price = -receipt.postings.find((p) => p.account === receipt.requester).amount_cc;
  const { fee, risk } = feeTerms(receipt.requester, price);
  const expect = {
    [receipt.provider]: +(price - fee - risk).toFixed(4),
    [TREASURY]: fee,
    [INSURANCE]: risk,
  };
  for (const [acct, amt] of Object.entries(expect)) {
    const p = receipt.postings.find((x) => x.account === acct);
    if (!p || Math.abs(p.amount_cc - amt) > 1e-6) {
      return fail(sock, `posting ${acct} != fee schedule (${amt})`, ref);
    }
  }
  // dynamic credit-line check (E_eff)
  for (const p of receipt.postings) {
    if (agents.has(p.account) &&
        bal(p.account) + p.amount_cc < -clOf(p.account) - 1e-9) {
      return fail(sock,
        `${p.account} would exceed credit line ${clOf(p.account).toFixed(1)}`, ref);
    }
  }
  for (const p of receipt.postings) addBal(p.account, p.amount_cc);
  req.stats.paidTo.set(receipt.provider,
    (req.stats.paidTo.get(receipt.provider) || 0) + price);
  prov.stats.earnedBy.set(receipt.requester,
    (prov.stats.earnedBy.get(receipt.requester) || 0) + price - fee - risk);
  prov.stats.completed += 1;
  receipts.push({ receipt, sigs });
  console.log(`[hub] SETTLED ${ref}: ` + receipt.postings
    .map((p) => `${p.account.slice(0, 18)}=${p.amount_cc.toFixed(2)}`).join(' ') +
    ` | CL ${receipt.provider.slice(0, 18)}→${clOf(receipt.provider).toFixed(1)}`);
  broadcast({ type: 'settled', receipt });
}

const server = net.createServer((sock) => {
  attachLineReader(sock, (msg) => {
    switch (msg.type) {
      case 'register': {
        const body = { did: msg.did, pub: msg.pub, box_pub: msg.box_pub };
        if (!verify(msg.pub, body, msg.sig)) {
          return fail(sock, 'bad register signature', msg.did);
        }
        agents.set(msg.did, {
          pub: msg.pub, boxPub: msg.box_pub, sock, stats: eeff.newStats(),
        });
        balances.set(msg.did, bal(msg.did));
        sendLine(sock, {
          type: 'registered', did: msg.did,
          credit_line: clOf(msg.did),
          fee_rate: eeff.FEE_RATE,
        });
        console.log(`[hub] registered ${msg.did} (CL ${clOf(msg.did).toFixed(1)} CC)`);
        break;
      }
      case 'task': {
        const req = agents.get(msg.task.requester);
        if (!req || !verify(req.pub, msg.task, msg.sig)) {
          return fail(sock, 'bad task signature', msg.task.task_id);
        }
        console.log(`[hub] task ${msg.task.task_id} broadcast ` +
          `(${msg.task.units}u, max ${msg.task.max_price_cc} CC, payload sealed)`);
        broadcast(msg, msg.task.requester);
        break;
      }
      case 'fee_quote': { // requester asks for the exact fee split
        const { fee, risk } = feeTerms(msg.requester, msg.price);
        sendLine(sock, { type: 'fee_terms', contract_id: msg.contract_id,
                         price: msg.price, fee, risk });
        break;
      }
      case 'bid': case 'contract': case 'delivery': case 'receipt_half': {
        const to = agents.get(msg.to);
        if (to) sendLine(to.sock, msg); // hub relays; parties verify sigs E2E
        break;
      }
      case 'receipt': handleReceipt(msg, sock); break;
      case 'export': {
        sendLine(sock, {
          type: 'ledger_export',
          receipts,
          pubkeys: Object.fromEntries([...agents].map(([d, a]) => [d, a.pub])),
          balances: Object.fromEntries(balances),
          credit_lines: Object.fromEntries([...agents.keys()].map((d) => [d, clOf(d)])),
          raw_log: rawLog.join('\n'),
        });
        break;
      }
    }
  }, (line) => rawLog.push(line));
});

server.listen(PORT, '127.0.0.1', () => console.log(
  `[hub] listening on ${PORT} — starter CL ${eeff.STARTER_CC} CC (dynamic E_eff), ` +
  `fee ${eeff.FEE_RATE * 100}%, risk ${eeff.RISK_THIN * 100}%/${eeff.RISK_BASE * 100}%`));
