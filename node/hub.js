// Coordination Hub — the "first sequencer, not a trust root" (proposal B).
// It relays signed messages and applies DUAL-SIGNED receipts to a
// conservation-checked ledger. It cannot forge a settlement: without both
// signatures a receipt is rejected, and the full receipt log is exportable
// so anyone can rebuild every balance (SDD §20-4, NFR-006).
//
// It also keeps a raw log of every inbound protocol line, so the demo can
// prove no API key ever crossed the wire (SDD §20-1/6, P-02).
'use strict';
const { attachLineReader, sendLine, verify, canon, net } = require('./lib/wire');

const PORT = Number(process.env.HUB_PORT || 47180);
const CREDIT_LINE = Number(process.env.DEMO_CREDIT_LINE || 100); // per agent
const FEE_RATE = 0.025;
const TREASURY = 'protocol:treasury';

const agents = new Map();   // did -> {pub, sock}
const balances = new Map(); // account -> number
const receipts = [];        // settled, dual-signed
const rawLog = [];          // every inbound line (key-leak scan surface)

const bal = (a) => balances.get(a) || 0;
const addBal = (a, d) => balances.set(a, bal(a) + d);

function broadcast(obj, exceptDid) {
  for (const [did, a] of agents) if (did !== exceptDid) sendLine(a.sock, obj);
}

function fail(sock, why, ref) {
  sendLine(sock, { type: 'error', why, ref });
  console.log(`[hub] REJECT ${ref || ''}: ${why}`);
}

function handleReceipt(msg, sock) {
  const { receipt, sigs } = msg;
  const req = agents.get(receipt.requester);
  const prov = agents.get(receipt.provider);
  if (!req || !prov) return fail(sock, 'unknown party', receipt.contract_id);
  if (!verify(req.pub, receipt, sigs.requester) ||
      !verify(prov.pub, receipt, sigs.provider)) {
    return fail(sock, 'bad signature: dual-signed receipt required',
      receipt.contract_id);
  }
  const sum = receipt.postings.reduce((s, p) => s + p.amount_cc, 0);
  if (Math.abs(sum) > 1e-9) {
    return fail(sock, `postings sum ${sum} != 0`, receipt.contract_id);
  }
  // credit-line check: no posting may push an agent below -CREDIT_LINE
  for (const p of receipt.postings) {
    if (agents.has(p.account) && bal(p.account) + p.amount_cc < -CREDIT_LINE) {
      return fail(sock, `${p.account} would exceed credit line`, receipt.contract_id);
    }
  }
  for (const p of receipt.postings) addBal(p.account, p.amount_cc);
  receipts.push({ receipt, sigs });
  console.log(`[hub] SETTLED ${receipt.contract_id}: ` +
    receipt.postings.map((p) => `${p.account}=${p.amount_cc.toFixed(2)}`).join(' '));
  broadcast({ type: 'settled', receipt });
}

const server = net.createServer((sock) => {
  attachLineReader(sock, (msg) => {
    switch (msg.type) {
      case 'register': {
        if (!verify(msg.pub, { did: msg.did, pub: msg.pub }, msg.sig)) {
          return fail(sock, 'bad register signature', msg.did);
        }
        agents.set(msg.did, { pub: msg.pub, sock });
        balances.set(msg.did, bal(msg.did));
        sendLine(sock, { type: 'registered', did: msg.did, credit_line: CREDIT_LINE, fee_rate: FEE_RATE });
        console.log(`[hub] registered ${msg.did}`);
        break;
      }
      case 'task': {
        const req = agents.get(msg.task.requester);
        if (!req || !verify(req.pub, msg.task, msg.sig)) {
          return fail(sock, 'bad task signature', msg.task.task_id);
        }
        console.log(`[hub] task ${msg.task.task_id} broadcast (${msg.task.units}u, max ${msg.task.max_price_cc} CC)`);
        broadcast(msg, msg.task.requester);
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
          raw_log: rawLog.join('\n'),
        });
        break;
      }
    }
  }, (line) => rawLog.push(line));
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`[hub] listening on ${PORT}, credit line ${CREDIT_LINE} CC, fee ${FEE_RATE * 100}%`));
module.exports = { canon };
