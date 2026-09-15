#!/usr/bin/env node
// Diagnose §4 #18: cross-machine UDP hub discovery does not work, and it is
// still undetermined whether the cause is the network or the beacon code.
// The demo's discovery check is same-host, so it cannot answer this.
//
// Two modes, run at the same time on two machines:
//
//   listen   on the machine that failed to discover (machine 2 / Windows):
//              node discovery-probe.js listen
//            Reports every UDP datagram on the beacon port with its source,
//            and whether it parses and verifies as a hub beacon.
//
//   send     on the hub machine, to emit test datagrams without touching the
//            running hub:
//              node discovery-probe.js send
//            Prints every target address it sends to, so "we broadcast to
//            192.168.1.255" becomes checkable rather than assumed.
//
// If listen sees nothing while send reports targets that include the
// listener's subnet broadcast, the packets are being dropped in the network
// (Wi-Fi client/AP isolation, guest network, separate interfaces, or a host
// firewall) and the beacon code is not at fault. If listen sees datagrams but
// rejects them, the fault is in the beacon.
'use strict';
const dgram = require('node:dgram');
const os = require('node:os');
const discovery = require('./lib/discovery');
const { verify, sha256 } = require('./lib/wire');

const mode = process.argv[2];
const PORT = Number(process.env.HUB_BEACON_PORT || discovery.BEACON_PORT);

function interfaces() {
  const rows = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      rows.push({
        name, address: a.address, netmask: a.netmask,
        broadcast: ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'),
      });
    }
  }
  return rows;
}

function printInterfaces() {
  console.log('本機 IPv4 介面：');
  for (const r of interfaces()) {
    console.log(`  ${r.name.padEnd(10)} ${r.address.padEnd(16)} ` +
      `mask ${r.netmask.padEnd(16)} broadcast ${r.broadcast}`);
  }
  if (interfaces().length > 1) {
    console.log('  ⚠ 多個介面：兩台若各自走不同介面（例如一台有線一台無線），');
    console.log('    廣播不會跨過去——這是 #18 最常見的成因之一。');
  }
  console.log('');
}

function listen() {
  printInterfaces();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let n = 0;
  sock.on('error', (err) => {
    console.error(`socket error: ${err.code || err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error('  該埠已被占用——本機是否正跑著 agent 或 hub？');
    }
    process.exit(1);
  });
  sock.on('message', (buf, rinfo) => {
    n += 1;
    let m = null;
    try { m = JSON.parse(buf.toString('utf8')); } catch { /* not ours */ }
    if (m && m.type === 'probe') {
      // Only a datagram from an address that is not ours proves anything
      // about crossing machines. Saying "cross-machine" for a local loop
      // would be the same false-green the demo's same-host discovery check
      // produced (§4 #18 is on the registry because of exactly that).
      const local = new Set(interfaces().map((r) => r.address));
      const remote = !local.has(rinfo.address) && rinfo.address !== '127.0.0.1';
      console.log(`#${n} probe seq ${m.seq} 自 ${rinfo.address}` +
        ` (發送端介面 ${(m.from || []).join('/')}) — ` +
        (remote ? '跨機抵達 ✓' : '同機迴路（不證明跨機）'));
      return;
    }
    if (!m || m.type !== 'hub_beacon') {
      console.log(`#${n} 收到 ${buf.length}B 自 ${rinfo.address}:${rinfo.port}` +
        ' — 既非 probe 也非 hub_beacon（其他廣播流量）');
      return;
    }
    const { sig, ...body } = m;
    const sigOk = verify(m.pub, body, sig);
    const age = Date.now() - m.ts;
    const did = 'did:demo:' + sha256(m.pub).slice(0, 16);
    const local = new Set(interfaces().map((r) => r.address));
    const remote = !local.has(rinfo.address) && rinfo.address !== '127.0.0.1';
    console.log(`#${n} hub_beacon 自 ${rinfo.address} → hub ` +
      `${rinfo.address}:${m.port}  簽章 ${sigOk ? 'OK' : '失敗'}  ` +
      `時差 ${age}ms  ${did}  ${remote ? '跨機 ✓' : '同機迴路'}`);
    if (!sigOk) console.log('   ⚠ 簽章驗不過 → 問題在 beacon 程式，不在網路');
    else if (Math.abs(age) > 60000) {
      console.log('   ⚠ 時差超過 60s，discoverHub 會拒絕它 → 兩台時鐘不同步');
    }
  });
  sock.bind(PORT, () => {
    console.log(`監聽 udp/${PORT}，等待 hub beacon（Ctrl-C 結束）…`);
    console.log('Hub 每秒廣播一次，所以 5 秒內沒有任何一行就代表封包沒到。\n');
  });
  setInterval(() => {
    if (n === 0) {
      console.log('…仍未收到任何封包。若 send 端顯示的 broadcast 位址' +
        '涵蓋本機網段，就是網路在丟包（AP isolation／訪客網路／防火牆）。');
    }
  }, 10000).unref();
}

function send() {
  printInterfaces();
  const targets = discovery.beaconTargets('0.0.0.0');
  console.log('beaconTargets("0.0.0.0") 會送往：', targets.join(', '));
  console.log('（這就是跑中的 Hub 使用的同一份清單）\n');

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.bind(() => {
    try { sock.setBroadcast(true); } catch (e) {
      console.error(`setBroadcast 失敗：${e.message} — 本機不允許廣播`);
    }
    let i = 0;
    const tick = () => {
      i += 1;
      const payload = Buffer.from(JSON.stringify({
        type: 'probe', seq: i, from: interfaces().map((r) => r.address), ts: Date.now(),
      }));
      for (const to of targets) {
        sock.send(payload, 0, payload.length, PORT, to, (err) => {
          console.log(`#${i} → ${to}:${PORT} ${err ? '失敗: ' + err.message : '已送出'}`);
        });
      }
    };
    console.log(`每秒送出測試封包到 udp/${PORT}（Ctrl-C 結束）…\n`);
    tick();
    setInterval(tick, 1000);
  });
}

// The decisive test: run the exact path an agent runs, with no registration
// and no side effects. listen proves datagrams arrive; this proves whether
// resolveHubTarget does anything with them.
async function resolveTest() {
  printInterfaces();
  const cfg = { hubHost: 'discover', hubPort: null, beaconPort: PORT,
                hubPin: process.argv[3] || null };
  console.log(`呼叫 resolveHubTarget（agent 使用的同一函式），` +
    `beaconPort ${PORT}${cfg.hubPin ? `, pin ${cfg.hubPin}` : ''}…`);
  const t0 = Date.now();
  const target = await discovery.resolveHubTarget(cfg, (m) => console.log(`  [agent log] ${m}`));
  const ms = Date.now() - t0;
  console.log(`\n結果（${ms}ms）：host ${target.host}, port ${target.port}`);
  if (target.host === '127.0.0.1' && !cfg.hubPin) {
    console.log('→ 退回 127.0.0.1，代表發現失敗（#18 重現）');
  } else {
    console.log('→ 發現成功，#18 在這台機器上不重現');
  }
  process.exit(0);
}

if (mode === 'resolve') resolveTest();
else if (mode === 'listen') listen();
else if (mode === 'send') send();
else {
  console.log('用法：');
  console.log('  在無法發現 Hub 的那台：  node discovery-probe.js listen');
  console.log('  在 Hub 那台：            node discovery-probe.js send');
  console.log('  測真實發現路徑：          node discovery-probe.js resolve [pin]');
  console.log('');
  printInterfaces();
  process.exit(1);
}
