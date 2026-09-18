// Cross-observer checkpoint comparison (登記簿 #69c).
//
// #69a/#69b made a forked checkpoint chain detectable — but only by someone
// holding artefacts from both branches, and nothing in the protocol ever put
// anyone in that position: every node learns roots from the same hub, and no
// message carried another node's view. F6c recorded that as open: detection
// was possible and never performed.
//
// This is the minimal mechanism that closes it. Nodes stamp the peer-directed
// messages they already send with the latest (seq, root) they have seen, and
// the receiver compares it against its own. A hub telling two peers different
// stories is then caught the first time those peers talk to each other, which
// they do constantly — bids, contracts, deliveries, attestations.
//
// Deliberately not consensus: nobody votes and nothing is rejected. The claim
// is only that equivocation stops being invisible, which is what §2.2 stakes
// the "first sequencer is not a trust root" position on.
//
// One subtlety that would otherwise produce false forks. Minting is
// unconditional but storage is sparse (#41), so a root broadcast at seq N may
// never be stored; an agent that later *asks* for seq N is answered with the
// stored entry at or before N, and agent.js records that answer under the seq
// it asked for. Two honest agents can therefore hold different roots for the
// same seq — one the minted root, the other an alias of an earlier one. Only
// roots learned from a broadcast are comparable, so aliases are kept apart
// and never stamped or checked.
'use strict';

const KEEP = Number(process.env.AMCN_CPWATCH_KEEP || 500);

function create(log = () => {}) {
  const minted = new Map();   // seq -> root, broadcast only: comparable
  const alias = new Map();    // seq -> root, answers to checkpoint_request
  let latest = -1;
  const forks = [];

  const trim = (m) => {
    if (m.size <= KEEP) return;
    for (const k of [...m.keys()].sort((a, b) => a - b).slice(0, m.size - KEEP)) {
      m.delete(k);
    }
  };

  return {
    // fromBroadcast=false marks an answer to checkpoint_request, which may be
    // an earlier entry recorded under the asked-for seq.
    observe(seq, root, fromBroadcast = true) {
      if (typeof seq !== 'number' || typeof root !== 'string') return;
      if (fromBroadcast) {
        minted.set(seq, root);
        if (seq > latest) latest = seq;
        trim(minted);
      } else {
        alias.set(seq, root);
        trim(alias);
      }
    },
    rootAt(seq) {
      return minted.has(seq) ? minted.get(seq) : alias.get(seq);
    },
    // What to attach to an outgoing peer message. null before anything is seen.
    stamp() {
      return latest < 0 ? null : { seq: latest, root: minted.get(latest) };
    },
    // Returns a description of the conflict, or null. A seq we have not seen
    // is not a conflict — it means one of us is behind, which is normal.
    check(peer, who = 'peer') {
      if (!peer || typeof peer.seq !== 'number' || typeof peer.root !== 'string') {
        return null;
      }
      const mine = minted.get(peer.seq);
      if (mine === undefined || mine === peer.root) return null;
      const why = `checkpoint #${peer.seq} fork: ${who} reports root ` +
        `${peer.root.slice(0, 12)}, we minted ${mine.slice(0, 12)} — the hub ` +
        'has told us different stories (§4 #69c)';
      forks.push({ seq: peer.seq, mine, theirs: peer.root, who, at: Date.now() });
      log(`FORK DETECTED — ${why}`);
      return why;
    },
    forks: () => forks.slice(),
    forkCount: () => forks.length,
  };
}

module.exports = { create, KEEP };
