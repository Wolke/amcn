// W10 强制里程碑的後半：第二個 ITransport 實作（§4 #10）。
//
// 為什麼需要這支 demo：§2.1 允許 MVP 把撮合/傳輸集中化，但條件是配齊
// 「協議內發現與輪替機制、至少一個開源替代實作、狀態可由公開簽署事件重建」。
// 發現（#14）與重建（#17）已有 demo，可替換性一直只是承諾——`lib/wire.js`
// 從第一個 commit 就直接 require('node:net')，換傳輸層等於改每一個呼叫端。
//
// 這支 demo 斷言的不是「兩種傳輸都能連上」，而是**同一場閉環在兩種傳輸下
// 產生同一本帳**：收據數、事件數、餘額分布、信用額度、驗收方式全等，
// 摘要成一個 fingerprint 比對。傳輸層若滲入任何語義（漏 frame、重排訊息、
// 改版本閘門），fingerprint 就會分岔。
//
// 另外斷言混用傳輸時**雙方都明確拒絕**。這是從 #36 學到的教訓：靜默卡住
// 的網路比崩掉的網路更難查——那次是 21/39 筆任務無聲未結算。
//
// 約 35 秒（跑兩次 demo.js）。可用 DEMO_PORT_OFFSET 與跑中的試點並存。
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const T = require('./lib/transport');

const BASE_OFFSET = Number(process.env.DEMO_PORT_OFFSET || 500);
// 兩次 demo.js 各自需要一整組埠（hub/beacon/fake provider/console）。
// Three implementations now: the encrypted one (#44) has to produce the
// same ledger as the plaintext ones, or "replaceable transport" is not true
// of the one we would actually deploy across locations.
const KINDS = ['tcp', 'http', 'secure'];
const OFFSETS = { tcp: BASE_OFFSET, http: BASE_OFFSET + 100,
                  secure: BASE_OFFSET + 200 };
const MISMATCH_PORT = 47900 + BASE_OFFSET;
const RUN_TIMEOUT_MS = 90000;

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// 跑一次完整的 demo.js，只回報它的結論——把 21 項斷言的輸出原樣轉印會把
// 這支 demo 自己的結果埋掉。
function runDemo(kind) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'demo.js')], {
      env: { ...process.env, AMCN_TRANSPORT: kind,
             DEMO_PORT_OFFSET: String(OFFSETS[kind]) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      out += '\n[demo-transport] TIMEOUT\n';
      p.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      const line = (re) => (out.match(re) || [])[0] || '';
      resolve({
        kind, code, out,
        fingerprint: (out.match(/ledger fingerprint: ([0-9a-f]{64})/) || [])[1] || null,
        summary: line(/結果：\d+\/\d+ PASS/),
        announced: new RegExp(`\\[hub\\] listening on .* — ${kind} transport`).test(out),
        fails: out.split('\n').filter((l) => l.includes('  FAIL  ')),
      });
    });
  });
}

// 兩個方向的混用：一端只講 tcp，另一端只講 http。斷言「雙方都出聲」，
// 所以拿 console.error 當成測量對象。
function mismatch(serverKind, clientKind, port) {
  return new Promise((resolve) => {
    const lines = [];
    const real = console.error;
    console.error = (...a) => { lines.push(a.join(' ')); };
    const server = T.get(serverKind).listen({
      port, host: '127.0.0.1',
      onChannel: (c) => c.onMessage((m) => lines.push(`SERVER ACCEPTED ${m.type}`)),
      onListening: () => {
        const c = T.get(clientKind).dial({ port, host: '127.0.0.1' });
        c.send({ type: 'export' });
        setTimeout(() => {
          console.error = real;
          c.close();
          server.close();
          resolve({
            serverSpoke: lines.some((l) => /refused a[n]? \w+ peer/.test(l)),
            clientSpoke: lines.some((l) => /refused (us|the stream)/.test(l)),
            accepted: lines.some((l) => l.startsWith('SERVER ACCEPTED')),
            lines,
          });
        }, 1200);
      },
    });
  });
}

async function main() {
  console.log('== W10: 第二個 ITransport 實作 — 同一本帳，兩種傳輸 ==');
  console.log(`   可用實作：${T.names().join(', ')}\n`);

  const runs = {};
  let i = 0;
  for (const kind of KINDS) {
    i += 1;
    console.log(`-- ${i}/${KINDS.length} ${kind}（埠偏移 ${OFFSETS[kind]}）--`);
    runs[kind] = await runDemo(kind);
    console.log(`   ${runs[kind].summary || '(無結論)'}  ` +
      `fingerprint ${runs[kind].fingerprint || '(無)'}`);
  }
  console.log('');
  const tcp = runs.tcp, http = runs.http, secure = runs.secure;
  for (const r of Object.values(runs)) r.fails.forEach((l) => console.log(`   ${r.kind}${l}`));

  const httpAtTcp = await mismatch('tcp', 'http', MISMATCH_PORT);
  const tcpAtHttp = await mismatch('http', 'tcp', MISMATCH_PORT + 1);
  let unknown = null;
  try { T.get('quic'); } catch (err) { unknown = err.message; }

  console.log('== 驗收檢查 ==');

  check('tcp：既有 21 項斷言全過（重構未改行為）',
    tcp.code === 0 && /^結果：(\d+)\/\1 PASS$/.test(tcp.summary), tcp.summary);
  check('http：同一場 demo 在第二實作上全過',
    http.code === 0 && /^結果：(\d+)\/\1 PASS$/.test(http.summary), http.summary);
  check('secure：加密實作上同樣全過（#44）',
    secure.code === 0 && /^結果：(\d+)\/\1 PASS$/.test(secure.summary), secure.summary);
  const prints = KINDS.map((k) => runs[k].fingerprint);
  check('§2.1 可替換性：三種傳輸產生同一本帳（fingerprint 相同）',
    !!prints[0] && new Set(prints).size === 1,
    new Set(prints).size === 1
      ? `${(prints[0] || '').slice(0, 16)}… 相同（收據/事件/餘額/額度/驗收方式全等）`
      : KINDS.map((k, n) => `${k} ${prints[n]}`).join(' vs '));
  check('三次執行真的用了各自的傳輸（Hub 啟動 log 自報）',
    KINDS.every((k) => runs[k].announced),
    KINDS.map((k) => `${k} ${runs[k].announced}`).join(', '));
  check('混用傳輸（http client → tcp hub）：雙方都明確拒絕，不是靜默卡住',
    httpAtTcp.serverSpoke && httpAtTcp.clientSpoke && !httpAtTcp.accepted,
    `server 出聲 ${httpAtTcp.serverSpoke}, client 出聲 ${httpAtTcp.clientSpoke}`);
  check('混用傳輸（tcp client → http hub）：雙方都明確拒絕，不是靜默卡住',
    tcpAtHttp.serverSpoke && tcpAtHttp.clientSpoke && !tcpAtHttp.accepted,
    `server 出聲 ${tcpAtHttp.serverSpoke}, client 出聲 ${tcpAtHttp.clientSpoke}`);
  check('未知傳輸名稱立即失敗並列出可用實作',
    !!unknown && unknown.includes('tcp') && unknown.includes('http'), unknown);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  if (failed) {
    console.log('\n--- 失敗時可看完整輸出 ---');
    for (const k of KINDS) console.log(runs[k].out.split('\n').slice(-20).join('\n'));
  }
  process.exit(failed ? 1 : 0);
}

main();
