#!/usr/bin/env node
// 內網剪貼板：讓三台機器之間貼文字，不必經過手機。
//
// 起因是試點期間 M2／M3 的輸出得用通訊軟體轉貼，而轉貼會掉格式、會截斷，
// 最麻煩的是**在 M1 上的人看不到原始輸出**，只看得到重貼的版本。貼板架在
// M1（Hub 那台，本來就一直開著），另外兩台貼進來就能被直接讀。
//
// 零相依，純 node:http。內容存成 JSONL，重啟不會掉。
//
// **沒有帳號密碼，也不該有。** 它只綁內網位址，用途是同一個實體網段內的
// 三台自己人；不要把它 expose 到網際網路，也不要貼私鑰或 .env。
//
// Run:  node pb.js            （預設 0.0.0.0:47800）
//       PB_PORT=9000 node pb.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PB_PORT || 47800);
const BIND = process.env.PB_BIND || '0.0.0.0';
const STORE = path.join(__dirname, 'out', 'pasteboard.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;     // 單則上限，防手滑貼進整份匯出
const KEEP = 200;

fs.mkdirSync(path.dirname(STORE), { recursive: true });
let items = [];
try {
  items = fs.readFileSync(STORE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
} catch { /* 第一次跑 */ }

const save = (it) => {
  items.push(it);
  if (items.length > KEEP) items = items.slice(-KEEP);
  try { fs.appendFileSync(STORE, JSON.stringify(it) + '\n'); } catch { /* 滿了就算了 */ }
};
const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const page = () => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AMCN 內網貼板</title>
<style>
 body{font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0;background:#111;color:#ddd}
 header{padding:10px 14px;background:#1b1b1b;position:sticky;top:0;border-bottom:1px solid #333}
 main{padding:14px;max-width:1100px}
 textarea{width:100%;height:9em;background:#000;color:#0f0;border:1px solid #333;padding:8px;
   font:13px/1.45 ui-monospace,Menlo,Consolas,monospace}
 input,button{font:14px ui-monospace,Menlo,Consolas,monospace;padding:6px 10px;
   background:#222;color:#ddd;border:1px solid #444;border-radius:4px}
 button{cursor:pointer;background:#2d5}
 .it{margin:14px 0;border:1px solid #333;border-radius:6px;overflow:hidden}
 .hd{background:#1b1b1b;padding:6px 10px;color:#8ab;font-size:12px;
   display:flex;justify-content:space-between}
 pre{margin:0;padding:10px;white-space:pre-wrap;word-break:break-word;background:#0a0a0a}
</style>
<header><b>AMCN 內網貼板</b> — 任一台貼、任一台讀。<a href="/" style="color:#8ab">重新整理</a></header>
<main>
<form method="POST" action="/post">
  <input name="from" placeholder="哪一台（M1/M2/M3）" value="" size="18">
  <textarea name="text" placeholder="貼上輸出…"></textarea>
  <p><button type="submit">貼上去</button></p>
</form>
${items.slice().reverse().map((it) => `<div class="it"><div class="hd">
  <span>${esc(it.from || '?')} · ${esc(it.at)}</span><span>#${it.id}</span></div>
  <pre>${esc(it.text)}</pre></div>`).join('')}
</main>`;

const body = (req) => new Promise((resolve) => {
  let b = ''; let over = false;
  req.on('data', (d) => {
    if (over) return;
    b += d; if (b.length > MAX_BYTES) { over = true; b = b.slice(0, MAX_BYTES) + '\n…（超過上限已截斷）'; }
  });
  req.on('end', () => resolve(b));
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, s) => {
    res.writeHead(code, { 'content-type': type + '; charset=utf-8' }); res.end(s);
  };
  if (req.method === 'POST' && u.pathname === '/post') {
    const raw = await body(req);
    const ct = req.headers['content-type'] || '';
    let from = u.searchParams.get('from') || '';
    let text = raw;
    // curl 的 --data-binary 預設就帶 x-www-form-urlencoded，所以不能只看
    // content-type 決定怎麼解——那會把管線進來的純文字當成空表單丟掉。
    // 有 `text` 欄位才當表單（瀏覽器那條路），否則整包當內文。
    let isForm = false;
    if (ct.includes('application/x-www-form-urlencoded')) {
      const f = new URLSearchParams(raw);
      if (f.has('text')) {
        isForm = true;
        text = f.get('text') || ''; from = f.get('from') || from;
      }
    }
    if (!text.trim()) return send(400, 'text/plain', '空的，沒有存\n');
    const it = { id: (items.at(-1)?.id || 0) + 1, at: new Date().toISOString(),
                 from: from || req.socket.remoteAddress, text };
    save(it);
    if (isForm) { res.writeHead(303, { location: '/' }); return res.end(); }
    return send(200, 'text/plain', `已存 #${it.id}\n`);
  }
  if (u.pathname === '/last') {
    const it = items.at(-1);
    return send(it ? 200 : 404, 'text/plain', it ? it.text : '（空）\n');
  }
  const m = u.pathname.match(/^\/raw\/(\d+)$/);
  if (m) {
    const it = items.find((x) => x.id === Number(m[1]));
    return send(it ? 200 : 404, 'text/plain', it ? it.text : '找不到\n');
  }
  if (u.pathname === '/list') {
    return send(200, 'text/plain', items.slice(-30).map((i) =>
      `#${i.id}  ${i.at}  ${i.from}  ${i.text.split('\n')[0].slice(0, 60)}`).join('\n') + '\n');
  }
  send(200, 'text/html', page());
}).listen(PORT, BIND, () => {
  console.log(`[pb] 貼板在 http://${BIND}:${PORT}  （存 ${path.relative(__dirname, STORE)}）`);
  console.log('[pb] 沒有認證，只給內網自己人用；不要貼私鑰');
});
