// Cross-network discovery and rotation (§4 #45).
//
// lib/discovery.js is a UDP broadcast beacon, which no cross-subnet or NAT
// path carries. The acceptance environment is machines in different places,
// so there hubHost could only ever be a fixed address — and moving the hub
// would go back to hand-editing every machine, which is exactly what #14
// fixed on a LAN. §2.1 makes in-protocol discovery *and rotation* a binding
// condition for centralising transport, so on a WAN that condition does not
// currently hold.
//
// A rendezvous record is the smallest thing that restores it: the hub
// publishes a signed {host, port, did, ts}, clients re-resolve it on every
// reconnect attempt (#40 already re-resolves), and `hubPin` decides whether
// to believe it. The host serving the record is untrusted infrastructure —
// it can withhold or serve something stale, but it cannot impersonate the
// hub, because the record carries the hub's signature and the client checks
// it against the pinned DID.
//
// Deliberately not a service AMCN runs: the record is a file. Publish it
// wherever you already have something stable — an object store, a static
// web host, a repo — with whatever tool you already use. A local path works
// too, which is what the chaos scenarios use to exercise rotation with no
// infrastructure at all.
'use strict';
const fs = require('node:fs');
const { sign, verify, canon } = require('./wire');
const { didOf } = require('./discovery');

const MAX_AGE_MS = Number(process.env.AMCN_RENDEZVOUS_MAX_AGE_MS || 600000);

function record(hubId, { host, port }) {
  const body = { type: 'hub_rendezvous', host, port, pub: hubId.pub,
                 ts: Date.now() };
  return { ...body, sig: sign(hubId.privateKey, body) };
}

// Written to a temp path and renamed, so a reader never sees half a record.
function publish(hubId, target, where) {
  const rec = record(hubId, target);
  const tmp = `${where}.tmp`;
  fs.mkdirSync(require('node:path').dirname(where), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, where);
  return rec;
}

function check(rec, { pin = null, maxAgeMs = MAX_AGE_MS } = {}) {
  if (!rec || rec.type !== 'hub_rendezvous' || typeof rec.port !== 'number') {
    return { ok: false, why: 'not a rendezvous record' };
  }
  const { sig, ...body } = rec;
  if (!verify(rec.pub, body, sig)) return { ok: false, why: 'bad signature' };
  const age = Date.now() - rec.ts;
  if (age > maxAgeMs) {
    return { ok: false, why: `stale by ${Math.round((age - maxAgeMs) / 1000)}s` };
  }
  const did = didOf(rec.pub);
  // A pinned client must not follow a record signed by anyone else — that is
  // the whole point of the pin, and the reason an untrusted host can serve
  // this file.
  if (pin && pin !== did) return { ok: false, why: `signed by ${did}, not the pinned hub` };
  return { ok: true, host: rec.host, port: rec.port, did, pub: rec.pub, ageMs: age };
}

async function read(where) {
  if (/^https?:\/\//.test(where)) {
    const res = await fetch(where, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(where, 'utf8'));
}

async function resolve(where, opts = {}) {
  try {
    return check(await read(where), opts);
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

module.exports = { record, publish, check, resolve, read, MAX_AGE_MS };
