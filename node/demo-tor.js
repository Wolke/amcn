// #89 的閘門：不需要對外開任何埠的傳輸。
//
// 這支**不需要安裝 tor、也不會啟動任何 onion service**。它自己起一個最小的
// SOCKS5 代理站在中間，因為要驗的是三件與 tor 本身無關的事：
//   1. SOCKS5 CONNECT 的交握寫對了（含 ATYP=0x03 的 domain name——`.onion`
//      在 DNS 裡不存在，必須交給代理去解，這正是客戶端不需要知道對方在哪
//      的原因）；
//   2. 這條路拿到的帳與直連 tcp **完全相同**（framing 與信封版本閘門都仍然
//      是 lib/channel.js 的那一份，不是自己另做一套）；
//   3. 失敗會**說出原因**：代理不在、或代理回 REP=0x04（onion 不存在／服務
//      沒開），是兩件不同的事，而分不出來的人只會一直重試（#76 的教訓）。
//
// 真的接上 tor 之後還要量的是延遲與長連線穩定度，那需要一個真的 onion
// service，屬於 #86／#89 的現場實驗，不在這支閘門的範圍。
//
// Run:  node demo-tor.js        (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const HUB_PORT = 47180 + 600 + OFFSET;
const SOCKS_PORT = HUB_PORT + 1;
const FAKE_ONION = 'amcnhubexampleaddressnotarealonion.onion';

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 最小 SOCKS5 代理：只支援 CONNECT、無認證。`route` 決定要把請求接到哪，
// 回傳 null 就答覆 REP=0x04（主機不可達），用來模擬「onion 位址不存在」。
function socks5({ port, route }) {
  const srv = net.createServer((c) => {
    let stage = 'greet';
    c.on('error', () => c.destroy());
    c.on('data', (buf) => {
      if (stage === 'greet') {
        if (buf[0] !== 0x05) return c.destroy();
        c.write(Buffer.from([0x05, 0x00]));
        stage = 'req';
        return;
      }
      if (stage === 'req') {
        // VER CMD RSV ATYP LEN host... port(2)
        if (buf[1] !== 0x01 || buf[3] !== 0x03) {
          c.write(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0]));
          return c.destroy();
        }
        const len = buf[4];
        const host = buf.slice(5, 5 + len).toString('utf8');
        const wantPort = buf.readUInt16BE(5 + len);
        const dest = route(host, wantPort);
        if (!dest) {
          c.write(Buffer.from([0x05, 0x04, 0, 1, 0, 0, 0, 0, 0, 0]));
          return c.end();
        }
        const up = net.connect(dest.port, dest.host, () => {
          c.write(Buffer.from([0x05, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]));
          stage = 'pipe';
          c.pipe(up);
          up.pipe(c);
        });
        up.on('error', () => { c.destroy(); });
      }
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

function exportVia(kind, target) {
  // 每一次都重新載入 transport，因為實作是由環境變數選的。
  delete require.cache[require.resolve('./lib/transport')];
  process.env.AMCN_TRANSPORT = kind;
  const transport = require('./lib/transport').fromEnv();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 20000);
    const c = transport.dial(target);
    c.onMessage((m) => {
      if (m.type !== 'ledger_export') return;
      clearTimeout(t); c.close(); resolve(m);
    });
    c.send({ type: 'export' });
  });
}

const fingerprint = (ex) => ex && JSON.stringify({
  receipts: ex.receipts.length,
  events: (ex.events || []).length,
  balances: ex.balances,
  hub: ex.hub_pub,
});

async function main() {
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); realErr(...a); };

  const hub = spawn(process.execPath, [path.join(__dirname, 'hub.js')], {
    env: { ...process.env, AMCN_TRANSPORT: 'tcp', HUB_PORT: String(HUB_PORT),
           HUB_BEACON: '0', HUB_AGE_RAMP_MS: '1', HUB_SEED: 'demo-tor' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  hub.stdout.on('data', (d) => process.stdout.write(`  ${d}`));
  await sleep(1200);

  // Hub 只聽回送位址——這支閘門的前提就是「對外沒有開任何埠」。
  // 用**本機的區網位址**去連，而不是 0.0.0.0：後者在 macOS 上會被 connect(2)
  // 當成回送位址，所以那個探測永遠回 true（第一版就是這樣誤判的）。
  const lanAddr = Object.values(require('node:os').networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  const boundPublic = lanAddr ? await new Promise((resolve) => {
    const probe = net.connect(HUB_PORT, lanAddr.address);
    probe.on('connect', () => { probe.destroy(); resolve(true); });
    probe.on('error', () => resolve(false));
    setTimeout(() => { probe.destroy(); resolve(false); }, 1500);
  }) : false;

  const srv = await socks5({
    port: SOCKS_PORT,
    route: (host) => (host === FAKE_ONION ? { host: '127.0.0.1', port: HUB_PORT } : null),
  });

  console.log(`\n-- hub 127.0.0.1:${HUB_PORT}（只聽回送）｜SOCKS5 代理 :${SOCKS_PORT} --\n`);

  const base = await exportVia('tcp', { port: HUB_PORT, host: '127.0.0.1' });
  process.env.AMCN_TOR_SOCKS = `127.0.0.1:${SOCKS_PORT}`;
  const viaTor = await exportVia('tor', { port: HUB_PORT, host: FAKE_ONION });

  delete require.cache[require.resolve('./lib/transport')];
  process.env.AMCN_TRANSPORT = 'tor';
  const tor = require('./lib/transport').fromEnv();
  const reachable = await tor.probe({ host: FAKE_ONION, port: HUB_PORT, timeoutMs: 6000 });
  const missing = await tor.probe({ host: 'someoneelse.onion', port: HUB_PORT, timeoutMs: 6000 });

  process.env.AMCN_TOR_SOCKS = `127.0.0.1:${SOCKS_PORT + 7}`;   // 沒有人在聽
  const noTor = await tor.probe({ host: FAKE_ONION, port: HUB_PORT, timeoutMs: 6000 });

  console.log('\n== #89 零入向埠傳輸驗收檢查 ==');

  check('Hub 只聽回送位址（對外沒有開任何埠）', !boundPublic,
    boundPublic ? `${lanAddr.address}:${HUB_PORT} 從區網連得上` :
      `${lanAddr ? lanAddr.address : '(無區網位址)'}:${HUB_PORT} 連不上，只有回送位址`);

  check('SOCKS5 CONNECT 交握成立，經代理拿得到整本帳',
    !!viaTor && !!viaTor.receipts,
    viaTor ? `${viaTor.receipts.length} 筆收據、${(viaTor.checkpoints || []).length} 個 checkpoint`
      : '拿不到');

  check('換傳輸、帳一模一樣（framing 與版本閘門仍是同一份 channel）',
    !!base && !!viaTor && fingerprint(base) === fingerprint(viaTor),
    base && viaTor ? '兩邊 fingerprint 相同' : '其中一邊沒拿到');

  check('位址用 domain name 交給代理解析（.onion 在 DNS 裡不存在）',
    !!viaTor, `請求的主機名是 ${FAKE_ONION.slice(0, 24)}…`);

  check('probe：服務在的 onion 回 true', reachable === true, String(reachable));

  check('負對照一：不存在的 onion 被指名拒絕（REP=0x04，不是靜默逾時）',
    missing === false && errs.some((e) => /主機不可達/.test(e)),
    errs.find((e) => /主機不可達/.test(e))?.slice(0, 60) || '沒有指名的理由');

  check('負對照二：本機 tor 沒起來時說的是「連不到本機的 tor」而不是「連不到對方」',
    noTor === false && errs.some((e) => /連不到本機的 tor/.test(e)),
    errs.find((e) => /連不到本機的 tor/.test(e))?.slice(0, 70) || '沒有指名的理由');

  console.error = realErr;
  srv.close();
  hub.kill();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
