#!/usr/bin/env node
// 試點自我診斷：一個指令回答「這台為什麼連不上 Hub」。
//
// 存在的原因：三台機器的試點裡，機器 2（Windows）連不上，而診斷靠的是
// grep／nc／curl 那串 macOS 指令來回貼輸出——那些指令在 Windows 上根本不
// 存在（#32 的同一類問題）。這支只用 node，所以三台都能跑，而且它測的是
// Agent 實際會走的那條路：同一個 transport、同一套 frame、同一個版本閘門。
//
// Run:  node pilot-doctor.js <hub IP> [hub port] [設定檔]
//       node pilot-doctor.js 192.168.50.30
//       node pilot-doctor.js 192.168.50.30 47180 configs/pilot-m2.json
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const transport = require('./lib/transport').fromEnv();
const discovery = require('./lib/discovery');

const [hostArg, portArg, cfgArg] = process.argv.slice(2);
const HOST = hostArg || '127.0.0.1';
const PORT = Number(portArg || 47180);

const rows = [];
const say = (ok, name, detail) => {
  rows.push([ok, name]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同網段判斷用：把 IPv4 位址與遮罩化成網路位址比較。
const netOf = (ip, mask) => ip.split('.')
  .map((o, i) => Number(o) & Number(mask.split('.')[i])).join('.');

async function main() {
  console.log(`== AMCN 試點診斷：目標 Hub ${HOST}:${PORT}（${transport.name} transport）==\n`);

  // 1. node 版本
  const major = Number(process.versions.node.split('.')[0]);
  say(major >= 20, `Node.js ${process.versions.node} ≥ 20`,
    major >= 20 ? undefined : '請升級，AMCN 需要 ≥ 20');

  // 2. 本機位址與是否同網段——跨網段是最常見也最難從錯誤訊息看出的原因
  const mine = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) mine.push(i);
    }
  }
  // 目標是本機時沒有「網段」可談，而第一版會因此在單機起步時報一個假的
  // FAIL——推廣路上第一個看到的東西不該是一個不是問題的紅字。
  const selfTarget = ['127.0.0.1', 'localhost', '::1'].includes(HOST)
    || mine.some((i) => i.address === HOST);
  const sameNet = mine.filter((i) => netOf(i.address, i.netmask) === netOf(HOST, i.netmask));
  if (selfTarget) {
    say(true, 'Hub 就在本機（單機起步不需要網段檢查）',
      `本機 ${mine.map((i) => i.address).join(', ') || '(無對外位址)'}`);
  } else {
    say(sameNet.length > 0, '本機與 Hub 在同一網段',
      `本機 ${mine.map((i) => i.address).join(', ') || '(無對外位址)'}` +
      (sameNet.length ? '' : ` ← 都不在 ${HOST} 的網段：跨 VLAN／訪客網路／VPN 都會擋`));
  }

  // 3. 設定檔（若指定或找得到）：JSON 合法性與它實際指向哪
  // 沒有指定設定檔時，找**這台實際在用的**那一個：configs/ 下任何不是範本的
  // .json。第一版寫死三個試點檔名，所以在別人的機器上這一節永遠跳過（而那正
  // 是「有沒有固定 seed」最該被檢查的地方）。
  const cfgPath = cfgArg || (() => {
    try {
      return fs.readdirSync('configs')
        .filter((f) => f.endsWith('.json') && !f.endsWith('.example.json'))
        .sort()
        .map((f) => `configs/${f}`)[0];
    } catch { return null; }
  })();
  if (cfgPath) {
    let cfg = null, err = null;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { err = e.message; }
    say(!!cfg, `設定檔 ${cfgPath} 是合法 JSON`, err || undefined);
    if (cfg) {
      const target = `${cfg.hubHost}:${cfg.hubPort || 47180}`;
      // 回送位址在 Hub 那台是正確答案，不是錯誤——這支工具會在三台都被跑到。
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.hubHost);
      const onHubMachine = mine.some((i) => i.address === HOST) || HOST === '127.0.0.1';
      const match = cfg.hubHost === HOST || cfg.hubHost === 'discover' ||
        (loopback && onHubMachine);
      say(match, '設定檔指向的 Hub 與本次檢查一致',
        match
          ? `hubHost ${cfg.hubHost}` +
            (loopback && onHubMachine ? '（本機就是 Hub 那台，回送位址正確）' : '')
          : `設定檔寫 ${target}，但你要連的是 ${HOST}:${PORT}`);
      say(!!cfg.seed, '設定檔有固定 seed（重啟後身分與餘額才會延續）',
        cfg.seed ? String(cfg.seed) : '缺 seed：每次重啟都是新 DID，舊債與餘額被棄置（§4 #17）');
    }
  } else {
    console.log('  --    找不到設定檔，跳過（可用第三個參數指定）');
  }

  // 4. TCP 層可達
  const reachable = await transport.probe({ host: HOST, port: PORT, timeoutMs: 4000 });
  say(reachable, `TCP ${HOST}:${PORT} 可連線`,
    reachable ? undefined : 'Hub 沒在跑、被防火牆擋、或 HUB_BIND 不是 0.0.0.0');

  // 5. AMCN 層可達：走 Agent 實際那條路。TCP 通不代表協議通——傳輸實作不
  //    同或版本不符都會在這一關才現形。
  let answered = null;
  if (reachable) {
    answered = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 6000);
      const c = transport.dial({ host: HOST, port: PORT });
      c.onMessage((m) => {
        // 分頁的第一頁就帶純量欄位，而這項檢查只要知道「Hub 回應了」與
        // 三個規模數字，不必把整本帳拉完（#41）。
        if (m.type === 'ledger_export_too_large') {
          clearTimeout(t); c.close();
          resolve({ tooLarge: m.bytes, receipts: null, accounts: null,
                    checkpoints: null });
          return;
        }
        if (m.type !== 'ledger_export') return;
        clearTimeout(t); c.close();
        resolve({ receipts: m.receipts.length, accounts: Object.keys(m.balances).length,
                  checkpoints: (m.checkpoints || []).length });
      });
      c.send({ type: 'export' });
    });
  }
  say(!!answered, 'AMCN 協議層可達（Hub 回應了 export）',
    answered
      ? (answered.tooLarge
          ? `Hub 回應了，但整份匯出 ${(answered.tooLarge / 1048576).toFixed(1)}MB ` +
            '超過單一 frame——要用 ledger-dump.js（會自動分頁，#41）'
          : `${answered.receipts} 筆收據、${answered.accounts} 個帳戶、` +
            `${answered.checkpoints} 個 checkpoint`)
      : reachable ? '埠開著但沒有 AMCN 回應：transport 實作不同（AMCN_TRANSPORT）或協議版本不符'
                  : '前一項已失敗，略過');

  // 6. UDP 信標（hubHost: "discover" 才需要，但聽得到就表示廣播網段相通）
  const beacon = await discovery.discoverHub({ timeoutMs: 3000 });
  say(!!beacon, 'UDP 信標聽得到（hubHost: "discover" 可用）',
    beacon ? `${beacon.host}:${beacon.port} ${beacon.did}`
           : '聽不到：手填 IP 不受影響，但 Wi-Fi client isolation／跨 VLAN 會擋廣播');

  const failed = rows.filter(([ok]) => !ok);
  console.log(`\n結果：${rows.length - failed.length}/${rows.length} PASS`);
  if (!failed.length) {
    console.log('這台到 Hub 的路徑完全正常——Agent 連不上就只剩它自己的設定或啟動方式。');
  } else {
    console.log('最可能的原因（依上面第一個 FAIL）：');
    console.log(`  → ${failed[0][1]}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
