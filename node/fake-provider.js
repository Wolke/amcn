// Local stand-in for a model provider's OpenAI-compatible endpoint, so the
// real HTTP adapter path can be exercised without paid API calls.
// Deterministic: replies with sha256 of the last user message (so the
// requester's deterministic verification still works).
//
// env: FAKE_PORT, FAKE_KEY (the only Bearer token it accepts)
'use strict';
const http = require('node:http');
const { sha256 } = require('./lib/wire');

const PORT = Number(process.env.FAKE_PORT);
const KEY = process.env.FAKE_KEY;
let requests = 0, authOk = 0;
// Attribution seen upstream (§4 #67): who the caller said the end user was.
// A node serving third-party work must name it; recording the field here is
// what lets demo.js assert the traffic was declared rather than blended in.
const users = [];
let unattributed = 0;

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(
      { requests, authOk, users, unattributed }));
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404); return res.end();
  }
  requests += 1;
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401); return res.end('{"error":"bad key"}');
  }
  authOk += 1;
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const req_ = JSON.parse(body);
    if (req_.user) users.push(req_.user); else unattributed += 1;
    const prompt = req_.messages.at(-1).content;
    res.writeHead(200, { 'content-type': 'application/json' });
    const content = sha256(prompt);
    // 真的供應商會回 usage，所以這個替身也要回——否則計量那條路只會被
    // 「估算」那一半覆蓋到（#92 的閘門自己踩過同型的事）。
    // FAKE_NO_USAGE=1 是**指名的負對照**：模擬不回 usage 的供應商。
    // `body` 這個名字外面已經在用（請求的累積緩衝），所以這裡叫 resBody——
    // 第一版就是這樣拿到一個 TDZ 例外的。
    const resBody = { choices: [{ message: { role: 'assistant', content } }] };
    if (process.env.FAKE_NO_USAGE !== '1') {
      resBody.usage = {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(content.length / 4),
      };
      resBody.usage.total_tokens =
        resBody.usage.prompt_tokens + resBody.usage.completion_tokens;
    }
    res.end(JSON.stringify(resBody));
  });
}).listen(PORT, '127.0.0.1', () =>
  console.log(`[fake-provider] :${PORT} up (key-gated OpenAI-compatible)`));
