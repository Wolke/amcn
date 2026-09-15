#!/usr/bin/env node
// Dedicated Verifier panel host — the machine-3 role from INSTALL.md §6.
//
// §4 #31: running the panel on the same machine as the trading agents makes
// "2-of-3 quorum" decoration at the deployment level — one host, one OS, one
// owner, one failure domain, which is what FR-041's random selection exists
// to prevent. This launcher exists so moving the panel to its own machine is
// one command instead of three configs and three terminals.
//
// Cross-platform on purpose: plain Node, so Windows needs no PowerShell
// execution-policy change and no shell-quoted JSON (§4 #32).
//
// Usage:
//   node panel.js 192.168.1.10          hub IP (required for a remote hub)
//   node panel.js 192.168.1.10 47180 5  hub IP, hub port, panel size
//   node panel.js                       defaults to 127.0.0.1:47180, 3 nodes
//
// A Verifier needs no API key, no model, and no credit: it only needs to
// reach the hub. Ctrl-C stops the whole panel.
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const [hostArg, portArg, sizeArg] = process.argv.slice(2);
const HOST = hostArg || '127.0.0.1';
const PORT = Number(portArg || 47180);
const SIZE = Number(sizeArg || 3);

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Node ${process.versions.node} is too old — AMCN needs >= 20.`);
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`bad hub port: ${portArg}`);
  process.exit(1);
}
if (!Number.isInteger(SIZE) || SIZE < 1 || SIZE > 20) {
  console.error(`bad panel size: ${sizeArg}`);
  process.exit(1);
}

// Fail with a useful message rather than three verifiers retrying quietly.
function probe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  // Give them a moment to close their hub sockets before exiting.
  setTimeout(() => process.exit(code), 300);
}

async function main() {
  console.log(`AMCN Verifier panel → hub ${HOST}:${PORT}, ${SIZE} verifiers`);
  console.log('（Verifier 不需要 API key、不需要模型、不參與信用）\n');

  if (!await probe(HOST, PORT)) {
    console.error(`cannot reach the hub at ${HOST}:${PORT}.`);
    console.error('  - is the hub running there with HUB_BIND=0.0.0.0 ?');
    console.error('  - same subnet, and the host firewall allowing inbound ' +
      `TCP ${PORT} on that machine?`);
    console.error('  - check the IP with `ipconfig getifaddr en0` (macOS) or ' +
      '`ipconfig` (Windows) on the hub machine.');
    process.exit(1);
  }
  console.log(`hub reachable at ${HOST}:${PORT}\n`);

  let registered = 0;
  for (let i = 1; i <= SIZE; i++) {
    const cfg = { name: `V${i}`, hubHost: HOST, hubPort: PORT };
    const child = spawn(process.execPath, [path.join(__dirname, 'verifier.js')], {
      env: { ...process.env, AGENT_CONFIG: JSON.stringify(cfg) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const tag = `V${i}`;
    const relay = (buf, stream) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        stream.write(`  [${tag}] ${line}\n`);
        if (line.includes('registered as verifier')) {
          registered += 1;
          if (registered === SIZE) {
            console.log(`\n全部 ${SIZE} 個 Verifier 已向 Hub 註冊。` +
              'Ctrl-C 停止整個 panel。\n');
          }
        }
      }
    };
    child.stdout.on('data', (b) => relay(b, process.stdout));
    child.stderr.on('data', (b) => relay(b, process.stderr));
    child.on('exit', (code) => {
      if (stopping) return;
      console.error(`  [${tag}] exited (code ${code}) — stopping the panel so ` +
        'a partial panel does not look healthy');
      stopAll(1);
    });
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\nstopping panel…');
      stopAll(0);
    });
  }
}

main();
